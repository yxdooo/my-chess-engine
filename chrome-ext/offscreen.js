/**
 * offscreen.js – SMP Worker Coordinator
 *
 * Runs inside the hidden offscreen document. Maintains a pool of Web Workers,
 * each loading the WASM chess engine. Distributes search tasks across workers
 * (Lazy SMP) and aggregates results with a Master-First Early Resolution model.
 */
import { log } from "./logger.js";

const MAX_WORKERS = 16;


/** @type {Worker[]} The active worker pool. */
let workers = [];

/** @type {Array<{ready: boolean, failed: boolean}>} Per-worker state tracking. */
let workerStates = [];

/** @type {number} Count of workers that have reported READY. */
let workersReady = 0;

/** @type {number} Target number of workers to spawn. */
let currentWorkerCount = 1;

/** @type {object|null} Queued search message waiting for workers to be ready. */
let messageQueue = null;

/** @type {Array<Function>} sendResponse callbacks waiting for the active search result. */
let activeResponseCallbacks = [];

/** @type {string} Normalized 4-field FEN currently being searched by the active search. */
let activeSearchFen = "";

/** @type {number} Current transposition table size in MB. */
let activeHashSize = 128;

let abortFlag = null;
let currentSearchId = 0;

// Active search tracking
let activeSearchRunning = false;
let activeSearchCompleted = false;
let activeSearchId = 0;
let activeWorkerResults = [];
let activeWorkersCount = 0;
let activeCompletedWorkers = 0;
let activeGraceTimer = null;
let activeFailsafeTimer = null;
let activeStartTime = 0;
let activeSelectedIndices = [];

/**
 * Robust Multi-Worker Aggregation:
 * 1. Filter out empty or broken moves.
 * 2. Find the highest completed depth among all workers.
 * 3. Discard lagging outliers (any result with depth < maxDepth - 1) to prevent
 *    horizon-effect blunders from shallow searches overriding deep analyses.
 * 4. For qualified candidates, sort by:
 *    a) Depth descending (deepest search wins)
 *    b) Worker 0 priority in ties (canonical unperturbed move ordering)
 *    c) Nodes descending (more thorough exploration wins)
 *    d) Score descending
 *
 * @param {Array<object>} workerResults
 * @returns {object} Aggregated result object
 */
export function aggregateWorkerResults(workerResults) {
    // Filter out empty moves and broken depth 0 results with score -INF (aborted before depth 1 completed)
    const validResults = (workerResults || []).filter(r => {
        if (!r || !r.bestMove || r.bestMove === "") return false;
        if ((r.depth || 0) === 0 && (r.score || 0) <= -20000 && (r.nodes || 0) <= 2) return false;
        return true;
    });
    if (validResults.length === 0) {
        return {
            bestMove: null,
            score: -999999,
            depth: 0,
            nodes: 0,
            pv: [],
            ponderFen: "",
            multiPv: []
        };
    }

    const maxDepth = Math.max(0, ...validResults.map(r => r.depth || 0));
    const minAcceptableDepth = maxDepth > 0 ? maxDepth - 1 : 0;
    let qualified = validResults.filter(r => (r.depth || 0) >= minAcceptableDepth);
    if (!qualified || qualified.length === 0) {
        qualified = validResults;
    }

    qualified.sort((a, b) => {
        const depthDiff = (b.depth || 0) - (a.depth || 0);
        if (depthDiff !== 0) return depthDiff;
        const scoreDiff = (b.score || 0) - (a.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        const nodeDiff = (b.nodes || 0) - (a.nodes || 0);
        if (nodeDiff !== 0) return nodeDiff;
        if (a.splitId === 0) return -1;
        if (b.splitId === 0) return 1;
        return 0;
    });

    const best = qualified[0] || validResults[0];
    if (!best || !best.bestMove) {
        return {
            bestMove: null,
            score: -999999,
            depth: 0,
            nodes: 0,
            pv: [],
            ponderFen: "",
            multiPv: []
        };
    }

    const seenMoves = new Set();
    const multiPv = [];
    for (const r of qualified) {
        if (r && r.bestMove && !seenMoves.has(r.bestMove)) {
            seenMoves.add(r.bestMove);
            multiPv.push({
                bestMove: r.bestMove,
                pv: r.pv || [],
                ponderFen: r.ponderFen || "",
                score: r.score ?? 0,
                depth: r.depth ?? 0,
            });
            if (multiPv.length >= 3) break;
        }
    }

    return {
        bestMove: best.bestMove,
        score: best.score ?? 0,
        depth: best.depth ?? 0,
        nodes: best.nodes ?? 0,
        pv: best.pv || [],
        ponderFen: best.ponderFen || "",
        multiPv
    };
}

// ---------------------------------------------------------------------------
// Worker Pool Management
// ---------------------------------------------------------------------------

/**
 * Spawns worker threads up to workerCount with permanent message handlers.
 * Never overwrites worker.onmessage so READY and INIT_FAILED are never lost.
 */
function initWorkers(workerCount) {
    const target = Math.min(MAX_WORKERS, Math.max(1, workerCount));
    currentWorkerCount = target;
    log.info('Pool', `Spawning workers up to target=${target} (${workers.length} exist)`);

    const initialLength = workers.length;
    for (let i = initialLength; i < target; i++) {
        try {
            const workerIndex = i;
            workerStates[workerIndex] = { ready: false, failed: false };

            const worker = new Worker("worker.js", { type: "module" });

            // PERMANENT message handler - NEVER overwritten!
            worker.onmessage = (e) => {
                handleWorkerMessage(workerIndex, e.data);
            };

            worker.onerror = (err) => {
                log.error('Pool', `Worker #${workerIndex} crashed!`, err);
                if (workerStates[workerIndex]) {
                    workerStates[workerIndex].failed = true;
                    workerStates[workerIndex].ready = false;
                }
                if (activeSearchRunning && !activeSearchCompleted) {
                    handleWorkerResult(workerIndex, {
                        type: "RESULT",
                        searchId: activeSearchId,
                        splitId: workerIndex,
                        bestMove: "",
                        score: 0,
                        depth: 0,
                        nodes: 0,
                        pv: [],
                        ponderFen: ""
                    });
                }
            };

            workers.push(worker);
            worker.postMessage({ type: "INIT" });
        } catch (e) {
            log.error('Pool', `Worker #${i} spawn failed`, e);
            workerStates[i] = { ready: false, failed: true };
        }
    }
}

/**
 * Restarts the worker pool to clear busy or stuck workers.
 */
function restartWorkerPool() {
    log.warn('Pool', 'Restarting worker pool to ensure fresh, responsive workers');
    for (let i = 0; i < workers.length; i++) {
        try { workers[i].terminate(); } catch (_) {}
    }
    workers = [];
    workerStates = [];
    workersReady = 0;
    initWorkers(currentWorkerCount || 2);
}

/**
 * Permanent message dispatcher for pool workers.
 */
function handleWorkerMessage(workerIndex, data) {
    if (!data || !data.type) return;

    if (data.type === "READY") {
        if (!workerStates[workerIndex]?.ready) {
            workerStates[workerIndex] = { ready: true, failed: false };
            workersReady = workerStates.filter(s => s && s.ready).length;
            
            // Distribute hash size across ready workers (minimum 16MB per worker)
            const perWorkerHash = Math.max(16, Math.floor(activeHashSize / Math.max(1, workersReady)));
            try {
                workers[workerIndex].postMessage({
                    type: "SET_HASH_SIZE",
                    size: perWorkerHash,
                });
            } catch (_) {}

            log.info('Pool', `Worker #${workerIndex} ready (${workersReady}/${workers.length} ready) | hash=${perWorkerHash}MB`);

            // If a search was queued and at least one worker is ready, start it
            if (messageQueue && !activeSearchRunning && workersReady >= 1) {
                log.info('Pool', 'Queued search can now proceed with ready worker(s)');
                const queued = messageQueue;
                messageQueue = null;
                processSearch(queued, currentSearchId, abortFlag);
            }
        }
        return;
    }

    if (data.type === "INIT_FAILED") {
        log.error('Pool', `Worker #${workerIndex} initialization failed:`, data.error);
        if (workerStates[workerIndex]) {
            workerStates[workerIndex].failed = true;
            workerStates[workerIndex].ready = false;
        }
        workersReady = workerStates.filter(s => s && s.ready).length;
        if (messageQueue && !activeSearchRunning && workersReady >= 1) {
            const queued = messageQueue;
            messageQueue = null;
            processSearch(queued, currentSearchId, abortFlag);
        } else if (workersReady === 0 && activeResponseCallbacks.length > 0) {
            const cbs = [...activeResponseCallbacks];
            activeResponseCallbacks = [];
            for (const cb of cbs) {
                try { cb({ bestMove: null }); } catch (_) {}
            }
        }
        return;
    }

    if (data.type === "RESULT") {
        handleWorkerResult(workerIndex, data);
        return;
    }
}

// ---------------------------------------------------------------------------
// Search Execution
// ---------------------------------------------------------------------------

/**
 * Distributes a search request across available ready workers (Lazy SMP).
 * Uses a Master-First Early Resolution model to eliminate all UI / bot freezes.
 *
 * @param {object} message - The START_SMP_SEARCH message payload.
 * @param {number} searchId - The unique search ID.
 * @param {Uint8Array} abortFlag - Shared array buffer for aborting.
 */
function processSearch(message, searchId, abortFlag) {
    messageQueue = null;

    // Select only workers that are actually READY
    const readyIndices = [];
    for (let i = 0; i < workers.length; i++) {
        if (workerStates[i]?.ready) {
            readyIndices.push(i);
        }
    }

    if (readyIndices.length === 0) {
        log.warn('SMP', 'No workers ready yet — queuing search');
        messageQueue = message;
        return;
    }

    const requestedCount = Math.max(1, message.activeWorkerCount || 1);

    // Boot grace period: If workers were spawned to meet requestedCount and are currently booting,
    // wait a short 180ms window so all requested workers can join the search together!
    if (requestedCount > readyIndices.length && workers.length >= requestedCount && !message._bootWaited) {
        message._bootWaited = true;
        log.info('SMP', `Waiting 180ms for ${requestedCount - readyIndices.length} booting worker(s) to finish init...`);
        setTimeout(() => {
            processSearch(message, searchId, abortFlag);
        }, 180);
        return;
    }

    activeStartTime = performance.now();
    activeSearchId = searchId;
    activeSearchRunning = true;
    activeSearchCompleted = false;
    activeWorkerResults = [];
    activeCompletedWorkers = 0;

    if (activeGraceTimer) {
        clearTimeout(activeGraceTimer);
        activeGraceTimer = null;
    }
    if (activeFailsafeTimer) {
        clearTimeout(activeFailsafeTimer);
        activeFailsafeTimer = null;
    }

    const workersToUse = Math.min(MAX_WORKERS, requestedCount, readyIndices.length);
    activeSelectedIndices = readyIndices.slice(0, workersToUse);
    activeWorkersCount = activeSelectedIndices.length;

    const targetSearchMs = message.searchTimeMs || (message.my_ms && message.my_ms > 0 ? Math.min(7500, Math.round(message.my_ms / 35)) : 2200);
    const maxSearchMs = message.maxTimeMs || Math.round(targetSearchMs * 1.35);
    const failsafeMs = Math.max(4500, Math.round(maxSearchMs + 2500));

    log.info('SMP', `Starting search #${searchId} | workers=${activeWorkersCount}/${requestedCount} elo=${message.elo} target=${targetSearchMs}ms max=${maxSearchMs}ms failsafe=${failsafeMs}ms`);
    log.debug('SMP', `FEN: ${(message.fen || '').substring(0, 50)}...`);

    activeFailsafeTimer = setTimeout(() => {
        if (activeSearchRunning && !activeSearchCompleted) {
            log.warn('SMP', `⏱️ Failsafe timeout fired (${failsafeMs}ms). Responded: ${activeCompletedWorkers}/${activeWorkersCount}. Finalizing to protect clock.`);
            if (abortFlag) {
                try { abortFlag[0] = 1; } catch (_) {}
            }
            finalizeActiveSearch();
        }
    }, failsafeMs);

    // Dispatch search to selected ready workers
    for (let s = 0; s < activeSelectedIndices.length; s++) {
        const idx = activeSelectedIndices[s];
        try {
            workers[idx].postMessage({
                type: "SEARCH",
                fen: message.fen,
                searchTimeMs: targetSearchMs,
                my_ms: message.my_ms,
                opp_ms: message.opp_ms,
                inc_ms: message.inc_ms,
                movesToGo: message.movesToGo,
                elo: message.elo,
                splitId: s,
                splitCount: activeWorkersCount,
                history: message.history || "",
                searchId: searchId,
                abortFlag: abortFlag,
            });
        } catch (err) {
            log.error('SMP', `Failed to post SEARCH to worker #${idx}`, err);
            handleWorkerResult(idx, {
                type: "RESULT",
                searchId: searchId,
                splitId: s,
                bestMove: "",
                score: 0,
                depth: 0,
                nodes: 0,
                pv: [],
                ponderFen: ""
            });
        }
    }
}

/**
 * Handles incoming RESULT message from a worker.
 */
function handleWorkerResult(workerIndex, data) {
    if (!activeSearchRunning || activeSearchCompleted) return;
    if (data.searchId !== activeSearchId) return;

    activeCompletedWorkers++;
    log.debug('SMP', `Worker result ${activeCompletedWorkers}/${activeWorkersCount} [split=${data.splitId}]: move=${data.bestMove} score=${data.score}cp depth=${data.depth}`);

    if (data.bestMove && data.bestMove !== "") {
        activeWorkerResults.push(data);
    }

    // Master-First Resolution:
    // Worker with splitId === 0 is the master thread exploring the canonical root.
    // If it found a move, give helper threads a 40ms grace period to report, then finalize.
    if (data.splitId === 0 && data.bestMove && !activeGraceTimer) {
        if (activeCompletedWorkers >= activeWorkersCount) {
            finalizeActiveSearch();
            return;
        } else {
            log.debug('SMP', 'Worker 0 (Master) finished — starting 40ms grace timer for helpers');
            activeGraceTimer = setTimeout(() => {
                log.debug('SMP', 'Grace timer finished — resolving search with best result');
                finalizeActiveSearch();
            }, 40);
        }
    }

    // If all assigned workers have responded, finalize immediately!
    if (activeCompletedWorkers >= activeWorkersCount) {
        if (activeGraceTimer) {
            clearTimeout(activeGraceTimer);
            activeGraceTimer = null;
        }
        finalizeActiveSearch();
    }
}

/**
 * Aggregates all received worker results and sends response to caller.
 */
function finalizeActiveSearch() {
    if (!activeSearchRunning || activeSearchCompleted) return;
    activeSearchCompleted = true;
    activeSearchRunning = false;

    if (activeGraceTimer) {
        clearTimeout(activeGraceTimer);
        activeGraceTimer = null;
    }
    if (activeFailsafeTimer) {
        clearTimeout(activeFailsafeTimer);
        activeFailsafeTimer = null;
    }

    try {
        const elapsed = Math.round(performance.now() - activeStartTime);
        const aggregated = aggregateWorkerResults(activeWorkerResults);
        const totalNodes = activeWorkerResults.reduce((acc, r) => acc + (r.nodes || 0), 0);
        const nps = elapsed > 0 ? Math.round(totalNodes / (elapsed / 1000)).toLocaleString() : '?';

        log.info('SMP', `Search #${activeSearchId} finalized in ${elapsed}ms | best=${aggregated.bestMove} score=${aggregated.score}cp depth=${aggregated.depth} nodes=${totalNodes.toLocaleString()} nps=${nps}`);

        if (activeResponseCallbacks.length > 0) {
            const payload = {
                bestMove:  aggregated.bestMove,
                pv:        aggregated.pv,
                ponderFen: aggregated.ponderFen,
                multiPv:   aggregated.multiPv,
                score:     aggregated.score,
                depth:     aggregated.depth,
                nodes:     totalNodes,
                timeMs:    elapsed,
            };
            const cbs = [...activeResponseCallbacks];
            activeResponseCallbacks = [];
            for (const cb of cbs) {
                try { cb(payload); } catch (_) {}
            }
        }
    } catch (err) {
        log.error('SMP', 'Error during finalizeActiveSearch', err);
        if (activeResponseCallbacks.length > 0) {
            const fallbackMove = activeWorkerResults.find(r => r && r.bestMove)?.bestMove || null;
            const errPayload = {
                bestMove: fallbackMove,
                pv: fallbackMove ? [fallbackMove] : [],
                ponderFen: "",
                multiPv: [],
                score: 0,
                depth: 0,
                nodes: 0,
                timeMs: 0,
            };
            const cbs = [...activeResponseCallbacks];
            activeResponseCallbacks = [];
            for (const cb of cbs) {
                try { cb(errPayload); } catch (_) {}
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "CONFIGURE_POOL") {
            const target = Math.min(MAX_WORKERS, Math.max(1, message.targetWorkers || 2));
            if (message.hashSize) {
                activeHashSize = message.hashSize;
                const perWorkerHash = Math.max(16, Math.floor(activeHashSize / Math.max(1, workersReady || 1)));
                for (const w of workers) {
                    try { w.postMessage({ type: "SET_HASH_SIZE", size: perWorkerHash }); } catch (_) {}
                }
            }
            initWorkers(target);
            return false;
        }

        if (message.type !== "START_SMP_SEARCH") return false;

        startEngineSearch(message, sendResponse);
        return true; // Keep message channel open for async response.
    });
}

/**
 * Dispatches or queues an SMP search request.
 * Incorporates robust FEN-deduplication: if a search is already running for the exact
 * same position, attaches the caller's callback instead of destructively aborting.
 *
 * @param {object}   message      - The search request payload.
 * @param {Function} sendResponse - Chrome messaging response callback.
 */
function startEngineSearch(message, sendResponse) {
    const normFen = (message.fen || "").split(" ").slice(0, 4).join(" ");
    const logTime = message.searchTimeMs || (message.my_ms ? Math.round(message.my_ms / 35) : 450);
    log.info('SMP', `New search request received | elo=${message.elo} targetTimeMs=${logTime} workers=${message.activeWorkerCount} fen=${normFen.substring(0, 35)}`);

    // 1. If an active search is ALREADY running for the EXACT SAME position:
    // Do NOT abort! Attach the caller's callback so it receives the result when ready.
    if (activeSearchRunning && !activeSearchCompleted && activeSearchFen === normFen) {
        log.info('SMP', `Search #${activeSearchId} already running for this exact FEN — attaching response listener`);
        if (sendResponse) {
            activeResponseCallbacks.push(sendResponse);
        }
        return;
    }

    // 2. If workers are still booting and a search is already queued:
    if (messageQueue && workersReady < 1) {
        const queuedFen = (messageQueue.fen || "").split(" ").slice(0, 4).join(" ");
        if (queuedFen === normFen) {
            log.info('SMP', `Search #${currentSearchId} already queued for this exact FEN — attaching response listener`);
            if (sendResponse) {
                activeResponseCallbacks.push(sendResponse);
            }
            return;
        }
        // Different position queued while waiting for workers: update queued message
        log.info('SMP', `Replacing queued search with newer position FEN`);
        messageQueue = message;
        activeSearchFen = normFen;
        const oldCbs = [...activeResponseCallbacks];
        activeResponseCallbacks = sendResponse ? [sendResponse] : [];
        for (const cb of oldCbs) {
            try { cb({ bestMove: null }); } catch (_) {}
        }
        return;
    }

    // 3. If an active search is running for a DIFFERENT position:
    // Abort the previous search gracefully WITHOUT destroying healthy workers!
    if (activeSearchRunning && !activeSearchCompleted) {
        log.info('SMP', `Aborting running search #${activeSearchId} for new position`);
        if (abortFlag) {
            try { abortFlag[0] = 1; } catch (_) {}
        }
        activeSearchRunning = false;
        activeSearchCompleted = true;
        if (activeGraceTimer) {
            clearTimeout(activeGraceTimer);
            activeGraceTimer = null;
        }
        if (activeFailsafeTimer) {
            clearTimeout(activeFailsafeTimer);
            activeFailsafeTimer = null;
        }
        const oldCbs = [...activeResponseCallbacks];
        activeResponseCallbacks = [];
        for (const cb of oldCbs) {
            try { cb({ bestMove: null }); } catch (_) {}
        }
    }

    currentSearchId++;
    activeSearchFen = normFen;
    activeResponseCallbacks = sendResponse ? [sendResponse] : [];

    if (message.hashSize && message.hashSize !== activeHashSize) {
        activeHashSize = message.hashSize;
        if (workers.length > 0) {
            const perWorkerSize = Math.max(1, Math.floor(activeHashSize / Math.max(1, workersReady)));
            for (const w of workers) {
                try { w.postMessage({ type: "SET_HASH_SIZE", size: perWorkerSize }); } catch (_) {}
            }
        }
    }

    const targetWorkers = Math.min(MAX_WORKERS, Math.max(1, message.activeWorkerCount || 2));

    // Allocate new abort flag if SharedArrayBuffer is supported
    if (typeof SharedArrayBuffer !== "undefined") {
        try {
            const sab = new SharedArrayBuffer(1);
            abortFlag = new Uint8Array(sab);
        } catch (_) {
            abortFlag = null;
        }
    } else {
        abortFlag = null;
    }

    if (targetWorkers > workers.length) {
        initWorkers(targetWorkers);
    }

    if (workersReady >= 1) {
        processSearch(message, currentSearchId, abortFlag);
    } else {
        log.info('Pool', `No workers ready yet — queuing search #${currentSearchId}`);
        messageQueue = message;
    }
}

// ---------------------------------------------------------------------------
// Initial Worker Pool
// ---------------------------------------------------------------------------
if (typeof Worker !== "undefined") {
    initWorkers(2);
}

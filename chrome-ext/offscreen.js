/**
 * offscreen.js – SMP Worker Coordinator
 *
 * Runs inside the hidden offscreen document. Maintains a pool of Web Workers,
 * each loading the WASM chess engine. Distributes search tasks across workers
 * (Lazy SMP) and aggregates results with a Master-First Early Resolution model.
 */
import { log } from "./logger.js";

const MAX_WORKERS = 4;

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

/** @type {Function|null} sendResponse callback for the pending search request. */
let currentSendResponse = null;

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
    const validResults = (workerResults || []).filter(r => r && r.bestMove && r.bestMove !== "");
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

    const maxDepth = Math.max(...validResults.map(r => r.depth || 0));
    const minAcceptableDepth = Math.max(1, maxDepth - 1);
    const qualified = validResults.filter(r => (r.depth || 0) >= minAcceptableDepth);

    qualified.sort((a, b) => {
        const depthDiff = (b.depth || 0) - (a.depth || 0);
        if (depthDiff !== 0) return depthDiff;
        if (a.splitId === 0) return -1;
        if (b.splitId === 0) return 1;
        const nodeDiff = (b.nodes || 0) - (a.nodes || 0);
        if (nodeDiff !== 0) return nodeDiff;
        return (b.score || 0) - (a.score || 0);
    });

    const best = qualified[0];
    const seenMoves = new Set();
    const multiPv = [];
    for (const r of qualified) {
        if (!seenMoves.has(r.bestMove)) {
            seenMoves.add(r.bestMove);
            multiPv.push({
                bestMove: r.bestMove,
                pv: r.pv || [],
                ponderFen: r.ponderFen || "",
                score: r.score,
                depth: r.depth,
            });
            if (multiPv.length >= 3) break;
        }
    }

    return {
        bestMove: best.bestMove,
        score: best.score,
        depth: best.depth || 0,
        nodes: best.nodes || 0,
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
 * Permanent message dispatcher for pool workers.
 */
function handleWorkerMessage(workerIndex, data) {
    if (!data || !data.type) return;

    if (data.type === "READY") {
        if (!workerStates[workerIndex]?.ready) {
            workerStates[workerIndex] = { ready: true, failed: false };
            workersReady = workerStates.filter(s => s && s.ready).length;
            
            // Distribute hash size across ready workers
            const perWorkerHash = Math.max(1, Math.floor(activeHashSize / Math.max(1, workersReady)));
            try {
                workers[workerIndex].postMessage({
                    type: "SET_HASH_SIZE",
                    size: perWorkerHash,
                });
            } catch (_) {}

            log.info('Pool', `Worker #${workerIndex} ready (${workersReady}/${workers.length} ready)`);

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
        } else if (workersReady === 0 && currentSendResponse) {
            currentSendResponse({ bestMove: null });
            currentSendResponse = null;
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
    const workersToUse = Math.min(MAX_WORKERS, requestedCount, readyIndices.length);
    activeSelectedIndices = readyIndices.slice(0, workersToUse);
    activeWorkersCount = activeSelectedIndices.length;

    log.info('SMP', `Starting search #${searchId} | workers=${activeWorkersCount} elo=${message.elo} timeMs=${(message.my_ms/20)}`);
    log.debug('SMP', `FEN: ${(message.fen || '').substring(0, 50)}...`);

    // Hard failsafe timer to protect clock from flagging:
    // If search takes longer than time budget + safety buffer, finalize immediately.
    const budgetMs = (message.my_ms / 20) || 3000;
    const failsafeMs = Math.min(8000, Math.max(1200, budgetMs * 1.5 + 1000));

    activeFailsafeTimer = setTimeout(() => {
        if (activeSearchRunning && !activeSearchCompleted) {
            log.warn('SMP', `⏱️ Failsafe timeout fired (${failsafeMs}ms). Responded: ${activeCompletedWorkers}/${activeWorkersCount}. Finalizing to protect clock.`);
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

    const elapsed = Math.round(performance.now() - activeStartTime);
    const aggregated = aggregateWorkerResults(activeWorkerResults);
    const totalNodes = activeWorkerResults.reduce((acc, r) => acc + (r.nodes || 0), 0);
    const nps = elapsed > 0 ? Math.round(totalNodes / (elapsed / 1000)).toLocaleString() : '?';

    log.info('SMP', `Search #${activeSearchId} finalized in ${elapsed}ms | best=${aggregated.bestMove} score=${aggregated.score}cp depth=${aggregated.depth} nodes=${totalNodes.toLocaleString()} nps=${nps}`);

    if (currentSendResponse) {
        currentSendResponse({
            bestMove:  aggregated.bestMove,
            pv:        aggregated.pv,
            ponderFen: aggregated.ponderFen,
            multiPv:   aggregated.multiPv,
            score:     aggregated.score,
            depth:     aggregated.depth,
            nodes:     totalNodes,
            timeMs:    elapsed,
        });
        currentSendResponse = null;
    }
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type !== "START_SMP_SEARCH") return false;

        startEngineSearch(message, sendResponse);
        return true; // Keep message channel open for async response.
    });
}

/**
 * Aborts any previous search and dispatches or queues the new search.
 *
 * @param {object}   message      - The search request payload.
 * @param {Function} sendResponse - Chrome messaging response callback.
 */
function startEngineSearch(message, sendResponse) {
    log.info('SMP', `New search request received | elo=${message.elo} timeMs=${(message.my_ms/20)} workers=${message.activeWorkerCount}`);
    
    // Abort previous search via SharedArrayBuffer flag
    if (abortFlag) {
        try { abortFlag[0] = 1; } catch (_) {}
    }

    // Cancel previously running search
    if (activeSearchRunning && !activeSearchCompleted) {
        log.info('SMP', 'Aborting previous running search for new position');
        if (currentSendResponse) {
            currentSendResponse({ bestMove: null });
            currentSendResponse = null;
        }
        activeSearchRunning = false;
        activeSearchCompleted = true;
    }

    currentSearchId++;

    if (currentSendResponse) {
        log.info('SMP', 'Previous search response uncalled — sending null fallback');
        currentSendResponse({ bestMove: null });
        currentSendResponse = null;
    }

    currentSendResponse = sendResponse;

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

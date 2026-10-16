/**
 * offscreen.js – SMP Worker Coordinator
 *
 * Runs inside the hidden offscreen document. Maintains a pool of Web Workers,
 * each loading the WASM chess engine. Distributes search tasks across workers
 * (Lazy SMP) and aggregates results.
 */
import { log } from "./logger.js";

const MAX_WORKERS = 16;

/** @type {Worker[]} The active worker pool. */
let workers = [];

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

/**
 * Robust Multi-Worker Aggregation:
 * 1. Filter out empty or broken moves.
 * 2. Find the highest completed depth among all workers.
 * 3. Discard lagging outliers (any result with depth < maxDepth - 1) to prevent
 *    horizon-effect blunders from shallow searches overriding deep analyses.
 * 4. For qualified candidates, sort by:
 *    a) Depth descending (deepest search wins)
 *    b) Score descending (for side to move)
 *    c) Nodes descending (more thorough exploration wins)
 *    d) Prefer Worker 0 in exact ties (canonical unperturbed move ordering)
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
 * Spawns workerCount fresh worker threads and waits for all to report READY.
 * After all workers are ready, processes any queued search message.
 */
function initWorkers(workerCount) {
    currentWorkerCount = workerCount;
    log.info('Pool', `Spawning ${workerCount} workers (${workers.length} already exist)`);

    const initialLength = workers.length;
    for (let i = initialLength; i < workerCount; i++) {
        try {
            const worker = new Worker("worker.js", { type: "module" });
            worker.postMessage({ type: "INIT" });

            worker.onmessage = (e) => {
                if (e.data.type === "READY") {
                    worker.postMessage({
                        type: "SET_HASH_SIZE",
                        size: Math.max(1, Math.floor(activeHashSize / currentWorkerCount)),
                    });
                    workersReady++;
                    log.info('Pool', `Worker #${workersReady}/${currentWorkerCount} ready`);
                    if (messageQueue && workersReady >= Math.min(MAX_WORKERS, Math.max(1, messageQueue.activeWorkerCount || 1), workers.length)) {
                        log.info('Pool', 'All workers ready — starting queued search');
                        processSearch(messageQueue, currentSearchId, abortFlag);
                    }
                } else if (e.data.type === "INIT_FAILED") {
                    log.error('Pool', `Worker #${i} initialization failed:`, e.data.error);
                    currentWorkerCount--;
                    if (workersReady >= currentWorkerCount && messageQueue && currentWorkerCount > 0) {
                        processSearch(messageQueue, currentSearchId, abortFlag);
                    } else if (currentWorkerCount === 0 && currentSendResponse) {
                        currentSendResponse({ bestMove: null });
                        currentSendResponse = null;
                    }
                }
            };

            worker.onerror = (err) => {
                log.error('Pool', `Worker crashed!`, err);
                currentWorkerCount--;
                if (workersReady >= currentWorkerCount && messageQueue && currentWorkerCount > 0) {
                    processSearch(messageQueue, currentSearchId, abortFlag);
                } else if (currentWorkerCount === 0 && currentSendResponse) {
                    currentSendResponse({ bestMove: null });
                    currentSendResponse = null;
                }
            };

            workers.push(worker);
        } catch (e) {
            log.error('Pool', `Worker spawn failed`, e);
            // If spawning fails, adjust the expected count to prevent hanging
            currentWorkerCount--;
            if (workersReady === currentWorkerCount && messageQueue && currentWorkerCount > 0) {
                processSearch(messageQueue, currentSearchId, abortFlag);
            }
        }
    }
    
    // If NO workers spawned successfully (e.g. Chrome block), send a fallback
    if (currentWorkerCount === 0 && currentSendResponse) {
        log.error('Pool', 'CRITICAL: No workers spawned! Sending null response.');
        currentSendResponse({ bestMove: null });
        currentSendResponse = null;
    }
}

// ---------------------------------------------------------------------------
// Search Execution
// ---------------------------------------------------------------------------

/**
 * Distributes a search request across the worker pool (Lazy SMP).
 * Each worker searches a disjoint subset of root moves (by index modulo).
 * The result with the highest score is selected as the overall best.
 *
 * @param {object} message - The START_SMP_SEARCH message payload.
 * @param {number} searchId - The unique search ID.
 * @param {Uint8Array} abortFlag - Shared array buffer for aborting.
 */
function processSearch(message, searchId, abortFlag) {
    messageQueue = null;
    const startTime = performance.now();
    let completed = 0;
    let bestOverallScore = -999999;
    let bestOverallMove = null;
    let bestPv = [];
    let bestPonderFen = "";
    let bestDepth = 0;
    let totalNodes = 0;

    const workersToUse = Math.max(
        1,
        Math.min(MAX_WORKERS, message.activeWorkerCount || 1, workersReady, workers.length)
    );
    const activeWorkers = workers.slice(0, workersToUse);

    log.info('SMP', `Starting search — workers=${workersToUse} elo=${message.elo} timeMs=${(message.my_ms/20)}`);
    log.debug('SMP', `FEN: ${(message.fen || '').substring(0, 50)}...`);

    // Freeze detector: if we don’t get results within timeMs*2+5s, log a freeze warning
    const freezeTimeout = setTimeout(() => {
        if (completed < workersToUse) {
            log.error('SMP', `🥶 FREEZE DETECTED! Only ${completed}/${workersToUse} workers responded after ${(message.my_ms/20) * 2 + 5000}ms`, { message });
        }
    }, ((message.my_ms/20) || 3000) * 2 + 5000);

    /** @type {Array<{bestMove: string, pv: string[], ponderFen: string, score: number}>} */
    let workerResults = [];

    const onWorkerResult = (e) => {
        if (e.data.type !== "RESULT" || e.data.searchId !== searchId) return;

        completed++;
        log.debug('SMP', `Worker result ${completed}/${workersToUse}: move=${e.data.bestMove} score=${e.data.score}cp depth=${e.data.depth}`);

        if (e.data.bestMove && e.data.bestMove !== "") {
            workerResults.push(e.data);
            totalNodes += (e.data.nodes || 0);
            const isBetter = e.data.depth > bestDepth || 
                             (e.data.depth === bestDepth && e.data.splitId === 0) ||
                             (bestDepth === 0);
            if (isBetter) {
                bestOverallScore = e.data.score;
                bestOverallMove  = e.data.bestMove;
                bestPv           = e.data.pv;
                bestPonderFen    = e.data.ponderFen;
                bestDepth        = e.data.depth || 0;
            }
        }

        if (completed === workersToUse) {
            clearTimeout(freezeTimeout);

            const aggregated = aggregateWorkerResults(workerResults);
            bestOverallScore = aggregated.score;
            bestOverallMove  = aggregated.bestMove;
            bestPv           = aggregated.pv;
            bestPonderFen    = aggregated.ponderFen;
            bestDepth        = aggregated.depth;
            const multiPv    = aggregated.multiPv;

            const elapsed = (performance.now() - startTime).toFixed(0);
            const nps = elapsed > 0 ? Math.round(totalNodes / (elapsed / 1000)).toLocaleString() : '?';
            log.info('SMP', `Done in ${elapsed}ms | best=${bestOverallMove} score=${bestOverallScore}cp depth=${bestDepth} nodes=${totalNodes.toLocaleString()} nps=${nps}`);

            if (currentSendResponse) {
                currentSendResponse({
                    bestMove: bestOverallMove,
                    pv:       bestPv,
                    ponderFen: bestPonderFen,
                    multiPv,
                    score:   bestOverallScore,
                    depth:   bestDepth,
                    nodes:   totalNodes,
                    timeMs:  Math.round(elapsed),
                });
                currentSendResponse = null;
            } else {
                log.warn('SMP', 'Search done but sendResponse is already null (request was cancelled?)');
            }
        }
    };

    for (let i = 0; i < workersToUse; i++) {
        activeWorkers[i].onmessage = onWorkerResult;
        activeWorkers[i].postMessage({
            type: "SEARCH",
            fen: message.fen,
            my_ms: message.my_ms, opp_ms: message.opp_ms, inc_ms: message.inc_ms, movesToGo: message.movesToGo,
            elo: message.elo,
            splitId: i,
            splitCount: workersToUse,
            history: message.history || "",
            searchId: searchId,
            abortFlag: abortFlag,
        });
    }
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type !== "START_SMP_SEARCH") return false;

        // Abort any in-flight search and start fresh.
        startEngineSearch(message, sendResponse);
        return true; // Keep message channel open for async response.
    });
}

/**
 * Aborts running workers and queues a new search request.
 * Workers are re-spawned fresh to abort their WASM execution.
 *
 * @param {object}   message      - The search request payload.
 * @param {Function} sendResponse - Chrome messaging response callback.
 */
function startEngineSearch(message, sendResponse) {
    log.info('SMP', `New search request received | elo=${message.elo} timeMs=${(message.my_ms/20)} workers=${message.activeWorkerCount}`);
    
    // Gracefully abort any running search.
    if (abortFlag) {
        log.debug('SMP', 'Aborting previous search via abortFlag');
        abortFlag[0] = 1;
    }

    currentSearchId++;

    if (currentSendResponse) {
        log.info('SMP', 'Previous search was not resolved — sending null to prevent hang');
        currentSendResponse({ bestMove: null });
        currentSendResponse = null;
    }

    messageQueue = message;
    currentSendResponse = sendResponse;
    if (message.hashSize && message.hashSize !== activeHashSize) {
        activeHashSize = message.hashSize;
        if (workers.length > 0) {
            const perWorkerSize = Math.max(1, Math.floor(activeHashSize / workers.length));
            for (const w of workers) {
                w.postMessage({ type: "SET_HASH_SIZE", size: perWorkerSize });
            }
        }
    }

    const targetWorkers = Math.min(MAX_WORKERS, Math.max(1, message.activeWorkerCount || 4));
    
    // Allocate new abort flag if SharedArrayBuffer is supported
    if (typeof SharedArrayBuffer !== "undefined") {
        try {
            const sab = new SharedArrayBuffer(1);
            abortFlag = new Uint8Array(sab);
            log.debug('SAB', 'SharedArrayBuffer abort flag allocated');
        } catch (_) {
            abortFlag = null;
        }
    } else {
        abortFlag = null;
    }

    if (targetWorkers > workers.length) {
        log.info('Pool', `Need ${targetWorkers} workers, have ${workers.length} — spawning more`);
        initWorkers(targetWorkers);
    } else if (workersReady >= targetWorkers) {
        processSearch(message, currentSearchId, abortFlag);
    } else {
        log.debug('Pool', `Waiting for ${targetWorkers - workersReady} worker(s) before starting search`);
    }
}

// ---------------------------------------------------------------------------
// Initial Worker Pool
// ---------------------------------------------------------------------------
if (typeof Worker !== "undefined") {
    initWorkers(4);
}

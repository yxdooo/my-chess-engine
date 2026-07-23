/**
 * offscreen.js – SMP Worker Coordinator
 *
 * Runs inside the hidden offscreen document. Maintains a pool of Web Workers,
 * each loading the WASM chess engine. Distributes search tasks across workers
 * (Lazy SMP) and aggregates results.
 */

const MAX_WORKERS = 16;

/** @type {Worker[]} The active worker pool. */
let workers = [];

/** @type {number} Count of workers that have reported READY. */
let workersReady = 0;

/** @type {object|null} Queued search message waiting for workers to be ready. */
let messageQueue = null;

/** @type {Function|null} sendResponse callback for the pending search request. */
let currentSendResponse = null;

/** @type {number} Current transposition table size in MB. */
let activeHashSize = 128;

// ---------------------------------------------------------------------------
// Worker Pool Management
// ---------------------------------------------------------------------------

/**
 * Spawns MAX_WORKERS fresh worker threads and waits for all to report READY.
 * After all workers are ready, processes any queued search message.
 */
function initWorkers() {
    workersReady = 0;
    workers = [];

    for (let i = 0; i < MAX_WORKERS; i++) {
        try {
            const worker = new Worker("worker.js", { type: "module" });

            worker.onmessage = (e) => {
                if (e.data.type === "READY") {
                    worker.postMessage({
                        type: "SET_HASH_SIZE",
                        size: activeHashSize,
                    });
                    workersReady++;
                    if (workersReady === MAX_WORKERS && messageQueue) {
                        processSearch(messageQueue);
                    }
                }
            };

            workers.push(worker);
        } catch (e) {
            console.error("[Offscreen] Worker spawn failed:", e);
        }
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
 */
function processSearch(message) {
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
        Math.min(message.activeWorkerCount, workersReady)
    );
    const activeWorkers = workers.slice(0, workersToUse);

    /** @type {Array<{bestMove: string, pv: string[], ponderFen: string, score: number}>} */
    let workerResults = [];

    /**
     * Handles a RESULT message from a worker.
     * @param {MessageEvent} e
     */
    const onWorkerResult = (e) => {
        if (e.data.type !== "RESULT") return;

        completed++;

        if (e.data.bestMove && e.data.bestMove !== "") {
            workerResults.push(e.data);
            // Accumulate totals for stats reporting.
            totalNodes += (e.data.nodes || 0);
            if (e.data.score > bestOverallScore) {
                bestOverallScore = e.data.score;
                bestOverallMove  = e.data.bestMove;
                bestPv           = e.data.pv;
                bestPonderFen    = e.data.ponderFen;
                bestDepth        = e.data.depth || 0;
            }
        }

        if (completed === workersToUse) {
            // Detach handlers to prevent stale callbacks on next search.
            for (const w of activeWorkers) w.onmessage = null;

            const elapsed = (performance.now() - startTime).toFixed(0);
            console.log(
                `[Offscreen] SMP-${workersToUse} finished in ${elapsed}ms. Best: ${bestOverallMove}`
            );

            // Build multiPv from unique worker results sorted by score.
            workerResults.sort((a, b) => b.score - a.score);
            const multiPv = workerResults.slice(0, 3).map((r) => ({
                bestMove: r.bestMove,
                pv: r.pv,
                ponderFen: r.ponderFen,
            }));

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
            }
        }
    };

    for (let i = 0; i < workersToUse; i++) {
        activeWorkers[i].onmessage = onWorkerResult;
        activeWorkers[i].postMessage({
            type: "SEARCH",
            fen: message.fen,
            timeMs: message.timeMs,
            elo: message.elo,
            splitId: i,
            splitCount: workersToUse,
            history: message.history || "",
        });
    }
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "START_SMP_SEARCH") return false;

    // Abort any in-flight search and start fresh.
    startEngineSearch(message, sendResponse);
    return true; // Keep message channel open for async response.
});

/**
 * Aborts running workers and queues a new search request.
 * Workers are re-spawned fresh to abort their WASM execution.
 *
 * @param {object}   message      - The search request payload.
 * @param {Function} sendResponse - Chrome messaging response callback.
 */
function startEngineSearch(message, sendResponse) {
    // Terminate all running workers to cancel any in-progress WASM search.
    for (const w of workers) w.terminate();

    // Reject the previous pending response if one exists.
    if (currentSendResponse) {
        currentSendResponse({ bestMove: null });
        currentSendResponse = null;
    }

    messageQueue = message;
    currentSendResponse = sendResponse;

    if (message.hashSize) activeHashSize = message.hashSize;

    // Respawn fresh worker pool (~5 ms overhead).
    initWorkers();
}

// ---------------------------------------------------------------------------
// Initial Worker Pool
// ---------------------------------------------------------------------------
initWorkers();

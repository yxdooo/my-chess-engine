/**
 * offscreen.js – SMP Worker Coordinator
 *
 * Runs inside the hidden offscreen document. Maintains a pool of Web Workers,
 * each loading the WASM chess engine. Distributes search tasks across workers
 * (Lazy SMP) and aggregates results.
 */

const MAX_WORKERS = 16;

const sharedWasmMemory = new WebAssembly.Memory({ initial: 2048, maximum: 16384, shared: true });

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

// ---------------------------------------------------------------------------
// Worker Pool Management
// ---------------------------------------------------------------------------

/**
 * Spawns workerCount fresh worker threads and waits for all to report READY.
 * After all workers are ready, processes any queued search message.
 */
function initWorkers(workerCount) {
    currentWorkerCount = workerCount;

    const initialLength = workers.length;
    for (let i = initialLength; i < workerCount; i++) {
        try {
            const worker = new Worker("worker.js", { type: "module" });
            worker.postMessage({ type: "INIT", memory: sharedWasmMemory });

            worker.onmessage = (e) => {
                if (e.data.type === "READY") {
                    worker.postMessage({
                        type: "SET_HASH_SIZE",
                        size: Math.max(1, Math.floor(activeHashSize / currentWorkerCount)),
                    });
                    workersReady++;
                    if (workersReady === currentWorkerCount && messageQueue) {
                        processSearch(messageQueue, currentSearchId, abortFlag);
                    }
                }
            };

            workers.push(worker);
        } catch (e) {
            console.error("[Offscreen] Worker spawn failed:", e);
            // If spawning fails, adjust the expected count to prevent hanging
            currentWorkerCount--;
            if (workersReady === currentWorkerCount && messageQueue && currentWorkerCount > 0) {
                processSearch(messageQueue, currentSearchId, abortFlag);
            }
        }
    }
    
    // If NO workers spawned successfully (e.g. Chrome block), send a fallback
    if (currentWorkerCount === 0 && currentSendResponse) {
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
        if (e.data.type !== "RESULT" || e.data.searchId !== searchId) return;

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
            searchId: searchId,
            abortFlag: abortFlag,
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
    // Gracefully abort any running search.
    if (abortFlag) {
        abortFlag[0] = 1;
    }

    currentSearchId++;

    if (currentSendResponse) {
        currentSendResponse({ bestMove: null });
        currentSendResponse = null;
    }

    messageQueue = message;
    currentSendResponse = sendResponse;
    if (message.hashSize) activeHashSize = message.hashSize;

    const targetWorkers = message.activeWorkerCount || 4;
    
    // Allocate new abort flag using SharedArrayBuffer
    try {
        const sab = new SharedArrayBuffer(1);
        abortFlag = new Uint8Array(sab);
    } catch (e) {
        // Fallback if SAB is disabled: must terminate and recreate workers
        console.warn("SharedArrayBuffer not available, recreating workers to abort");
        abortFlag = null;
        for (const worker of workers) worker.terminate();
        workers = [];
        workersReady = 0;
    }

    if (targetWorkers > workers.length) {
        initWorkers(targetWorkers);
    } else {
        processSearch(message, currentSearchId, abortFlag);
    }
}

// ---------------------------------------------------------------------------
// Initial Worker Pool
// ---------------------------------------------------------------------------
initWorkers(4);

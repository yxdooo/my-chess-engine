const MAX_WORKERS = 16; 
let workers = [];
let workersReady = 0;
let messageQueue = null;
let currentSendResponse = null;

function initWorkers() {
    workersReady = 0;
    workers = [];
    for (let i = 0; i < MAX_WORKERS; i++) {
        try {
            const worker = new Worker('worker.js', { type: 'module' });
            worker.onmessage = (e) => {
                if (e.data.type === 'READY') {
                    workersReady++;
                    if (workersReady === MAX_WORKERS && messageQueue) {
                        processSearch(messageQueue);
                    }
                }
            };
            workers.push(worker);
        } catch (e) {
            console.error("Worker spawn failed in offscreen:", e);
        }
    }
}

function processSearch(message) {
    messageQueue = null; 
    const start = performance.now();
    let completed = 0;
    let bestOverallScore = -999999;
    let bestOverallMove = null;
    let pv = [];
    let ponderFen = "";
    
    let workersToUse = Math.min(message.activeWorkerCount, workersReady);
    if (workersToUse < 1) workersToUse = 1;
    const activeWorkers = workers.slice(0, workersToUse);
    const splitCount = activeWorkers.length;
    
    const onWorkerResult = (e) => {
        if (e.data.type === 'RESULT') {
            completed++;
            if (e.data.score > bestOverallScore && e.data.bestMove !== "") {
                bestOverallScore = e.data.score;
                bestOverallMove = e.data.bestMove;
                pv = e.data.pv;
                ponderFen = e.data.ponderFen;
            }
            
            if (completed === splitCount) {
                for (let w of activeWorkers) w.onmessage = null; 
                console.log(`[SMP-${splitCount}] Search: ${performance.now() - start}ms. Best: ${bestOverallMove}`);
                if (currentSendResponse) {
                    currentSendResponse({ bestMove: bestOverallMove, pv: pv, ponderFen: ponderFen });
                    currentSendResponse = null;
                }
            }
        }
    };
    
    for (let i = 0; i < splitCount; i++) {
        activeWorkers[i].onmessage = onWorkerResult;
        activeWorkers[i].postMessage({
            type: 'SEARCH', 
            fen: message.fen, 
            timeMs: message.timeMs, 
            elo: message.elo, 
            splitId: i, 
            splitCount: splitCount
        });
    }
}

// Initial Spawn
initWorkers();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_SMP_SEARCH') {
        // INSTANT ABORT: Kill all running workers to cancel their Wasm execution
        for (let w of workers) {
            w.terminate();
        }
        
        // Save the new request
        if (currentSendResponse) currentSendResponse({bestMove: null});
        messageQueue = message;
        currentSendResponse = sendResponse;
        
        // Respawn fresh workers (Takes ~5ms)
        initWorkers();
        
        return true; 
    }
});


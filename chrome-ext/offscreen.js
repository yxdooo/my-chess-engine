const MAX_WORKERS = 16; 
let workers = [];
let workersReady = 0;
let messageQueue = null;
let currentSendResponse = null;

let activeHashSize = 128; // Default

function initWorkers() {
    workersReady = 0;
    workers = [];
    for (let i = 0; i < MAX_WORKERS; i++) {
        try {
            const worker = new Worker('worker.js', { type: 'module' });
            worker.onmessage = (e) => {
                if (e.data.type === 'READY') {
                    worker.postMessage({ type: 'SET_HASH_SIZE', size: activeHashSize });
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
    
    let activeWorkersResults = [];

    const onWorkerResult = (e) => {
        if (e.data.type === 'RESULT') {
            completed++;
            if (e.data.bestMove !== "") {
                activeWorkersResults.push(e.data);
            }
            if (e.data.score > bestOverallScore && e.data.bestMove !== "") {
                bestOverallScore = e.data.score;
                bestOverallMove = e.data.bestMove;
                pv = e.data.pv;
                ponderFen = e.data.ponderFen;
            }
            
            if (completed === splitCount) {
                for (let w of activeWorkers) w.onmessage = null; 
                console.log(`[SMP-${splitCount}] Search: ${performance.now() - start}ms. Best: ${bestOverallMove}`);
                
                activeWorkersResults.sort((a, b) => b.score - a.score);
                let multiPv = activeWorkersResults.slice(0, 3).map(r => ({
                    bestMove: r.bestMove,
                    pv: r.pv,
                    ponderFen: r.ponderFen
                }));

                if (currentSendResponse) {
                    currentSendResponse({ 
                        bestMove: bestOverallMove, 
                        pv: pv, 
                        ponderFen: ponderFen,
                        multiPv: multiPv
                    });
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
            splitCount: splitCount,
            history: message.history
        });
    }
}

// Initial Spawn
initWorkers();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_SMP_SEARCH') {
        // Syzygy Endgame Tablebases via Lichess API (7-piece)
        let fenPieces = message.fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
        if (fenPieces <= 7) {
            fetch(`https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(message.fen)}`)
                .then(r => r.json())
                .then(data => {
                    if (data && data.moves && data.moves.length > 0) {
                        let best = data.moves[0].uci;
                        sendResponse({
                            bestMove: best,
                            pv: [best],
                            ponderFen: "",
                            multiPv: [{bestMove: best, pv: [best], ponderFen: ""}]
                        });
                    } else {
                        throw new Error("No TB moves");
                    }
                })
                .catch(e => {
                    console.log("TB fallback to engine:", e);
                    startEngineSearch(message, sendResponse);
                });
            return true;
        }

        startEngineSearch(message, sendResponse);
        return true; 
    }
});

function startEngineSearch(message, sendResponse) {
    // INSTANT ABORT: Kill all running workers to cancel their Wasm execution
    for (let w of workers) {
        w.terminate();
    }
    
    // Save the new request
    if (currentSendResponse) currentSendResponse({bestMove: null});
    messageQueue = message;
    currentSendResponse = sendResponse;
    if (message.hashSize) activeHashSize = message.hashSize;
    
    // Respawn fresh workers (Takes ~5ms)
    initWorkers();
}


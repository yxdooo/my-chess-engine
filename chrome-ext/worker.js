import init, { ChessEngine } from './pkg/engine_wasm.js';

let engine = null;

init().then(() => {
    engine = new ChessEngine();
    postMessage({ type: 'READY' });
}).catch(e => {
    console.error("Worker WASM Load Error:", e);
});

onmessage = function(e) {
    if (!engine) return;
    const msg = e.data;
    if (msg.type === 'SEARCH') {
        try {
            const resStr = engine.get_best_move(msg.fen, msg.timeMs, msg.elo, msg.splitId, msg.splitCount);
            const res = JSON.parse(resStr);
            postMessage({ type: 'RESULT', splitId: msg.splitId, bestMove: res.bestMove, score: res.score, pv: res.pv, ponderFen: res.ponderFen });
        } catch(err) {
            postMessage({ type: 'ERROR', error: err.toString() });
        }
    }
}


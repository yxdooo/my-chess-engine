import init, { ChessEngine } from './pkg/engine_wasm.js';

let engine = null;

init().then(() => {
    engine = new ChessEngine();
    postMessage({ type: 'READY' });
}).catch(e => {
    console.error("Worker WASM Load Error:", e);
});

onmessage = (e) => {
    if (!engine) return;
    if (e.data.type === 'SET_HASH_SIZE') {
        engine.set_hash_size(e.data.size);
    } else if (e.data.type === 'SEARCH') {
        const { fen, timeMs, elo, splitId, splitCount, history } = e.data;
        const histStr = history || "";
        const result = engine.get_best_move(fen, timeMs, elo, splitId, splitCount, histStr);
        try {
            const parsed = JSON.parse(result);
            postMessage({ type: 'RESULT', ...parsed });
        } catch(err) {
            console.error("WASM JSON Parse error:", err, result);
            postMessage({ type: 'RESULT', bestMove: "", score: 0, pv: [], ponderFen: "" });
        }
    }
};

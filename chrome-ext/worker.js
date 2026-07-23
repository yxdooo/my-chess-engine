/**
 * worker.js – WASM Engine Worker Thread
 *
 * Loads the Rust/WASM chess engine and handles search requests from offscreen.js.
 * Runs as a dedicated Web Worker (ES module type).
 */

import init, { ChessEngine } from "./pkg/engine_wasm.js";

/** @type {ChessEngine|null} The initialized WASM engine instance. */
let engine = null;

// Initialize the WASM module and signal readiness.
init()
    .then(() => {
        engine = new ChessEngine();
        postMessage({ type: "READY" });
    })
    .catch((e) => {
        console.error("[Worker] WASM initialization failed:", e);
    });

onmessage = (e) => {
    if (!engine) return;

    const { type, size, fen, timeMs, elo, splitId, splitCount, history } =
        e.data;

    if (type === "SET_HASH_SIZE") {
        engine.set_hash_size(size);
        return;
    }

    if (type === "SEARCH") {
        const result = engine.get_best_move(
            fen,
            timeMs,
            elo,
            splitId,
            splitCount,
            history || ""
        );

        try {
            const parsed = JSON.parse(result);
            postMessage({ type: "RESULT", ...parsed });
        } catch (err) {
            console.error("[Worker] Failed to parse engine result:", err, result);
            postMessage({
                type: "RESULT",
                bestMove: "",
                score: 0,
                pv: [],
                ponderFen: "",
            });
        }
    }
};

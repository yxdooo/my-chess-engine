/**
 * worker.js – WASM Engine Worker Thread
 *
 * Loads the Rust/WASM chess engine and handles search requests from offscreen.js.
 * Runs as a dedicated Web Worker (ES module type).
 */

import init, { ChessEngine } from "./pkg/engine_wasm.js";

/** @type {ChessEngine|null} The initialized WASM engine instance. */
let engine = null;

onmessage = async (e) => {
    const { type, size, fen, timeMs, elo, splitId, splitCount, history, searchId, abortFlag, memory } =
        e.data;

    if (type === "INIT") {
        try {
            await init({ module_or_path: new URL('./pkg/engine_wasm_bg.wasm', import.meta.url), memory });
            engine = new ChessEngine();
            postMessage({ type: "READY" });
        } catch (err) {
            console.error("[Worker] WASM initialization failed:", err);
        }
        return;
    }

    if (!engine) return;

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
            history || "",
            abortFlag
        );

        try {
            const parsed = JSON.parse(result);
            postMessage({ type: "RESULT", searchId, ...parsed });
        } catch (err) {
            console.error("[Worker] Failed to parse engine result:", err, result);
            postMessage({
                type: "RESULT",
                searchId,
                bestMove: "",
                score: 0,
                pv: [],
                ponderFen: "",
            });
        }
    }
};

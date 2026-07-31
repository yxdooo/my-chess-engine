/**
 * worker.js – WASM Engine Worker Thread
 *
 * Loads the Rust/WASM chess engine and handles search requests from offscreen.js.
 * Runs as a dedicated Web Worker (ES module type).
 */

import init, { ChessEngine } from "./pkg/engine_wasm.js";
import { log } from "./logger.js";

/** @type {ChessEngine|null} The initialized WASM engine instance. */
let engine = null;
let workerId = Math.random().toString(36).slice(2, 6); // e.g. "a3f7"

onmessage = async (e) => {
    const { type, size, fen, timeMs, elo, splitId, splitCount, history, searchId, abortFlag, memory } =
        e.data;

    if (type === "INIT") {
        log.info('Init', `Worker[${workerId}] starting WASM init...`);
        try {
            log.time('WasmInit');
            await init({ module_or_path: new URL('./pkg/engine_wasm_bg.wasm', import.meta.url) });
            engine = new ChessEngine();
            log.timeEnd('WasmInit');
            
            try {
                log.time('NNUELoad');
                const nnueUrl = new URL('./net.nnue', import.meta.url);
                const response = await fetch(nnueUrl);
                const buffer = await response.arrayBuffer();
                const success = engine.load_network(new Uint8Array(buffer));
                log.timeEnd('NNUELoad');
                if (success) {
                    log.info('NNUE', `Worker[${workerId}] NNUE loaded OK (${(buffer.byteLength/1024/1024).toFixed(1)}MB)`);
                } else {
                    log.warn('NNUE', `Worker[${workerId}] NNUE load_network returned false — using classic eval`);
                }
            } catch (err) {
                log.error('NNUE', `Worker[${workerId}] NNUE fetch failed — using classic eval`, err);
            }
            
            log.info('Init', `Worker[${workerId}] READY`);
            postMessage({ type: "READY" });
        } catch (err) {
            log.error('Init', `Worker[${workerId}] WASM initialization FAILED`, err);
        }
        return;
    }

    if (!engine) return;

    if (type === "SET_HASH_SIZE") {
        engine.set_hash_size(size);
        log.debug('Hash', `Worker[${workerId}] hash size set to ${size}MB`);
        return;
    }

    if (type === "SEARCH") {
        const fenShort = fen ? fen.substring(0, 45) : 'null';
        log.debug('Search', `Worker[${workerId}] searching elo=${elo} timeMs=${timeMs} split=${splitId}/${splitCount}`, { fenShort });
        log.time(`Search[${workerId}]`);
        
        const result = engine.get_best_move(
            fen,
            timeMs,
            elo,
            splitId,
            splitCount,
            history || "",
            abortFlag
        );

        const elapsed = log.timeEnd(`Search[${workerId}]`);

        try {
            const parsed = JSON.parse(result);
            if (!parsed.bestMove) {
                log.warn('Search', `Worker[${workerId}] got empty bestMove`, { parsed, fenShort });
            } else {
                log.info('Search', `Worker[${workerId}] → ${parsed.bestMove} score=${parsed.score}cp depth=${parsed.depth} nodes=${(parsed.nodes||0).toLocaleString()} time=${elapsed}ms`);
            }
            postMessage({ type: "RESULT", searchId, ...parsed });
        } catch (err) {
            log.error('Search', `Worker[${workerId}] JSON parse FAILED — raw result below`, { err, result });
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

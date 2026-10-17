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
    const { type, size, fen, my_ms, opp_ms, inc_ms, movesToGo, elo, splitId, splitCount, history, searchId, abortFlag } =
        e.data;

    if (type === "INIT") {
        log.info('Init', `Worker[${workerId}] starting WASM init...`);
        try {
            log.time('WasmInit');
            const wasmUrl = new URL('./pkg/engine_wasm_bg.wasm', import.meta.url);
            const wasmResponse = await fetch(wasmUrl);
            const wasmBytes = await wasmResponse.arrayBuffer();
            await init({ module_or_path: wasmBytes });
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
            postMessage({ type: "INIT_FAILED", workerId, error: String(err) });
        }
        return;
    }

    if (!engine) {
        log.warn('Search', `Worker[${workerId}] received ${type} while engine uninitialized — sending graceful fallback`);
        if (type === "SEARCH") {
            postMessage({
                type: "RESULT",
                searchId,
                workerId,
                splitId,
                bestMove: "",
                score: 0,
                depth: 0,
                nodes: 0,
                pv: [],
                ponderFen: "",
            });
        }
        return;
    }

    if (type === "SET_HASH_SIZE") {
        engine.set_hash_size(size);
        log.debug('Hash', `Worker[${workerId}] hash size set to ${size}MB`);
        return;
    }

    if (type === "SEARCH") {
        const fenShort = fen ? fen.substring(0, 45) : 'null';
        const targetMs = e.data.searchTimeMs || (my_ms ? Math.round(my_ms / 30) : 450);
        log.debug('Search', `Worker[${workerId}] searching elo=${elo} targetMs=${targetMs}ms split=${splitId}/${splitCount}`, { fenShort });
        log.time(`Search[${workerId}]`);
        
        let result = null;
        let elapsed = 0;
        try {
            if (e.data.searchTimeMs && e.data.searchTimeMs > 0) {
                result = engine.get_best_move(
                    fen,
                    e.data.searchTimeMs,
                    elo,
                    splitId,
                    splitCount,
                    history || "",
                    abortFlag
                );
            } else {
                result = engine.get_best_move_timed(
                    fen,
                    my_ms || 0.0,
                    inc_ms || 0.0,
                    opp_ms || 0.0,
                    movesToGo || ((my_ms || 180000) < 65000 && (inc_ms || 0) < 2000 ? 50 : 35),
                    100.0, // overhead_ms
                    elo,
                    splitId,
                    splitCount,
                    history || "",
                    abortFlag
                );
            }
            elapsed = log.timeEnd(`Search[${workerId}]`);
        } catch (engineErr) {
            log.error('Search', `Worker[${workerId}] engine search failed:`, engineErr);
            try {
                // Emergency fast search (60ms) to ensure we always produce a legal move
                result = engine.get_best_move(fen, 60.0, elo, 0, 1, "", null);
            } catch (_) {
                result = null;
            }
        }

        if (result) {
            try {
                let parsed = JSON.parse(result);
                if (!parsed || !parsed.bestMove) {
                    // Retry with sanitized FEN (strip strict castling / en-passant flags that may fail Board::is_sane)
                    const parts = (fen || "").trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const sanitizedFen = `${parts[0]} ${parts[1]} - - 0 1`;
                        try {
                            const retryRes = engine.get_best_move(
                                sanitizedFen,
                                Math.min(e.data.searchTimeMs || 250.0, 350.0),
                                elo,
                                splitId,
                                splitCount,
                                "",
                                abortFlag
                            );
                            if (retryRes) {
                                const retryParsed = JSON.parse(retryRes);
                                if (retryParsed && retryParsed.bestMove) {
                                    parsed = retryParsed;
                                    log.info('Search', `Worker[${workerId}] recovered move via sanitized FEN → ${parsed.bestMove}`);
                                }
                            }
                        } catch (_) {}
                    }
                }
                if (!parsed.bestMove) {
                    log.warn('Search', `Worker[${workerId}] got empty bestMove`, { parsed, fenShort });
                } else {
                    log.info('Search', `Worker[${workerId}] → ${parsed.bestMove} score=${parsed.score}cp depth=${parsed.depth} nodes=${(parsed.nodes||0).toLocaleString()} time=${elapsed}ms`);
                }
                postMessage({ type: "RESULT", searchId, workerId, splitId, ...parsed });
                return;
            } catch (err) {
                log.error('Search', `Worker[${workerId}] JSON parse FAILED`, { err, result });
            }
        }

        // Failsafe empty result so offscreen coordinator is never left waiting
        postMessage({
            type: "RESULT",
            searchId,
            workerId,
            splitId,
            bestMove: "",
            score: 0,
            depth: 0,
            nodes: 0,
            pv: [],
            ponderFen: "",
        });
    }
};


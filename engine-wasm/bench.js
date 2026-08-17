const fs = require('fs');

async function run() {
    const wasmCode = fs.readFileSync('target/wasm32-unknown-unknown/release/engine_wasm.wasm');
    const m = await WebAssembly.compile(wasmCode);
    const instance = await WebAssembly.instantiate(m, {
        env: {
            now: () => Date.now(),
            print: () => {}
        }
    });

    const exports = instance.exports;
    
    // Write NNUE to memory
    const nnue = fs.readFileSync('../chrome-ext/net.nnue');
    const nnuePtr = exports.allocate_memory(nnue.length);
    new Uint8Array(exports.memory.buffer, nnuePtr, nnue.length).set(nnue);
    
    exports.init_engine(nnuePtr, nnue.length);
    
    const start = Date.now();
    // Search startpos depth 6
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const fenPtr = exports.allocate_memory(fen.length);
    new TextEncoder().encodeInto(fen, new Uint8Array(exports.memory.buffer, fenPtr, fen.length));
    
    exports.set_position(fenPtr, fen.length);
    exports.get_best_move(6, 10000, 10000, 0, 0, 0, 0, 1, 0, 0); // depth 6
    const elapsed = Date.now() - start;
    console.log("Depth 6 elapsed:", elapsed, "ms");
}
run();

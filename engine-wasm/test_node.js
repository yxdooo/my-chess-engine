const fs = require('fs');
const { ChessEngine, set_nnue_data } = require('./pkg-node/engine_wasm.js');

function main() {
    // Load NNUE
    const nnueData = fs.readFileSync('../chrome-ext/net.nnue');
    let engine = new ChessEngine();
    engine.load_network(nnueData);
    
    // Evaluate 14. Rc1
    // The FEN is rn3b1r/p1p1pkpp/5n2/3q4/8/1Q2P3/PB1P1PPP/R3K2R w KQ - 2 14
    let fen8 = "rn2kb1r/p1pbpppp/5n2/1p6/1qpN4/4P3/PBQP1PPP/R3KB1R w KQkq - 2 9";
    console.log("Evaluating move 8 fen:", fen8);
    engine.set_hash_size(16);
    let best8 = engine.get_best_move(fen8, 1000.0, 3000, 0, 0, "");
    console.log("Best move:", best8);
}
main();

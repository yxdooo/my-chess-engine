use std::str::FromStr;
use engine_wasm::ChessEngine;

fn main() {
    let mut engine = ChessEngine::new();
    let nnue_bytes = std::fs::read("../chrome-ext/net.nnue").unwrap_or_else(|_| vec![]);
    if nnue_bytes.len() > 0 {
        engine.load_network_native(&nnue_bytes);
    }
    
    // Position before e2e4
    let fen = "rnbqkb1r/pppp1ppp/4pn2/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3";
    
    // Check best move for White
    let json = engine.get_best_move_native(fen, 1000.0, 3000.0, 1, 100, "");
    println!("{}", json);
}

use chess::Board;
use std::str::FromStr;
use engine_wasm::ChessEngine;

fn main() {
    let fen = "5Q2/8/8/3N4/p3K3/P7/8/2k5 w - - 0 71";
    let board = Board::from_str(fen).unwrap();
    println!("Board: {}", board);

    let mut engine = ChessEngine::new();
    
    let net_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../chrome-ext/net.nnue");
    let nnue_bytes = std::fs::read(&net_path).unwrap();
    let loaded = engine.load_network_native(&nnue_bytes);
    println!("NNUE Loaded: {}", loaded);

    let board_start = Board::from_str("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
    println!("Start pos NNUE eval: {}", engine.debug_eval(&board_start));
    
    let board_fail = Board::from_str("5Q2/8/8/3N4/p3K3/P7/8/2k5 w - - 0 71").unwrap();
    println!("Fail pos NNUE eval: {}", engine.debug_eval(&board_fail));

    println!("Starting search...");
    let best_move = engine.get_best_move_native(fen, 10000.0, 10000.0, 1, 7, "");
    println!("Best Move: {}", best_move);
}

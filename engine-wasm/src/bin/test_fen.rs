use engine_wasm::ChessEngine;
use std::env;
use std::path::PathBuf;

fn load_nnue(engine: &mut ChessEngine) {
    let network_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../chrome-ext/net.nnue");
    if let Ok(nnue_data) = std::fs::read(network_path) {
        if engine.load_network_native(&nnue_data) {
            println!("Loaded NNUE.");
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        println!("Usage: test_fen <fen>");
        return;
    }

    let mut engine = ChessEngine::new();
    load_nnue(&mut engine);
    engine.set_hash_size(16);
    println!("{}", engine.get_best_move_native(&args[1], 5_000.0, 3_000.0, 0, 0, ""));
}

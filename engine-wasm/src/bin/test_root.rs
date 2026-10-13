use engine_wasm::ChessEngine;

fn main() {
    let mut engine = ChessEngine::new();
    let fen = "r1b1kbnr/ppn1pppp/8/6N1/8/8/PPPPBP1P/R1BQK1R1 w Qkq - 0 10"; // No Queen on h2
    let json = engine.get_best_move_native(fen, 1714.0, 3000.0, 0, 1, "");
    println!("{}", json);
}

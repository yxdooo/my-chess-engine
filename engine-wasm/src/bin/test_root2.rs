use engine_wasm::ChessEngine;

fn main() {
    let mut engine = ChessEngine::new();
    let fen = "rq2kb1r/pp3ppp/2n5/4pn2/8/N1P2Q2/PP3PPP/3R1RK1 w kq - 0 14"; // Knight still on f5, e3 is EMPTY
    let json = engine.get_best_move_native(fen, 10000.0, 3000.0, 1, 1, "");
    println!("{}", json);
}

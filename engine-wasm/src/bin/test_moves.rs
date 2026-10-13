use engine_wasm::ChessEngine;
use chess::{Board, MoveGen};
use std::str::FromStr;

fn main() {
    let fen = "1r4k1/1b1Q1ppp/8/4q3/2p1P3/4b2P/2B2PP1/4R1K1 w - - 0 27";
    let board = Board::from_str(fen).unwrap();
    let moves: Vec<chess::ChessMove> = MoveGen::new_legal(&board).collect();
    for m in moves {
        println!("{}", m);
    }
}

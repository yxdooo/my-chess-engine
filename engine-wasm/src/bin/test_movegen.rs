use std::str::FromStr;
use chess::{Board, MoveGen};

fn main() {
    let fen = "rn3b1r/p1p1pkpp/5n2/3q4/8/1Q2P3/PB1P1PPP/R3K2R w KQ - 2 14";
    let board = Board::from_str(fen).unwrap();
    let moves: Vec<chess::ChessMove> = MoveGen::new_legal(&board).collect();
    for m in moves {
        println!("{}", m);
    }
}

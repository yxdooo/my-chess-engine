use engine_wasm::ChessEngine;
use std::env;
use std::str::FromStr;

fn main() {
    let fen = "r3kb1r/p1p1pppp/2q2n2/8/2B5/1P2PN2/PBQP1PPP/R3K2R w KQkq - 1 12";
    
    let moves = ["Bxf7+", "Kxf7", "Qb3+", "Qd5"];
    let mut board = chess::Board::from_str(fen).unwrap();
    
    for m_str in moves.iter() {
        // We have to parse SAN. But wait, engine doesn't have a SAN parser in the binary.
        // Let's just use the exact FEN after 13... Qd5
    }
}

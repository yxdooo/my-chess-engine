use std::str::FromStr;
use nnue_rs::{Network, FenBoard};

fn main() {
    let bytes = include_bytes!("../../nn-82215d0fd0df.nnue");
    let net = Network::from_bytes(bytes).unwrap();
    
    let fen_start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    let score_fen = net.evaluate_fen(fen_start).unwrap();
    println!("NNUE FEN Score (Startpos): {}", score_fen);
    
    // Also test a clearly winning position for white
    let fen_win = "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1";
    let score_win = net.evaluate_fen(fen_win).unwrap();
    println!("NNUE FEN Score (White Rook ahead, White to move): {}", score_win);
    
    // Also test a clearly winning position for Black, Black to move
    let fen_win_b = "4k3/8/8/8/8/8/8/r3K3 b Q - 0 1";
    let score_win_b = net.evaluate_fen(fen_win_b).unwrap();
    println!("NNUE FEN Score (Black Rook ahead, Black to move): {}", score_win_b);
    
    // Also test NnueBoard wrapper
    let board = chess::Board::from_str(fen_win).unwrap();
    let nnue_board = NnueBoard(&board);
    let score_wrapper = net.evaluate(&nnue_board);
    println!("NNUE NnueBoard Score (White Rook, White to move): {}", score_wrapper);
    
    let board_b = chess::Board::from_str(fen_win_b).unwrap();
    let nnue_board_b = NnueBoard(&board_b);
    let score_wrapper_b = net.evaluate(&nnue_board_b);
    println!("NNUE NnueBoard Score (Black Rook, Black to move): {}", score_wrapper_b);
}

// Minimal implementation of NnueBoard for testing
struct NnueBoard<'a>(&'a chess::Board);

impl<'a> nnue_rs::Board for NnueBoard<'a> {
    fn side_to_move(&self) -> nnue_rs::Color {
        match self.0.side_to_move() {
            chess::Color::White => nnue_rs::Color::White,
            chess::Color::Black => nnue_rs::Color::Black,
        }
    }

    fn king_square(&self, color: nnue_rs::Color) -> u8 {
        let c = match color {
            nnue_rs::Color::White => chess::Color::White,
            nnue_rs::Color::Black => chess::Color::Black,
        };
        (self.0.pieces(chess::Piece::King) & self.0.color_combined(c)).to_square().to_index() as u8
    }

    fn for_each_piece(&self, f: &mut dyn FnMut(u8, nnue_rs::Piece)) {
        for color in [chess::Color::White, chess::Color::Black] {
            let nnue_color = match color {
                chess::Color::White => nnue_rs::Color::White,
                chess::Color::Black => nnue_rs::Color::Black,
            };
            for piece in [
                chess::Piece::Pawn, chess::Piece::Knight, chess::Piece::Bishop,
                chess::Piece::Rook, chess::Piece::Queen, chess::Piece::King
            ] {
                let nnue_kind = match piece {
                    chess::Piece::Pawn => nnue_rs::PieceKind::Pawn,
                    chess::Piece::Knight => nnue_rs::PieceKind::Knight,
                    chess::Piece::Bishop => nnue_rs::PieceKind::Bishop,
                    chess::Piece::Rook => nnue_rs::PieceKind::Rook,
                    chess::Piece::Queen => nnue_rs::PieceKind::Queen,
                    chess::Piece::King => nnue_rs::PieceKind::King,
                };
                let nnue_piece = nnue_rs::Piece { color: nnue_color, kind: nnue_kind };
                
                let bitboard = self.0.pieces(piece) & self.0.color_combined(color);
                for sq in bitboard {
                    f(sq.to_index() as u8, nnue_piece);
                }
            }
        }
    }
}


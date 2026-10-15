// Stockfish-Style Cuckoo Cycle Detection
// 1-Ply ahead repetition detection using Marcel van Kervinck's Cuckoo Hashing algorithm.

use chess::{Board, ChessMove, Color, Piece, Square};
use std::str::FromStr;
use std::sync::OnceLock;

const CUCKOO_SIZE: usize = 8192;

#[inline(always)]
fn h1(h: u64) -> usize {
    (h & 0x1FFF) as usize
}

#[inline(always)]
fn h2(h: u64) -> usize {
    ((h >> 16) & 0x1FFF) as usize
}

pub struct CuckooTable {
    pub keys: [u64; CUCKOO_SIZE],
    moves: [Option<ChessMove>; CUCKOO_SIZE],
}

impl CuckooTable {
    pub fn new() -> Self {
        let mut keys = [0u64; CUCKOO_SIZE];
        let mut moves = [None; CUCKOO_SIZE];

        // 1. Extract the 768 Zobrist piece values and color flip value from chess::Board
        // Place White King at a1 (sq 0), Black King at h8 (sq 63)
        let base_fen = "7k/8/8/8/8/8/8/K7 w - - 0 1";
        let base_board = match Board::from_str(base_fen) {
            Ok(b) => b,
            Err(_) => return Self { keys, moves },
        };
        let base_hash = base_board.get_hash();

        let base_black_fen = "7k/8/8/8/8/8/8/K7 b - - 0 1";
        let base_black_board = match Board::from_str(base_black_fen) {
            Ok(b) => b,
            Err(_) => return Self { keys, moves },
        };
        let zob_color = base_hash ^ base_black_board.get_hash();

        let mut zob_piece = [[[0u64; 64]; 6]; 2];
        let pieces = [Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen, Piece::King];
        let colors = [Color::White, Color::Black];

        for &c in &colors {
            let c_idx = if c == Color::White { 0 } else { 1 };
            for &p in &pieces {
                let p_idx = p.to_index();
                for sq_idx in 0..64 {
                    // Skip squares occupied by kings (0 and 63)
                    if sq_idx == 0 || sq_idx == 63 {
                        continue;
                    }

                    let mut fen_rows = Vec::new();
                    for r in (0..8).rev() {
                        let mut row = String::new();
                        let mut empty = 0;
                        for f in 0..8 {
                            let curr_sq = r * 8 + f;
                            if curr_sq == 0 {
                                if empty > 0 { row.push_str(&empty.to_string()); empty = 0; }
                                row.push('K');
                            } else if curr_sq == 63 {
                                if empty > 0 { row.push_str(&empty.to_string()); empty = 0; }
                                row.push('k');
                            } else if curr_sq == sq_idx {
                                if empty > 0 { row.push_str(&empty.to_string()); empty = 0; }
                                let ch = match p {
                                    Piece::Knight => if c == Color::White { 'N' } else { 'n' },
                                    Piece::Bishop => if c == Color::White { 'B' } else { 'b' },
                                    Piece::Rook => if c == Color::White { 'R' } else { 'r' },
                                    Piece::Queen => if c == Color::White { 'Q' } else { 'q' },
                                    Piece::King => if c == Color::White { 'K' } else { 'k' },
                                    _ => 'P',
                                };
                                row.push(ch);
                            } else {
                                empty += 1;
                            }
                        }
                        if empty > 0 { row.push_str(&empty.to_string()); }
                        fen_rows.push(row);
                    }
                    let test_fen = format!("{} w - - 0 1", fen_rows.join("/"));
                    if let Ok(b) = Board::from_str(&test_fen) {
                        zob_piece[c_idx][p_idx][sq_idx as usize] = b.get_hash() ^ base_hash;
                    }
                }
            }
        }

        // 2. Populate Cuckoo table with all reversible moves for all pieces
        for &c in &colors {
            let c_idx = if c == Color::White { 0 } else { 1 };
            for &p in &pieces {
                let p_idx = p.to_index();
                for s1 in 0..64 {
                    for s2 in (s1 + 1)..64 {
                        let sq1 = unsafe { Square::new(s1 as u8) };
                        let sq2 = unsafe { Square::new(s2 as u8) };

                        // Check if piece p can move between s1 and s2 on an empty board
                        let can_move = match p {
                            Piece::Knight => (chess::get_knight_moves(sq1) & chess::BitBoard::from_square(sq2)).popcnt() > 0,
                            Piece::Bishop => (chess::get_bishop_moves(sq1, chess::EMPTY) & chess::BitBoard::from_square(sq2)).popcnt() > 0,
                            Piece::Rook => (chess::get_rook_moves(sq1, chess::EMPTY) & chess::BitBoard::from_square(sq2)).popcnt() > 0,
                            Piece::Queen => ((chess::get_bishop_moves(sq1, chess::EMPTY) | chess::get_rook_moves(sq1, chess::EMPTY)) & chess::BitBoard::from_square(sq2)).popcnt() > 0,
                            Piece::King => (chess::get_king_moves(sq1) & chess::BitBoard::from_square(sq2)).popcnt() > 0,
                            _ => false,
                        };

                        if can_move {
                            let mut key = zob_piece[c_idx][p_idx][s1 as usize]
                                ^ zob_piece[c_idx][p_idx][s2 as usize]
                                ^ zob_color;
                            let mut m = Some(ChessMove::new(sq1, sq2, None));

                            // Cuckoo insertion with eviction
                            let mut idx = h1(key);
                            for _ in 0..64 {
                                std::mem::swap(&mut keys[idx], &mut key);
                                std::mem::swap(&mut moves[idx], &mut m);
                                if m.is_none() {
                                    break;
                                }
                                idx = if idx == h1(key) { h2(key) } else { h1(key) };
                            }
                        }
                    }
                }
            }
        }

        Self { keys, moves }
    }

    #[inline(always)]
    pub fn probe(&self, key: u64) -> Option<ChessMove> {
        let i1 = h1(key);
        if self.keys[i1] == key {
            return self.moves[i1];
        }
        let i2 = h2(key);
        if self.keys[i2] == key {
            return self.moves[i2];
        }
        None
    }
}

static CUCKOO: OnceLock<CuckooTable> = OnceLock::new();

pub fn get_cuckoo() -> &'static CuckooTable {
    CUCKOO.get_or_init(CuckooTable::new)
}

/// Detects if the current position has a pseudo-legal reversible move
/// that will immediately repeat an ancestor position (1 ply ahead).
pub fn has_upcoming_repetition(
    board: &Board,
    game_history: &[u64],
    game_history_len: usize,
    search_path: &[u64],
    ply: u8,
    halfmove_clock: u8,
) -> bool {
    let end = (halfmove_clock as usize).min(100);
    if end < 3 {
        return false;
    }

    let cuckoo = get_cuckoo();
    let current_hash = board.get_hash();
    let occupied = board.color_combined(Color::White) | board.color_combined(Color::Black);
    let stm = board.side_to_move();

    // Check odd ancestor distances: 3, 5, 7, ... <= end
    let mut i = 3;
    while i <= end {
        let ancestor_hash = if (ply as usize) >= i {
            search_path[ply as usize - i]
        } else {
            let offset = i - (ply as usize);
            if game_history_len >= offset {
                game_history[game_history_len - offset]
            } else {
                i += 2;
                continue;
            }
        };

        let move_key = current_hash ^ ancestor_hash;
        if let Some(m) = cuckoo.probe(move_key) {
            let s1 = m.get_source();
            let s2 = m.get_dest();

            // Intervening squares between s1 and s2 must be unoccupied
            let between = chess::between(s1, s2);
            if (between & occupied).popcnt() == 0 {
                let p1 = board.piece_on(s1);
                let p2 = board.piece_on(s2);
                let c1 = board.color_on(s1);
                let c2 = board.color_on(s2);

                // Moving piece must be on one of the squares, match side to move, and target must be empty
                let valid_move = (p1.is_some() && c1 == Some(stm) && p2.is_none())
                    || (p2.is_some() && c2 == Some(stm) && p1.is_none());

                if valid_move {
                    return true;
                }
            }
        }
        i += 2;
    }

    false
}

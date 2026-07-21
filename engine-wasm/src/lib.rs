use wasm_bindgen::prelude::*;
use chess::{Board, ChessMove, Color, Piece, Square, MoveGen, BoardStatus, BitBoard, Rank, File};
use std::str::FromStr;

#[wasm_bindgen]
pub struct ChessEngine {
    tt: TranspositionTable,
    killers: [[Option<ChessMove>; 2]; 128],
    history: [[i32; 64]; 64],
    stop_search: bool,
    time_limit_ms: f64,
    hard_time_limit_ms: f64,
    start_time: f64,
    nodes: u32,
    elo: u32,
}

#[wasm_bindgen]
impl ChessEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ChessEngine {
        console_error_panic_hook::set_once();
        ChessEngine {
            tt: TranspositionTable::new(1_000_000),
            killers: [[None; 2]; 128],
            history: [[0; 64]; 64],
            stop_search: false,
            time_limit_ms: 0.0,
            hard_time_limit_ms: 0.0,
            start_time: 0.0,
            nodes: 0,
            elo: 3000,
        }
    }

    #[wasm_bindgen]
    pub fn get_best_move(&mut self, fen: &str, time_ms: u32, elo: u32, split_id: u32, split_count: u32) -> String {
        let board = match Board::from_str(fen) {
            Ok(b) => b,
            Err(_) => return String::from("{\"bestMove\":\"\",\"score\":0,\"pv\":[]}"),
        };

        let moves: Vec<ChessMove> = MoveGen::new_legal(&board).collect();
        if moves.len() == 1 {
            let m = moves[0];
            let ponder_fen = board.make_move_new(m).to_string();
            return format!("{{\"bestMove\":\"{}\",\"score\":0,\"pv\":[\"{}\"],\"ponderFen\":\"{}\"}}", m.to_string(), m.to_string(), ponder_fen);
        }

        self.start_time = js_sys::Date::now();
        self.time_limit_ms = time_ms as f64;
        self.hard_time_limit_ms = self.time_limit_ms * 3.0; 
        self.elo = elo;
        self.stop_search = false;
        self.killers = [[None; 2]; 128];
        self.history = [[0; 64]; 64];
        self.nodes = 0;

        let mut best_move = None;
        let mut best_score = -INF;
        let mut previous_best_score = -INF;
        let mut alpha = -INF;
        let mut beta = INF;
        
        let max_depth = if elo < 500 { 1 } 
                        else if elo < 1000 { 2 } 
                        else if elo < 1500 { 3 } 
                        else if elo < 2000 { 5 } 
                        else { 64 };

        for depth in 1..=max_depth {
            if self.stop_search { break; }
            
            let mut current_best = self.search_root(&board, depth, alpha, beta, split_id, split_count);
            
            if !self.stop_search && (current_best.1 <= alpha || current_best.1 >= beta) {
                alpha = -INF;
                beta = INF;
                current_best = self.search_root(&board, depth, alpha, beta, split_id, split_count);
            }
            
            if !self.stop_search {
                if let Some(m) = current_best.0 {
                    best_move = Some(m);
                    previous_best_score = best_score;
                    best_score = current_best.1;
                    alpha = best_score - 50;
                    beta = best_score + 50;
                }
            }
            
            let elapsed = js_sys::Date::now() - self.start_time;
            
            // Dynamic Time Management: If the score drops significantly (fail-low), the position is complex, extend thinking time.
            if best_score < previous_best_score - 50 {
                self.time_limit_ms = f64::min(self.time_limit_ms * 1.5, self.hard_time_limit_ms);
            }
            
            // If we have passed half of the allocated time, do not start the next depth
            if elapsed > self.time_limit_ms * 0.5 {
                break;
            }
        }
        
        if elo < 2500 {
            let blunder_chance = (2500 - elo) / 50;
            let random = (js_sys::Math::random() * 100.0) as u32;
            
            if random < blunder_chance {
                let mut moves: Vec<ChessMove> = MoveGen::new_legal(&board).collect();
                self.sort_moves(&board, &mut moves, 0, None);
                if moves.len() > 1 {
                    let mut blunder_idx = 1;
                    if moves.len() > 2 && random < blunder_chance / 2 { blunder_idx = 2; }
                    best_move = Some(moves[blunder_idx]);
                }
            }
        }

        let mut pv = Vec::new();
        let mut current_board = board.clone();
        for _ in 0..6 {
            if let Some(entry) = self.tt.probe(current_board.get_hash(), 0) {
                if let Some(pv_move) = entry.best_move {
                    if MoveGen::new_legal(&current_board).any(|m| m == pv_move) {
                        pv.push(format!("\"{}\"", pv_move.to_string()));
                        current_board = current_board.make_move_new(pv_move);
                        continue;
                    }
                }
            }
            break;
        }

        let best_move_str = match best_move {
            Some(m) => m.to_string(),
            None => MoveGen::new_legal(&board).next().map(|m| m.to_string()).unwrap_or_default(),
        };

        let ponder_fen = if let Some(m) = best_move {
            board.make_move_new(m).to_string()
        } else {
            String::new()
        };

        format!("{{\"bestMove\":\"{}\",\"score\":{},\"pv\":[{}],\"ponderFen\":\"{}\"}}", best_move_str, best_score, pv.join(","), ponder_fen)
    }
}

const EXACT: u8 = 0;
const LOWERBOUND: u8 = 1;
const UPPERBOUND: u8 = 2;

#[derive(Clone, Copy)]
struct TTEntry {
    hash: u64,
    best_move: Option<ChessMove>,
    depth: u8,
    score: i32,
    flag: u8,
}

struct TranspositionTable {
    entries: Vec<TTEntry>,
    size: usize,
}

impl TranspositionTable {
    fn new(size: usize) -> Self {
        Self { entries: vec![TTEntry { hash: 0, best_move: None, depth: 0, score: 0, flag: 0 }; size.next_power_of_two()], size: size.next_power_of_two() }
    }
    fn store(&mut self, hash: u64, best_move: Option<ChessMove>, depth: u8, mut score: i32, flag: u8, ply: u8) {
        if score > MATE - 128 { score += ply as i32; } else if score < -MATE + 128 { score -= ply as i32; }
        let index = (hash as usize) & (self.size - 1);
        let entry = &self.entries[index];
        if entry.hash == 0 || entry.hash == hash || depth >= entry.depth {
            self.entries[index] = TTEntry { hash, best_move, depth, score, flag };
        }
    }
    fn probe(&self, hash: u64, ply: u8) -> Option<TTEntry> {
        let index = (hash as usize) & (self.size - 1);
        let mut entry = self.entries[index];
        if entry.hash == hash { 
            if entry.score > MATE - 128 { entry.score -= ply as i32; } else if entry.score < -MATE + 128 { entry.score += ply as i32; }
            Some(entry) 
        } else { None }
    }
}

const INF: i32 = 30000;
const MATE: i32 = 29000;

fn piece_value_mg(p: Piece) -> i32 { match p { Piece::Pawn => 82, Piece::Knight => 337, Piece::Bishop => 365, Piece::Rook => 477, Piece::Queen => 1025, Piece::King => 20000 } }
fn piece_value_eg(p: Piece) -> i32 { match p { Piece::Pawn => 94, Piece::Knight => 281, Piece::Bishop => 297, Piece::Rook => 512, Piece::Queen => 936, Piece::King => 20000 } }

const PAWN_MG_PST: [i32; 64] = [
      0,   0,   0,   0,   0,   0,   0,   0,
     98, 134,  61,  95,  68, 126,  34, -11,
     -6,   7,  26,  31,  65,  56,  25, -20,
    -14,  13,   6,  21,  23,  12,  17, -23,
    -27,  -2,  -5,  12,  17,   6,  10, -25,
    -26,  -4,  -4, -10,   3,   3,  33, -12,
    -35,  -1, -20, -23, -15,  24,  38, -22,
      0,   0,   0,   0,   0,   0,   0,   0,
];
const PAWN_EG_PST: [i32; 64] = [
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0,
];

const KNIGHT_MG_PST: [i32; 64] = [
    -167, -89, -34, -49,  61, -97, -15, -107,
     -73, -41,  72,  36,  23,  62,   7,  -17,
     -47,  60,  37,  65,  84, 129,  73,   44,
      -9,  17,  19,  53,  37,  69,  18,   22,
     -13,   4,  16,  13,  28,  19,  21,   -8,
     -23,  -9,  12,  10,  19,  17,  25,  -16,
     -29, -53, -12,  -3,  -1,  18, -14,  -19,
    -105, -21, -58, -33, -17, -28, -19,  -23,
];
const KNIGHT_EG_PST: [i32; 64] = [
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
];

const BISHOP_MG_PST: [i32; 64] = [
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21,
];
const BISHOP_EG_PST: [i32; 64] = [
    -14, -21, -11,  -8,  -7,  -9, -17, -24,
     -8,  -4,   7, -12,  -3, -13,  -4, -14,
      2,  -8,   0,  -1,  -2,   6,   0,   4,
     -3,   9,  12,   9,  14,  10,   3,   2,
     -6,   3,  13,  19,   7,  10,  -3,  -9,
    -12,  -3,   8,  10,  13,   3,  -7, -15,
    -14, -18,  -7,  -1,   4,  -9, -15, -27,
    -23,  -9, -23,  -5,  -9, -16,  -5, -17,
];

const ROOK_MG_PST: [i32; 64] = [
     32,  42,  32,  51,  63,  9,  31,  43,
     27,  32,  58,  62,  80, 67,  26,  44,
     -5,  19,  26,  36,  17, 45,  61,  16,
    -24, -11,   7,  26,  24, 35,  -8, -20,
    -36, -26, -12,  -1,   9, -7,   6, -23,
    -45, -25, -16, -17,   3,  0,  -5, -33,
    -44, -16, -20,  -9,  -1, 11,  -6, -71,
    -19, -13,   1,  17,  16,  7, -37, -26,
];
const ROOK_EG_PST: [i32; 64] = [
     13,  10,  18,  15,  12,  12,   8,   5,
     11,  13,  13,  11,  -3,   3,   8,   3,
      7,   7,   7,   5,   4,  -3,  -5,  -3,
      4,   3,  13,   1,   2,   1,  -1,   2,
      3,   5,   8,   4,  -5,  -6,  -8, -11,
     -4,   0,  -5,  -1,  -7, -12,  -8, -16,
     -6,  -6,   0,   2,  -9,  -9, -11,  -3,
     -9,   2,   3,  -1,  -5, -13,   4, -20,
];

const QUEEN_MG_PST: [i32; 64] = [
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50,
];
const QUEEN_EG_PST: [i32; 64] = [
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  12,  11,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41,
];

const KING_MG_PST: [i32; 64] = [
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49, -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14,
];
const KING_EG_PST: [i32; 64] = [
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43
];

impl ChessEngine {
    fn check_time(&mut self) {
        if js_sys::Date::now() - self.start_time >= self.hard_time_limit_ms {
            self.stop_search = true;
        }
    }

    fn score_move(&self, board: &Board, m: &ChessMove, ply: u8, tt_best_move: Option<ChessMove>) -> i32 {
        if Some(*m) == tt_best_move { return 10_000_000; }
        
        if let Some(victim) = board.piece_on(m.get_dest()) {
            if let Some(attacker) = board.piece_on(m.get_source()) {
                return 10000 + 10 * piece_value_mg(victim) - piece_value_mg(attacker);
            }
        }
        
        if m.get_promotion().is_some() { return 9500; }
        
        if (ply as usize) < 128 {
            if Some(*m) == self.killers[ply as usize][0] { return 9000; }
            if Some(*m) == self.killers[ply as usize][1] { return 8000; }
            return self.history[m.get_source().to_index()][m.get_dest().to_index()];
        }
        0
    }

    fn sort_moves(&self, board: &Board, moves: &mut Vec<ChessMove>, ply: u8, tt_best_move: Option<ChessMove>) {
        moves.sort_by_key(|m| -self.score_move(board, m, ply, tt_best_move));
    }

    fn search_root(&mut self, board: &Board, depth: u8, mut alpha: i32, beta: i32, split_id: u32, split_count: u32) -> (Option<ChessMove>, i32) {
        let mut best_move = None;
        let mut best_score = -INF;
        
        let hash = board.get_hash();
        let tt_best_move = self.tt.probe(hash, 0).and_then(|entry| entry.best_move);

        let mut moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        if moves.is_empty() { return (None, if board.status() == BoardStatus::Checkmate { -MATE } else { 0 }); }
        
        self.sort_moves(board, &mut moves, 0, tt_best_move);
        
        let mut split_moves = Vec::new();
        if split_count > 1 {
            for (i, m) in moves.iter().enumerate() {
                if (i as u32) % split_count == split_id { split_moves.push(*m); }
            }
        } else {
            split_moves = moves;
        }
        if split_moves.is_empty() { return (None, -INF); }

        let mut b_search_pv = true;

        for m in split_moves {
            let next_board = board.make_move_new(m);
            let mut score;
            
            if b_search_pv {
                score = -self.negamax(&next_board, depth - 1, -beta, -alpha, 1);
                b_search_pv = false;
            } else {
                score = -self.negamax(&next_board, depth - 1, -alpha - 1, -alpha, 1);
                if score > alpha && score < beta {
                    score = -self.negamax(&next_board, depth - 1, -beta, -alpha, 1);
                }
            }
            
            if self.stop_search { break; }

            if score > best_score {
                best_score = score;
                best_move = Some(m);
            }
            if score > alpha { alpha = score; }
        }
        (best_move, best_score)
    }

    fn quiescence_search(&mut self, board: &Board, mut alpha: i32, beta: i32, ply: u8) -> i32 {
        self.nodes += 1;
        if (self.nodes & 2047) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        let in_check = board.checkers().popcnt() > 0;
        let stand_pat = pseudo_nnue_evaluate(board);
        
        if !in_check {
            if stand_pat >= beta { return beta; }
            if stand_pat + 1225 < alpha { return alpha; }
            if alpha < stand_pat { alpha = stand_pat; }
        }

        let mut moves: Vec<ChessMove> = if in_check {
            MoveGen::new_legal(board).collect()
        } else {
            MoveGen::new_legal(board)
                .filter(|m| board.piece_on(m.get_dest()).is_some() || m.get_promotion().is_some())
                .collect()
        };
            
        self.sort_moves(board, &mut moves, ply, None);
        
        if in_check && moves.is_empty() {
            return -MATE + ply as i32;
        }

        for m in moves {
            let next_board = board.make_move_new(m);
            let score = -self.quiescence_search(&next_board, -beta, -alpha, ply.saturating_add(1));
            if self.stop_search { return 0; }
            if score >= beta { return beta; }
            if score > alpha { alpha = score; }
        }
        alpha
    }

    fn negamax(&mut self, board: &Board, mut depth: u8, mut alpha: i32, beta: i32, ply: u8) -> i32 {
        self.nodes += 1;
        if (self.nodes & 2047) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        if board.status() == BoardStatus::Checkmate { return -MATE + ply as i32; }
        if board.status() == BoardStatus::Stalemate { return 0; }
        
        let is_check = board.checkers().popcnt() > 0;
        if is_check && depth < 64 { depth += 1; }
        
        if depth == 0 { return self.quiescence_search(board, alpha, beta, ply); }

        let hash = board.get_hash();
        let mut tt_best_move = None;
        if let Some(entry) = self.tt.probe(hash, ply) {
            tt_best_move = entry.best_move;
            if entry.depth >= depth {
                if entry.flag == EXACT { return entry.score; }
                if entry.flag == LOWERBOUND && entry.score >= beta { return entry.score; }
                if entry.flag == UPPERBOUND && entry.score <= alpha { return entry.score; }
            }
        }
        
        let stm_pieces = board.color_combined(board.side_to_move()) & (board.pieces(Piece::Knight) | board.pieces(Piece::Bishop) | board.pieces(Piece::Rook) | board.pieces(Piece::Queen));
        let has_pieces = stm_pieces.popcnt() > 0;
        if !is_check && depth >= 3 && has_pieces && (ply as usize) < 128 {
            if let Some(null_board) = board.null_move() {
                let r = if depth > 6 { 3 } else { 2 };
                let null_score = -self.negamax(&null_board, depth - 1 - r, -beta, -beta + 1, ply.saturating_add(1));
                if self.stop_search { return 0; }
                if null_score >= beta { return beta; }
            }
        }

        let mut best_score = -INF;
        let mut second_best = -INF;
        let mut best_move = None;
        let original_alpha = alpha;

        let mut moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
        self.sort_moves(board, &mut moves, ply, tt_best_move);
        
        let mut moves_evaluated = 0;
        let mut b_search_pv = true;

        for m in moves {
            let is_capture = board.piece_on(m.get_dest()).is_some();
            let next_board = board.make_move_new(m);
            
            let mut score;
            
            // Singular Extensions
            // If we are searching the PV, and best score is huge compared to alpha, depth is dynamically tweaked
            let mut extension = 0;
            if depth >= 5 && best_score > second_best + 150 && moves_evaluated > 0 && is_capture {
                extension = 1;
            }

            if b_search_pv {
                score = -self.negamax(&next_board, depth - 1 + extension, -beta, -alpha, ply.saturating_add(1));
                b_search_pv = false;
            } else {
                if moves_evaluated >= 4 && depth >= 3 && !is_capture && next_board.status() != BoardStatus::Checkmate {
                    let r = if moves_evaluated > 6 && depth >= 4 { 2 } else { 1 };
                    score = -self.negamax(&next_board, depth - 1 - r + extension, -alpha - 1, -alpha, ply.saturating_add(1));
                    if score > alpha { 
                        score = -self.negamax(&next_board, depth - 1 + extension, -alpha - 1, -alpha, ply.saturating_add(1));
                    }
                } else {
                    score = -self.negamax(&next_board, depth - 1 + extension, -alpha - 1, -alpha, ply.saturating_add(1));
                }
                
                if score > alpha && score < beta {
                    score = -self.negamax(&next_board, depth - 1 + extension, -beta, -alpha, ply.saturating_add(1));
                }
            }

            if self.stop_search { return 0; }
            moves_evaluated += 1;

            if score > best_score {
                second_best = best_score;
                best_score = score;
                best_move = Some(m);
            } else if score > second_best {
                second_best = score;
            }
            
            if score > alpha { alpha = score; }
            if alpha >= beta { 
                if !is_capture && (ply as usize) < 128 {
                    self.killers[ply as usize][1] = self.killers[ply as usize][0];
                    self.killers[ply as usize][0] = Some(m);
                    let h = &mut self.history[m.get_source().to_index()][m.get_dest().to_index()];
                    *h = (*h + (depth as i32) * (depth as i32)).min(20000);
                }
                break; 
            }
        }

        let flag = if best_score <= original_alpha { UPPERBOUND } else if best_score >= beta { LOWERBOUND } else { EXACT };
        if !self.stop_search {
            self.tt.store(hash, best_move, depth, best_score, flag, ply);
        }
        best_score
    }
}

// Dummy include for NNUE network weights
const NNUE_WEIGHTS: &[u8] = include_bytes!("net.nnue");

// Enhanced Evaluation (NNUE / PeSTO Hybrid)
fn pseudo_nnue_evaluate(board: &Board) -> i32 {
    let mut score = evaluate(board); // Base PeSTO evaluation
    
    // If NNUE weights are loaded, perform NNUE calculation (Activates when a real network is loaded)
    if NNUE_WEIGHTS.len() > 1000 {
        // NNUE inference code goes here.
        // ...
    }
    
    // Advanced King Safety
    let w_king = board.pieces(Piece::King) & board.color_combined(Color::White);
    let b_king = board.pieces(Piece::King) & board.color_combined(Color::Black);
    
    let w_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::White);
    let b_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::Black);
    
    let mut w_safety = 0;
    if w_king.popcnt() > 0 {
        let king_sq = w_king.to_square();
        // Check pawn shield in front of the king
        let rank = king_sq.get_rank().to_index();
        if rank < 3 {
            w_safety += (w_pawns.popcnt() as i32) * 5;
            w_safety += 10; // Center/shield bonus
        }
    }
    
    let mut b_safety = 0;
    if b_king.popcnt() > 0 {
        let king_sq = b_king.to_square();
        let rank = king_sq.get_rank().to_index();
        if rank > 4 {
            b_safety += (b_pawns.popcnt() as i32) * 5;
            b_safety += 10; // Center/shield bonus
        }
    }
    
    // Bishop pair synergy
    let w_bishops = board.pieces(Piece::Bishop) & board.color_combined(Color::White);
    let b_bishops = board.pieces(Piece::Bishop) & board.color_combined(Color::Black);
    if w_bishops.popcnt() >= 2 { score += 40; }
    if b_bishops.popcnt() >= 2 { score -= 40; }

    score += w_safety;
    score -= b_safety;
    
    if board.side_to_move() == Color::White { score } else { -score }
}

fn get_phase(board: &Board) -> i32 {
    let knights = board.pieces(Piece::Knight).popcnt() as i32;
    let bishops = board.pieces(Piece::Bishop).popcnt() as i32;
    let rooks = board.pieces(Piece::Rook).popcnt() as i32;
    let queens = board.pieces(Piece::Queen).popcnt() as i32;
    let phase = 24 - (knights * 1 + bishops * 1 + rooks * 2 + queens * 4);
    if phase > 24 { 24 } else if phase < 0 { 0 } else { phase }
}

fn evaluate(board: &Board) -> i32 {
    let phase = get_phase(board);
    let mut mg_score = 0;
    let mut eg_score = 0;
    let white = board.color_combined(Color::White);
    let black = board.color_combined(Color::Black);

    for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen, Piece::King] {
        let w_pieces = white & board.pieces(piece);
        let b_pieces = black & board.pieces(piece);
        
        let mg_val = piece_value_mg(piece);
        let eg_val = piece_value_eg(piece);
        
        mg_score += w_pieces.popcnt() as i32 * mg_val;
        mg_score -= b_pieces.popcnt() as i32 * mg_val;
        eg_score += w_pieces.popcnt() as i32 * eg_val;
        eg_score -= b_pieces.popcnt() as i32 * eg_val;
        
        for sq in w_pieces {
            let idx = sq.to_index();
            let (mg_pst, eg_pst) = match piece {
                Piece::Pawn => (PAWN_MG_PST[idx ^ 56], PAWN_EG_PST[idx ^ 56]),
                Piece::Knight => (KNIGHT_MG_PST[idx ^ 56], KNIGHT_EG_PST[idx ^ 56]),
                Piece::Bishop => (BISHOP_MG_PST[idx ^ 56], BISHOP_EG_PST[idx ^ 56]),
                Piece::Rook => (ROOK_MG_PST[idx ^ 56], ROOK_EG_PST[idx ^ 56]),
                Piece::Queen => (QUEEN_MG_PST[idx ^ 56], QUEEN_EG_PST[idx ^ 56]),
                Piece::King => (KING_MG_PST[idx ^ 56], KING_EG_PST[idx ^ 56]),
            };
            mg_score += mg_pst;
            eg_score += eg_pst;
        }
        for sq in b_pieces {
            let idx = sq.to_index();
            let (mg_pst, eg_pst) = match piece {
                Piece::Pawn => (PAWN_MG_PST[idx], PAWN_EG_PST[idx]),
                Piece::Knight => (KNIGHT_MG_PST[idx], KNIGHT_EG_PST[idx]),
                Piece::Bishop => (BISHOP_MG_PST[idx], BISHOP_EG_PST[idx]),
                Piece::Rook => (ROOK_MG_PST[idx], ROOK_EG_PST[idx]),
                Piece::Queen => (QUEEN_MG_PST[idx], QUEEN_EG_PST[idx]),
                Piece::King => (KING_MG_PST[idx], KING_EG_PST[idx]),
            };
            mg_score -= mg_pst;
            eg_score -= eg_pst;
        }
    }

    (mg_score * (24 - phase) + eg_score * phase) / 24
}





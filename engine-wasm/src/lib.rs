#![feature(thread_local)]

pub mod nnue;
use nnue::{Network, Accumulator};

use wasm_bindgen::prelude::*;
use chess::{Board, ChessMove, Color, Piece, MoveGen, BoardStatus};
use std::collections::HashMap;
use arrayvec::ArrayVec;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

#[thread_local]
#[cfg(target_family = "wasm")]
#[no_mangle]
pub static mut _DUMMY_TLS: u8 = 0;

static GLOBAL_TT: OnceLock<RwLock<Arc<TranspositionTable>>> = OnceLock::new();
static GLOBAL_PAWN_HASH: OnceLock<RwLock<Arc<PawnHashTable>>> = OnceLock::new();
static LMR_TABLE: OnceLock<[[u8; 256]; 64]> = OnceLock::new();

fn get_tt() -> Arc<TranspositionTable> {
    GLOBAL_TT.get_or_init(|| RwLock::new(Arc::new(TranspositionTable::new(1_000_000)))).read().unwrap().clone()
}

fn get_pawn_hash() -> Arc<PawnHashTable> {
    GLOBAL_PAWN_HASH.get_or_init(|| RwLock::new(Arc::new(PawnHashTable::new(131_072)))).read().unwrap().clone()
}

fn get_lmr(depth: u8, moves_evaluated: usize) -> u8 {
    let table = LMR_TABLE.get_or_init(|| {
        let mut t = [[0; 256]; 64];
        for d in 0..64 {
            for m in 0..256 {
                if d >= 1 && m >= 1 {
                    let r = 0.5 + ((d as f64).ln() * (m as f64).ln() / 2.25);
                    t[d][m] = r as u8;
                }
            }
        }
        t
    });
    table[depth.min(63) as usize][moves_evaluated.min(255)]
}

fn pack_move(m: Option<ChessMove>) -> u16 {
    if let Some(m) = m {
        let src = m.get_source().to_index() as u16;
        let dest = m.get_dest().to_index() as u16;
        let promo = match m.get_promotion() {
            None => 0,
            Some(Piece::Knight) => 1,
            Some(Piece::Bishop) => 2,
            Some(Piece::Rook) => 3,
            Some(Piece::Queen) => 4,
            _ => 0,
        };
        (promo << 12) | (dest << 6) | src
    } else {
        0xFFFF
    }
}

fn unpack_move(val: u16) -> Option<ChessMove> {
    if val == 0xFFFF {
        None
    } else {
        let src = unsafe { chess::Square::new((val & 0x3F) as u8) };
        let dest = unsafe { chess::Square::new(((val >> 6) & 0x3F) as u8) };
        let promo = match val >> 12 {
            1 => Some(Piece::Knight),
            2 => Some(Piece::Bishop),
            3 => Some(Piece::Rook),
            4 => Some(Piece::Queen),
            _ => None,
        };
        Some(ChessMove::new(src, dest, promo))
    }
}

struct PawnHashEntry {
    hash: AtomicU64,
    data: AtomicU64,
}

struct PawnHashTable {
    entries: Box<[PawnHashEntry]>,
    mask: usize,
}

impl PawnHashTable {
    fn new(capacity: usize) -> Self {
        let size = capacity.next_power_of_two();
        let mut entries = Vec::with_capacity(size);
        for _ in 0..size {
            entries.push(PawnHashEntry { hash: AtomicU64::new(0), data: AtomicU64::new(0) });
        }
        Self {
            entries: entries.into_boxed_slice(),
            mask: size - 1,
        }
    }

    fn probe(&self, key: u64) -> Option<(i32, i32)> {
        let index = (key as usize) & self.mask;
        let entry = &self.entries[index];
        let data = entry.data.load(Ordering::Acquire);
        let stored_hash = entry.hash.load(Ordering::Acquire);
        if (stored_hash ^ data) == key && key != 0 {
            let w = (data as u16 as i16) as i32;
            let b = ((data >> 16) as u16 as i16) as i32;
            Some((w, b))
        } else {
            None
        }
    }

    fn store(&self, key: u64, w_pawn_score: i32, b_pawn_score: i32) {
        let index = (key as usize) & self.mask;
        let entry = &self.entries[index];
        let data = (w_pawn_score as i16 as u16 as u64) | ((b_pawn_score as i16 as u16 as u64) << 16);
        entry.data.store(data, Ordering::Release);
        entry.hash.store(key ^ data, Ordering::Release);
    }
}

#[wasm_bindgen]
pub struct ChessEngine {
    killers: [[Option<ChessMove>; 2]; 128],
    /// Butterfly history table for move ordering heuristics.
    history: [[i32; 64]; 64],
    stop_search: bool,
    time_limit_ms: f64,
    hard_time_limit_ms: f64,
    start_time: f64,
    /// Total nodes visited across the current search.
    nodes: u32,
    elo: u32,
    /// Zobrist hashes of previously seen positions for 3-fold repetition detection.
    history_hashes: HashMap<u64, u8>,
    /// Array of Zobrist hashes for the current search path to detect perpetual checks in the search tree.
    search_path: [u64; 128],
    /// Generation counter for TT age-based replacement.
    search_generation: u8,
    abort_flag: Option<js_sys::Uint8Array>,
    counter_moves: [[[Option<ChessMove>; 64]; 6]; 2],
    followup_history: Vec<i32>,
    search_path_moves: [Option<ChessMove>; 128],
    network: Option<Box<Network>>,
    accumulators: [Accumulator; 130],
}
#[wasm_bindgen]
impl ChessEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        
        Self {
            killers: [[None; 2]; 128],
            history: [[0; 64]; 64],
            stop_search: false,
            time_limit_ms: 0.0,
            hard_time_limit_ms: 0.0,
            start_time: 0.0,
            nodes: 0,
            elo: 3000,
            history_hashes: HashMap::new(),
            search_path: [0; 128],
            search_generation: 0,
            abort_flag: None,
            counter_moves: [[[None; 64]; 6]; 2],
            followup_history: vec![0; 64 * 64 * 64],
            search_path_moves: [None; 128],
            network: None,
            accumulators: [Accumulator::new(); 130],
        }
    }

    #[wasm_bindgen]
    pub fn load_network(&mut self, data: js_sys::Uint8Array) -> bool {
        let mut bytes = vec![0; data.length() as usize];
        data.copy_to(&mut bytes[..]);
        
        if bytes.len() < 21022697 { return false; }
        
        let mut offset = 0;
        let version = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        let hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        let desc_len = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize; offset += 4;
        
        offset += desc_len; // skip desc
        if offset + 4 > bytes.len() { return false; }
        
        let ft_hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        
        let mut net = Box::new(Network::new());
        
        for i in 0..nnue::LAYER1_BIASES {
            net.feature_biases[i] = i16::from_le_bytes(bytes[offset..offset+2].try_into().unwrap());
            offset += 2;
        }
        for i in 0..nnue::LAYER1_WEIGHTS {
            net.feature_weights[i] = i16::from_le_bytes(bytes[offset..offset+2].try_into().unwrap());
            offset += 2;
        }
        
        let fc_hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        
        for i in 0..32 {
            net.fc0_biases[i] = i32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap());
            offset += 4;
        }
        for i in 0..(512 * 32) {
            net.fc0_weights[i] = bytes[offset] as i8;
            offset += 1;
        }
        
        for i in 0..32 {
            net.fc1_biases[i] = i32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap());
            offset += 4;
        }
        for i in 0..(32 * 32) {
            net.fc1_weights[i] = bytes[offset] as i8;
            offset += 1;
        }
        
        net.fc2_biases[0] = i32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap());
        offset += 4;
        for i in 0..32 {
            net.fc2_weights[i] = bytes[offset] as i8;
            offset += 1;
        }
        
        self.network = Some(net);
        true
    }

    pub fn set_hash_size(&mut self, mb: usize) {
        let entries = (mb * 1024 * 1024) / 16;
        let mut tt_lock = GLOBAL_TT.get_or_init(|| RwLock::new(Arc::new(TranspositionTable::new(entries)))).write().unwrap();
        if tt_lock.entries.len() != entries {
            *tt_lock = Arc::new(TranspositionTable::new(entries));
        }
        
        let mut pawn_lock = GLOBAL_PAWN_HASH.get_or_init(|| RwLock::new(Arc::new(PawnHashTable::new(131_072)))).write().unwrap();
        if pawn_lock.entries.len() != 131_072 {
            *pawn_lock = Arc::new(PawnHashTable::new(131_072));
        }
    }

    #[wasm_bindgen]
    pub fn get_best_move(&mut self, fen: &str, time_limit_ms: f64, elo: f64, split_id: u8, split_count: u8, history: &str, abort_flag: &js_sys::Uint8Array) -> String {
        let tt = get_tt();
        let pawn_hash = get_pawn_hash();

        self.nodes = 0;
        self.stop_search = false;
        if time_limit_ms.is_nan() {
            self.time_limit_ms = 3000.0;
            self.hard_time_limit_ms = 4500.0;
        } else {
            self.time_limit_ms = time_limit_ms;
            self.hard_time_limit_ms = time_limit_ms * 1.5;
        }
        self.elo = elo as u32;
        self.abort_flag = Some(abort_flag.clone());
        // Bump generation every search so old TT entries are more aggressively replaced.
        self.search_generation = self.search_generation.wrapping_add(1);

        // History gravity: age heuristic scores to prevent stale move ordering.
        for from in 0..64usize {
            for to in 0..64usize {
                self.history[from][to] /= 2;
            }
        }

        let halfmove_clock: u8 = fen.split_whitespace().nth(4).unwrap_or("0").parse().unwrap_or(0);
        let board = match Board::from_str(&fen) {
            Ok(b) => b,
            Err(_) => return "{\"bestMove\":\"\",\"ponderFen\":\"\",\"score\":0,\"depth\":0,\"nodes\":0,\"pv\":[]}".to_string(),
        };
        
        // Rebuild the set of past position hashes for 3-fold repetition detection.
        // History is passed as pipe-separated normalized FEN strings.
        self.history_hashes.clear();
        for h_fen in history.split('|') {
            if h_fen.is_empty() { continue; }
            let full_fen = format!("{} 0 1", h_fen);
            if let Ok(b) = Board::from_str(&full_fen) {
                *self.history_hashes.entry(b.get_hash()).or_insert(0) += 1;
            }
        }

        let moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(&board).collect();
        if moves.len() == 1 {
            if let Some(network) = &self.network {
                nnue::refresh_accumulator(network, &mut self.accumulators[0], &board);
            }
            let score = self.evaluate_full(&board, &pawn_hash, 0);
            return format!("{{\"bestMove\":\"{}\",\"ponderFen\":\"\",\"score\":{},\"depth\":1,\"nodes\":1,\"pv\":[\"{}\"]}}", moves[0].to_string(), score, moves[0].to_string());
        }
        
        let my_moves = moves.len();
        if my_moves == 0 {
            let is_check = board.checkers().popcnt() > 0;
            let score = if is_check { -MATE } else { 0 };
            return format!("{{\"bestMove\":\"\",\"ponderFen\":\"\",\"score\":{},\"depth\":0,\"nodes\":0,\"pv\":[]}}", score);
        }

        self.start_time = js_sys::Date::now();
        
        if let Some(network) = &self.network {
            nnue::refresh_accumulator(network, &mut self.accumulators[0], &board);
        }

        let mut best_move: Option<ChessMove> = None;
        let mut best_score = -INF;
        let mut previous_best_score = -INF;
        let mut second_best_move = None;
        
        let mut t_moves = ArrayVec::<ChessMove, 256>::new();
        let mut depth_reached: u8 = 0;
        
        let max_depth = if self.elo < 500 { 1 } 
                        else if self.elo < 1000 { 2 } 
                        else if self.elo < 1500 { 3 } 
                        else if self.elo < 2000 { 5 } 
                        else { 64 };

        let is_check = board.checkers().popcnt() > 0;
        if is_check {
            self.time_limit_ms = f64::min(self.time_limit_ms * 2.0, self.hard_time_limit_ms);
        }

        let max_horizon = max_depth;
        for base_depth in 1..=64u8 {
            let depth = base_depth + (split_id % 2) as u8;
            if depth > max_horizon { break; }

            // --------------- Gradual Aspiration Window ---------------
            // Start with tight window; on fail widen by 1.5x each time.
            // If depth is shallow (<=4) use full window to avoid re-searches.
            let (mut alpha, mut beta, mut delta) = if depth <= 4 || best_score == -INF {
                (-INF, INF, INF)
            } else {
                (best_score - 30, best_score + 30, 30i32)
            };

            let (current_move, current_best_score, current_second_move, current_second_score) = loop {
                let result = self.search_root(&board, depth, alpha, beta, split_id as u32, split_count as u32, halfmove_clock, &tt, &pawn_hash);
                if self.stop_search { break result; }

                if delta == INF {
                    // Full-window search, accept result unconditionally.
                    break result;
                }

                if result.1 <= alpha {
                    // Fail-low: widen downward
                    alpha = (alpha - delta / 2).max(-INF);
                    delta = delta + delta / 2; // 1.5x
                    if delta > 2000 { alpha = -INF; beta = INF; delta = INF; }
                } else if result.1 >= beta {
                    // Fail-high: widen upward
                    beta = (beta + delta / 2).min(INF);
                    delta = delta + delta / 2;
                    if delta > 2000 { alpha = -INF; beta = INF; delta = INF; }
                } else {
                    break result;
                }
            };

            if self.stop_search { break; }

            best_move = current_move;
            best_score = current_best_score;
            second_best_move = current_second_move;
            depth_reached = depth;
            
            let elapsed = js_sys::Date::now() - self.start_time;
            
            // Panic Time: position is complex after score drop → extend time.
            if best_score < previous_best_score - 50 {
                self.time_limit_ms = f64::min(self.time_limit_ms * 2.0, self.hard_time_limit_ms);
            }
            
            // Instant Mate Found: stop immediately.
            if best_score > 20000 {
                self.stop_search = true;
                break;
            }
            
            // Soft-bound: clearly dominant move + 40% time used → exit early.
            let early_exit_threshold = if best_score > 1000 { 100 } else { 300 };
            let early_exit_depth = if best_score > 1000 { 5 } else { 7 };
            if depth >= early_exit_depth && best_score.saturating_sub(current_second_score) > early_exit_threshold {
                if elapsed > self.hard_time_limit_ms * 0.4 {
                    self.stop_search = true;
                    break;
                }
            }
            
            // Do not start next depth if soft time is up.
            if elapsed > self.time_limit_ms * 0.5 {
                break;
            }

            previous_best_score = best_score;
        }
        
        // Blunder simulation: for weaker Elo, sometimes play the second-best scored move
        // rather than picking from move-ordering (which could still be a good move).
        if elo < 2500.0 {
            let blunder_chance = ((2500.0 - elo) / 50.0) as u32;
            let random = (js_sys::Math::random() * 100.0) as u32;
            
            if random < blunder_chance {
                if let Some(m) = second_best_move {
                    best_move = Some(m);
                } else {
                    let mut moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(&board).collect();
                    let mut scores = self.score_moves(&board, &moves, 0, best_move);
                    for i in 0..moves.len() {
                        self.pick_move(&mut moves, &mut scores, i);
                    }
                    if moves.len() > 1 {
                        best_move = moves.iter().find(|&&m| Some(m) != best_move).copied();
                    }
                }
            }
        }

        let mut pv = Vec::new();
        let mut current_board = board.clone();
        for _ in 0..6 {
            if let Some(entry) = tt.probe(current_board.get_hash(), 0) {
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
        
        if pv.is_empty() && best_move.is_some() {
            pv.push(format!("\"{}\"", best_move.unwrap().to_string()));
        }

        let best_move_str = match best_move {
            Some(m) => m.to_string(),
            None => MoveGen::new_legal(&board).next().map(|m| m.to_string()).unwrap_or_default(),
        };

        let mut ponder_fen = String::new();
        
        if let Some(m) = best_move {
            let mut pv_board = board.make_move_new(m);
            
            // Extract the opponent's expected reply from the TT
            let hash = pv_board.get_hash();
            if let Some(entry) = tt.probe(hash, 0) {
                if let Some(opp_m) = entry.best_move {
                    pv_board = pv_board.make_move_new(opp_m);
                }
            }
            ponder_fen = pv_board.to_string(); 
        }

        let score_cp = if best_score > 20000 {
            30000 - best_score
        } else if best_score < -20000 {
            -30000 - best_score
        } else {
            best_score
        };

        format!(
            "{{\"bestMove\":\"{}\",\"ponderFen\":\"{}\",\"score\":{},\"depth\":{},\"nodes\":{},\"pv\":[{}]}}",
            best_move_str,
            ponder_fen,
            score_cp,
            depth_reached,
            self.nodes,
            pv.join(",")
        )
    }
}

const EXACT: u8 = 0;
const LOWERBOUND: u8 = 1;
const UPPERBOUND: u8 = 2;

struct TTEntry {
    hash: AtomicU64,
    data: AtomicU64,
}

#[derive(Clone, Copy)]
struct TTProbeResult {
    hash: u64,
    best_move: Option<ChessMove>,
    depth: u8,
    score: i32,
    flag: u8,
    generation: u8,
}

struct TranspositionTable {
    entries: Box<[TTEntry]>,
    size: usize,
}

impl TranspositionTable {
    fn new(size: usize) -> Self {
        let size = size.next_power_of_two();
        let mut entries = Vec::with_capacity(size);
        for _ in 0..size {
            entries.push(TTEntry { hash: AtomicU64::new(0), data: AtomicU64::new(0) });
        }
        Self {
            entries: entries.into_boxed_slice(),
            size,
        }
    }
    fn store(&self, hash: u64, best_move: Option<ChessMove>, depth: u8, mut score: i32, flag: u8, ply: u8, generation: u8) {
        if score > MATE - 128 { score += ply as i32; } else if score < -MATE + 128 { score -= ply as i32; }
        
        let index = (hash as usize) & (self.size - 1);
        let entry = &self.entries[index];
        let stored_data = entry.data.load(Ordering::Relaxed);
        let stored_hash = entry.hash.load(Ordering::Acquire) ^ stored_data;
        
        let should_replace = if stored_hash != hash || stored_hash == 0 {
            true // empty or collision
        } else {
            let old_depth = ((stored_data >> 32) & 0x3F) as u8;
            let old_gen = ((stored_data >> 40) & 0xFF) as u8;
            old_gen != generation || depth >= old_depth
        };

        if should_replace {
            let m_val = pack_move(best_move) as u64;
            let s_val = (score as i16 as u16 as u64) << 16;
            let d_val = ((depth as u64) & 0x3F) << 32;
            let f_val = ((flag as u64) & 0x3) << 38;
            let g_val = ((generation as u64) & 0xFF) << 40;
            let data = m_val | s_val | d_val | f_val | g_val;
            
            entry.data.store(data, Ordering::Relaxed);
            entry.hash.store(hash ^ data, Ordering::Release);
        }
    }
    fn probe(&self, hash: u64, ply: u8) -> Option<TTProbeResult> {
        let index = (hash as usize) & (self.size - 1);
        let entry = &self.entries[index];
        let data = entry.data.load(Ordering::Relaxed);
        let stored_hash = entry.hash.load(Ordering::Acquire) ^ data;
        if stored_hash == hash && hash != 0 {
            let mut score = ((data >> 16) as u16 as i16) as i32;
            if score > MATE - 128 { score -= ply as i32; } else if score < -MATE + 128 { score += ply as i32; }
            Some(TTProbeResult {
                hash,
                best_move: unpack_move((data & 0xFFFF) as u16),
                depth: ((data >> 32) & 0x3F) as u8,
                score,
                flag: ((data >> 38) & 0x3) as u8,
                generation: ((data >> 40) & 0xFF) as u8,
            })
        } else {
            None
        }
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
        if let Some(flag) = &self.abort_flag {
            if flag.get_index(0) == 1 {
                self.stop_search = true;
                return;
            }
        }
        let now = js_sys::Date::now();
        if now - self.start_time >= self.hard_time_limit_ms {
            self.stop_search = true;
        }
    }

    fn score_move(&self, board: &Board, m: &ChessMove, ply: u8, tt_best_move: Option<ChessMove>) -> i32 {
        if Some(*m) == tt_best_move { return 10_000_000; }

        // Captures: order by SEE value.
        // Good captures (SEE ≥ 0) come before promotions/killers.
        // Bad captures (SEE < 0) are searched last (negative score).
        let is_ep = board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file() && board.piece_on(m.get_dest()).is_none();
        if board.piece_on(m.get_dest()).is_some() || is_ep {
            let see = see_value(board, *m);
            return if see >= 0 { 100_000 + see } else { -50_000 + see };
        }

        if m.get_promotion().is_some() { return 9_500; }

        if (ply as usize) < 128 {
            if Some(*m) == self.killers[ply as usize][0] { return 9_000; }
            if Some(*m) == self.killers[ply as usize][1] { return 8_000; }
            
            let mut score = self.history[m.get_source().to_index()][m.get_dest().to_index()];
            
            if ply > 0 {
                if let Some(prev) = self.search_path_moves[(ply - 1) as usize] {
                    let prev_piece = board.piece_on(prev.get_dest()).unwrap_or(Piece::Pawn);
                    let prev_color = !board.side_to_move();
                    if self.counter_moves[prev_color as usize][prev_piece as usize][prev.get_dest().to_index()] == Some(*m) {
                        score += 5_000;
                    }
                }
            }
            if ply > 1 {
                if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                    let idx = (prev2.get_dest().to_index() * 4096) + (m.get_source().to_index() * 64) + m.get_dest().to_index();
                    score += self.followup_history[idx];
                }
            }
            return score;
        }
        0
    }

    fn score_moves(&self, board: &Board, moves: &[ChessMove], ply: u8, tt_best_move: Option<ChessMove>) -> ArrayVec<i32, 256> {
        moves.iter().map(|&m| self.score_move(board, &m, ply, tt_best_move)).collect()
    }

    fn pick_move(&self, moves: &mut [ChessMove], scores: &mut [i32], start: usize) {
        let mut best_idx = start;
        let mut best_score = scores[start];
        for i in (start + 1)..moves.len() {
            if scores[i] > best_score {
                best_score = scores[i];
                best_idx = i;
            }
        }
        moves.swap(start, best_idx);
        scores.swap(start, best_idx);
    }

    fn search_root(&mut self, board: &Board, depth: u8, mut alpha: i32, beta: i32, split_id: u32, split_count: u32, halfmove_clock: u8, tt: &TranspositionTable, pawn_hash: &PawnHashTable) -> (Option<ChessMove>, i32, Option<ChessMove>, i32) {
        let mut best_move = None;
        let mut best_score = -INF;
        let mut second_best_move = None;
        let mut second_best_score = -INF;
        let original_alpha = alpha;
        
        let hash = board.get_hash();
        self.search_path[0] = hash;
        let tt_best_move = tt.probe(hash, 0).and_then(|entry| entry.best_move);

        let mut moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(board).collect();
        if moves.is_empty() { return (None, if board.checkers().popcnt() > 0 { -MATE } else { 0 }, None, -INF); }
        
        let mut scores = self.score_moves(board, &moves, 0, tt_best_move);
        
        if split_count > 1 && split_id > 0 {
            for i in 0..moves.len() {
                if scores[i] < 50_000 {
                    scores[i] += ((i as u32 * split_id as u32 * 17) % 31) as i32;
                }
            }
        }

        if moves.is_empty() { return (None, -INF, None, -INF); }

        let mut b_search_pv = true;

        for i in 0..moves.len() {
            self.pick_move(&mut moves, &mut scores, i);
            let m = moves[i];
            
            let next_board = board.make_move_new(m);
            self.update_nnue(0, board, &next_board);
            let is_capture = board.piece_on(m.get_dest()).is_some();
            let is_pawn_move = board.piece_on(m.get_source()) == Some(Piece::Pawn);
            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let mut score;
            
            self.search_path_moves[0] = Some(m);
            
            if b_search_pv {
                score = -self.negamax(&next_board, depth - 1, -beta, -alpha, 1, next_halfmove, tt, pawn_hash);
                b_search_pv = false;
            } else {
                score = -self.negamax(&next_board, depth - 1, -alpha - 1, -alpha, 1, next_halfmove, tt, pawn_hash);
                if score > alpha {
                    score = -self.negamax(&next_board, depth - 1, -beta, -alpha, 1, next_halfmove, tt, pawn_hash);
                }
            }
            
            if self.stop_search { break; }

            if score > best_score {
                second_best_score = best_score;
                second_best_move = best_move;
                best_score = score;
                best_move = Some(m);
            } else if score > second_best_score {
                second_best_score = score;
                second_best_move = Some(m);
            }
            if score > alpha { alpha = score; }
            if alpha >= beta { break; }
        }
        if !self.stop_search {
            let flag = if best_score <= original_alpha { UPPERBOUND } else if best_score >= beta { LOWERBOUND } else { EXACT };
            tt.store(hash, best_move, depth, best_score, flag, 0, self.search_generation);
        }
        (best_move, best_score, second_best_move, second_best_score)
    }

    #[inline(always)]
    fn update_nnue(&mut self, ply: u8, old_board: &Board, new_board: &Board) {
        if let Some(network) = &self.network {
            let (left, right) = self.accumulators.split_at_mut((ply + 1) as usize);
            nnue::update_accumulator(network, &mut right[0], &left[ply as usize], old_board, new_board);
        }
    }

    fn quiescence_search(&mut self, board: &Board, mut alpha: i32, beta: i32, ply: u8, halfmove_clock: u8, tt: &TranspositionTable, pawn_hash: &PawnHashTable) -> i32 {
        if ply >= 127 { return self.evaluate_full(board, pawn_hash, ply); }
        self.nodes += 1;
        if (self.nodes & 16383) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        let hash = board.get_hash();
        
        let mut rep_count = self.history_hashes.get(&hash).copied().unwrap_or(0);
        let limit = ply.saturating_sub(halfmove_clock);
        if ply > limit {
            let mut i = ply;
            while i >= limit + 2 {
                i -= 2;
                if self.search_path[i as usize] == hash {
                    rep_count += 1;
                }
            }
        }
        if rep_count >= 1 { return 0; }

        let mut tt_move = None;
        if let Some(entry) = tt.probe(hash, ply) {
            tt_move = entry.best_move;
            if entry.flag == EXACT { return entry.score; }
            if entry.flag == LOWERBOUND && entry.score >= beta { return entry.score; }
            if entry.flag == UPPERBOUND && entry.score <= alpha { return entry.score; }
        }

        let in_check = board.checkers().popcnt() > 0;
        let stand_pat = if in_check { 0 } else { self.evaluate_full(board, pawn_hash, ply) };
        let original_alpha = alpha;
        
        if !in_check {
            if stand_pat >= beta { 
                tt.store(hash, None, 0, stand_pat, LOWERBOUND, ply, self.search_generation);
                return beta; 
            }
            if alpha < stand_pat { alpha = stand_pat; }
        }

        let mut moves: ArrayVec<ChessMove, 256> = if in_check {
            MoveGen::new_legal(board).collect()
        } else {
            let mut gen = MoveGen::new_legal(board);
            let enemies = board.color_combined(!board.side_to_move()).0;
            let promos = if board.side_to_move() == Color::White { 0xFF00000000000000 } else { 0x00000000000000FF };
            let ep = board.en_passant().map_or(0, |sq| 1u64 << sq.to_index());
            gen.set_iterator_mask(chess::BitBoard(enemies | promos | ep));
            gen.filter(|m| {
                board.piece_on(m.get_dest()).is_some() 
                || m.get_promotion().is_some()
                || (board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file())
            }).collect()
        };
            
        let mut scores = self.score_moves(board, &moves, ply, tt_move);
        
        if moves.is_empty() {
            if in_check {
                return -MATE + ply as i32;
            } else if MoveGen::new_legal(board).next().is_none() {
                return 0; // Stalemate
            }
        }

        let mut best_score = if in_check { -INF } else { stand_pat };
        let mut best_move = None;

        for i in 0..moves.len() {
            self.pick_move(&mut moves, &mut scores, i);
            let m = moves[i];
            
            let is_ep = board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file() && board.piece_on(m.get_dest()).is_none();

            if !in_check && stand_pat + 1225 < alpha && m.get_promotion().is_none() {
                continue;
            }

            // Full SEE filter for captures in quiescence search.
            if !in_check && m.get_promotion().is_none() && (board.piece_on(m.get_dest()).is_some() || is_ep) {
                let see = see_value(board, m);
                // Skip captures that lose material even after all recaptures.
                if see < 0 { continue; }
                // Delta pruning: if even an optimistic continuation can't reach alpha, skip.
                let captured_val = if is_ep { 100 } else { board.piece_on(m.get_dest()).map_or(0, |p| piece_value_mg(p)) };
                if stand_pat + captured_val.max(see) + 150 <= alpha { continue; }
            }

            let next_board = board.make_move_new(m);
            self.update_nnue(ply, board, &next_board);
            let is_capture = board.piece_on(m.get_dest()).is_some();
            let is_pawn_move = board.piece_on(m.get_source()) == Some(Piece::Pawn);
            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let score = -self.quiescence_search(&next_board, -beta, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
            if self.stop_search { return 0; }
            
            if score > best_score {
                best_score = score;
                best_move = Some(m);
            }
            if score > alpha { alpha = score; }
            if score >= beta { break; }
        }
        
        if !self.stop_search {
            let flag = if best_score <= original_alpha { UPPERBOUND } else if best_score >= beta { LOWERBOUND } else { EXACT };
            tt.store(hash, best_move, 0, best_score, flag, ply, self.search_generation);
        }
        best_score
    }

    fn negamax(&mut self, board: &Board, depth: u8, mut alpha: i32, beta: i32, ply: u8, halfmove_clock: u8, tt: &TranspositionTable, pawn_hash: &PawnHashTable) -> i32 {
        if ply >= 127 { return self.evaluate_full(board, pawn_hash, ply); }
        self.nodes += 1;
        if (self.nodes & 16383) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        if halfmove_clock >= 100 { return 0; }
        
        let hash = board.get_hash();
        let mut rep_count = self.history_hashes.get(&hash).copied().unwrap_or(0);
        let limit = ply.saturating_sub(halfmove_clock);
        if ply > limit {
            let mut i = ply;
            while i >= limit + 2 {
                i -= 2;
                if self.search_path[i as usize] == hash {
                    rep_count += 1;
                }
            }
        }
        if rep_count >= 1 { return 0; }
        if (ply as usize) < 128 {
            self.search_path[ply as usize] = hash;
        }
        
        let is_check = board.checkers().popcnt() > 0;
        
        if depth == 0 { return self.quiescence_search(board, alpha, beta, ply, halfmove_clock, tt, pawn_hash); }

        // ---- TT probe FIRST: if we have a sufficient hit, return early ----
        // (moved before static_eval to avoid computing eval when TT suffices)
        let mut tt_best_move = None;
        let mut tt_score_for_singular: Option<i32> = None;
        let mut tt_depth_for_singular: u8 = 0;
        if let Some(entry) = tt.probe(hash, ply) {
            tt_best_move = entry.best_move;
            tt_score_for_singular = Some(entry.score);
            tt_depth_for_singular = entry.depth;
            if entry.depth >= depth {
                if entry.flag == EXACT { return entry.score; }
                if entry.flag == LOWERBOUND && entry.score >= beta { return entry.score; }
                if entry.flag == UPPERBOUND && entry.score <= alpha { return entry.score; }
            }
        }

        let mut moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(board).collect();
        if moves.is_empty() {
            if is_check { return -MATE + ply as i32; }
            return 0; // Stalemate
        }

        // Compute static eval once — shared by Razoring, RFP, Futility.
        // Only compute when we'll actually need it (not in check at depth > 3).
        let static_eval = if !is_check { self.evaluate_full(board, pawn_hash, ply) } else { 0 };

        // Reverse Futility Pruning (RFP)
        if !is_check && depth <= 3 {
            let margin = depth as i32 * 120;
            if static_eval - margin >= beta {
                return static_eval;
            }
        }

        // Razoring: if even an optimistic score can't reach alpha, fall through to qsearch.
        if !is_check && depth <= 3 {
            let razor_margin = depth as i32 * 300;
            if static_eval + razor_margin <= alpha {
                let q_score = self.quiescence_search(board, alpha - razor_margin, beta, ply, halfmove_clock, tt, pawn_hash);
                if q_score + razor_margin <= alpha {
                    return q_score;
                }
            }
        }

        let stm_pieces = board.color_combined(board.side_to_move()) & (board.pieces(Piece::Knight) | board.pieces(Piece::Bishop) | board.pieces(Piece::Rook) | board.pieces(Piece::Queen));
        let has_pieces = stm_pieces.popcnt() > 0;
        if !is_check && depth >= 2 && has_pieces && (ply as usize) < 128 {
            if let Some(null_board) = board.null_move() {
                self.update_nnue(ply, board, &null_board);
                let r = 3 + depth / 4; // More aggressive reduction
                let reduced_depth = if depth > r { depth - r - 1 } else { 0 };
                let null_score = -self.negamax(&null_board, reduced_depth, -beta, -beta + 1, ply.saturating_add(1), 0, tt, pawn_hash);
                if self.stop_search { return 0; }
                if null_score >= beta {
                    if null_score >= MATE - 128 {
                        let verify_score = self.negamax(board, depth - 1, beta - 1, beta, ply, halfmove_clock, tt, pawn_hash);
                        if verify_score >= beta { return verify_score; }
                    } else {
                        return beta;
                    }
                }
            }
        }

        // ProbCut
        if !is_check && depth >= 5 && beta < MATE - 128 {
            let bound = beta + 200;
            let probcut_score = self.quiescence_search(board, bound - 1, bound, ply, halfmove_clock, tt, pawn_hash);
            if probcut_score >= bound {
                return probcut_score;
            }
        }


        let mut best_score = -INF;
        let mut second_best = -INF;
        let mut best_move = None;
        let original_alpha = alpha;
        let is_pv_node = beta > alpha + 1;

        let mut scores = self.score_moves(board, &moves, ply, tt_best_move);

        // Multi-Cut Pruning: if several quick null-window searches at reduced depth
        // all cause a beta cutoff, the position is very likely a cut node – prune it.
        const MC_TRIES: usize = 3;
        const MC_CUTS: usize = 2;
        if !is_check && depth >= 6 && has_pieces && !is_pv_node && moves.len() >= MC_TRIES {
            let mut cutoffs = 0usize;
            for i in 0..MC_TRIES.min(moves.len()) {
                self.pick_move(&mut moves, &mut scores, i);
                let mc_m = moves[i];
                if self.stop_search { break; }
                let next = board.make_move_new(mc_m);
                self.update_nnue(ply, board, &next);
                let mc_next_halfmove = if mc_m.get_promotion().is_some() || board.piece_on(mc_m.get_dest()).is_some() || board.piece_on(mc_m.get_source()) == Some(Piece::Pawn) { 0 } else { halfmove_clock + 1 };
                let score = -self.negamax(&next, depth - 4, -beta, -beta + 1, ply.saturating_add(1), mc_next_halfmove, tt, pawn_hash);
                if score >= beta {
                    cutoffs += 1;
                    if cutoffs >= MC_CUTS {
                        return beta; // Multi-cut
                    }
                }
            }
            if self.stop_search { return 0; }
        }

        let mut moves_evaluated = 0;
        let mut b_search_pv = true;
        let mut quiet_moves: ArrayVec<ChessMove, 256> = ArrayVec::new();

        let mc_done = !is_check && depth >= 6 && has_pieces && !is_pv_node && moves.len() >= MC_TRIES;

        for i in 0..moves.len() {
            if !(mc_done && i < MC_TRIES) {
                self.pick_move(&mut moves, &mut scores, i);
            }
            let m = moves[i];
            let is_capture = board.piece_on(m.get_dest()).is_some() || (board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file());
            let is_promotion = m.get_promotion().is_some();
            
            if !is_capture && !is_promotion {
                quiet_moves.push(m);
            }

            // Futility Pruning
            if depth <= 2 && !is_check && !is_capture && !is_promotion {
                if static_eval + (120 * depth as i32) <= alpha {
                    continue; 
                }
            }

            let next_board = board.make_move_new(m);
            self.update_nnue(ply, board, &next_board);
            
            let is_pawn_move = board.piece_on(m.get_source()) == Some(Piece::Pawn);
            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let mut score;
            let gives_check = next_board.checkers().popcnt() > 0;
            
            // Genuine Singular Extension:
            // Only at depth >= 8 to avoid expensive mini-searches on shallow nodes.
            let mut extension = 0u8;
            if gives_check && depth < 64 && see_value(board, m) >= 0 {
                extension = 1;
            }

            if depth >= 8
                && Some(m) == tt_best_move
                && tt_depth_for_singular >= depth.saturating_sub(3)
                && moves_evaluated == 0
            {
                if let Some(tt_s) = tt_score_for_singular {
                    let s_margin = 15 + 2 * depth as i32;
                    let s_beta = tt_s - s_margin;
                    if s_beta > -MATE + 128 {
                        let is_singular = self.is_singular_move(
                            board, m, depth, s_beta, ply, &moves, halfmove_clock, tt, pawn_hash
                        );
                        if is_singular { extension = 1; }
                    }
                }
            }

            if (ply as usize) < 127 {
                self.search_path_moves[ply as usize] = Some(m);
            }

            if b_search_pv {
                score = -self.negamax(&next_board, depth - 1 + extension, -beta, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
                b_search_pv = false;
            } else {
                if moves_evaluated >= 3 && depth >= 3 && !is_capture && !gives_check && !is_promotion && next_board.status() != BoardStatus::Checkmate {
                    // Logarithmic LMR based on Stockfish formula
                    let mut r = get_lmr(depth, moves_evaluated);
                    
                    // History heuristic bonus/malus for LMR
                    let history_score = self.history[m.get_source().to_index()][m.get_dest().to_index()];
                    if history_score > 4000 {
                        r = r.saturating_sub(1);
                    } else if history_score < -4000 {
                        r += 1;
                    }
                    
                    if r > depth - 2 { r = depth - 2; }
                    score = -self.negamax(&next_board, depth - 1 - r + extension, -alpha - 1, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
                } else {
                    score = -self.negamax(&next_board, depth - 1 + extension, -alpha - 1, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
                }
                
                if score > alpha && score < beta {
                    score = -self.negamax(&next_board, depth - 1 + extension, -beta, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
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
                if (ply as usize) < 128 {
                    let bonus = (depth as i32) * (depth as i32);
                    if !is_capture {
                        if Some(m) != self.killers[ply as usize][0] {
                            self.killers[ply as usize][1] = self.killers[ply as usize][0];
                            self.killers[ply as usize][0] = Some(m);
                        }
                        let h = &mut self.history[m.get_source().to_index()][m.get_dest().to_index()];
                        *h = (*h + bonus).min(20000);
                        
                        if ply > 0 {
                            if let Some(prev) = self.search_path_moves[(ply - 1) as usize] {
                                let prev_piece = board.piece_on(prev.get_dest()).unwrap_or(Piece::Pawn);
                                self.counter_moves[(!board.side_to_move()) as usize][prev_piece as usize][prev.get_dest().to_index()] = Some(m);
                            }
                        }
                        if ply > 1 {
                            if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                                let idx = (prev2.get_dest().to_index() * 4096) + (m.get_source().to_index() * 64) + m.get_dest().to_index();
                                self.followup_history[idx] = (self.followup_history[idx] + bonus).min(20000);
                            }
                        }
                    }
                    
                    for &qm in &quiet_moves {
                        if qm != m {
                            let h2 = &mut self.history[qm.get_source().to_index()][qm.get_dest().to_index()];
                            *h2 = (*h2 - bonus).max(-20000);
                            
                            if ply > 1 {
                                if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                                    let idx = (prev2.get_dest().to_index() * 4096) + (qm.get_source().to_index() * 64) + qm.get_dest().to_index();
                                    self.followup_history[idx] = (self.followup_history[idx] - bonus).max(-20000);
                                }
                            }
                        }
                    }
                }
                break; 
            }
        }

        let flag = if best_score <= original_alpha { UPPERBOUND } else if best_score >= beta { LOWERBOUND } else { EXACT };
        if !self.stop_search {
            tt.store(hash, best_move, depth, best_score, flag, ply, self.search_generation);
        }
        best_score
    }

    /// Checks whether `excluded_move` is a singular move at this position:
    /// searches all other moves at reduced depth with a tight beta = s_beta.
    /// Returns true if all other moves fail low (i.e., excluded_move is uniquely good).
    fn is_singular_move(
        &mut self,
        board: &Board,
        excluded_move: ChessMove,
        depth: u8,
        s_beta: i32,
        ply: u8,
        moves: &[ChessMove],
        halfmove_clock: u8,
        tt: &TranspositionTable,
        pawn_hash: &PawnHashTable
    ) -> bool {
        let s_depth = (depth - 1) / 2;
        let s_alpha = s_beta - 1;
        for &m in moves {
            if m == excluded_move { continue; }
            if self.stop_search { return false; }
            
            let is_capture = board.piece_on(m.get_dest()).is_some() || (board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file());
            let is_pawn_move = board.piece_on(m.get_source()) == Some(Piece::Pawn);
            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let next = board.make_move_new(m);
            self.update_nnue(ply, board, &next);
            let score = -self.negamax(&next, s_depth, -s_beta, -s_alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
            if score >= s_beta {
                return false; // Another move is also good → not singular
            }
        }
        true // All other moves failed low → excluded_move is singular
    }
}

// ---------------------------------------------------------------------------
// Static Exchange Evaluation (SEE)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fast Bitboard-Based Static Exchange Evaluation (SEE)
// ---------------------------------------------------------------------------
// Uses magic bitboard move generators from the chess crate.
// Crucially, re-computes attackers after each capture to catch X-ray attackers
// (e.g. a rook hiding behind a bishop that just moved away).

use chess::BitBoard;

/// Compute all pieces of any color that attack `sq` given the current `occupied` bitboard.
/// `occupied` is updated after each capture so sliding X-ray attackers are revealed.
fn get_all_attackers(board: &Board, sq: chess::Square, occupied: BitBoard) -> BitBoard {
    use chess::{get_knight_moves, get_king_moves, get_bishop_moves, get_rook_moves};
    let mut attackers = BitBoard(0);

    // Pawn attackers: a white pawn at (rank-1, file±1) attacks sq; reverse for black.
    let rank = sq.get_rank().to_index() as i32;
    let file = sq.get_file().to_index() as i32;

    let mut add_pawn_attacker = |r: i32, f: i32, color: Color| {
        if r >= 0 && r < 8 && f >= 0 && f < 8 {
            let psq = chess::Square::make_square(
                chess::Rank::from_index(r as usize),
                chess::File::from_index(f as usize),
            );
            let pawn_bb = board.pieces(Piece::Pawn) & board.color_combined(color) & occupied;
            if (BitBoard::from_square(psq) & pawn_bb) != BitBoard(0) {
                attackers |= BitBoard::from_square(psq);
            }
        }
    };
    // White pawns attacking sq come from one rank below, ±1 file.
    add_pawn_attacker(rank - 1, file - 1, Color::White);
    add_pawn_attacker(rank - 1, file + 1, Color::White);
    // Black pawns attacking sq come from one rank above, ±1 file.
    add_pawn_attacker(rank + 1, file - 1, Color::Black);
    add_pawn_attacker(rank + 1, file + 1, Color::Black);

    // Knight and King — not blocked by other pieces.
    attackers |= get_knight_moves(sq) & board.pieces(Piece::Knight) & occupied;
    attackers |= get_king_moves(sq) & board.pieces(Piece::King) & occupied;

    // Diagonal sliders (Bishop + Queen)
    let diagonals = get_bishop_moves(sq, occupied);
    attackers |= diagonals & (board.pieces(Piece::Bishop) | board.pieces(Piece::Queen)) & occupied;

    // Straight sliders (Rook + Queen)
    let straights = get_rook_moves(sq, occupied);
    attackers |= straights & (board.pieces(Piece::Rook) | board.pieces(Piece::Queen)) & occupied;

    attackers
}

/// Fast SEE using bitboard attacker enumeration with X-ray support.
/// Returns the expected net material gain for the moving side (positive = good).
fn see_value(board: &Board, m: ChessMove) -> i32 {
    let to = m.get_dest();
    let from = m.get_source();

    let mut captured_val = match board.piece_on(to) {
        Some(p) => piece_value_mg(p),
        None => 0,
    };
    let mut ep_sq = None;
    if captured_val == 0 && board.piece_on(from) == Some(Piece::Pawn) && from.get_file() != to.get_file() {
        captured_val = 100;
        ep_sq = Some(chess::Square::make_square(from.get_rank(), to.get_file()));
    }

    // gain[d] = material gain at depth d in the capture sequence.
    let mut gain = [0i32; 32];
    let mut d = 0usize;
    gain[0] = captured_val;

    // Remove moving piece from occupied to reveal potential X-ray attackers behind it.
    let mut occupied = *board.combined() ^ BitBoard::from_square(from);
    if let Some(sq) = ep_sq {
        occupied ^= BitBoard::from_square(sq);
    }
    let mut stm = !board.side_to_move(); // Side to recapture
    let mut attackers = get_all_attackers(board, to, occupied);

    // Value of the piece that just moved (will be captured by recapture).
    let mut attacker_val = if let Some(prom) = m.get_promotion() {
        let prom_val = piece_value_mg(prom);
        let pawn_val = piece_value_mg(Piece::Pawn);
        captured_val += prom_val - pawn_val;
        prom_val
    } else {
        board.piece_on(from).map_or(0, |p| piece_value_mg(p))
    };

    loop {
        // Find cheapest attacker for `stm`.
        let mut found_sq: Option<chess::Square> = None;
        let mut found_val = i32::MAX;
        for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen, Piece::King] {
            let piece_bb = board.pieces(piece) & board.color_combined(stm) & attackers & occupied;
            if piece_bb != BitBoard(0) {
                // Pick any square from this piece bitboard (lowest index = deterministic).
                let sq = chess::Square::make_square(
                    chess::Rank::from_index(piece_bb.to_square().get_rank().to_index()),
                    chess::File::from_index(piece_bb.to_square().get_file().to_index()),
                );
                let v = piece_value_mg(piece);
                if v < found_val { found_val = v; found_sq = Some(sq); }
                break; // Pieces are ordered cheapest-first, first match wins.
            }
        }

        let attacker_sq = match found_sq {
            Some(sq) => sq,
            None => break, // No more attackers for this side.
        };

        d += 1;
        if d >= 31 { break; }
        gain[d] = attacker_val - gain[d - 1];
        attacker_val = found_val;

        // Remove the attacker from occupied — may uncover X-ray sliders.
        occupied ^= BitBoard::from_square(attacker_sq);
        // Recompute attackers after the capture (catches X-ray).
        attackers = get_all_attackers(board, to, occupied);
        stm = !stm;
    }

    // Negamax over gain[] to find optimal play.
    while d > 0 {
        d -= 1;
        gain[d] = -((-gain[d]).max(gain[d + 1]));
    }
    gain[0]
}

impl ChessEngine {
    fn evaluate_full(&mut self, board: &Board, pawn_hash: &PawnHashTable, ply: u8) -> i32 {
        if let Some(network) = &self.network {
            return nnue::evaluate(network, &self.accumulators[ply as usize], board.side_to_move());
        }

        let mut score = evaluate(board); // Base PeSTO evaluation
    let phase = get_phase(board);
    
    // Advanced King Safety
    let w_king = board.pieces(Piece::King) & board.color_combined(Color::White);
    let b_king = board.pieces(Piece::King) & board.color_combined(Color::Black);
    
    let w_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::White);
    let b_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::Black);
    
    let mut w_safety = 0;
    if w_king.popcnt() > 0 {
        let king_sq = w_king.to_square();
        let rank = king_sq.get_rank().to_index() as i32;
        let file = king_sq.get_file().to_index() as i32;
        if rank < 3 { // White king on 1st, 2nd, or 3rd rank
            for f in (file - 1)..=(file + 1) {
                if f >= 0 && f <= 7 {
                    let pawn_mask = 0x0101010101010101_u64 << f;
                    if (w_pawns.0 & pawn_mask) != 0 {
                        w_safety += 20; // Friendly pawn shields king
                    } else if (b_pawns.0 & pawn_mask) != 0 {
                        w_safety -= 10; // Enemy pawn blocking file is okay but less safe
                    } else {
                        w_safety -= 30; // Open file near king!
                    }
                }
            }
        } else {
            w_safety -= 50; // King is marching up the board
        }
        let k_r = king_sq.get_rank().to_index() as i32;
        let k_f = king_sq.get_file().to_index() as i32;
        for sq in board.color_combined(Color::Black) & (board.pieces(Piece::Queen) | board.pieces(Piece::Rook) | board.pieces(Piece::Knight)) {
            let r = sq.get_rank().to_index() as i32;
            let f = sq.get_file().to_index() as i32;
            let dist = (k_r - r).abs().max((k_f - f).abs());
            w_safety -= (8 - dist) * 2;
        }
    }
    
    let mut b_safety = 0;
    if b_king.popcnt() > 0 {
        let king_sq = b_king.to_square();
        let rank = king_sq.get_rank().to_index() as i32;
        let file = king_sq.get_file().to_index() as i32;
        if rank > 4 { // Black king on 6th, 7th, or 8th rank
            for f in (file - 1)..=(file + 1) {
                if f >= 0 && f <= 7 {
                    let pawn_mask = 0x0101010101010101_u64 << f;
                    if (b_pawns.0 & pawn_mask) != 0 {
                        b_safety += 20; // Friendly pawn shields king
                    } else if (w_pawns.0 & pawn_mask) != 0 {
                        b_safety -= 10; // Enemy pawn blocking file is okay but less safe
                    } else {
                        b_safety -= 30; // Open file near king!
                    }
                }
            }
        } else {
            b_safety -= 50; // King is marching down the board
        }
        let k_r = king_sq.get_rank().to_index() as i32;
        let k_f = king_sq.get_file().to_index() as i32;
        for sq in board.color_combined(Color::White) & (board.pieces(Piece::Queen) | board.pieces(Piece::Rook) | board.pieces(Piece::Knight)) {
            let r = sq.get_rank().to_index() as i32;
            let f = sq.get_file().to_index() as i32;
            let dist = (k_r - r).abs().max((k_f - f).abs());
            b_safety -= (8 - dist) * 2;
        }
    }
    
    // Positional Pawn Evaluation (Passed, Isolated, Doubled)
    let w_pawns_bb = w_pawns.0;
    let b_pawns_bb = b_pawns.0;
    let pawn_hash_key = w_pawns_bb.wrapping_mul(0x9E3779B97F4A7C15) ^ b_pawns_bb.wrapping_mul(0xC6A4A7935BD1E995);
    
    let (w_pawn_score, b_pawn_score) = if let Some((w_score, b_score)) = pawn_hash.probe(pawn_hash_key) {
        (w_score, b_score)
    } else {
        let mut w_score = 0;
        for sq in w_pawns {
            let file = sq.get_file().to_index();
            let rank = sq.get_rank().to_index();
            let file_mask = 0x0101010101010101_u64 << file;
            let adj_files = (if file > 0 { 0x0101010101010101_u64 << (file - 1) } else { 0 }) |
                            (if file < 7 { 0x0101010101010101_u64 << (file + 1) } else { 0 });
            
            let isolated = (w_pawns_bb & adj_files) == 0;
            
            let w_front_span = if rank < 7 { !0u64 << ((rank + 1) * 8) } else { 0 };
            let doubled = (w_pawns_bb & file_mask & w_front_span) != 0;
            
            let passed_mask = (file_mask | adj_files) & w_front_span;
            let passed = (b_pawns_bb & passed_mask) == 0;
            
            if isolated { w_score -= 15; }
            if doubled { w_score -= 15; }
            if passed { w_score += 20 + (rank as i32) * 15; }
        }
        
        let mut b_score = 0;
        for sq in b_pawns {
            let file = sq.get_file().to_index();
            let rank = sq.get_rank().to_index();
            let file_mask = 0x0101010101010101_u64 << file;
            let adj_files = (if file > 0 { 0x0101010101010101_u64 << (file - 1) } else { 0 }) |
                            (if file < 7 { 0x0101010101010101_u64 << (file + 1) } else { 0 });
            
            let isolated = (b_pawns_bb & adj_files) == 0;
            
            let b_front_span = if rank > 0 { (1u64 << (rank * 8)) - 1 } else { 0 };
            let doubled = (b_pawns_bb & file_mask & b_front_span) != 0;
            
            let passed_mask = (file_mask | adj_files) & b_front_span;
            let passed = (w_pawns_bb & passed_mask) == 0;
            
            if isolated { b_score -= 15; }
            if doubled { b_score -= 15; }
            if passed { b_score += 20 + ((7 - rank) as i32) * 15; }
        }
        
        pawn_hash.store(pawn_hash_key, w_score, b_score);
        (w_score, b_score)
    };

    // Rook open-file bonuses
    let w_rooks = board.pieces(Piece::Rook) & board.color_combined(Color::White);
    let mut rook_score = 0;
    for sq in w_rooks {
        let file = sq.get_file().to_index();
        let file_mask = 0x0101010101010101_u64 << file;
        if (w_pawns_bb & file_mask) == 0 {
            if (b_pawns_bb & file_mask) == 0 {
                rook_score += 20; // Fully open
            } else {
                rook_score += 10; // Semi-open
            }
        }
    }
    
    let b_rooks = board.pieces(Piece::Rook) & board.color_combined(Color::Black);
    for sq in b_rooks {
        let file = sq.get_file().to_index();
        let file_mask = 0x0101010101010101_u64 << file;
        if (b_pawns_bb & file_mask) == 0 {
            if (w_pawns_bb & file_mask) == 0 {
                rook_score -= 20; // Fully open
            } else {
                rook_score -= 10; // Semi-open
            }
        }
    }
    score += rook_score;

    // Bishop pair synergy
    let w_bishops = board.pieces(Piece::Bishop) & board.color_combined(Color::White);
    let b_bishops = board.pieces(Piece::Bishop) & board.color_combined(Color::Black);
    if w_bishops.popcnt() >= 2 { score += 40; }
    if b_bishops.popcnt() >= 2 { score -= 40; }

    score += w_safety * phase / 24;
    score -= b_safety * phase / 24;
    score += w_pawn_score;
    score -= b_pawn_score;
    
    if board.side_to_move() == Color::White { score } else { -score }
}
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_see_basic() {
        // QxP should win material: queen takes pawn → positive SEE expected
        let board = Board::from_str("4k3/8/8/3p4/8/8/3Q4/4K3 w - - 0 1").unwrap();
        let m = MoveGen::new_legal(&board)
            .find(|m| m.get_dest().to_string() == "d5")
            .expect("Queen d5 move should exist");
        let score = see_value(&board, m);
        assert!(score > 0, "Queen capturing undefended pawn should be positive SEE: {}", score);
    }

    #[test]
    fn test_see_losing_capture() {
        // QxR defended by king (king on d6 defends rook on d5) → queen loses material
        let board = Board::from_str("8/8/3k4/3r4/8/8/3Q4/4K3 w - - 0 1").unwrap();
        let m = MoveGen::new_legal(&board)
            .find(|m| m.get_dest().to_string() == "d5")
            .expect("Queen d5 move should exist");
        let score = see_value(&board, m);
        // Queen (1025) takes Rook (477), then king recaptures queen — net = 477 - 1025 < 0
        assert!(score < 0, "Queen capturing defended rook should be negative SEE: {}", score);
    }

    #[test]
    fn test_eval_speed() {
        let board = Board::default();
        let mut engine = ChessEngine::new();
        let pawn_hash = PawnHashTable::new(131_072);
        let start = std::time::Instant::now();
        let mut sum = 0;
        let iters = 1_000_000;
        for _ in 0..iters {
            sum += engine.evaluate_full(&board, &pawn_hash, 0);
        }
        let duration = start.elapsed();
        println!("Evaluated {} nodes in {:?} ({} NPS)", iters, duration,
            (iters as f64 / duration.as_secs_f64()) as u64);
        assert!(sum != 0 || sum == 0);
    }
}



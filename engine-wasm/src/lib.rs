pub mod nnue;
mod book;
pub mod polyglot;
mod timeman;
use nnue::{Network, Accumulator};

use wasm_bindgen::prelude::*;
pub use wasm_bindgen_rayon::init_thread_pool;
use chess::{Board, ChessMove, Color, Piece, MoveGen, Rank, Square};
use std::collections::HashMap;
use arrayvec::ArrayVec;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

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
                    // Aggressive LMR tuning: larger base and steeper curve
                    let r = 0.75 + ((d as f64).ln() * (m as f64).ln() / 1.95);
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

    fn probe(&self, key: u64) -> Option<(i32, i32, i32, i32)> {
        let index = (key as usize) & self.mask;
        let entry = &self.entries[index];
        let data = entry.data.load(Ordering::Acquire);
        let stored_hash = entry.hash.load(Ordering::Acquire);
        if (stored_hash ^ data) == key && key != 0 {
            let wb = (data as u16 as i16) as i32;
            let wp = ((data >> 16) as u16 as i16) as i32;
            let bb = ((data >> 32) as u16 as i16) as i32;
            let bp = ((data >> 48) as u16 as i16) as i32;
            Some((wb, wp, bb, bp))
        } else {
            None
        }
    }

    fn store(&self, key: u64, wb: i32, wp: i32, bb: i32, bp: i32) {
        let index = (key as usize) & self.mask;
        let entry = &self.entries[index];
        let data = (wb as i16 as u16 as u64)
            | ((wp as i16 as u16 as u64) << 16)
            | ((bb as i16 as u16 as u64) << 32)
            | ((bp as i16 as u16 as u64) << 48);
        entry.data.store(data, Ordering::Release);
        entry.hash.store(key ^ data, Ordering::Release);
    }
}

#[cfg(target_arch = "wasm32")]
fn current_time_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn current_time_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64
}

#[wasm_bindgen]
pub struct ChessEngine {
    killers: [[Option<ChessMove>; 2]; 128],
    /// Butterfly history table for move ordering heuristics.
    history: [[i32; 64]; 64],
    stop_search: bool,
    optimum_time_ms: f64,
    maximum_time_ms: f64,
    start_time: f64,
    /// Total nodes visited across the current search.
    nodes: u64,
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
    capture_history: Box<[[[i32; 6]; 64]; 6]>,
    pawn_corr_table: Box<[[i32; 16384]; 2]>,
    custom_polyglot_book: Option<Vec<u8>>,
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
            optimum_time_ms: 0.0,
            maximum_time_ms: 0.0,
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
            capture_history: Box::new([[[0; 6]; 64]; 6]),
            pawn_corr_table: Box::new([[0; 16384]; 2]),
            custom_polyglot_book: None,
        }
    }

    #[wasm_bindgen]
    pub fn load_polyglot_book(&mut self, data: js_sys::Uint8Array) -> bool {
        let mut bytes = vec![0; data.length() as usize];
        data.copy_to(&mut bytes[..]);
        self.load_polyglot_book_native(&bytes)
    }

    pub fn load_polyglot_book_native(&mut self, bytes: &[u8]) -> bool {
        if bytes.len() >= polyglot::PolyglotEntry::SIZE && bytes.len() % polyglot::PolyglotEntry::SIZE == 0 {
            self.custom_polyglot_book = Some(bytes.to_vec());
            true
        } else {
            false
        }
    }

    #[wasm_bindgen]
    pub fn load_network(&mut self, data: js_sys::Uint8Array) -> bool {
        let mut bytes = vec![0; data.length() as usize];
        data.copy_to(&mut bytes[..]);
        self.load_network_native(&bytes)
    }

    pub fn load_network_native(&mut self, bytes: &[u8]) -> bool {
        let mut offset = 0;
        if bytes.len() < 12 { return false; }
        
        let _version = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        let _hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        let desc_len = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize; offset += 4;
        
        if desc_len > bytes.len().saturating_sub(offset) { return false; } offset += desc_len;
        
        // Exact size required after desc_len: 
        // ft_hash(4) + f_biases(512) + f_weights(21004288) + fc_hash(4) + fc0_b(128) + fc0_w(16384) + fc1_b(128) + fc1_w(1024) + fc2_b(4) + fc2_w(32) = 21022508
        const NETWORK_PAYLOAD_SIZE: usize = 21_022_508; if NETWORK_PAYLOAD_SIZE > bytes.len().saturating_sub(offset) { return false; }
        
        let _ft_hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        
        let mut net = Box::new(Network::new_halfkp());
        
        for i in 0..nnue::HALFKP_HIDDEN_SIZE {
            net.feature_biases[i] = i16::from_le_bytes(bytes[offset..offset+2].try_into().unwrap());
            offset += 2;
        }
        for i in 0..(nnue::HALFKP_INPUT_SIZE * nnue::HALFKP_HIDDEN_SIZE) {
            let weight = i16::from_le_bytes(bytes[offset..offset+2].try_into().unwrap());
            offset += 2;
            net.feature_weights[i] = weight;
        }
        
        let _fc_hash = u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()); offset += 4;
        
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
        // Each bucket contains two 16-byte TTEntry (total 32 bytes):
        let buckets = ((mb * 1024 * 1024) / 32).max(1024).next_power_of_two();
        let mut tt_lock = GLOBAL_TT
            .get_or_init(|| RwLock::new(Arc::new(TranspositionTable::new(buckets))))
            .write()
            .unwrap();
        if tt_lock.size != buckets {
            *tt_lock = Arc::new(TranspositionTable::new(buckets));
        }
        
        let mut pawn_lock = GLOBAL_PAWN_HASH.get_or_init(|| RwLock::new(Arc::new(PawnHashTable::new(131_072)))).write().unwrap();
        if pawn_lock.entries.len() != 131_072 {
            *pawn_lock = Arc::new(PawnHashTable::new(131_072));
        }
    }

    #[wasm_bindgen]
    pub fn get_best_move_timed(&mut self, fen: &str, my_ms: f64, inc_ms: f64, opp_ms: f64, moves_to_go: i32, overhead_ms: f64, elo: f64, split_id: u8, split_count: u8, history: &str, abort_flag: Option<js_sys::Uint8Array>) -> String {
        self.abort_flag = abort_flag;
        let piece_count = fen.split_whitespace().next().unwrap_or("").chars().filter(|c| c.is_alphabetic()).count() as u32;
        let clock = timeman::ClockInfo {
            remaining_ms: my_ms,
            increment_ms: inc_ms,
            opponent_remaining_ms: opp_ms,
            moves_to_go: if moves_to_go > 0 { Some(moves_to_go as u32) } else { None },
            move_overhead_ms: overhead_ms,
            piece_count,
        };
        let budget = timeman::allocate(&clock);
        self.optimum_time_ms = budget.optimum_ms;
        self.maximum_time_ms = budget.maximum_ms;
        self.get_best_move_internal(fen, elo, split_id, split_count, history)
    }

    #[wasm_bindgen]
    pub fn get_best_move(&mut self, fen: &str, optimum_time_ms: f64, elo: f64, split_id: u8, split_count: u8, history: &str, abort_flag: Option<js_sys::Uint8Array>) -> String {
        self.abort_flag = abort_flag;
        self.optimum_time_ms = optimum_time_ms;
        self.maximum_time_ms = optimum_time_ms * 1.2;
        self.get_best_move_internal(fen, elo, split_id, split_count, history)
    }

    
    pub fn get_best_move_timed_native(&mut self, fen: &str, my_ms: f64, inc_ms: f64, opp_ms: f64, moves_to_go: i32, overhead_ms: f64, elo: f64, split_id: u8, split_count: u8, history: &str) -> String {
        self.abort_flag = None;
        let piece_count = fen.split_whitespace().next().unwrap_or("").chars().filter(|c| c.is_alphabetic()).count() as u32;
        let clock = timeman::ClockInfo {
            remaining_ms: my_ms,
            increment_ms: inc_ms,
            opponent_remaining_ms: opp_ms,
            moves_to_go: if moves_to_go > 0 { Some(moves_to_go as u32) } else { None },
            move_overhead_ms: overhead_ms,
            piece_count,
        };
        let budget = timeman::allocate(&clock);
        self.optimum_time_ms = budget.optimum_ms;
        self.maximum_time_ms = budget.maximum_ms;
        self.get_best_move_internal(fen, elo, split_id, split_count, history)
    }

    pub fn get_best_move_native(&mut self, fen: &str, optimum_time_ms: f64, elo: f64, split_id: u8, split_count: u8, history: &str) -> String {
        self.abort_flag = None;
        self.optimum_time_ms = optimum_time_ms;
        self.maximum_time_ms = optimum_time_ms * 1.2;
        self.get_best_move_internal(fen, elo, split_id, split_count, history)
    }

    fn get_best_move_internal(&mut self, fen: &str, elo: f64, split_id: u8, split_count: u8, history: &str) -> String {
        let board = match Board::from_str(&fen) {
            Ok(b) => b,
            Err(_) => return "{\"bestMove\":\"\",\"ponderFen\":\"\",\"score\":0,\"depth\":0,\"nodes\":0,\"pv\":[]}".to_string(),
        };

        // Multi-tier opening book lookup:
        // Tier 1: Custom loaded Polyglot book (if provided)
        let mut book_move_str = None;
        if let Some(custom_book) = &self.custom_polyglot_book {
            if let Some(m) = polyglot::probe_polyglot(custom_book, &board) {
                book_move_str = Some(m.to_string());
            }
        }
        // Tier 2: Embedded Master Polyglot book (covering ECO A00-E99 grandmaster lines)
        if book_move_str.is_none() {
            if let Some(m) = polyglot::probe_polyglot(polyglot::EMBEDDED_MASTER_BOOK, &board) {
                book_move_str = Some(m.to_string());
            }
        }
        // Tier 3: Built-in static fallback book
        if book_move_str.is_none() {
            if let Some(m) = book::get_book_move(fen) {
                book_move_str = Some(m.to_string());
            }
        }

        if let Some(book_move) = book_move_str {
            return format!("{{\"bestMove\":\"{}\",\"ponderFen\":\"\",\"score\":0,\"depth\":1,\"nodes\":1,\"pv\":[\"{}\"]}}", book_move, book_move);
        }
        
        let tt = get_tt();
        let pawn_hash = get_pawn_hash();

        self.nodes = 0;
        self.stop_search = false;
        self.elo = elo as u32;
        // Bump generation every search so old TT entries are more aggressively replaced.
        self.search_generation = self.search_generation.wrapping_add(1);

        // History gravity: age heuristic scores to prevent stale move ordering.
        for from in 0..64usize {
            for to in 0..64usize {
                self.history[from][to] /= 2;
            }
        }
        for val in &mut self.followup_history {
            *val /= 2;
        }
        for a in 0..6 {
            for s in 0..64 {
                for v in 0..6 {
                    self.capture_history[a][s][v] /= 2;
                }
            }
        }
        self.killers = [[None; 2]; 128];

        let halfmove_clock: u8 = fen.split_whitespace().nth(4).unwrap_or("0").parse().unwrap_or(0);
        
        // Rebuild the set of past position hashes for 3-fold repetition detection.
        self.history_hashes = parse_history_hashes(history);

        let moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(&board).collect();
        let my_moves = moves.len();
        if my_moves == 0 {
            let is_check = board.checkers().popcnt() > 0;
            let score = if is_check { -MATE } else { 0 };
            return format!("{{\"bestMove\":\"\",\"ponderFen\":\"\",\"score\":{},\"depth\":0,\"nodes\":0,\"pv\":[]}}", score);
        }

        if my_moves == 1 {
            let only_move = moves[0];
            let next_board = board.make_move_new(only_move);
            return format!(
                "{{\"bestMove\":\"{}\",\"ponderFen\":\"{}\",\"score\":0,\"depth\":1,\"nodes\":1,\"pv\":[\"{}\"]}}",
                only_move.to_string(),
                next_board.to_string(),
                only_move.to_string()
            );
        }

        self.start_time = current_time_ms();
        
        if let Some(network) = &self.network {
            nnue::refresh_accumulator(network, &mut self.accumulators[0], &board);
        }

        let mut best_move: Option<ChessMove> = tt.probe(board.get_hash(), 0)
            .and_then(|e| e.best_move)
            .filter(|&m| moves.iter().any(|&lm| lm == m))
            .or_else(|| moves.first().copied());
        let mut best_score = -INF;
        let mut best_move_stable_iterations = 0;
        let mut previous_best_move: Option<ChessMove> = None;
        let mut previous_best_score = -INF;
        
        let mut depth_reached: u8 = 0;
        
        let max_depth = if elo < 500.0 { 2 } 
                        else if elo < 1000.0 { 4 } 
                        else if elo < 1500.0 { 6 } 
                        else if elo < 1800.0 { 8 } 
                        else if elo < 2000.0 { 12 } 
                        else { 64 };
        let max_horizon = max_depth;
        let base_opt = self.optimum_time_ms;
        let mut time_scale = 1.0f64;

        for base_depth in 1..=64u8 {
            let depth = base_depth + if split_count > 1 { (split_id % 2) as u8 } else { 0 };
            if depth > max_horizon { break; }
            


            let (mut alpha, mut beta, mut delta) = if depth <= 4 || best_score == -INF {
                (-INF, INF, INF)
            } else {
                let init_delta = if split_count > 1 && split_id > 0 { 75 } else { 50 };
                (best_score - init_delta, best_score + init_delta, init_delta)
            };

            let mut completed_search = false;
            let mut current_move = None;
            let mut current_best_score = -INF;
            let mut current_second_best = -INF;

            loop {
                let result = self.search_root(&board, depth, alpha, beta, split_id as u32, split_count as u32, halfmove_clock, &tt, &pawn_hash);
                if self.stop_search { break; }
                
                let elapsed_check = current_time_ms() - self.start_time;
                if elapsed_check >= self.maximum_time_ms {
                    self.stop_search = true;
                }

                if delta == INF {
                    current_move = result.0;
                    current_best_score = result.1;
                    current_second_best = result.2;
                    completed_search = true;
                    break;
                }

                if result.1 <= alpha {
                    alpha = (alpha - delta).max(-INF);
                    delta += delta / 2;
                    if delta > 2000 { alpha = -INF; beta = INF; delta = INF; }
                } else if result.1 >= beta {
                    beta = (beta + delta).min(INF);
                    delta += delta / 2;
                    if delta > 2000 { alpha = -INF; beta = INF; delta = INF; }
                } else {
                    current_move = result.0;
                    current_best_score = result.1;
                    current_second_best = result.2;
                    completed_search = true;
                    break;
                }

                if self.stop_search { break; }
            }

            if self.stop_search && !completed_search {
                // Incomplete or timed out search on this depth — keep previous completed best_move!
                break;
            }

            if let Some(m) = current_move {
                best_move = Some(m);
                best_score = current_best_score;
            }
            if self.stop_search { break; }
            
            depth_reached = depth;
            
            // TimeScaler logic
            if previous_best_move == best_move {
                best_move_stable_iterations += 1;
            } else {
                best_move_stable_iterations = 0;
                // Best move changed: extend time slightly
                time_scale = (time_scale * 1.3).min(self.maximum_time_ms / base_opt.max(1.0));
            }
            
            // Score dropped significantly: extend time
            if depth > 1 && previous_best_score - best_score > 40 {
                time_scale = (time_scale * 1.5).min(self.maximum_time_ms / base_opt.max(1.0));
            }
            
            // Reductions for stable or easy move: calculated per depth from base, not accumulated indefinitely
            let mut reduction_factor = 1.0f64;
            if best_move_stable_iterations >= 4 {
                reduction_factor *= 0.85; // conservative reduction
            }
            
            // "Easy move": best move is significantly better than the second best (> 120 cp)
            if depth >= 8 && best_move_stable_iterations >= 3 && (best_score - current_second_best > 120) {
                reduction_factor *= 0.80; // genuine easy move, save time
            }

            self.optimum_time_ms = ((base_opt * time_scale) * reduction_factor).clamp(10.0, self.maximum_time_ms);

            previous_best_move = best_move;
            previous_best_score = best_score;

            // Do not start next depth if soft time is up.
            let elapsed = current_time_ms() - self.start_time;
            if elapsed > self.optimum_time_ms * 0.75 {
                break;
            }

        }
        

        // elo >= 2400: always play the best found move, no blunder simulation.

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
        
        if pv.is_empty() {
            if let Some(m) = best_move {
                pv.push(format!("\"{}\"", m.to_string()));
            }
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
                    if MoveGen::new_legal(&pv_board).any(|legal| legal == opp_m) { pv_board = pv_board.make_move_new(opp_m); }
                }
            }
            ponder_fen = pv_board.to_string(); 
        }

        format!(
            "{{\"bestMove\":\"{}\",\"ponderFen\":\"{}\",\"score\":{},\"depth\":{},\"nodes\":{},\"pv\":[{}]}}",
            best_move_str,
            ponder_fen,
            best_score,
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
#[allow(dead_code)]
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
        let mut entries = Vec::with_capacity(size * 2);
        for _ in 0..(size * 2) {
            entries.push(TTEntry { hash: AtomicU64::new(0), data: AtomicU64::new(0) });
        }
        Self {
            entries: entries.into_boxed_slice(),
            size,
        }
    }
    
    fn store(&self, hash: u64, best_move: Option<ChessMove>, depth: u8, mut score: i32, flag: u8, ply: u8, generation: u8) {
        if score > MATE - 128 { score += ply as i32; } else if score < -MATE + 128 { score -= ply as i32; }
        
        let index = ((hash as usize) & (self.size - 1)) * 2;
        let entry0 = &self.entries[index];
        let stored_data0 = entry0.data.load(Ordering::Relaxed);
        let stored_hash0 = entry0.hash.load(Ordering::Acquire) ^ stored_data0;

        // Preserve previous best_move if slot 0 already has the same position and new entry has None
        let final_move = if best_move.is_none() && stored_hash0 == hash {
            unpack_move((stored_data0 & 0xFFFF) as u16)
        } else {
            best_move
        };

        let m_val = pack_move(final_move) as u64;
        let s_val = (score as i16 as u16 as u64) << 16;
        let d_val = u64::from(depth.min(63)) << 32;
        let f_val = ((flag as u64) & 0x3) << 38;
        let g_val = ((generation as u64) & 0xFF) << 40;
        let data = m_val | s_val | d_val | f_val | g_val;

        let old_depth0 = ((stored_data0 >> 32) & 0x3F) as u8;
        let old_gen0 = ((stored_data0 >> 40) & 0xFF) as u8;

        // Slot 0: Depth / Generation prioritized slot
        let replace_slot0 = stored_hash0 == 0
            || stored_hash0 == hash
            || depth >= old_depth0
            || (old_gen0 != generation && depth + 4 >= old_depth0);
        if replace_slot0 {
            // Displace older slot 0 entry to slot 1 when overwriting a different valid position
            if stored_hash0 != 0 && stored_hash0 != hash {
                let entry1 = &self.entries[index + 1];
                entry1.data.store(stored_data0, Ordering::Relaxed);
                entry1.hash.store(stored_hash0 ^ stored_data0, Ordering::Release);
            }
            entry0.data.store(data, Ordering::Relaxed);
            entry0.hash.store(hash ^ data, Ordering::Release);
            return;
        }

        // Slot 1: Always-Replace slot
        let entry1 = &self.entries[index + 1];
        entry1.data.store(data, Ordering::Relaxed);
        entry1.hash.store(hash ^ data, Ordering::Release);
    }
    
    fn probe(&self, hash: u64, ply: u8) -> Option<TTProbeResult> {
        let index = ((hash as usize) & (self.size - 1)) * 2;
        
        let mut best_res = None;
        
        let entry0 = &self.entries[index];
        let data0 = entry0.data.load(Ordering::Relaxed);
        let stored_hash0 = entry0.hash.load(Ordering::Acquire) ^ data0;
        
        if stored_hash0 == hash && hash != 0 {
            let mut score0 = ((data0 >> 16) as u16 as i16) as i32;
            if score0 > MATE - 128 { score0 -= ply as i32; } else if score0 < -MATE + 128 { score0 += ply as i32; }
            best_res = Some(TTProbeResult {
                hash,
                best_move: unpack_move((data0 & 0xFFFF) as u16),
                depth: ((data0 >> 32) & 0x3F) as u8,
                score: score0,
                flag: ((data0 >> 38) & 0x3) as u8,
                generation: ((data0 >> 40) & 0xFF) as u8,
            });
        }
        
        let entry1 = &self.entries[index + 1];
        let data1 = entry1.data.load(Ordering::Relaxed);
        let stored_hash1 = entry1.hash.load(Ordering::Acquire) ^ data1;
        
        if stored_hash1 == hash && hash != 0 {
            let mut score1 = ((data1 >> 16) as u16 as i16) as i32;
            if score1 > MATE - 128 { score1 -= ply as i32; } else if score1 < -MATE + 128 { score1 += ply as i32; }
            let depth1 = ((data1 >> 32) & 0x3F) as u8;
            
            if best_res.as_ref().map_or(true, |r| depth1 > r.depth) {
                best_res = Some(TTProbeResult {
                    hash,
                    best_move: unpack_move((data1 & 0xFFFF) as u16),
                    depth: depth1,
                    score: score1,
                    flag: ((data1 >> 38) & 0x3) as u8,
                    generation: ((data1 >> 40) & 0xFF) as u8,
                });
            }
        }
        
        best_res
    }
}


#[inline(always)]
fn get_move_props(board: &Board, m: ChessMove) -> (bool, bool, bool) {
    let piece = board.piece_on(m.get_source());
    let is_pawn_move = piece == Some(Piece::Pawn);
    let is_capture_normal = board.piece_on(m.get_dest()).is_some();
    let is_ep = is_pawn_move && m.get_source().get_file() != m.get_dest().get_file() && !is_capture_normal;
    let is_capture = is_capture_normal || is_ep;
    (is_capture, is_ep, is_pawn_move)
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
        let now = current_time_ms();
        if now - self.start_time >= self.maximum_time_ms {
            self.stop_search = true;
        }
    }

    fn score_move(&self, board: &Board, m: &ChessMove, ply: u8, tt_best_move: Option<ChessMove>) -> i32 {
        if Some(*m) == tt_best_move { return 10_000_000; }

        // Captures: order by SEE value.
        // Good captures (SEE ≥ 0) come before promotions/killers.
        // Bad captures (SEE < 0) are searched last (negative score).
        let (is_capture, is_ep, _is_pawn_move) = get_move_props(board, *m);
        if is_capture {
            let see = see_value(board, *m);
            let victim = if is_ep { Piece::Pawn } else { board.piece_on(m.get_dest()).unwrap_or(Piece::Pawn) };
            let attacker = board.piece_on(m.get_source()).unwrap_or(Piece::Pawn);
            let mut prom_bonus = 0;
            if let Some(prom) = m.get_promotion() {
                if prom == Piece::Queen { prom_bonus = 5000; }
            }
            let mvv_lva = piece_value_mg(victim) * 10 - piece_value_mg(attacker) + prom_bonus;
            let cap_hist = self.capture_history[attacker as usize][m.get_dest().to_index()][victim as usize];
            let cap_scaled = (cap_hist / 16).clamp(-10_000, 10_000);
            return if see >= 0 { 100_000 + mvv_lva + cap_scaled } else { -50_000 + mvv_lva + cap_scaled };
        }

        // Non-capture promotions
        if let Some(prom) = m.get_promotion() {
            return match prom {
                Piece::Queen => 95_000,
                Piece::Knight => 10_000,
                _ => -20_000,
            };
        }

        if (ply as usize) < 128 {
            if Some(*m) == self.killers[ply as usize][0] { return 80_000; }
            if Some(*m) == self.killers[ply as usize][1] { return 75_000; }
            
            if ply > 0 {
                if let Some(prev) = self.search_path_moves[(ply - 1) as usize] {
                    let prev_piece = board.piece_on(prev.get_dest()).unwrap_or(Piece::Pawn);
                    let prev_color = !board.side_to_move();
                    if self.counter_moves[prev_color as usize][prev_piece as usize][prev.get_dest().to_index()] == Some(*m) {
                        return 70_000;
                    }
                }
            }
            
            let mut hist = self.history[m.get_source().to_index()][m.get_dest().to_index()];
            if ply > 1 {
                if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                    let idx = (prev2.get_dest().to_index() * 4096) + (m.get_source().to_index() * 64) + m.get_dest().to_index();
                    hist += self.followup_history[idx];
                }
            }
            // Strict clamping to [-40_000, 40_000] ensures quiet moves never surpass Counter (70k),
            // Killers (75k/80k), Queen promotions (95k), or Good Captures (100k+)
            return hist.clamp(-40_000, 40_000);
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

    fn search_root(&mut self, board: &Board, depth: u8, mut alpha: i32, beta: i32, split_id: u32, split_count: u32, halfmove_clock: u8, tt: &TranspositionTable, pawn_hash: &PawnHashTable) -> (Option<ChessMove>, i32, i32) {
        let mut best_move = None;
        let mut best_score = -INF;
        let mut second_best = -INF;
        
        let original_alpha = alpha;
        
        let hash = board.get_hash();
        self.search_path[0] = hash;
        let tt_best_move = tt.probe(hash, 0).and_then(|entry| entry.best_move);

        let mut moves: ArrayVec<ChessMove, 256> = MoveGen::new_legal(board).collect();
        if moves.is_empty() { return (None, if board.checkers().popcnt() > 0 { -MATE } else { 0 }, -INF); }
        
        let mut scores = self.score_moves(board, &moves, 0, tt_best_move);

        // Root Move Distribution (SMP Lazy Diversification):
        // TT best move (if any) keeps highest priority (score 10,000,000).
        // For remaining moves, assign helper workers (split_id > 0) a priority bonus
        // on their modulo-assigned moves so that workers explore disjoint root subtrees
        // and populate the shared Transposition Table without duplicated effort.
        if split_count > 1 && split_id > 0 {
            for (idx, m) in moves.iter().enumerate() {
                if Some(*m) != tt_best_move {
                    if (idx % split_count as usize) == (split_id as usize % split_count as usize) {
                        scores[idx] += 500_000;
                    }
                }
            }
        }

        if moves.is_empty() { return (None, -INF, -INF); }

        let mut b_search_pv = true;

        for i in 0..moves.len() {
            self.pick_move(&mut moves, &mut scores, i);
            let m = moves[i];
            
            let next_board = board.make_move_new(m);
            self.update_nnue(0, board, &next_board);
            let (is_capture, _is_ep, is_pawn_move) = get_move_props(board, m);
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
                second_best = best_score;
                best_score = score;
                best_move = Some(m);
            } else if score > second_best {
                second_best = score;
            }
            if score > alpha { alpha = score; }
            if alpha >= beta { break; }
        }
        if !self.stop_search {
            let flag = if best_score <= original_alpha { UPPERBOUND } else if best_score >= beta { LOWERBOUND } else { EXACT };
            tt.store(hash, best_move, depth, best_score, flag, 0, self.search_generation);
        }
        (best_move, best_score, second_best)
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
        if (self.nodes & 131071) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        let hash = board.get_hash();
        let history_count = if halfmove_clock >= ply && !self.history_hashes.is_empty() {
            self.history_hashes.get(&hash).copied().unwrap_or(0)
        } else {
            0
        };
        let mut path_rep = 0;
        let limit = ply.saturating_sub(halfmove_clock);
        if ply > limit {
            let mut i = ply;
            while i >= limit + 2 {
                i -= 2;
                if self.search_path[i as usize] == hash {
                    path_rep += 1;
                }
            }
        }
        if history_count >= 2 || path_rep >= 1 { return 0; }
        if (ply as usize) < 128 {
            self.search_path[ply as usize] = hash;
        }


        let mut tt_move = None;
        if let Some(entry) = tt.probe(hash, ply) {
            tt_move = entry.best_move;
            if entry.flag == EXACT { return entry.score; }
            if entry.flag == LOWERBOUND && entry.score >= beta { return entry.score; }
            if entry.flag == UPPERBOUND && entry.score <= alpha { return entry.score; }
        }

        let in_check = board.checkers().popcnt() > 0;
        let stand_pat = if in_check { 
            0 
        } else { 
            let base_eval = self.evaluate_full(board, pawn_hash, ply);
            if halfmove_clock > 40 && base_eval.abs() < MATE - 1000 {
                (base_eval * (200 - halfmove_clock as i32)) / 200
            } else {
                base_eval
            }
        };
        let original_alpha = alpha;
        
        if !in_check {
            if stand_pat >= beta { 
                tt.store(hash, None, 0, stand_pat, LOWERBOUND, ply, self.search_generation);
                return stand_pat; 
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
            }
            return stand_pat;
        }

        let mut best_score = if in_check { -INF } else { stand_pat };
        let mut best_move = None;

        for i in 0..moves.len() {
            self.pick_move(&mut moves, &mut scores, i);
            let m = moves[i];
            let move_score = scores[i];
            
            let (is_capture, is_ep, is_pawn_move) = get_move_props(board, m);

            if !in_check && stand_pat + 1225 < alpha && m.get_promotion().is_none() {
                continue;
            }

            // Full SEE filter for captures in quiescence search.
            if !in_check && m.get_promotion().is_none() && is_capture {
                // score_move already computed SEE and assigned -50_000 + mvv_lva (< 0) to losing captures
                if move_score < 0 { continue; }

                // Delta pruning: if even an optimistic continuation can't reach alpha, skip.
                let captured_val = if is_ep {
                    piece_value_mg(Piece::Pawn)
                } else {
                    board.piece_on(m.get_dest()).map_or(0, piece_value_mg)
                };
                if stand_pat + captured_val + 150 <= alpha { continue; }
            }

            let next_board = board.make_move_new(m);
            self.update_nnue(ply, board, &next_board);
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

    // Helper to detect strictly drawn insufficient material
    fn is_insufficient_material(&self, board: &Board) -> bool {
        let pawns = board.pieces(Piece::Pawn).popcnt();
        let rooks = board.pieces(Piece::Rook).popcnt();
        let queens = board.pieces(Piece::Queen).popcnt();
        
        if pawns > 0 || rooks > 0 || queens > 0 {
            return false; // Still winning potential
        }
        
        let knights = board.pieces(Piece::Knight).popcnt();
        let bishops = board.pieces(Piece::Bishop).popcnt();
        
        // K vs K
        if knights == 0 && bishops == 0 { return true; }
        
        // K+N vs K or K+B vs K
        if (knights == 1 && bishops == 0) || (knights == 0 && bishops == 1) { return true; }
        
        false
    }

    fn negamax(&mut self, board: &Board, depth: u8, mut alpha: i32, beta: i32, ply: u8, halfmove_clock: u8, tt: &TranspositionTable, pawn_hash: &PawnHashTable) -> i32 {
        if ply >= 127 { return self.evaluate_full(board, pawn_hash, ply); }
        self.nodes += 1;
        if (self.nodes & 131071) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        if halfmove_clock >= 100 { return 0; }
        if self.is_insufficient_material(board) { return 0; }
        
        let hash = board.get_hash();
        let history_count = if halfmove_clock >= ply && !self.history_hashes.is_empty() {
            self.history_hashes.get(&hash).copied().unwrap_or(0)
        } else {
            0
        };
        let mut path_rep = 0;
        let limit = ply.saturating_sub(halfmove_clock);
        if ply > limit {
            let mut i = ply;
            while i >= limit + 2 {
                i -= 2;
                if self.search_path[i as usize] == hash {
                    path_rep += 1;
                }
            }
        }
        if history_count >= 2 || path_rep >= 1 { return 0; }
        if (ply as usize) < 128 {
            self.search_path[ply as usize] = hash;
        }
        
        let is_check = board.checkers().popcnt() > 0;
        
        if depth == 0 { 
            return self.quiescence_search(board, alpha, beta, ply, halfmove_clock, tt, pawn_hash);
        }

        // ---- TT probe FIRST: if we have a sufficient hit, return early ----
        // (moved before static_eval to avoid computing eval when TT suffices)
        let mut tt_best_move = None;
        let mut tt_score_for_singular: Option<i32> = None;
        let mut tt_depth_for_singular: u8 = 0;
        let mut tt_flag_for_singular: u8 = UPPERBOUND;
        if let Some(entry) = tt.probe(hash, ply) {
            tt_best_move = entry.best_move;
            tt_score_for_singular = Some(entry.score);
            tt_depth_for_singular = entry.depth;
            tt_flag_for_singular = entry.flag;
            if entry.depth >= depth {
                if entry.flag == EXACT { return entry.score; }
                if entry.flag == LOWERBOUND && entry.score >= beta { return entry.score; }
                if entry.flag == UPPERBOUND && entry.score <= alpha { return entry.score; }
            }
        }

        // Internal Iterative Deepening (IID)
        let is_pv_node = beta > alpha + 1;
        if depth >= 4 && tt_best_move.is_none() && is_pv_node && !is_check {
            let iid_depth = depth - 2;
            self.negamax(board, iid_depth, alpha, beta, ply, halfmove_clock, tt, pawn_hash);
            if self.stop_search { return 0; }
            if let Some(entry) = tt.probe(hash, ply) {
                tt_best_move = entry.best_move;
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

        // Reverse Futility Pruning (RFP) — only on non-PV nodes
        if !is_pv_node && !is_check && depth <= 6 {
            let margin = depth as i32 * 75;
            if static_eval - margin >= beta {
                return static_eval;
            }
        }



        let stm_pieces = board.color_combined(board.side_to_move()) & (board.pieces(Piece::Knight) | board.pieces(Piece::Bishop) | board.pieces(Piece::Rook) | board.pieces(Piece::Queen));
        let has_pieces = stm_pieces.popcnt() > 0;

        let prev_was_null = ply > 0 && self.search_path_moves[(ply - 1) as usize].is_none();
        if !is_pv_node && !is_check && !prev_was_null && depth >= 3 && static_eval >= beta && has_pieces && (ply as usize) < 128 {
            if let Some(null_board) = board.null_move() {
                if self.network.is_some() && ((ply + 1) as usize) < self.accumulators.len() {
                    self.accumulators[(ply + 1) as usize] = self.accumulators[ply as usize];
                }
                let mut r = 3 + depth / 3;
                let eval_diff = static_eval.saturating_sub(beta);
                if eval_diff > 0 {
                    r += (eval_diff / 200).min(3) as u8;
                }
                let reduced_depth = if depth > r { depth - r - 1 } else { 0 };
                let old_move = self.search_path_moves[ply as usize];
                self.search_path_moves[ply as usize] = None;
                let null_score = -self.negamax(&null_board, reduced_depth, -beta, -beta + 1, ply.saturating_add(1), 0, tt, pawn_hash);
                self.search_path_moves[ply as usize] = old_move;
                if self.stop_search { return 0; }
                if null_score >= beta {
                    if null_score >= MATE - 128 {
                        self.search_path_moves[ply as usize] = None;
                        let verify_score = self.negamax(board, depth - 1, beta - 1, beta, ply.saturating_add(1), halfmove_clock, tt, pawn_hash);
                        self.search_path_moves[ply as usize] = old_move;
                        if verify_score >= beta { return verify_score; }
                    } else {
                        return null_score;
                    }
                }
            }
        }

        // ProbCut: test only captures/promotions with SEE >= bound - static_eval at reduced depth
        if !is_pv_node && !is_check && depth >= 5 && beta < MATE - 128 {
            let bound = beta + 200;
            for &m in &moves {
                let (is_capture, _, is_pawn_move) = get_move_props(board, m);
                if !is_capture && m.get_promotion().is_none() {
                    continue;
                }
                if see_value(board, m) < bound - static_eval {
                    continue;
                }
                let next_board = board.make_move_new(m);
                self.update_nnue(ply, board, &next_board);
                if (ply as usize) < 128 {
                    self.search_path_moves[ply as usize] = Some(m);
                }
                let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
                let probcut_score = -self.negamax(&next_board, depth - 4, -bound, -bound + 1, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
                if self.stop_search { return 0; }
                if probcut_score >= bound {
                    return probcut_score;
                }
            }
        }


        let mut best_score = -INF;
        let mut second_best = -INF;
        let mut best_move = None;
        let original_alpha = alpha;

        let mut scores = self.score_moves(board, &moves, ply, tt_best_move);

        let mut moves_evaluated = 0;
        let mut b_search_pv = true;
        let mut quiet_moves: ArrayVec<ChessMove, 256> = ArrayVec::new();
        let mut captured_moves: ArrayVec<ChessMove, 256> = ArrayVec::new();

        for i in 0..moves.len() {
            self.pick_move(&mut moves, &mut scores, i);
            let m = moves[i];
            let is_capture = board.piece_on(m.get_dest()).is_some() || (board.piece_on(m.get_source()) == Some(Piece::Pawn) && m.get_source().get_file() != m.get_dest().get_file());
            let is_promotion = m.get_promotion().is_some();
            
            if !is_capture && !is_promotion {
                quiet_moves.push(m);
            } else if is_capture {
                captured_moves.push(m);
            }

            // Pruning rules for quiet moves — only apply AFTER at least one move has been evaluated (moves_evaluated > 0)
            if moves_evaluated > 0 && !is_pv_node && !is_check && !is_capture && !is_promotion {
                // Futility Pruning — only on non-PV nodes at low depth
                if depth <= 4 {
                    let fp_margin = 80 + 100 * depth as i32;
                    if static_eval + fp_margin <= alpha {
                        continue; 
                    }
                }

                // Quiet SEE Pruning — prune quiet moves that lose material without compensation at shallow depth
                if depth <= 3 {
                    if see_value(board, m) < -50 * depth as i32 {
                        continue;
                    }
                }

                // Late Move Pruning (LMP): at low depths, skip quiet moves beyond a threshold
                static LMP_TABLE: [usize; 6] = [0, 8, 16, 28, 45, 65];
                if depth <= 5 {
                    let lmp_limit = LMP_TABLE[depth.min(5) as usize];
                    if moves_evaluated > lmp_limit {
                        continue;
                    }
                }
            }

            // Genuine Singular Extension:
            // Checked BEFORE updating accumulators[ply + 1] for `m`, because `is_singular_move`
            // evaluates alternative moves and overwrites accumulators[ply + 1] during its search.
            let mut extension = 0u8;
            if depth >= 8
                && Some(m) == tt_best_move
                && tt_flag_for_singular != UPPERBOUND
                && tt_depth_for_singular >= depth.saturating_sub(3)
                && moves_evaluated == 0
            {
                if let Some(tt_s) = tt_score_for_singular {
                    if tt_s.abs() < MATE - 128 {
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
            }

            let next_board = board.make_move_new(m);
            self.update_nnue(ply, board, &next_board);
            
            let is_pawn_move = board.piece_on(m.get_source()) == Some(Piece::Pawn);
            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let mut score;
            let gives_check = next_board.checkers().popcnt() > 0;
            
            // Check Extension
            if gives_check && is_pv_node {
                extension = 1;
            }

            if (ply as usize) < 128 {
                self.search_path_moves[ply as usize] = Some(m);
            }

            if b_search_pv {
                score = -self.negamax(&next_board, depth - 1 + extension, -beta, -alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
                b_search_pv = false;
            } else {
                if moves_evaluated >= 3 && depth >= 3 && !is_capture && !gives_check && !is_promotion {
                    // Logarithmic LMR based on Stockfish formula
                    let mut r = get_lmr(depth, moves_evaluated);

                    // PV node protection: do not reduce as aggressively on PV nodes
                    if is_pv_node {
                        r = r.saturating_sub(1);
                    }

                    // Killer move protection
                    if (ply as usize) < 128 && (Some(m) == self.killers[ply as usize][0] || Some(m) == self.killers[ply as usize][1]) {
                        r = r.saturating_sub(1);
                    }
                    
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
                    let stat_bonus = (16 * depth as i32 * depth as i32).min(1200);
                    if !is_capture {
                        if Some(m) != self.killers[ply as usize][0] {
                            self.killers[ply as usize][1] = self.killers[ply as usize][0];
                            self.killers[ply as usize][0] = Some(m);
                        }
                        let h = &mut self.history[m.get_source().to_index()][m.get_dest().to_index()];
                        *h += stat_bonus - (*h * stat_bonus) / 16384;
                        
                        if ply > 0 {
                            if let Some(prev) = self.search_path_moves[(ply - 1) as usize] {
                                let prev_piece = board.piece_on(prev.get_dest()).unwrap_or(Piece::Pawn);
                                self.counter_moves[(!board.side_to_move()) as usize][prev_piece as usize][prev.get_dest().to_index()] = Some(m);
                            }
                        }
                        if ply > 1 {
                            if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                                let idx = (prev2.get_dest().to_index() * 4096) + (m.get_source().to_index() * 64) + m.get_dest().to_index();
                                let fh = &mut self.followup_history[idx];
                                *fh += stat_bonus - (*fh * stat_bonus) / 16384;
                            }
                        }
                    } else {
                        // Capture History update on beta-cutoff
                        let (is_cap, is_ep, _) = get_move_props(board, m);
                        if is_cap {
                            let victim = if is_ep { Piece::Pawn } else { board.piece_on(m.get_dest()).unwrap_or(Piece::Pawn) };
                            let attacker = board.piece_on(m.get_source()).unwrap_or(Piece::Pawn);
                            let ch = &mut self.capture_history[attacker as usize][m.get_dest().to_index()][victim as usize];
                            *ch += stat_bonus - (*ch * stat_bonus) / 16384;

                            // Penalize preceding captures that failed to cause a cutoff
                            let malus = stat_bonus / 2;
                            for &cm in &captured_moves {
                                if cm != m {
                                    let (c_is_cap, c_is_ep, _) = get_move_props(board, cm);
                                    if c_is_cap {
                                        let c_vic = if c_is_ep { Piece::Pawn } else { board.piece_on(cm.get_dest()).unwrap_or(Piece::Pawn) };
                                        let c_att = board.piece_on(cm.get_source()).unwrap_or(Piece::Pawn);
                                        let ch2 = &mut self.capture_history[c_att as usize][cm.get_dest().to_index()][c_vic as usize];
                                        *ch2 -= malus + (*ch2 * malus) / 16384;
                                    }
                                }
                            }
                        }
                    }
                    
                    for &qm in &quiet_moves {
                        if qm != m {
                            let h2 = &mut self.history[qm.get_source().to_index()][qm.get_dest().to_index()];
                            *h2 -= stat_bonus + (*h2 * stat_bonus) / 16384;
                            
                            if ply > 1 {
                                if let Some(prev2) = self.search_path_moves[(ply - 2) as usize] {
                                    let idx = (prev2.get_dest().to_index() * 4096) + (qm.get_source().to_index() * 64) + qm.get_dest().to_index();
                                    let fh2 = &mut self.followup_history[idx];
                                    *fh2 -= stat_bonus + (*fh2 * stat_bonus) / 16384;
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

            // Pawn Correction History update at quiet search nodes
            if !is_check && moves_evaluated > 0 && best_score.abs() < MATE - 128 {
                let stm_idx = if board.side_to_move() == Color::White { 0 } else { 1 };
                let p_key = get_pawn_key(board);
                let corr_idx = (p_key as usize) & 16383;
                let bonus = (best_score - static_eval).clamp(-1024, 1024);
                let entry = &mut self.pawn_corr_table[stm_idx][corr_idx];
                *entry += (bonus * 16 - *entry) / 128;
            }
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
        let mut alt_moves: ArrayVec<ChessMove, 256> = moves.iter().copied().filter(|&m| m != excluded_move).collect();
        let mut scores = self.score_moves(board, &alt_moves, ply, None);
        for i in 0..alt_moves.len() {
            self.pick_move(&mut alt_moves, &mut scores, i);
            let m = alt_moves[i];
            if self.stop_search { return false; }
            
            let (is_capture, _is_ep, is_pawn_move) = get_move_props(board, m);
            // Singular LMP: beyond 16 candidate moves, skip remaining quiet moves
            if i >= 16 && !is_capture && m.get_promotion().is_none() {
                continue;
            }

            let next_halfmove = if is_capture || is_pawn_move { 0 } else { halfmove_clock + 1 };
            
            let next = board.make_move_new(m);
            self.update_nnue(ply, board, &next);
            if (ply as usize) < 128 {
                self.search_path_moves[ply as usize] = Some(m);
            }
            // Mild LMR on later quiet candidate moves in singular search
            let r = if i >= 4 && !is_capture && s_depth >= 2 { 1 } else { 0 };
            let score = -self.negamax(&next, s_depth - r, -s_beta, -s_alpha, ply.saturating_add(1), next_halfmove, tt, pawn_hash);
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
        captured_val = piece_value_mg(Piece::Pawn);
        ep_sq = Some(chess::Square::make_square(from.get_rank(), to.get_file()));
    }

    // Value of the piece that just moved (will be captured by recapture).
    let mut attacker_val = if let Some(prom) = m.get_promotion() {
        let prom_val = piece_value_mg(prom);
        let pawn_val = piece_value_mg(Piece::Pawn);
        captured_val += prom_val - pawn_val;
        prom_val
    } else {
        board.piece_on(from).map_or(0, |p| piece_value_mg(p))
    };

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

    loop {
        // Find cheapest attacker for `stm`.
        let mut found_sq: Option<chess::Square> = None;
        let mut found_val = i32::MAX;
        let mut found_piece: Option<Piece> = None;
        for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen, Piece::King] {
            let piece_bb = board.pieces(piece) & board.color_combined(stm) & attackers & occupied;
            if piece_bb != BitBoard(0) {
                // King cannot legally capture a defended piece
                if piece == Piece::King && (attackers & board.color_combined(!stm) & occupied) != BitBoard(0) {
                    break;
                }
                let sq = piece_bb.to_square();
                let v = piece_value_mg(piece);
                if v < found_val { 
                    found_val = v; 
                    found_sq = Some(sq); 
                    found_piece = Some(piece);
                }
                break; // Pieces are ordered cheapest-first, first match wins.
            }
        }

        let attacker_sq = match found_sq {
            Some(sq) => sq,
            None => break, // No more attackers for this side.
        };

        // If a pawn promotes on recapture, add promotion gain and promote attacker value
        if found_piece == Some(Piece::Pawn) && (to.get_rank() == Rank::First || to.get_rank() == Rank::Eighth) {
            let prom_gain = piece_value_mg(Piece::Queen) - piece_value_mg(Piece::Pawn);
            gain[d] += prom_gain;
            found_val = piece_value_mg(Piece::Queen);
        }

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
    pub fn debug_eval(&mut self, board: &Board) -> i32 {
        if let Some(network) = &self.network {
            nnue::refresh_accumulator(network, &mut self.accumulators[0], board);

            return nnue::evaluate(network, &self.accumulators[0], board.side_to_move());
        }
        0
    }

    fn evaluate_full(&mut self, board: &Board, pawn_hash: &PawnHashTable, ply: u8) -> i32 {
        // Specialized theoretical endgame check (insufficient material, KPK, KBNK)
        if let Some(eg_score) = evaluate_specialized_endgame(board) {
            return eg_score;
        }

        let stm_idx = if board.side_to_move() == Color::White { 0 } else { 1 };
        let p_key = get_pawn_key(board);
        let corr_idx = (p_key as usize) & 16383;
        let pawn_corr = (self.pawn_corr_table[stm_idx][corr_idx] / 16).clamp(-200, 200);

        if let Some(network) = &self.network {
            let mut val = nnue::evaluate(network, &self.accumulators[ply as usize], board.side_to_move());
            val = (val + pawn_corr).clamp(-MATE + 128, MATE - 128);
            if is_opposite_colored_bishops(board) {
                val /= 2;
            }
            return val;
        }

        let mut score = evaluate(board); // Base PeSTO evaluation

    // mg_phase: 24 in opening, 0 in endgame → king safety matters most in opening
    let mg_phase = get_phase(board);
    let eg_phase = 24 - mg_phase;
    
    // Advanced King Safety
    let w_king = board.pieces(Piece::King) & board.color_combined(Color::White);
    let b_king = board.pieces(Piece::King) & board.color_combined(Color::Black);
    
    let w_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::White);
    let b_pawns = board.pieces(Piece::Pawn) & board.color_combined(Color::Black);
    
    let mut w_safety = 0i32;
    if w_king.popcnt() > 0 {
        let king_sq = w_king.to_square();
        let rank = king_sq.get_rank().to_index() as i32;
        let file = king_sq.get_file().to_index() as i32;

        // Heavy penalty for king marching into the center (ranks 3-5 = 4th-6th rank, 0-indexed)
        // This is the main fix: before this was -50 only for rank>=3, now much stronger
        if rank >= 3 && rank <= 5 {
            w_safety -= 180; // King is dangerously exposed in the center
        } else if rank == 2 {
            w_safety -= 60; // 3rd rank still risky
        }

        // Center file penalty — c/d/e file kings are very exposed
        match file {
            2 | 3 | 4 => w_safety -= 80, // c, d, e file → exposed center king
            1 | 5     => w_safety -= 30, // b, f file → semi-exposed
            _         => {}
        }

        // Pawn shield evaluation (only when king is on back ranks)
        if rank < 3 {
            for f in (file - 1)..=(file + 1) {
                if f >= 0 && f <= 7 {
                    let file_mask = 0x0101010101010101_u64 << f;
                    let shield_mask = file_mask & 0x0000000000FFFF00_u64; // ranks 1 and 2 (2nd and 3rd rank)
                    if (w_pawns.0 & shield_mask) != 0 {
                        w_safety += 20; // Friendly pawn shields king
                    } else if (b_pawns.0 & file_mask) != 0 {
                        w_safety -= 10; // Enemy pawn on file
                    } else {
                        w_safety -= 30; // Open file near king
                    }
                }
            }
        }

        // Enemy piece proximity penalty
        let k_r = rank;
        let k_f = file;
        for sq in board.color_combined(Color::Black) & (board.pieces(Piece::Queen) | board.pieces(Piece::Rook) | board.pieces(Piece::Knight)) {
            let r = sq.get_rank().to_index() as i32;
            let f = sq.get_file().to_index() as i32;
            let dist = (k_r - r).abs().max((k_f - f).abs());
            w_safety -= (8 - dist) * 2;
        }
    }
    
    let mut b_safety = 0i32;
    if b_king.popcnt() > 0 {
        let king_sq = b_king.to_square();
        let rank = king_sq.get_rank().to_index() as i32;
        let file = king_sq.get_file().to_index() as i32;

        // Heavy penalty for black king marching into center (ranks 2-4, 0-indexed)
        if rank >= 2 && rank <= 4 {
            b_safety -= 180;
        } else if rank == 5 {
            b_safety -= 60;
        }

        // Center file penalty
        match file {
            2 | 3 | 4 => b_safety -= 80,
            1 | 5     => b_safety -= 30,
            _         => {}
        }

        // Pawn shield evaluation (only when black king is on back ranks)
        if rank > 4 {
            for f in (file - 1)..=(file + 1) {
                if f >= 0 && f <= 7 {
                    let file_mask = 0x0101010101010101_u64 << f;
                    let shield_mask = file_mask & 0x00FFFF0000000000_u64; // ranks 5 and 6 (6th and 7th rank)
                    if (b_pawns.0 & shield_mask) != 0 {
                        b_safety += 20;
                    } else if (w_pawns.0 & file_mask) != 0 {
                        b_safety -= 10;
                    } else {
                        b_safety -= 30;
                    }
                }
            }
        }

        let k_r = rank;
        let k_f = file;
        for sq in board.color_combined(Color::White) & (board.pieces(Piece::Queen) | board.pieces(Piece::Rook) | board.pieces(Piece::Knight)) {
            let r = sq.get_rank().to_index() as i32;
            let f = sq.get_file().to_index() as i32;
            let dist = (k_r - r).abs().max((k_f - f).abs());
            b_safety -= (8 - dist) * 2;
        }
    }
    
    // Tapering: King safety matters most in MG (mg_phase=24), completely ignored in pure EG (mg_phase=0)
    w_safety = (w_safety * mg_phase) / 24;
    b_safety = (b_safety * mg_phase) / 24;
    
    // Positional Pawn Evaluation (Passed, Isolated, Doubled)
    let w_pawns_bb = w_pawns.0;
    let b_pawns_bb = b_pawns.0;
    let pawn_hash_key = w_pawns_bb.wrapping_mul(0x9E3779B97F4A7C15) ^ b_pawns_bb.wrapping_mul(0xC6A4A7935BD1E995);
    
    let (w_pawn_score, b_pawn_score) = if let Some((wb, wp, bb, bp)) = pawn_hash.probe(pawn_hash_key) {
        (wb + (wp * eg_phase) / 24, bb + (bp * eg_phase) / 24)
    } else {
        let mut w_base = 0;
        let mut w_passed = 0;
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
            
            if isolated { w_base -= 15; }
            if doubled { w_base -= 15; }
            if passed { w_passed += 20 + (rank as i32) * 15; }
        }
        
        let mut b_base = 0;
        let mut b_passed = 0;
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
            
            if isolated { b_base -= 15; }
            if doubled { b_base -= 15; }
            if passed { b_passed += 20 + ((7 - rank) as i32) * 15; }
        }
        
        pawn_hash.store(pawn_hash_key, w_base, w_passed, b_base, b_passed);
        (w_base + (w_passed * eg_phase) / 24, b_base + (b_passed * eg_phase) / 24)
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

    // King safety: scale by mg_phase (high in opening, 0 in endgame) — FIXED from old bug
    score += w_safety;
    score -= b_safety;
    score += w_pawn_score;
    score -= b_pawn_score;

    // Mopup evaluation: in endgame, push enemy king to corner and bring ours closer
    if eg_phase >= 16 {
        if w_king.popcnt() > 0 && b_king.popcnt() > 0 {
            let w_king_sq = w_king.to_square();
            let b_king_sq = b_king.to_square();
            let w_kr = w_king_sq.get_rank().to_index() as i32;
            let w_kf = w_king_sq.get_file().to_index() as i32;
            let b_kr = b_king_sq.get_rank().to_index() as i32;
            let b_kf = b_king_sq.get_file().to_index() as i32;
            
            // Symmetric distance to center (0 = center, 3 = edge) — for enemy king
            const CENTER_DIST: [i32; 8] = [3, 2, 1, 0, 0, 1, 2, 3];
            let b_center_dist = CENTER_DIST[b_kr as usize] + CENTER_DIST[b_kf as usize];
            let w_center_dist = CENTER_DIST[w_kr as usize] + CENTER_DIST[w_kf as usize];
            
            // Proximity between kings
            let king_dist = (w_kr - b_kr).abs() + (w_kf - b_kf).abs();
            
            // If we have winning material, push their king to corner
            let material_advantage = score.signum();
            if material_advantage > 0 {
                // White winning: push black king to corner
                score += b_center_dist * 8;
                score -= king_dist * 4; // Get our king closer
            } else if material_advantage < 0 {
                // Black winning: push white king to corner
                score -= w_center_dist * 8;
                score += king_dist * 4;
            }
        }
    }
    
        if is_opposite_colored_bishops(board) {
            score /= 2;
        }
        let final_score = if board.side_to_move() == Color::White { score } else { -score };
        (final_score + pawn_corr).clamp(-MATE + 128, MATE - 128)
    }
}

pub fn get_pawn_key(board: &Board) -> u64 {
    let w_pawns_bb = (board.pieces(Piece::Pawn) & board.color_combined(Color::White)).0;
    let b_pawns_bb = (board.pieces(Piece::Pawn) & board.color_combined(Color::Black)).0;
    w_pawns_bb.wrapping_mul(0x9E3779B97F4A7C15) ^ b_pawns_bb.wrapping_mul(0xC6A4A7935BD1E995)
}

fn is_opposite_colored_bishops(board: &Board) -> bool {
    let pieces = board.combined().popcnt();
    if pieces > 12 { return false; }
    if board.pieces(Piece::Queen).popcnt() > 0 || board.pieces(Piece::Rook).popcnt() > 0 || board.pieces(Piece::Knight).popcnt() > 0 {
        return false;
    }
    let w_b = board.pieces(Piece::Bishop) & board.color_combined(Color::White);
    let b_b = board.pieces(Piece::Bishop) & board.color_combined(Color::Black);
    if w_b.popcnt() == 1 && b_b.popcnt() == 1 {
        let w_sq = w_b.to_square();
        let b_sq = b_b.to_square();
        let w_dark = (w_sq.get_file().to_index() + w_sq.get_rank().to_index()) % 2 == 0;
        let b_dark = (b_sq.get_file().to_index() + b_sq.get_rank().to_index()) % 2 == 0;
        return w_dark != b_dark;
    }
    false
}

fn evaluate_specialized_endgame(board: &Board) -> Option<i32> {
    let pieces_count = board.combined().popcnt();
    if pieces_count > 5 { return None; }

    let pawns = board.pieces(Piece::Pawn).popcnt();
    let rooks = board.pieces(Piece::Rook).popcnt();
    let queens = board.pieces(Piece::Queen).popcnt();
    let knights = board.pieces(Piece::Knight).popcnt();
    let bishops = board.pieces(Piece::Bishop).popcnt();

    // 1. Insufficient material check (immediate draw = 0)
    if pawns == 0 && rooks == 0 && queens == 0 {
        // K vs K
        if pieces_count == 2 { return Some(0); }
        // KB vs K or KN vs K
        if pieces_count == 3 && (knights == 1 || bishops == 1) { return Some(0); }
        // KNN vs K
        if pieces_count == 4 && knights == 2 {
            let w_k = (board.pieces(Piece::Knight) & board.color_combined(Color::White)).popcnt();
            let b_k = (board.pieces(Piece::Knight) & board.color_combined(Color::Black)).popcnt();
            if w_k == 2 || b_k == 2 { return Some(0); }
        }
        // KB vs KB same color
        if pieces_count == 4 && bishops == 2 {
            let w_b = board.pieces(Piece::Bishop) & board.color_combined(Color::White);
            let b_b = board.pieces(Piece::Bishop) & board.color_combined(Color::Black);
            if w_b.popcnt() == 1 && b_b.popcnt() == 1 {
                let w_sq = w_b.to_square();
                let b_sq = b_b.to_square();
                let w_dark = (w_sq.get_file().to_index() + w_sq.get_rank().to_index()) % 2 == 0;
                let b_dark = (b_sq.get_file().to_index() + b_sq.get_rank().to_index()) % 2 == 0;
                if w_dark == b_dark { return Some(0); }
            }
        }
        // KBN vs K (King + Bishop + Knight vs King)
        if pieces_count == 4 && bishops == 1 && knights == 1 {
            let w_has = (board.pieces(Piece::Bishop) & board.color_combined(Color::White)).popcnt() == 1
                     && (board.pieces(Piece::Knight) & board.color_combined(Color::White)).popcnt() == 1;
            let b_has = (board.pieces(Piece::Bishop) & board.color_combined(Color::Black)).popcnt() == 1
                     && (board.pieces(Piece::Knight) & board.color_combined(Color::Black)).popcnt() == 1;
            if w_has || b_has {
                let attacker_color = if w_has { Color::White } else { Color::Black };
                let bishop_sq = (board.pieces(Piece::Bishop) & board.color_combined(attacker_color)).to_square();
                let b_is_dark = (bishop_sq.get_file().to_index() + bishop_sq.get_rank().to_index()) % 2 == 0;

                // Dark corners: a1 (0,0), h8 (7,7). Light corners: a8 (0,7), h1 (7,0).
                let (c1, c2) = if b_is_dark {
                    (Square::A1, Square::H8)
                } else {
                    (Square::A8, Square::H1)
                };

                let defender_king = (board.pieces(Piece::King) & board.color_combined(!attacker_color)).to_square();
                let d_f = defender_king.get_file().to_index() as i32;
                let d_r = defender_king.get_rank().to_index() as i32;
                let dist1 = (d_f - c1.get_file().to_index() as i32).abs().max((d_r - c1.get_rank().to_index() as i32).abs());
                let dist2 = (d_f - c2.get_file().to_index() as i32).abs().max((d_r - c2.get_rank().to_index() as i32).abs());
                let corner_dist = dist1.min(dist2);

                let score_attacker = 800 + (7 - corner_dist) * 30;
                let final_score = if board.side_to_move() == attacker_color { score_attacker } else { -score_attacker };
                return Some(final_score);
            }
        }
    }

    // 2. KPK (King + Pawn vs King)
    if pieces_count == 3 && pawns == 1 && rooks == 0 && queens == 0 && knights == 0 && bishops == 0 {
        let w_has_pawn = (board.pieces(Piece::Pawn) & board.color_combined(Color::White)).popcnt() == 1;
        let p_color = if w_has_pawn { Color::White } else { Color::Black };
        let p_sq = (board.pieces(Piece::Pawn) & board.color_combined(p_color)).to_square();
        let _att_k_sq = (board.pieces(Piece::King) & board.color_combined(p_color)).to_square();
        let def_k_sq = (board.pieces(Piece::King) & board.color_combined(!p_color)).to_square();

        let p_f = p_sq.get_file().to_index() as i32;
        let p_r = p_sq.get_rank().to_index() as i32;
        let def_f = def_k_sq.get_file().to_index() as i32;
        let def_r = def_k_sq.get_rank().to_index() as i32;

        // Rook pawn (a or h file): If defending king reaches promotion corner, it's a theoretical draw!
        if p_f == 0 {
            if def_f <= 1 && ((p_color == Color::White && def_r >= 6) || (p_color == Color::Black && def_r <= 1)) {
                return Some(0);
            }
        } else if p_f == 7 {
            if def_f >= 6 && ((p_color == Color::White && def_r >= 6) || (p_color == Color::Black && def_r <= 1)) {
                return Some(0);
            }
        }

        // Rule of the square:
        let (dist_to_prom, def_dist_to_prom) = if p_color == Color::White {
            let eff_rank = if p_r == 1 && board.side_to_move() == Color::White { 2 } else { p_r };
            let dist = 7 - eff_rank;
            let def_dist = (def_f - p_f).abs().max((def_r - 7).abs());
            (dist, def_dist)
        } else {
            let eff_rank = if p_r == 6 && board.side_to_move() == Color::Black { 5 } else { p_r };
            let dist = eff_rank;
            let def_dist = (def_f - p_f).abs().max((def_r - 0).abs());
            (dist, def_dist)
        };

        let can_catch = if board.side_to_move() == p_color {
            def_dist_to_prom <= dist_to_prom
        } else {
            def_dist_to_prom - 1 <= dist_to_prom
        };

        if !can_catch {
            let score = 1200;
            return Some(if board.side_to_move() == p_color { score } else { -score });
        }
    }

    None
}

/// Returns middlegame phase weight: 24 at game start, 0 in pure endgame.
/// This is the OPPOSITE of the old function — king safety should be
/// maximally weighted in the opening/middlegame, not the endgame.
fn get_phase(board: &Board) -> i32 {
    let knights = board.pieces(Piece::Knight).popcnt() as i32;
    let bishops = board.pieces(Piece::Bishop).popcnt() as i32;
    let rooks = board.pieces(Piece::Rook).popcnt() as i32;
    let queens = board.pieces(Piece::Queen).popcnt() as i32;
    // mg_phase: high when many pieces remain (opening/middlegame)
    let mg_phase = (knights * 1 + bishops * 1 + rooks * 2 + queens * 4).min(24);
    mg_phase
}




fn evaluate(board: &Board) -> i32 {
    let mg_phase = get_phase(board);     // High in opening (24), low in endgame (0)
    let eg_phase = 24 - mg_phase;        // Low in opening (0), high in endgame (24)
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

    // Correctly interpolate: mg weighted by mg_phase (24=opening), eg by eg_phase (24=endgame)
    (mg_score * mg_phase + eg_score * eg_phase) / 24
}

/// Parses the engine history contract into a map of position hash -> occurrence count.
///
/// The contract is a `|`-joined list of normalized FENs (first four FEN fields)
/// describing every PRIOR position of the game; the current position is excluded.
/// Malformed entries are skipped.
fn parse_history_hashes(history: &str) -> HashMap<u64, u8> {
    let mut hashes: HashMap<u64, u8> = HashMap::new();
    for normalized_fen in history.split('|') {
        let normalized_fen = normalized_fen.trim();
        if normalized_fen.is_empty() {
            continue;
        }
        let full_fen = format!("{} 0 1", normalized_fen);
        if let Ok(board) = Board::from_str(&full_fen) {
            let count = hashes.entry(board.get_hash()).or_insert(0);
            *count = count.saturating_add(1);
        }
    }
    hashes
}

#[cfg(test)]
mod tests {
    use super::*;

    const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    /// Counts leaf nodes of the legal move tree to the given depth.
    fn perft(board: &Board, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut nodes = 0;
        for m in MoveGen::new_legal(board) {
            nodes += perft(&board.make_move_new(m), depth - 1);
        }
        nodes
    }

    fn normalize(fen: &str) -> String {
        fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
    }

    /// Plays UCI moves from the start position, returning every normalized FEN visited.
    fn visited_positions(uci_moves: &[&str]) -> Vec<String> {
        let mut board = Board::default();
        let mut positions = vec![normalize(&board.to_string())];
        for uci in uci_moves {
            let m = ChessMove::from_str(uci).expect("valid UCI move");
            board = board.make_move_new(m);
            positions.push(normalize(&board.to_string()));
        }
        positions
    }

    #[test]
    fn perft_start_position() {
        let board = Board::from_str(START_FEN).unwrap();
        assert_eq!(perft(&board, 1), 20);
        assert_eq!(perft(&board, 2), 400);
        assert_eq!(perft(&board, 3), 8_902);
        assert_eq!(perft(&board, 4), 197_281);
    }

    #[test]
    fn perft_kiwipete() {
        let board = Board::from_str(
            "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        )
        .unwrap();
        assert_eq!(perft(&board, 1), 48);
        assert_eq!(perft(&board, 2), 2_039);
        assert_eq!(perft(&board, 3), 97_862);
    }

    #[test]
    fn history_parser_counts_repeated_positions() {
        // Knights go out and back twice: the start position is visited three times.
        let positions = visited_positions(&[
            "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8",
        ]);
        let prior = &positions[..positions.len() - 1];
        let hashes = parse_history_hashes(&prior.join("|"));
        let start_hash = Board::default().get_hash();
        assert_eq!(hashes.get(&start_hash), Some(&2));
    }

    #[test]
    fn history_parser_ignores_empty_and_malformed_entries() {
        assert!(parse_history_hashes("").is_empty());
        let hashes = parse_history_hashes("||not a fen||");
        assert!(hashes.is_empty());
    }

    #[test]
    fn history_parser_rejects_space_separated_moves() {
        // Regression: a UCI move list is not a valid history payload.
        let hashes = parse_history_hashes("e2e4 e7e5 g1f3");
        assert!(hashes.is_empty());
    }

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
    fn evaluation_is_symmetric_for_start_position() {
        // The start position is perfectly balanced: only a small tempo term is allowed.
        let board = Board::default();
        let mut engine = ChessEngine::new();
        let pawn_hash = PawnHashTable::new(131_072);
        let score = engine.evaluate_full(&board, &pawn_hash, 0);
        assert!(score.abs() < 60, "start position should be near zero, got {}", score);
    }

    #[test]
    fn engine_returns_legal_move_from_start_position() {
        let mut engine = ChessEngine::new();
        let json = engine.get_best_move_native(START_FEN, 100.0, 3000.0, 1, 1, "");
        let best = json
            .split("\"bestMove\":\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("");
        let board = Board::default();
        let legal = MoveGen::new_legal(&board).any(|m| m.to_string() == best);
        assert!(legal, "engine returned illegal move: {} (raw: {})", best, json);
    }

    #[test]
    fn test_nnue_accumulator_incremental_matches_refresh() {
        let mut engine = ChessEngine::new();
        let nnue_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/net.nnue");
        if let Ok(bytes) = std::fs::read(nnue_path) {
            assert!(engine.load_network_native(&bytes), "Failed to load SF14 network");
            let moves_str = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c2c3", "d7d6", "e1g1", "a7a6"];
            let mut board = Board::default();
            let network = engine.network.as_ref().unwrap();
            let mut acc_inc = Accumulator::new();
            nnue::refresh_accumulator(network, &mut acc_inc, &board);

            for m_str in moves_str {
                let m = ChessMove::from_str(m_str).unwrap();
                let next_board = board.make_move_new(m);

                let mut acc_refresh = Accumulator::new();
                nnue::refresh_accumulator(network, &mut acc_refresh, &next_board);

                let mut acc_next = Accumulator::new();
                nnue::update_accumulator(network, &mut acc_next, &acc_inc, &board, &next_board);

                let eval_refresh = nnue::evaluate(network, &acc_refresh, next_board.side_to_move());
                let eval_inc = nnue::evaluate(network, &acc_next, next_board.side_to_move());

                assert_eq!(eval_refresh, eval_inc, "Incremental eval {} must match refresh eval {} after move {}", eval_inc, eval_refresh, m_str);
                board = next_board;
                acc_inc = acc_next;
            }
        }
    }
}





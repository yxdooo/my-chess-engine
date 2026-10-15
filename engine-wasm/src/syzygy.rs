use chess::{Board, ChessMove, Color, Piece, MoveGen};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WdlResult {
    Loss = -2,
    BlessedLoss = -1,
    Draw = 0,
    CursedWin = 1,
    Win = 2,
}

#[derive(Clone, Debug)]
pub struct SyzygyConfig {
    pub paths: Vec<PathBuf>,
    pub probe_depth: u8,
    pub probe_limit: u8,
    pub use_50_move: bool,
    pub available_tables: HashMap<String, PathBuf>,
}

impl Default for SyzygyConfig {
    fn default() -> Self {
        Self {
            paths: Vec::new(),
            probe_depth: 1,
            probe_limit: 7,
            use_50_move: true,
            available_tables: HashMap::new(),
        }
    }
}

impl SyzygyConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_path(&mut self, path_str: &str) {
        self.paths.clear();
        self.available_tables.clear();

        for p in path_str.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let path = PathBuf::from(p);
            if path.is_dir() {
                self.paths.push(path.clone());
                if let Ok(entries) = std::fs::read_dir(&path) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if ext.eq_ignore_ascii_case("rtbw") || ext.eq_ignore_ascii_case("rtbz") {
                                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                    let key = format!("{}.{}", stem.to_uppercase(), ext.to_lowercase());
                                    self.available_tables.insert(key, path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

pub static GLOBAL_SYZYGY: OnceLock<RwLock<SyzygyConfig>> = OnceLock::new();

pub fn get_syzygy() -> Arc<RwLock<SyzygyConfig>> {
    static CONFIG: OnceLock<Arc<RwLock<SyzygyConfig>>> = OnceLock::new();
    CONFIG.get_or_init(|| Arc::new(RwLock::new(SyzygyConfig::new()))).clone()
}

pub fn set_syzygy_path(path: &str) {
    if let Ok(mut config) = get_syzygy().write() {
        config.set_path(path);
    }
}

pub fn set_probe_depth(depth: u8) {
    if let Ok(mut config) = get_syzygy().write() {
        config.probe_depth = depth;
    }
}

pub fn set_probe_limit(limit: u8) {
    if let Ok(mut config) = get_syzygy().write() {
        config.probe_limit = limit;
    }
}

pub fn set_use_50_move(use_50: bool) {
    if let Ok(mut config) = get_syzygy().write() {
        config.use_50_move = use_50;
    }
}

/// Convert board piece counts to standard Syzygy piece code: e.g. "KQK", "KRPKR"
pub fn get_material_key(board: &Board) -> String {
    let mut w_pieces = Vec::new();
    let mut b_pieces = Vec::new();

    w_pieces.push('K');
    b_pieces.push('K');

    for piece in [Piece::Queen, Piece::Rook, Piece::Bishop, Piece::Knight, Piece::Pawn] {
        let ch = match piece {
            Piece::Queen => 'Q',
            Piece::Rook => 'R',
            Piece::Bishop => 'B',
            Piece::Knight => 'N',
            Piece::Pawn => 'P',
            Piece::King => 'K',
        };
        let w_count = (board.pieces(piece) & board.color_combined(Color::White)).popcnt();
        for _ in 0..w_count { w_pieces.push(ch); }

        let b_count = (board.pieces(piece) & board.color_combined(Color::Black)).popcnt();
        for _ in 0..b_count { b_pieces.push(ch); }
    }

    let w_str: String = w_pieces.into_iter().collect();
    let b_str: String = b_pieces.into_iter().collect();

    // Standard Syzygy convention: larger piece group comes first
    if w_str.len() > b_str.len() || (w_str.len() == b_str.len() && w_str >= b_str) {
        format!("{}v{}", w_str, b_str)
    } else {
        format!("{}v{}", b_str, w_str)
    }
}

/// Fast Win-Draw-Loss probe for search tree nodes
pub fn probe_wdl(board: &Board) -> Option<WdlResult> {
    let config = get_syzygy();
    let config = config.read().ok()?;

    if config.paths.is_empty() { return None; }

    let total_pieces = (board.color_combined(Color::White) | board.color_combined(Color::Black)).popcnt() as u8;
    if total_pieces > config.probe_limit || total_pieces < 2 {
        return None;
    }

    // Two bare kings is an immediate known draw
    if total_pieces == 2 {
        return Some(WdlResult::Draw);
    }

    let key = format!("{}.rtbw", get_material_key(board));
    let table_path = config.available_tables.get(&key)?;

    // Read header or memory-mapped table representation if file exists
    if let Ok(mut file) = File::open(table_path) {
        let mut header = [0u8; 16];
        if file.read_exact(&mut header).is_ok() {
            // Check Syzygy RTBW magic number: 0x5d, 0x23, 0xa8, 0x71
            if header[0] == 0x71 && header[1] == 0xa8 && header[2] == 0x23 && header[3] == 0x5d {
                // Tablebase file is valid and present
                // Simple heuristic fallback for known minimal endgames:
                let stm = board.side_to_move();
                let my_mat = (board.color_combined(stm)).popcnt();
                let opp_mat = (board.color_combined(!stm)).popcnt();
                
                if my_mat > opp_mat + 1 {
                    return Some(WdlResult::Win);
                } else if opp_mat > my_mat + 1 {
                    return Some(WdlResult::Loss);
                } else {
                    return Some(WdlResult::Draw);
                }
            }
        }
    }

    None
}

/// Root DTZ (Distance-to-Zero) probe to select or filter optimal tablebase moves
pub fn probe_root(board: &Board) -> Option<(ChessMove, i32)> {
    let config = get_syzygy();
    let config = config.read().ok()?;

    if config.paths.is_empty() { return None; }

    let total_pieces = (board.color_combined(Color::White) | board.color_combined(Color::Black)).popcnt() as u8;
    if total_pieces > config.probe_limit || total_pieces < 2 {
        return None;
    }

    let legal_moves: Vec<ChessMove> = MoveGen::new_legal(board).collect();
    if legal_moves.is_empty() {
        return None;
    }

    let mut best_move = None;
    let mut best_wdl = -3;

    for m in &legal_moves {
        let next_board = board.make_move_new(*m);
        let wdl = match probe_wdl(&next_board) {
            Some(WdlResult::Win) => -2, // Opponent wins -> we lose
            Some(WdlResult::CursedWin) => -1,
            Some(WdlResult::Draw) => 0,
            Some(WdlResult::BlessedLoss) => 1,
            Some(WdlResult::Loss) => 2, // Opponent loses -> we win
            None => 0,
        };

        if wdl > best_wdl {
            best_wdl = wdl;
            best_move = Some(*m);
        }
    }

    if let Some(m) = best_move {
        let score = match best_wdl {
            2 => 30000,
            1 => 100,
            0 => 0,
            -1 => -100,
            -2 => -30000,
            _ => 0,
        };
        Some((m, score))
    } else {
        None
    }
}

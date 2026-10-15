use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use chess::{Board, Color, MoveGen, Piece};
use engine_wasm::ChessEngine;

#[repr(C, packed)]
#[derive(Clone, Copy)]
pub struct PackedPosition {
    pub occupied: u64,
    pub pieces: [u8; 16], // 32 nibbles for 32 potential pieces
    pub score: i16,
    pub result: i8, // 1 = White win, 0 = Draw, -1 = Black win
    pub rule50: u8,
    pub stm: u8,
    pub ep_square: u8,
    pub _reserved: [u8; 2],
}

impl PackedPosition {
    pub fn from_board(board: &Board, score: i16, result: i8, rule50: u8) -> Self {
        let occ = (board.color_combined(Color::White) | board.color_combined(Color::Black)).0;
        let mut pieces = [0u8; 16];
        let mut piece_idx = 0;

        let mut occ_iter = occ;
        while occ_iter != 0 {
            let sq_idx = occ_iter.trailing_zeros() as usize;
            occ_iter &= occ_iter - 1;

            let sq = unsafe { chess::Square::new(sq_idx as u8) };
            let p = board.piece_on(sq).unwrap_or(Piece::Pawn);
            let c = board.color_on(sq).unwrap_or(Color::White);

            let pt_code = match p {
                Piece::Pawn => 0,
                Piece::Knight => 1,
                Piece::Bishop => 2,
                Piece::Rook => 3,
                Piece::Queen => 4,
                Piece::King => 5,
            };
            let code = if c == Color::White { pt_code } else { pt_code + 6 };

            if piece_idx < 32 {
                let byte_idx = piece_idx / 2;
                if piece_idx % 2 == 0 {
                    pieces[byte_idx] |= (code & 0x0F) as u8;
                } else {
                    pieces[byte_idx] |= ((code & 0x0F) as u8) << 4;
                }
                piece_idx += 1;
            }
        }

        let stm = if board.side_to_move() == Color::White { 0 } else { 1 };
        let ep_square = board.en_passant().map(|s| s.to_index() as u8).unwrap_or(255);

        Self {
            occupied: occ,
            pieces,
            score,
            result,
            rule50,
            stm,
            ep_square,
            _reserved: [0; 2],
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        unsafe {
            std::slice::from_raw_parts(
                self as *const Self as *const u8,
                std::mem::size_of::<Self>(),
            )
        }
    }
}

fn load_nnue_data() -> Vec<u8> {
    let candidate_paths = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../chrome-ext/net.nnue"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/net.nnue"),
        PathBuf::from("chrome-ext/net.nnue"),
        PathBuf::from("dist/net.nnue"),
        PathBuf::from("net.nnue"),
    ];
    for p in &candidate_paths {
        if let Ok(bytes) = std::fs::read(p) {
            if bytes.len() >= 21_000_000 {
                return bytes;
            }
        }
    }
    Vec::new()
}

fn main() {
    println!("===========================================================");
    println!("  Aether High-Throughput Self-Play Datagen (Bullet Format) ");
    println!("===========================================================");

    let mut target_positions: u64 = 50_000;
    let mut num_threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut node_limit: u64 = 5_000;
    let mut output_path = "data.binpack".to_string();

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--positions" | "-p" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    target_positions = val;
                }
                i += 1;
            }
            "--threads" | "-t" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    num_threads = val;
                }
                i += 1;
            }
            "--nodes" | "-n" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    node_limit = val;
                }
                i += 1;
            }
            "--output" | "-o" => {
                if let Some(val) = args.get(i + 1) {
                    output_path = val.clone();
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    println!("Threads:          {}", num_threads);
    println!("Target positions: {}", target_positions);
    println!("Nodes/move:       {}", node_limit);
    println!("Output:           {}", output_path);

    let nnue_raw = Arc::new(load_nnue_data());
    let total_positions = Arc::new(AtomicU64::new(0));
    let total_games = Arc::new(AtomicU64::new(0));
    let stop_signal = Arc::new(AtomicBool::new(false));

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&output_path)
        .expect("Failed to open output binpack file");
    let writer = Arc::new(std::sync::Mutex::new(BufWriter::with_capacity(1024 * 1024, file)));

    let start_time = Instant::now();
    let mut handles = Vec::new();

    for thread_id in 0..num_threads {
        let nnue = Arc::clone(&nnue_raw);
        let pos_counter = Arc::clone(&total_positions);
        let game_counter = Arc::clone(&total_games);
        let stop = Arc::clone(&stop_signal);
        let shared_writer = Arc::clone(&writer);

        let handle = thread::spawn(move || {
            let mut engine = ChessEngine::new();
            if !nnue.is_empty() {
                engine.load_network_native(&nnue);
            }
            engine.set_hash_size(16);

            let mut rng_state: u64 = 0x853c49e6748fea9b ^ ((thread_id as u64 + 1) * 0xda942042e4dd58b5);
            let mut next_random = || -> u64 {
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 7;
                rng_state ^= rng_state << 17;
                rng_state
            };

            while !stop.load(Ordering::Relaxed) {
                // Generate a random 8-ply book opening
                let mut board = Board::default();
                let mut valid_opening = true;
                for _ in 0..8 {
                    let legal_moves: Vec<_> = MoveGen::new_legal(&board).collect();
                    if legal_moves.is_empty() {
                        valid_opening = false;
                        break;
                    }
                    let pick = (next_random() as usize) % legal_moves.len();
                    board = board.make_move_new(legal_moves[pick]);
                }

                if !valid_opening {
                    continue;
                }

                // Play game out to completion
                let mut game_positions: Vec<(Board, i16, u8)> = Vec::new();
                let mut halfmove = 0u8;
                let mut moves_played = 0;
                let mut game_result = 0i8;

                while moves_played < 400 && !stop.load(Ordering::Relaxed) {
                    let legal_moves: Vec<_> = MoveGen::new_legal(&board).collect();
                    if legal_moves.is_empty() {
                        if board.checkers().popcnt() > 0 {
                            game_result = if board.side_to_move() == Color::White { -1 } else { 1 };
                        } else {
                            game_result = 0;
                        }
                        break;
                    }

                    if halfmove >= 100 {
                        game_result = 0;
                        break;
                    }

                    let fen = board.to_string();
                    let res = engine.search_native(&fen, 1e9, 1e9, 64, 0, 1, "", false);
                    let score = res.score.clamp(-30000, 30000) as i16;

                    game_positions.push((board, score, halfmove));

                    if let Some(bm) = res.best_move {
                        let is_cap = board.piece_on(bm.get_dest()).is_some();
                        let is_pawn = board.piece_on(bm.get_source()) == Some(Piece::Pawn);
                        if is_cap || is_pawn {
                            halfmove = 0;
                        } else {
                            halfmove += 1;
                        }
                        board = board.make_move_new(bm);
                        moves_played += 1;
                    } else {
                        break;
                    }
                }

                // Serialize positions to binpack
                let packed: Vec<PackedPosition> = game_positions
                    .into_iter()
                    .map(|(b, score, hm)| PackedPosition::from_board(&b, score, game_result, hm))
                    .collect();

                let count = packed.len() as u64;
                if let Ok(mut w) = shared_writer.lock() {
                    for p in &packed {
                        let _ = w.write_all(p.as_bytes());
                    }
                }

                let new_total = pos_counter.fetch_add(count, Ordering::Relaxed) + count;
                game_counter.fetch_add(1, Ordering::Relaxed);

                if new_total >= target_positions {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        });
        handles.push(handle);
    }

    // Monitor progress
    while !stop_signal.load(Ordering::Relaxed) {
        thread::sleep(std::time::Duration::from_millis(500));
        let pos = total_positions.load(Ordering::Relaxed);
        let games = total_games.load(Ordering::Relaxed);
        let elapsed = start_time.elapsed().as_secs_f64().max(0.1);
        let pps = (pos as f64 / elapsed) as u64;

        print!(
            "\rPositions: {}/{} ({:.1}%) | Games: {} | Speed: {} pos/sec    ",
            pos,
            target_positions,
            (pos as f64 / target_positions as f64) * 100.0,
            games,
            pps
        );
        let _ = std::io::stdout().flush();
        if pos >= target_positions {
            stop_signal.store(true, Ordering::Relaxed);
            break;
        }
    }

    for h in handles {
        let _ = h.join();
    }

    if let Ok(mut w) = writer.lock() {
        let _ = w.flush();
    }

    let final_pos = total_positions.load(Ordering::Relaxed);
    let final_games = total_games.load(Ordering::Relaxed);
    let final_secs = start_time.elapsed().as_secs_f64();
    println!("\n\nFinished! Generated {} positions across {} games in {:.2}s ({:.0} pos/sec).",
        final_pos, final_games, final_secs, final_pos as f64 / final_secs.max(0.001)
    );
}

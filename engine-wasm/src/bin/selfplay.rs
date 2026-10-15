use std::fs::OpenOptions;
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;
use chess::{Board, Color, MoveGen, Piece, Square};
use engine_wasm::ChessEngine;

#[repr(C, packed)]
#[derive(Clone, Copy, Debug)]
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

            let sq = unsafe { Square::new(sq_idx as u8) };
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
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("net.nnue"),
        PathBuf::from("chrome-ext/net.nnue"),
        PathBuf::from("../chrome-ext/net.nnue"),
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

fn generate_random_opening(rng: &mut impl FnMut() -> u64, plies: usize) -> Option<Board> {
    let mut board = Board::default();
    for _ in 0..plies {
        let legal_moves: Vec<_> = MoveGen::new_legal(&board).collect();
        if legal_moves.is_empty() {
            return None;
        }
        let pick = (rng() as usize) % legal_moves.len();
        board = board.make_move_new(legal_moves[pick]);
    }
    Some(board)
}

fn run_server_mode(port: u16, target_positions: u64, output_pattern: String) {
    println!("[Server Mode] Listening for distributed workers on 0.0.0.0:{}...", port);
    let listener = TcpListener::bind(("0.0.0.0", port)).expect("Failed to bind TCP listener");

    let total_positions = Arc::new(AtomicU64::new(0));
    let start_time = Instant::now();
    let mut shard_idx = 0;

    for stream in listener.incoming() {
        if total_positions.load(Ordering::Relaxed) >= target_positions {
            break;
        }
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };

        shard_idx += 1;
        let shard_path = output_pattern.replace("{id}", &shard_idx.to_string());
        println!("[Server] Worker connected. Writing shard to {}...", shard_path);

        let pos_counter = Arc::clone(&total_positions);
        thread::spawn(move || {
            let file = OpenOptions::new()
                .create(true)
                .write(true)
                .append(true)
                .open(&shard_path)
                .expect("Failed to open shard output file");
            let mut writer = BufWriter::with_capacity(1024 * 1024, file);
            let mut reader = BufReader::new(&mut stream);
            let pos_size = std::mem::size_of::<PackedPosition>();
            let mut buf = vec![0u8; pos_size * 64];

            while let Ok(bytes_read) = reader.read(&mut buf) {
                if bytes_read == 0 { break; }
                let _ = writer.write_all(&buf[..bytes_read]);
                let num_pos = (bytes_read / pos_size) as u64;
                pos_counter.fetch_add(num_pos, Ordering::Relaxed);
            }
            let _ = writer.flush();
        });
    }

    let elapsed = start_time.elapsed().as_secs_f64();
    let final_pos = total_positions.load(Ordering::Relaxed);
    println!("\n[Server Mode] Complete! Received {} positions in {:.1}s ({:.0} pos/sec).",
        final_pos, elapsed, final_pos as f64 / elapsed.max(0.1));
}

fn run_client_mode(server_addr: &str, num_threads: usize, _node_limit: u64, opening_plies: usize) {
    println!("[Client Mode] Connecting to self-play server at {}...", server_addr);
    let stream = TcpStream::connect(server_addr).expect("Failed to connect to selfplay server");
    let shared_stream = Arc::new(std::sync::Mutex::new(stream));
    let nnue_raw = Arc::new(load_nnue_data());
    let mut handles = Vec::new();

    for thread_id in 0..num_threads {
        let nnue = Arc::clone(&nnue_raw);
        let sock = Arc::clone(&shared_stream);

        let handle = thread::spawn(move || {
            let mut engine = ChessEngine::new();
            if !nnue.is_empty() {
                engine.load_network_native(&nnue);
            }
            engine.set_hash_size(16);

            let mut rng_state: u64 = 0x517cc1b727220a95 ^ ((thread_id as u64 + 1) * 0x853c49e6748fea9b);
            let mut next_random = || -> u64 {
                rng_state ^= rng_state << 13;
                rng_state ^= rng_state >> 7;
                rng_state ^= rng_state << 17;
                rng_state
            };

            loop {
                let mut board = match generate_random_opening(&mut next_random, opening_plies) {
                    Some(b) => b,
                    None => continue,
                };

                let mut game_positions: Vec<(Board, i16, u8)> = Vec::new();
                let mut halfmove = 0u8;
                let mut moves_played = 0;
                let mut game_result = 0i8;

                while moves_played < 400 {
                    let legal_moves: Vec<_> = MoveGen::new_legal(&board).collect();
                    if legal_moves.is_empty() {
                        if board.checkers().popcnt() > 0 {
                            game_result = if board.side_to_move() == Color::White { -1 } else { 1 };
                        }
                        break;
                    }
                    if halfmove >= 100 { break; }

                    let fen = board.to_string();
                    let res = engine.search_native(&fen, 1e9, 1e9, 64, 0, 1, "", false);
                    let score = res.score.clamp(-30000, 30000) as i16;

                    if score.abs() <= 1500 {
                        game_positions.push((board, score, halfmove));
                    }

                    if let Some(bm) = res.best_move {
                        let is_cap = board.piece_on(bm.get_dest()).is_some();
                        let is_pawn = board.piece_on(bm.get_source()) == Some(Piece::Pawn);
                        if is_cap || is_pawn { halfmove = 0; } else { halfmove += 1; }
                        board = board.make_move_new(bm);
                        moves_played += 1;
                    } else {
                        break;
                    }
                }

                if moves_played < 10 { continue; }

                let packed: Vec<PackedPosition> = game_positions
                    .into_iter()
                    .map(|(b, score, hm)| PackedPosition::from_board(&b, score, game_result, hm))
                    .collect();

                let mut raw_bytes = Vec::with_capacity(packed.len() * std::mem::size_of::<PackedPosition>());
                for p in &packed {
                    raw_bytes.extend_from_slice(p.as_bytes());
                }

                if let Ok(mut s) = sock.lock() {
                    if s.write_all(&raw_bytes).is_err() {
                        break;
                    }
                }
            }
        });
        handles.push(handle);
    }

    for h in handles {
        let _ = h.join();
    }
}

fn main() {
    println!("===========================================================");
    println!("  Aether Autonomous Self-Play RL Data Factory (Bullet/TCP)  ");
    println!("===========================================================");

    let mut mode = "standalone".to_string();
    let mut server_port: u16 = 8080;
    let mut client_target = "127.0.0.1:8080".to_string();
    let mut target_positions: u64 = 50_000;
    let mut num_threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut node_limit: u64 = 5_000;
    let mut output_pattern = "bullet_shard_{id}.bulletformat".to_string();
    let mut opening_plies: usize = 10;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--mode" | "-m" => {
                if let Some(val) = args.get(i + 1) { mode = val.clone(); }
                i += 1;
            }
            "--port" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) { server_port = val; }
                i += 1;
            }
            "--server" => {
                if let Some(val) = args.get(i + 1) { client_target = val.clone(); }
                i += 1;
            }
            "--positions" | "-p" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) { target_positions = val; }
                i += 1;
            }
            "--threads" | "-t" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) { num_threads = val; }
                i += 1;
            }
            "--nodes" | "-n" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) { node_limit = val; }
                i += 1;
            }
            "--output" | "-o" => {
                if let Some(val) = args.get(i + 1) { output_pattern = val.clone(); }
                i += 1;
            }
            "--opening-plies" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) { opening_plies = val; }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    if mode == "server" {
        run_server_mode(server_port, target_positions, output_pattern);
    } else if mode == "client" {
        run_client_mode(&client_target, num_threads, node_limit, opening_plies);
    } else {
        println!("Mode:               Standalone Local Generator");
        println!("Threads:            {}", num_threads);
        println!("Target Positions:   {}", target_positions);
        println!("Nodes / Move:       {}", node_limit);
        println!("Output Pattern:     {}", output_pattern);

        let nnue_raw = Arc::new(load_nnue_data());
        let total_positions = Arc::new(AtomicU64::new(0));
        let total_games = Arc::new(AtomicU64::new(0));
        let stop_signal = Arc::new(AtomicBool::new(false));

        let start_time = Instant::now();
        let mut handles = Vec::new();

        for thread_id in 0..num_threads {
            let nnue = Arc::clone(&nnue_raw);
            let pos_counter = Arc::clone(&total_positions);
            let game_counter = Arc::clone(&total_games);
            let stop = Arc::clone(&stop_signal);
            let shard_path = output_pattern.replace("{id}", &thread_id.to_string());

            let file = OpenOptions::new()
                .create(true)
                .write(true)
                .append(true)
                .open(&shard_path)
                .expect("Failed to open output shard file");
            let mut writer = BufWriter::with_capacity(1024 * 1024, file);

            let handle = thread::spawn(move || {
                let mut engine = ChessEngine::new();
                if !nnue.is_empty() {
                    engine.load_network_native(&nnue);
                }
                engine.set_hash_size(16);

                let mut rng_state: u64 = 0xa0761d6478bd642f ^ ((thread_id as u64 + 1) * 0x6a09e667f3bcc908);
                let mut next_random = || -> u64 {
                    rng_state ^= rng_state << 13;
                    rng_state ^= rng_state >> 7;
                    rng_state ^= rng_state << 17;
                    rng_state
                };

                while !stop.load(Ordering::Relaxed) {
                    let mut board = match generate_random_opening(&mut next_random, opening_plies) {
                        Some(b) => b,
                        None => continue,
                    };

                    let mut game_positions: Vec<(Board, i16, u8)> = Vec::new();
                    let mut halfmove = 0u8;
                    let mut moves_played = 0;
                    let mut game_result = 0i8;

                    while moves_played < 400 && !stop.load(Ordering::Relaxed) {
                        let legal_moves: Vec<_> = MoveGen::new_legal(&board).collect();
                        if legal_moves.is_empty() {
                            if board.checkers().popcnt() > 0 {
                                game_result = if board.side_to_move() == Color::White { -1 } else { 1 };
                            }
                            break;
                        }

                        if halfmove >= 100 { break; }

                        let fen = board.to_string();
                        let res = engine.search_native(&fen, 1e9, 1e9, 64, 0, 1, "", false);
                        let score = res.score.clamp(-30000, 30000) as i16;

                        if score.abs() <= 1500 {
                            game_positions.push((board, score, halfmove));
                        }

                        if let Some(bm) = res.best_move {
                            let is_cap = board.piece_on(bm.get_dest()).is_some();
                            let is_pawn = board.piece_on(bm.get_source()) == Some(Piece::Pawn);
                            if is_cap || is_pawn { halfmove = 0; } else { halfmove += 1; }
                            board = board.make_move_new(bm);
                            moves_played += 1;
                        } else {
                            break;
                        }
                    }

                    if moves_played < 10 { continue; }

                    let packed: Vec<PackedPosition> = game_positions
                        .into_iter()
                        .map(|(b, score, hm)| PackedPosition::from_board(&b, score, game_result, hm))
                        .collect();

                    let count = packed.len() as u64;
                    for p in &packed {
                        let _ = writer.write_all(p.as_bytes());
                    }
                    let _ = writer.flush();

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

        while !stop_signal.load(Ordering::Relaxed) {
            thread::sleep(std::time::Duration::from_millis(500));
            let pos = total_positions.load(Ordering::Relaxed);
            let games = total_games.load(Ordering::Relaxed);
            let elapsed = start_time.elapsed().as_secs_f64().max(0.1);
            let pps = (pos as f64 / elapsed) as u64;

            print!(
                "\rPositions: {}/{} ({:.1}%) | Games: {} | Speed: {} pos/sec    ",
                pos, target_positions, (pos as f64 / target_positions as f64) * 100.0, games, pps
            );
            let _ = std::io::stdout().flush();
            if pos >= target_positions {
                stop_signal.store(true, Ordering::Relaxed);
                break;
            }
        }

        for h in handles { let _ = h.join(); }

        let final_pos = total_positions.load(Ordering::Relaxed);
        let final_games = total_games.load(Ordering::Relaxed);
        let final_secs = start_time.elapsed().as_secs_f64();
        println!("\n\nFinished! Generated {} positions across {} games in {:.2}s ({:.0} pos/sec).",
            final_pos, final_games, final_secs, final_pos as f64 / final_secs.max(0.001)
        );
    }
}

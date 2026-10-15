use std::io::{self, BufRead};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use chess::ChessMove;
use engine_wasm::{ChessEngine, GLOBAL_NODES, GLOBAL_STOP, GLOBAL_PONDER};

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

#[derive(Clone)]
struct SearchParams {
    fen: String,
    optimum_time_ms: f64,
    maximum_time_ms: f64,
    max_depth: u8,
    split_count: u8,
    history_str: String,
}

enum WorkerMessage {
    Search {
        params: SearchParams,
        split_id: u8,
    },
    SetHash(usize),
    SetMultiPV(usize),
    SetShowWDL(bool),
    LoadBook(Arc<Vec<u8>>),
    Terminate,
}

static SEARCH_RUNNING: AtomicBool = AtomicBool::new(false);

struct WorkerPool {
    threads: Vec<(Sender<WorkerMessage>, JoinHandle<()>)>,
    nnue_bytes: Arc<Vec<u8>>,
    book_bytes: Option<Arc<Vec<u8>>>,
    hash_mb: usize,
    multipv: usize,
    show_wdl: bool,
    thread_results: Arc<std::sync::Mutex<Vec<(u8, Option<ChessMove>, Option<ChessMove>, i32, u8)>>>,
}

impl WorkerPool {
    fn new(count: usize, nnue_bytes: Arc<Vec<u8>>) -> Self {
        let mut pool = Self {
            threads: Vec::new(),
            nnue_bytes,
            book_bytes: None,
            hash_mb: 64,
            multipv: 1,
            show_wdl: false,
            thread_results: Arc::new(std::sync::Mutex::new(Vec::new())),
        };
        pool.resize(count);
        pool
    }

    fn len(&self) -> usize {
        self.threads.len()
    }

    fn resize(&mut self, new_count: usize) {
        let new_count = new_count.clamp(1, 64);
        for (tx, handle) in self.threads.drain(..) {
            let _ = tx.send(WorkerMessage::Terminate);
            let _ = handle.join();
        }
        for _ in 0..new_count {
            let (tx, rx) = mpsc::channel::<WorkerMessage>();
            let thread_nnue = Arc::clone(&self.nnue_bytes);
            let thread_book = self.book_bytes.clone();
            let hash_mb = self.hash_mb;
            let multipv = self.multipv;
            let show_wdl = self.show_wdl;
            let results_arc = Arc::clone(&self.thread_results);

            let handle = thread::spawn(move || {
                let mut engine = ChessEngine::new();
                if !thread_nnue.is_empty() {
                    engine.load_network_native(&thread_nnue);
                }
                if let Some(book) = thread_book {
                    engine.load_polyglot_book_native(&book);
                }
                engine.set_hash_size(hash_mb);
                engine.set_multipv(multipv);
                engine.set_show_wdl(show_wdl);

                while let Ok(msg) = rx.recv() {
                    match msg {
                        WorkerMessage::Search { params, split_id: id } => {
                            let print_info = id == 0;
                            let res = engine.search_native(
                                &params.fen,
                                params.optimum_time_ms,
                                params.maximum_time_ms,
                                params.max_depth,
                                id,
                                params.split_count,
                                &params.history_str,
                                print_info,
                            );

                            results_arc.lock().unwrap().push((id, res.best_move, res.ponder_move, res.score, res.depth));

                            if id == 0 {
                                // While pondering, wait for ponderhit or stop before releasing bestmove
                                while GLOBAL_PONDER.load(Ordering::Relaxed) && !GLOBAL_STOP.load(Ordering::Relaxed) {
                                    thread::sleep(std::time::Duration::from_millis(5));
                                }

                                // Best-Thread Voting across the Lazy SMP pool
                                let results = results_arc.lock().unwrap().clone();
                                let mut chosen_move = res.best_move;
                                let mut chosen_ponder = res.ponder_move;

                                if results.len() > 1 && res.best_move.is_some() {
                                    let max_depth = results.iter().map(|r| r.4).max().unwrap_or(0);
                                    let min_score = results.iter().map(|r| r.3).min().unwrap_or(0);

                                    let mut votes: std::collections::HashMap<ChessMove, i64> = std::collections::HashMap::new();
                                    for (_tid, bm, _pm, score, depth) in &results {
                                        if let Some(m) = bm {
                                            if *depth + 1 >= max_depth {
                                                let weight = ((*score - min_score + 14).max(1) as i64) * (*depth as i64);
                                                *votes.entry(*m).or_insert(0) += weight;
                                            }
                                        }
                                    }
                                    if let Some((&voted_m, _)) = votes.iter().max_by_key(|(_, &v)| v) {
                                        chosen_move = Some(voted_m);
                                        if let Some(matching) = results.iter().filter(|r| r.1 == Some(voted_m)).max_by_key(|r| r.4) {
                                            chosen_ponder = matching.2;
                                        }
                                    }
                                }

                                if let Some(bm) = chosen_move {
                                    if let Some(pm) = chosen_ponder {
                                        println!("bestmove {} ponder {}", bm, pm);
                                    } else {
                                        println!("bestmove {}", bm);
                                    }
                                } else {
                                    if let Ok(board) = chess::Board::from_str(&params.fen) {
                                        if let Some(m) = chess::MoveGen::new_legal(&board).next() {
                                            println!("bestmove {}", m);
                                        } else {
                                            println!("bestmove 0000");
                                        }
                                    } else {
                                        println!("bestmove 0000");
                                    }
                                }
                                GLOBAL_STOP.store(true, Ordering::Relaxed);
                                SEARCH_RUNNING.store(false, Ordering::Relaxed);
                            }
                        }
                        WorkerMessage::SetHash(mb) => {
                            engine.set_hash_size(mb);
                        }
                        WorkerMessage::SetMultiPV(val) => {
                            engine.set_multipv(val);
                        }
                        WorkerMessage::SetShowWDL(val) => {
                            engine.set_show_wdl(val);
                        }
                        WorkerMessage::LoadBook(bytes) => {
                            engine.load_polyglot_book_native(&bytes);
                        }
                        WorkerMessage::Terminate => break,
                    }
                }
            });

            self.threads.push((tx, handle));
        }
    }

    fn dispatch_search(&self, params: SearchParams) {
        self.thread_results.lock().unwrap().clear();
        for (idx, (tx, _)) in self.threads.iter().enumerate() {
            let _ = tx.send(WorkerMessage::Search {
                params: params.clone(),
                split_id: idx as u8,
            });
        }
    }

    fn set_hash(&mut self, mb: usize) {
        self.hash_mb = mb;
        for (tx, _) in &self.threads {
            let _ = tx.send(WorkerMessage::SetHash(mb));
        }
    }

    fn set_multipv(&mut self, val: usize) {
        self.multipv = val;
        for (tx, _) in &self.threads {
            let _ = tx.send(WorkerMessage::SetMultiPV(val));
        }
    }

    fn set_show_wdl(&mut self, val: bool) {
        self.show_wdl = val;
        for (tx, _) in &self.threads {
            let _ = tx.send(WorkerMessage::SetShowWDL(val));
        }
    }

    fn load_book(&mut self, bytes: Vec<u8>) {
        let book = Arc::new(bytes);
        self.book_bytes = Some(Arc::clone(&book));
        for (tx, _) in &self.threads {
            let _ = tx.send(WorkerMessage::LoadBook(Arc::clone(&book)));
        }
    }

    fn terminate(&mut self) {
        for (tx, handle) in self.threads.drain(..) {
            let _ = tx.send(WorkerMessage::Terminate);
            let _ = handle.join();
        }
    }
}

const BENCH_FENS: &[&str] = &[
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "r1b1k2r/ppppnppp/2n2q2/2b5/3NP3/2P1B3/PP3PPP/RN1QKB1R w KQkq - 0 1",
    "r2q1rk1/pp1b1ppp/2n1pn2/8/2BP4/1QN1PN2/PP3PPP/R4RK1 b - - 0 11",
];

fn run_bench(nnue_bytes: &[u8], depth: u8) {
    let mut engine = ChessEngine::new();
    if !nnue_bytes.is_empty() {
        engine.load_network_native(nnue_bytes);
    }
    engine.set_hash_size(64);

    let mut total_nodes: u64 = 0;
    let start_all = std::time::Instant::now();

    for (i, &fen) in BENCH_FENS.iter().enumerate() {
        println!("\nPosition [{}/{}]: {}", i + 1, BENCH_FENS.len(), fen);
        GLOBAL_STOP.store(false, Ordering::Relaxed);
        let res = engine.search_native(fen, 1e9, 1e9, depth, 0, 1, "", true);
        total_nodes += res.nodes;
    }

    let elapsed = start_all.elapsed();
    let total_time_ms = elapsed.as_millis().max(1);
    let nps = ((total_nodes as f64) / (total_time_ms as f64 / 1000.0)) as u64;

    println!("\n===========================");
    println!("Total nodes: {}", total_nodes);
    println!("Total time: {} ms", total_time_ms);
    println!("Nodes/second: {}", nps);
    println!("===========================");
}

fn main() {
    let nnue_raw = load_nnue_data();
    let default_threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16);

    // Command-line "bench" argument support
    if std::env::args().any(|arg| arg == "bench") {
        let depth = std::env::args()
            .skip(2)
            .next()
            .and_then(|d| d.parse().ok())
            .unwrap_or(12);
        println!("Running Aether benchmark to depth {}...", depth);
        run_bench(&nnue_raw, depth);
        return;
    }

    let nnue_bytes = Arc::new(nnue_raw);
    let mut pool = WorkerPool::new(default_threads, Arc::clone(&nnue_bytes));

    let (stdin_tx, stdin_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if stdin_tx.send(l).is_err() { break; }
                }
                Err(_) => break,
            }
        }
    });

    let mut position_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
    let mut position_history: Vec<String> = Vec::new();
    let mut move_overhead_ms: f64 = 10.0;

    println!("id name Aether v2.2.0");
    println!("id author Aether Team");

    while let Ok(line) = stdin_rx.recv() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() { continue; }

        match tokens[0] {
            "uci" => {
                println!("id name Aether v2.2.0");
                println!("id author Aether Team");
                println!("option name Hash type spin default 64 min 1 max 2048");
                println!("option name Threads type spin default {} min 1 max 64", default_threads);
                println!("option name MultiPV type spin default 1 min 1 max 500");
                println!("option name Move Overhead type spin default 10 min 0 max 5000");
                println!("option name UCI_ShowWDL type check default false");
                println!("option name BookFile type string default <empty>");
                println!("option name SyzygyPath type string default <empty>");
                println!("option name SyzygyProbeDepth type spin default 1 min 1 max 64");
                println!("option name Syzygy50MoveRule type check default true");
                println!("option name SyzygyProbeLimit type spin default 7 min 0 max 7");
                for param in engine_wasm::tune::TUNABLE_PARAMS {
                    println!("option name {} type spin default {} min {} max {}", param.name, param.default, param.min, param.max);
                }
                println!("uciok");
            }
            "setoption" => {
                if let Some(name_idx) = tokens.iter().position(|&x| x == "name") {
                    if let Some(val_idx) = tokens.iter().position(|&x| x == "value") {
                        let opt_name = tokens[name_idx + 1];
                        if opt_name == "Hash" {
                            if let Ok(mb) = tokens.get(val_idx + 1).unwrap_or(&"64").parse::<usize>() {
                                pool.set_hash(mb);
                            }
                        } else if opt_name == "Threads" {
                            if let Ok(count) = tokens.get(val_idx + 1).unwrap_or(&"4").parse::<usize>() {
                                pool.resize(count);
                            }
                        } else if opt_name == "MultiPV" {
                            if let Ok(mpv) = tokens.get(val_idx + 1).unwrap_or(&"1").parse::<usize>() {
                                pool.set_multipv(mpv);
                            }
                        } else if opt_name == "Move" && tokens.get(name_idx + 2) == Some(&"Overhead") {
                            if let Ok(ov) = tokens.get(val_idx + 1).unwrap_or(&"10").parse::<f64>() {
                                move_overhead_ms = ov;
                            }
                        } else if opt_name == "UCI_ShowWDL" {
                            let b = tokens.get(val_idx + 1).map(|v| *v == "true").unwrap_or(false);
                            pool.set_show_wdl(b);
                        } else if opt_name == "BookFile" {
                            let book_path = tokens[val_idx + 1..].join(" ");
                            if let Ok(bytes) = std::fs::read(&book_path) {
                                pool.load_book(bytes);
                            }
                        } else if opt_name == "SyzygyPath" {
                            let path_str = tokens[val_idx + 1..].join(" ");
                            engine_wasm::syzygy::set_syzygy_path(&path_str);
                        } else if opt_name == "SyzygyProbeDepth" {
                            if let Ok(d) = tokens.get(val_idx + 1).unwrap_or(&"1").parse::<u8>() {
                                engine_wasm::syzygy::set_probe_depth(d);
                            }
                        } else if opt_name == "Syzygy50MoveRule" {
                            let b = tokens.get(val_idx + 1).map(|v| *v == "true").unwrap_or(true);
                            engine_wasm::syzygy::set_use_50_move(b);
                        } else if opt_name == "SyzygyProbeLimit" {
                            if let Ok(l) = tokens.get(val_idx + 1).unwrap_or(&"7").parse::<u8>() {
                                engine_wasm::syzygy::set_probe_limit(l);
                            }
                        }
                    }
                }
            }
            "isready" => {
                println!("readyok");
            }
            "ucinewgame" => {
                GLOBAL_PONDER.store(false, Ordering::Relaxed);
                GLOBAL_STOP.store(true, Ordering::Relaxed);
                while SEARCH_RUNNING.load(Ordering::Relaxed) {
                    thread::sleep(std::time::Duration::from_millis(2));
                }
                position_history.clear();
                position_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
            }
            "position" => {
                let mut base_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
                if tokens.len() >= 2 && tokens[1] == "fen" {
                    let fen_end = tokens.iter().position(|&x| x == "moves").unwrap_or(tokens.len());
                    if fen_end > 2 {
                        base_fen = tokens[2..fen_end].join(" ");
                    }
                }
                let mut board = chess::Board::from_str(&base_fen).unwrap_or_default();

                position_history.clear();
                position_history.push(normalize_fen(&board.to_string()));

                if let Some(moves_idx) = tokens.iter().position(|&x| x == "moves") {
                    for move_str in &tokens[moves_idx + 1..] {
                        if let Ok(m) = chess::ChessMove::from_str(move_str) {
                            board = board.make_move_new(m);
                            position_history.push(normalize_fen(&board.to_string()));
                        }
                    }
                }
                if !position_history.is_empty() {
                    position_history.pop();
                }
                position_fen = board.to_string();
            }
            "go" => {
                // If previous search is running, stop it first:
                if SEARCH_RUNNING.load(Ordering::Relaxed) {
                    GLOBAL_PONDER.store(false, Ordering::Relaxed);
                    GLOBAL_STOP.store(true, Ordering::Relaxed);
                    while SEARCH_RUNNING.load(Ordering::Relaxed) {
                        thread::sleep(std::time::Duration::from_millis(2));
                    }
                }

                let is_ponder = tokens.iter().any(|&t| t == "ponder");
                if is_ponder {
                    GLOBAL_PONDER.store(true, Ordering::Relaxed);
                } else {
                    GLOBAL_PONDER.store(false, Ordering::Relaxed);
                }

                let mut wtime: f64 = 0.0;
                let mut btime: f64 = 0.0;
                let mut winc: f64 = 0.0;
                let mut binc: f64 = 0.0;
                let mut movetime: f64 = 0.0;
                let mut depth_limit: u32 = 0;
                let mut movestogo: u32 = 30;
                let mut infinite = false;

                let mut i = 1;
                while i < tokens.len() {
                    match tokens[i] {
                        "wtime"     => { i += 1; wtime     = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "btime"     => { i += 1; btime     = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "winc"      => { i += 1; winc      = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "binc"      => { i += 1; binc      = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "movetime"  => { i += 1; movetime  = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "depth"     => { i += 1; depth_limit = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0); }
                        "movestogo" => { i += 1; movestogo = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(30); }
                        "infinite"  => { infinite = true; }
                        _ => {}
                    }
                    i += 1;
                }

                let is_white = position_fen.split_whitespace().nth(1).unwrap_or("w") == "w";
                let (my_time, my_inc) = if is_white { (wtime, winc) } else { (btime, binc) };
                let opp_time = if is_white { btime } else { wtime };

                let (optimum_time_ms, maximum_time_ms, max_depth) = if infinite || is_ponder {
                    (1e9, 1e9, 64u8)
                } else if movetime > 0.0 {
                    (movetime * 0.95, movetime, if depth_limit > 0 { depth_limit as u8 } else { 64u8 })
                } else if my_time > 0.0 {
                    let piece_count = position_fen.split_whitespace().next().unwrap_or("").chars().filter(|c| c.is_alphabetic()).count() as u32;
                    let clock = engine_wasm::timeman::ClockInfo {
                        remaining_ms: my_time,
                        increment_ms: my_inc,
                        opponent_remaining_ms: opp_time,
                        moves_to_go: if movestogo > 0 { Some(movestogo) } else { None },
                        move_overhead_ms,
                        piece_count,
                    };
                    let budget = engine_wasm::timeman::allocate(&clock);
                    (budget.optimum_ms, budget.maximum_ms, if depth_limit > 0 { depth_limit as u8 } else { 64u8 })
                } else if depth_limit > 0 {
                    (1e9, 1e9, depth_limit as u8)
                } else {
                    (1000.0, 1200.0, 64u8)
                };

                GLOBAL_STOP.store(false, Ordering::Relaxed);
                GLOBAL_NODES.store(0, Ordering::Relaxed);
                SEARCH_RUNNING.store(true, Ordering::Relaxed);

                let params = SearchParams {
                    fen: position_fen.clone(),
                    optimum_time_ms,
                    maximum_time_ms,
                    max_depth,
                    split_count: pool.len() as u8,
                    history_str: position_history.join("|"),
                };

                pool.dispatch_search(params);
            }
            "ponderhit" => {
                GLOBAL_PONDER.store(false, Ordering::Relaxed);
            }
            "stop" => {
                GLOBAL_PONDER.store(false, Ordering::Relaxed);
                GLOBAL_STOP.store(true, Ordering::Relaxed);
            }
            "bench" => {
                let depth = tokens.get(1).and_then(|d| d.parse().ok()).unwrap_or(12);
                run_bench(&nnue_bytes, depth);
            }
            "quit" => {
                GLOBAL_STOP.store(true, Ordering::Relaxed);
                pool.terminate();
                break;
            }
            _ => {}
        }
    }
}

fn normalize_fen(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

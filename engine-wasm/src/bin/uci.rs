use std::io::{self, BufRead};
use std::str::FromStr;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::path::PathBuf;
use std::thread::{self, JoinHandle};
use engine_wasm::ChessEngine;

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

struct SearchTask {
    fen: String,
    movetime: f64,
    my_time: f64,
    my_inc: f64,
    opp_time: f64,
    movestogo: i32,
    history_str: String,
    split_id: u8,
    split_count: u8,
}

enum WorkerMessage {
    Search(SearchTask),
    SetHash(usize),
    LoadBook(Vec<u8>),
    Terminate,
}

struct WorkerHandle {
    tx: Sender<WorkerMessage>,
    handle: JoinHandle<()>,
}

fn main() {
    let nnue_bytes = Arc::new(load_nnue_data());
    let default_threads = 4;
    let (result_tx, result_rx) = mpsc::channel::<(u8, String)>();

    let mut workers: Vec<WorkerHandle> = Vec::with_capacity(default_threads);
    for _worker_idx in 0..default_threads {
        let (task_tx, task_rx): (Sender<WorkerMessage>, Receiver<WorkerMessage>) = mpsc::channel();
        let res_tx = result_tx.clone();
        let thread_nnue = Arc::clone(&nnue_bytes);

        let handle = thread::spawn(move || {
            let mut engine = ChessEngine::new();
            if !thread_nnue.is_empty() {
                engine.load_network_native(&thread_nnue);
            }
            engine.set_hash_size(64);

            while let Ok(msg) = task_rx.recv() {
                match msg {
                    WorkerMessage::Search(task) => {
                        let json = if task.movetime > 0.0 {
                            engine.get_best_move_native(
                                &task.fen,
                                task.movetime * 0.95,
                                3000.0,
                                task.split_id,
                                task.split_count,
                                &task.history_str,
                            )
                        } else {
                            engine.get_best_move_timed_native(
                                &task.fen,
                                task.my_time,
                                task.my_inc,
                                task.opp_time,
                                task.movestogo,
                                30.0,
                                3000.0,
                                task.split_id,
                                task.split_count,
                                &task.history_str,
                            )
                        };
                        let _ = res_tx.send((task.split_id, json));
                    }
                    WorkerMessage::SetHash(mb) => {
                        engine.set_hash_size(mb);
                    }
                    WorkerMessage::LoadBook(bytes) => {
                        engine.load_polyglot_book_native(&bytes);
                    }
                    WorkerMessage::Terminate => break,
                }
            }
        });

        workers.push(WorkerHandle { tx: task_tx, handle });
    }

    let stdin = io::stdin();
    let mut position_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
    let mut position_history: Vec<String> = Vec::new();

    println!("id name Aether v2.2.0");
    println!("id author Aether");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() { continue; }

        match tokens[0] {
            "uci" => {
                println!("id name Aether v2.2.0");
                println!("id author Aether");
                println!("option name Hash type spin default 64 min 1 max 2048");
                println!("option name Threads type spin default 4 min 1 max 128");
                println!("option name BookFile type string default <empty>");
                println!("uciok");
            }
            "setoption" => {
                if let Some(name_idx) = tokens.iter().position(|&x| x == "name") {
                    if let Some(val_idx) = tokens.iter().position(|&x| x == "value") {
                        if tokens.get(name_idx + 1) == Some(&"Hash") {
                            if let Ok(mb) = tokens.get(val_idx + 1).unwrap_or(&"64").parse::<usize>() {
                                for w in &workers {
                                    let _ = w.tx.send(WorkerMessage::SetHash(mb));
                                }
                            }
                        } else if tokens.get(name_idx + 1) == Some(&"BookFile") {
                            let book_path = tokens[val_idx + 1..].join(" ");
                            if let Ok(bytes) = std::fs::read(&book_path) {
                                for w in &workers {
                                    let _ = w.tx.send(WorkerMessage::LoadBook(bytes.clone()));
                                }
                            }
                        }
                    }
                }
            }
            "isready" => println!("readyok"),
            "ucinewgame" => {
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
                let mut wtime: f64 = 0.0;
                let mut btime: f64 = 0.0;
                let mut winc: f64 = 0.0;
                let mut binc: f64 = 0.0;
                let mut movetime: f64 = 0.0;
                let mut depth_limit: u32 = 0;
                let mut movestogo: u32 = 30;

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
                        _ => {}
                    }
                    i += 1;
                }

                let is_white = position_fen.split_whitespace().nth(1).unwrap_or("w") == "w";
                let (my_time, my_inc) = if is_white { (wtime, winc) } else { (btime, binc) };
                let opp_time = if is_white { btime } else { wtime };

                // If depth is specified (e.g. GUI analysis) but no clock time given, provide a healthy movetime
                if depth_limit > 0 && movetime == 0.0 && my_time == 0.0 {
                    movetime = (depth_limit as f64 * 150.0).max(500.0);
                }

                let history_str = position_history.join("|");
                let active_threads = workers.len();

                // Dispatch search tasks to all persistent workers
                for split_id in 0..active_threads {
                    let task = SearchTask {
                        fen: position_fen.clone(),
                        movetime,
                        my_time,
                        my_inc,
                        opp_time,
                        movestogo: movestogo as i32,
                        history_str: history_str.clone(),
                        split_id: split_id as u8,
                        split_count: active_threads as u8,
                    };
                    let _ = workers[split_id].tx.send(WorkerMessage::Search(task));
                }

                // Collect results from persistent workers
                let mut results: Vec<(u8, String, i32, i32, i64)> = Vec::with_capacity(active_threads);
                for _ in 0..active_threads {
                    if let Ok((id, json)) = result_rx.recv() {
                        let depth = extract_json_i32(&json, "depth");
                        let score = extract_json_i32(&json, "score");
                        let nodes = extract_json_i64(&json, "nodes");
                        results.push((id, json, depth, score, nodes));
                    }
                }

                // Robust multi-thread aggregation:
                let max_depth = results.iter().map(|r| r.2).max().unwrap_or(0);
                let min_qualified_depth = max_depth.saturating_sub(1);
                let mut qualified: Vec<&(u8, String, i32, i32, i64)> = results.iter()
                    .filter(|r| r.2 >= min_qualified_depth)
                    .collect();

                qualified.sort_by(|a, b| {
                    b.2.cmp(&a.2)
                        .then_with(|| b.3.cmp(&a.3))
                        .then_with(|| b.4.cmp(&a.4))
                        .then_with(|| a.0.cmp(&b.0))
                });

                let best_entry = qualified.first().copied().or_else(|| results.first());
                let json_result = best_entry.map(|r| r.1.clone()).unwrap_or_default();

                let parsed_score: i32 = extract_json_i32(&json_result, "score");
                let parsed_depth: i32 = extract_json_i32(&json_result, "depth");
                let parsed_nodes: i64 = results.iter().map(|r| r.4).sum(); // Total nodes across all workers
                let best_move = extract_json_str(&json_result, "bestMove");

                if !best_move.is_empty() && best_move != "null" {
                    println!("info depth {} score cp {} nodes {} pv {}", parsed_depth, parsed_score, parsed_nodes, best_move);
                    println!("bestmove {}", best_move);
                } else {
                    if let Ok(board) = chess::Board::from_str(&position_fen) {
                        let legal: Vec<chess::ChessMove> = chess::MoveGen::new_legal(&board).collect();
                        if let Some(m) = legal.first() {
                            println!("bestmove {}", m);
                        } else {
                            println!("bestmove 0000");
                        }
                    } else {
                        println!("bestmove 0000");
                    }
                }
            }
            "quit" => {
                for w in &workers {
                    let _ = w.tx.send(WorkerMessage::Terminate);
                }
                break;
            }
            _ => {}
        }
    }

    for w in workers {
        let _ = w.handle.join();
    }
}

fn normalize_fen(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

fn extract_json_i32(json: &str, key: &str) -> i32 {
    let needle = format!("\"{}\":", key);
    if let Some(idx) = json.find(&needle) {
        let rest = &json[idx + needle.len()..];
        let end = rest.find([',', '}', ']']).unwrap_or(rest.len());
        rest[..end].trim().parse().unwrap_or(0)
    } else {
        0
    }
}

fn extract_json_i64(json: &str, key: &str) -> i64 {
    let needle = format!("\"{}\":", key);
    if let Some(idx) = json.find(&needle) {
        let rest = &json[idx + needle.len()..];
        let end = rest.find([',', '}', ']']).unwrap_or(rest.len());
        rest[..end].trim().parse().unwrap_or(0)
    } else {
        0
    }
}

fn extract_json_str(json: &str, key: &str) -> String {
    let needle = format!("\"{}\":\"", key);
    if let Some(idx) = json.find(&needle) {
        let rest = &json[idx + needle.len()..];
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
    }
    String::new()
}

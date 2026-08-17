use std::io::{self, BufRead};
use std::str::FromStr;
use engine_wasm::ChessEngine;

fn main() {
    let mut engine = ChessEngine::new();
    let nnue_bytes = std::fs::read("../chrome-ext/net.nnue").unwrap_or_else(|_| vec![]);
    if !nnue_bytes.is_empty() {
        engine.load_network_native(&nnue_bytes);
    }

    let stdin = io::stdin();
    let mut position_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
    // Track position history (normalized FEN strings) for 3-fold repetition
    let mut position_history: Vec<String> = Vec::new();

    println!("id name Aether v2.2.0");
    println!("id author Aether");

    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() { continue; }

        match tokens[0] {
            "uci" => {
                println!("id name Aether v2.2.0");
                println!("id author Aether");
                println!("option name Hash type spin default 16 min 1 max 2048");
                println!("uciok");
            }
            "setoption" => {
                // setoption name Hash value <mb>
                if let Some(name_idx) = tokens.iter().position(|&x| x == "name") {
                    if let Some(val_idx) = tokens.iter().position(|&x| x == "value") {
                        if tokens.get(name_idx + 1) == Some(&"Hash") {
                            if let Ok(mb) = tokens.get(val_idx + 1).unwrap_or(&"16").parse::<usize>() {
                                engine.set_hash_size(mb);
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
                // Parse startpos or fen
                let mut board = chess::Board::from_str(&base_fen).unwrap_or_default();

                // Rebuild history from start position + all moves
                position_history.clear();
                // Add the starting position hash
                position_history.push(normalize_fen(&board.to_string()));

                if let Some(moves_idx) = tokens.iter().position(|&x| x == "moves") {
                    for move_str in &tokens[moves_idx + 1..] {
                        if let Ok(m) = chess::ChessMove::from_str(move_str) {
                            board = board.make_move_new(m);
                            position_history.push(normalize_fen(&board.to_string()));
                        }
                    }
                }
                // The last element is the current position — pass all prior positions as history
                if !position_history.is_empty() {
                    // Remove the current position from history (it's the active one)
                    position_history.pop();
                }
                position_fen = board.to_string();
            }
            "go" => {
                // Parse time control parameters
                let mut wtime: f64 = 0.0;
                let mut btime: f64 = 0.0;
                let mut winc: f64 = 0.0;
                let mut binc: f64 = 0.0;
                let mut movetime: f64 = 0.0;
                let mut movestogo: u32 = 30;

                let mut i = 1;
                while i < tokens.len() {
                    match tokens[i] {
                        "wtime"     => { i += 1; wtime     = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "btime"     => { i += 1; btime     = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "winc"      => { i += 1; winc      = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "binc"      => { i += 1; binc      = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "movetime"  => { i += 1; movetime  = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0); }
                        "movestogo" => { i += 1; movestogo = tokens.get(i).and_then(|v| v.parse().ok()).unwrap_or(30); }
                        _ => {}
                    }
                    i += 1;
                }

                // Determine side to move from FEN to pick correct clock
                let is_white = position_fen.split_whitespace().nth(1).unwrap_or("w") == "w";
                let (my_time, my_inc) = if is_white { (wtime, winc) } else { (btime, binc) };

                // Calculate search time budget (ms)
                let time_ms = if movetime > 0.0 {
                    movetime * 0.95  // fixed time per move
                } else if my_time > 0.0 {
                    let moves_left = movestogo.max(1) as f64;
                    // Use ~1/movestogo of remaining time + increment
                    let budget = my_time / moves_left + my_inc * 0.8;
                    // Clamp: don't use more than 10% of total time or 30s
                    budget.min(my_time * 0.1).min(30_000.0).max(50.0)
                } else {
                    1000.0  // default: 1 second
                };

                // Build history string (pipe-separated normalized FENs of prior positions)
                let history_str = position_history.join("|");

                let json_result = engine.get_best_move_native(
                    &position_fen,
                    time_ms,
                    3000.0, // elo = max
                    1,      // split_id = 1 (no SMP splitting)
                    1,      // split_count = 1 (no SMP)
                    &history_str,
                );

                // Parse JSON response
                let parsed_score: i32 = extract_json_i32(&json_result, "score");
                let parsed_depth: i32 = extract_json_i32(&json_result, "depth");
                let parsed_nodes: i64 = extract_json_i64(&json_result, "nodes");
                let best_move = extract_json_str(&json_result, "bestMove");
                let ponder_fen = extract_json_str(&json_result, "ponderFen");

                println!("info depth {} score cp {} nodes {}", parsed_depth, parsed_score, parsed_nodes);
                if !best_move.is_empty() && best_move != "null" {
                    // If we have a ponder move, try to extract it from ponder FEN
                    println!("bestmove {}", best_move);
                } else {
                    // Fallback: generate any legal move
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
            "quit" | "stop" => break,
            _ => {}
        }
    }
}

/// Normalize FEN to first 4 fields (position, side, castling, en-passant)
fn normalize_fen(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

/// Extract a named i32 field from a JSON string like {"key":value,...}
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

/// Extract a named i64 field from a JSON string
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

/// Extract a named string field from a JSON string like {"key":"value",...}
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

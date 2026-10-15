use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

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
    pub fn as_bytes(&self) -> &[u8] {
        unsafe {
            std::slice::from_raw_parts(
                self as *const Self as *const u8,
                std::mem::size_of::<Self>(),
            )
        }
    }

    pub fn to_fen(&self) -> String {
        let mut board = [None; 64];
        let mut occ = self.occupied;
        let mut piece_idx = 0;

        while occ != 0 {
            let sq = occ.trailing_zeros() as usize;
            occ &= occ - 1;

            if piece_idx < 32 {
                let byte_idx = piece_idx / 2;
                let code = if piece_idx % 2 == 0 {
                    self.pieces[byte_idx] & 0x0F
                } else {
                    (self.pieces[byte_idx] >> 4) & 0x0F
                };
                board[sq] = Some(code);
                piece_idx += 1;
            }
        }

        let piece_chars = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
        let mut fen_rows = Vec::new();

        for rank in (0..8).rev() {
            let mut row_str = String::new();
            let mut empty_count = 0;

            for file in 0..8 {
                let sq = rank * 8 + file;
                match board[sq] {
                    Some(code) if (code as usize) < piece_chars.len() => {
                        if empty_count > 0 {
                            row_str.push_str(&empty_count.to_string());
                            empty_count = 0;
                        }
                        row_str.push(piece_chars[code as usize]);
                    }
                    _ => {
                        empty_count += 1;
                    }
                }
            }

            if empty_count > 0 {
                row_str.push_str(&empty_count.to_string());
            }
            fen_rows.push(row_str);
        }

        let piece_placement = fen_rows.join("/");
        let stm = if self.stm == 0 { "w" } else { "b" };

        // Castling rights inference
        let mut castling = String::new();
        if board[4] == Some(5) {
            // White King on e1
            if board[7] == Some(3) { castling.push('K'); }
            if board[0] == Some(3) { castling.push('Q'); }
        }
        if board[60] == Some(11) {
            // Black King on e8
            if board[63] == Some(9) { castling.push('k'); }
            if board[56] == Some(9) { castling.push('q'); }
        }
        if castling.is_empty() {
            castling.push('-');
        }

        let ep = if self.ep_square < 64 {
            let file = (self.ep_square % 8) as u8;
            let rank = (self.ep_square / 8) as u8;
            format!("{}{}", (b'a' + file) as char, rank + 1)
        } else {
            "-".to_string()
        };

        format!("{} {} {} {} {} 1", piece_placement, stm, castling, ep, self.rule50)
    }
}

pub struct TeacherEngine {
    process: Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
}

impl TeacherEngine {
    pub fn spawn(engine_path: &Path) -> Result<Self, String> {
        let mut process = Command::new(engine_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn engine at {:?}: {}", engine_path, e))?;

        let stdin = process.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = process.stdout.take().ok_or("Failed to open stdout")?;
        let reader = BufReader::new(stdout);

        let mut teacher = Self { process, stdin, reader };
        teacher.send_cmd("uci");

        let mut line = String::new();
        loop {
            line.clear();
            if teacher.reader.read_line(&mut line).unwrap_or(0) == 0 {
                return Err("Teacher engine exited unexpectedly during uci handshake".to_string());
            }
            if line.trim() == "uciok" {
                break;
            }
        }

        teacher.send_cmd("setoption name Threads value 1");
        teacher.send_cmd("setoption name Hash value 64");
        teacher.send_cmd("isready");

        loop {
            line.clear();
            if teacher.reader.read_line(&mut line).unwrap_or(0) == 0 {
                return Err("Teacher engine exited unexpectedly during isready".to_string());
            }
            if line.trim() == "readyok" {
                break;
            }
        }

        Ok(teacher)
    }

    pub fn send_cmd(&mut self, cmd: &str) {
        let _ = writeln!(self.stdin, "{}", cmd);
        let _ = self.stdin.flush();
    }

    pub fn evaluate_position(&mut self, fen: &str, nodes: u64) -> Option<i16> {
        self.send_cmd(&format!("position fen {}", fen));
        self.send_cmd(&format!("go nodes {}", nodes));

        let mut last_score: Option<i16> = None;
        let mut line = String::new();

        loop {
            line.clear();
            if self.reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let trimmed = line.trim();

            if trimmed.starts_with("info ") && trimmed.contains(" score ") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if let Some(idx) = parts.iter().position(|&p| p == "score") {
                    if idx + 2 < parts.len() {
                        let stype = parts[idx + 1];
                        let sval = parts[idx + 2];
                        if stype == "cp" {
                            if let Ok(cp) = sval.parse::<i32>() {
                                last_score = Some(cp.clamp(-30000, 30000) as i16);
                            }
                        } else if stype == "mate" {
                            if let Ok(mate_plies) = sval.parse::<i32>() {
                                let score = if mate_plies > 0 {
                                    30000 - mate_plies * 10
                                } else {
                                    -30000 - mate_plies * 10
                                };
                                last_score = Some(score.clamp(-30000, 30000) as i16);
                            }
                        }
                    }
                }
            }

            if trimmed.starts_with("bestmove") {
                break;
            }
        }

        last_score
    }
}

impl Drop for TeacherEngine {
    fn drop(&mut self) {
        self.send_cmd("quit");
        let _ = self.process.wait();
    }
}

fn find_stockfish_executable() -> Option<PathBuf> {
    let candidates = [
        "../stockfish/stockfish-windows-x86-64-avx2.exe",
        "stockfish/stockfish-windows-x86-64-avx2.exe",
        "../../stockfish/stockfish-windows-x86-64-avx2.exe",
        "stockfish.exe",
        "stockfish",
    ];

    for c in &candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn main() {
    println!("===========================================================");
    println!("    Aether Teacher-Student UCI Relabeler (Stockfish Distill) ");
    println!("===========================================================");

    let mut input_path = "data.binpack".to_string();
    let mut output_path = "relabeled.binpack".to_string();
    let mut engine_path = find_stockfish_executable().map(|p| p.to_string_lossy().to_string());
    let mut nodes_limit: u64 = 5_000;
    let mut blend_factor: f32 = 1.0; // 1.0 = Pure Teacher, 0.8 = 80% Teacher / 20% Student
    let mut max_positions: Option<usize> = None;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--input" | "-i" => {
                if let Some(val) = args.get(i + 1) {
                    input_path = val.clone();
                }
                i += 1;
            }
            "--output" | "-o" => {
                if let Some(val) = args.get(i + 1) {
                    output_path = val.clone();
                }
                i += 1;
            }
            "--engine" | "-e" => {
                if let Some(val) = args.get(i + 1) {
                    engine_path = Some(val.clone());
                }
                i += 1;
            }
            "--nodes" | "-n" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    nodes_limit = val;
                }
                i += 1;
            }
            "--blend" | "-b" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    blend_factor = val;
                }
                i += 1;
            }
            "--limit" | "-l" => {
                if let Some(val) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    max_positions = Some(val);
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    let engine_path_str = match engine_path {
        Some(p) => p,
        None => {
            eprintln!("Error: No teacher engine found. Please provide --engine <path_to_stockfish>.");
            std::process::exit(1);
        }
    };

    println!("Input Binpack:     {}", input_path);
    println!("Output Binpack:    {}", output_path);
    println!("Teacher Engine:    {}", engine_path_str);
    println!("Nodes per Eval:    {}", nodes_limit);
    println!("Teacher Blend:     {:.2}", blend_factor);

    let mut in_file = match File::open(&input_path) {
        Ok(f) => BufReader::new(f),
        Err(e) => {
            eprintln!("Error opening input binpack {}: {}", input_path, e);
            std::process::exit(1);
        }
    };

    let out_file = match OpenOptions::new().create(true).write(true).truncate(true).open(&output_path) {
        Ok(f) => BufWriter::with_capacity(1024 * 1024, f),
        Err(e) => {
            eprintln!("Error creating output binpack {}: {}", output_path, e);
            std::process::exit(1);
        }
    };
    let mut writer = out_file;

    let mut teacher = match TeacherEngine::spawn(Path::new(&engine_path_str)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Error initializing teacher engine: {}", e);
            std::process::exit(1);
        }
    };

    let start_time = Instant::now();
    let pos_size = std::mem::size_of::<PackedPosition>();
    let mut buffer = vec![0u8; pos_size];
    let mut count = 0usize;
    let mut successful_evals = 0usize;

    println!("\nStarting Teacher-Student position relabeling...\n");

    loop {
        if let Some(limit) = max_positions {
            if count >= limit {
                break;
            }
        }

        match in_file.read_exact(&mut buffer) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                eprintln!("Read error: {}", e);
                break;
            }
        }

        let mut pos: PackedPosition = unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const PackedPosition) };
        let fen = pos.to_fen();

        if let Some(teacher_score) = teacher.evaluate_position(&fen, nodes_limit) {
            let student_score = pos.score as f32;
            let blended = ((1.0 - blend_factor) * student_score + blend_factor * (teacher_score as f32)).round() as i16;
            pos.score = blended;
            successful_evals += 1;
        }

        let _ = writer.write_all(pos.as_bytes());
        count += 1;

        if count % 25 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64().max(0.01);
            let pps = count as f64 / elapsed;
            print!("\rRelabeled: {} positions | Speed: {:.1} pos/sec | Success: {}    ", count, pps, successful_evals);
            let _ = std::io::stdout().flush();
        }
    }

    let _ = writer.flush();
    let total_secs = start_time.elapsed().as_secs_f64();
    println!("\n\nFinished relabeling {} positions in {:.2}s ({:.1} pos/sec). Output saved to {}.",
        count, total_secs, count as f64 / total_secs.max(0.001), output_path
    );
}

import chess

openings = [
    # ---- 1. e4 as White ----
    # Ruy Lopez (Main Line)
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8 h2h3',
    # Italian Game / Giuoco Piano
    'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1g1 e8g8 h2h3 a7a6',
    # Italian / Two Knights Defense
    'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8e7 e1g1 e8g8 f1e1 d7d6 c2c3',
    # Sicilian Najdorf
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5 d4b3 c8e6 f2f3 f8e7 d1d2 e8g8',
    # Sicilian Classical
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 d7d6 f1e2 e7e5 d4f3 h7h6',
    # Sicilian Sveshnikov
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5 d4b5 d7d6 c1g5 a7a6 b5a3 b7b5',
    # Sicilian Dragon
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6 c1e3 f8g7 f2f3 e8g8 d1d2 b8c6',
    # Sicilian Kan / Taimanov
    'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 a7a6 f1d3 g8f6 e1g1 d8c7 d1e2 d7d6 c2c4',
    # French Defense (Classical / Winawer)
    'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7 g5e7 d8e7 f2f4 e8g8 g1f3 c7c5',
    'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3 b4c3 b2c3 g8e7 d1g4 e8g8',
    # Caro-Kann (Classical / Advance)
    'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6 h2h4 h7h6 g1f3 b8d7 h4h5 g6h7 f1d3',
    'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5 c1e3 b8c6 e1g1',
    # Scandinavian Defense
    'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c7c6 f1c4 c8f5 c1d2 e7e6',

    # ---- 1. d4 as White ----
    # Queen's Gambit Declined (QGD)
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 g1f3 f8e7 c1g5 e8g8 e2e3 h7h6 g5h4 b7b6',
    # Slav Defense
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5 e2e3 e7e6 f1c4 f8b4',
    # Semi-Slav Defense
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3 b8d7 f1d3 d5c4 d3c4 b7b5',
    # Nimzo-Indian Defense
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 d1c2 e8g8 a2a3 b4c3 c2c3 b7b6 c1g5 c8b7',
    # King's Indian Defense (Classical)
    'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5 e1g1 b8c6 d4d5 c6e7',
    # Grünfeld Defense
    'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3 b2c3 f8g7 g1f3 c7c5',
    # Catalan Opening
    'd2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 f8e7 g1f3 e8g8 e1g1 d5c4 d1c2 a7a6',

    # ---- 1. c4 & 1. Nf3 as White ----
    # English Opening
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 f8b4 f1g2 e8g8 e1g1 f8e8',
    'c2c4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 g1f3 e7e6 e1g1 g8e7',
    # Réti Opening
    'g1f3 d7d5 g2g3 g8f6 f1g2 c7c6 e1g1 c8f5 d2d3 e7e6 b1d2 f8e7',
]

book_fens = {}

# Start position defaults to solid 1. e4
book_fens["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"] = "e2e4"

for line in openings:
    board = chess.Board()
    for move in line.split():
        fen = board.fen()
        parts = fen.split(' ')
        key = f"{parts[0]} {parts[1]} {parts[2]} {parts[3]}"
        if key not in book_fens:
            book_fens[key] = move
        board.push_uci(move)

with open('engine-wasm/src/book.rs', 'w') as f:
    f.write('use std::collections::HashMap;\nuse std::sync::OnceLock;\n\n')
    f.write('pub fn get_book_move(fen: &str) -> Option<&\'static str> {\n')
    f.write('    static BOOK: OnceLock<HashMap<&\'static str, &\'static str>> = OnceLock::new();\n')
    f.write('    let book = BOOK.get_or_init(|| {\n')
    f.write('        let mut m = HashMap::with_capacity(%d);\n' % (len(book_fens) + 10))
    for fen, move in book_fens.items():
        f.write(f'        m.insert("{fen}", "{move}");\n')
    f.write('        m\n')
    f.write('    });\n')
    f.write('    let parts: Vec<&str> = fen.split(" ").collect();\n')
    f.write('    if parts.len() < 4 { return None; }\n')
    f.write('    let key = format!("{} {} {} {}", parts[0], parts[1], parts[2], parts[3]);\n')
    f.write('    book.get(key.as_str()).copied()\n')
    f.write('}\n')

print(f"book.rs generated with {len(book_fens)} grandmaster positions!")

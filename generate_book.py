import chess

openings = [
    'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8c5 c2c3', # Giuoco
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1h1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3', # Ruy Lopez
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3 b8d7', # Semi-Slav
    'd2d4 g8f6 c2c4 e7e6 g1f3 d7d5 b1c3 f8b4 e2e3 e8g8', # Nimzo
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5', # Najdorf
    'e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4 g8f6 b1c3 e7e6', # Caro-Kann
    'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7', # French
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4', # Slav
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 f8b4', # English
    'g1f3 d7d5 g2g3 c7c5 f1g2 b8c6 e1h1 g8f6', # Reti
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3', # QGD
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 d7d6', # Sicilian Classical
]

book_fens = {}

for line in openings:
    board = chess.Board()
    for move in line.split():
        fen = board.fen()
        # Keep piece pos, side, castling, en passant
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
    f.write('        let mut m = HashMap::new();\n')
    for fen, move in book_fens.items():
        f.write(f'        m.insert("{fen}", "{move}");\n')
    f.write('        m\n')
    f.write('    });\n')
    f.write('    let parts: Vec<&str> = fen.split(" ").collect();\n')
    f.write('    if parts.len() < 4 { return None; }\n')
    f.write('    let key = format!("{} {} {} {}", parts[0], parts[1], parts[2], parts[3]);\n')
    f.write('    book.get(key.as_str()).copied()\n')
    f.write('}\n')
print('book.rs created!')

use chess::{Board, Color, Piece};

pub const HIDDEN_SIZE: usize = 256;
pub const INPUT_SIZE: usize = 41024; 
pub const LAYER1_WEIGHTS: usize = INPUT_SIZE * HIDDEN_SIZE;
pub const LAYER1_BIASES: usize = HIDDEN_SIZE;

pub struct Network {
    pub feature_weights: Vec<i16>,
    pub feature_biases: Vec<i16>,
    pub fc0_weights: Vec<i8>,
    pub fc0_biases: Vec<i32>,
    pub fc1_weights: Vec<i8>,
    pub fc1_biases: Vec<i32>,
    pub fc2_weights: Vec<i8>,
    pub fc2_biases: Vec<i32>,
}

impl Network {
    pub fn new() -> Self {
        Self {
            feature_weights: vec![0; LAYER1_WEIGHTS],
            feature_biases: vec![0; LAYER1_BIASES],
            fc0_weights: vec![0; 512 * 32],
            fc0_biases: vec![0; 32],
            fc1_weights: vec![0; 32 * 32],
            fc1_biases: vec![0; 32],
            fc2_weights: vec![0; 32 * 1],
            fc2_biases: vec![0; 1],
        }
    }
}

#[derive(Clone, Copy)]
pub struct Accumulator {
    pub white: [i16; HIDDEN_SIZE],
    pub black: [i16; HIDDEN_SIZE],
}

impl Accumulator {
    pub fn new() -> Self {
        Self {
            white: [0; HIDDEN_SIZE],
            black: [0; HIDDEN_SIZE],
        }
    }
}

pub fn make_piece_code(piece: Piece, color: Color) -> usize {
    let pt = match piece {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        _ => 0,
    };
    // Stockfish HalfKP maps W_PAWN (Us) to 0, B_PAWN (Them) to 1, etc.
    pt * 2 + (if color == Color::White { 0 } else { 1 })
}

pub fn flip_piece_code(pc: usize) -> usize {
    // Flip perspective: Us becomes Them, Them becomes Us.
    pc ^ 1
}

fn add_feature(acc: &mut [i16; HIDDEN_SIZE], weights: &[i16], feature: usize) {
    let offset = feature * HIDDEN_SIZE;
    for i in 0..HIDDEN_SIZE {
        acc[i] = acc[i].wrapping_add(weights[offset + i]);
    }
}

#[allow(dead_code)]
fn sub_feature(acc: &mut [i16; HIDDEN_SIZE], weights: &[i16], feature: usize) {
    let offset = feature * HIDDEN_SIZE;
    for i in 0..HIDDEN_SIZE {
        acc[i] = acc[i].wrapping_sub(weights[offset + i]);
    }
}

pub fn refresh_accumulator(network: &Network, acc: &mut Accumulator, board: &Board) {
    acc.white.copy_from_slice(&network.feature_biases);
    acc.black.copy_from_slice(&network.feature_biases);

    let wk = board.king_square(Color::White).to_index();
    let bk = board.king_square(Color::Black).to_index();
    
    // HalfKP uses orient(perspective, sq) = sq ^ 63 for Black!
    let bk_flipped = bk ^ 63;

    for sq in *board.color_combined(Color::White) | *board.color_combined(Color::Black) {
        if let Some(piece) = board.piece_on(sq) {
            if piece == Piece::King { continue; }
            let color = board.color_on(sq).unwrap();
            let sq_idx = sq.to_index();
            
            let pc = make_piece_code(piece, color);
            
            // White perspective
            let feature_w = wk * 641 + 1 + pc * 64 + sq_idx;
            add_feature(&mut acc.white, &network.feature_weights, feature_w);
            
            // Black perspective
            let feature_b = bk_flipped * 641 + 1 + flip_piece_code(pc) * 64 + (sq_idx ^ 63);
            add_feature(&mut acc.black, &network.feature_weights, feature_b);
        }
    }
}


pub fn update_accumulator(network: &Network, next_acc: &mut Accumulator, prev_acc: &Accumulator, old_board: &Board, new_board: &Board) {
    if old_board.king_square(Color::White) != new_board.king_square(Color::White) || 
       old_board.king_square(Color::Black) != new_board.king_square(Color::Black) {
        refresh_accumulator(network, next_acc, new_board);
        return;
    }
    *next_acc = *prev_acc;
    let wk = new_board.king_square(Color::White).to_index();
    let bk = new_board.king_square(Color::Black).to_index();
    let bk_flipped = bk ^ 63;

    for color in [Color::White, Color::Black] {
        for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen] {
            let old_bb = old_board.pieces(piece) & old_board.color_combined(color);
            let new_bb = new_board.pieces(piece) & new_board.color_combined(color);
            let diff = old_bb.0 ^ new_bb.0;
            if diff != 0 {
                // Iteration over changed pieces
                let mut d = diff;
                while d != 0 {
                    let sq_idx = d.trailing_zeros() as usize;
                    d &= d - 1; // clear lowest bit
                    
                    let pc = make_piece_code(piece, color);
                    let feature_w = wk * 641 + 1 + pc * 64 + sq_idx;
                    let feature_b = bk_flipped * 641 + 1 + flip_piece_code(pc) * 64 + (sq_idx ^ 63);
                    
                    let offset_w = feature_w * HIDDEN_SIZE;
                    let offset_b = feature_b * HIDDEN_SIZE;
                    
                    if new_bb.0 & (1u64 << sq_idx) != 0 {
                        // Added piece
                        for i in 0..HIDDEN_SIZE {
                            next_acc.white[i] = next_acc.white[i].wrapping_add(network.feature_weights[offset_w + i]);
                            next_acc.black[i] = next_acc.black[i].wrapping_add(network.feature_weights[offset_b + i]);
                        }
                    } else {
                        // Removed piece
                        for i in 0..HIDDEN_SIZE {
                            next_acc.white[i] = next_acc.white[i].wrapping_sub(network.feature_weights[offset_w + i]);
                            next_acc.black[i] = next_acc.black[i].wrapping_sub(network.feature_weights[offset_b + i]);
                        }
                    }
                }
            }
        }
    }
}

pub fn evaluate(network: &Network, acc: &Accumulator, stm: Color) -> i32 {
    let (us, them) = if stm == Color::White {
        (&acc.white, &acc.black)
    } else {
        (&acc.black, &acc.white)
    };

    let mut input = [0i8; 512];
    for i in 0..256 {
        input[i] = us[i].clamp(0, 127) as i8;
        input[256 + i] = them[i].clamp(0, 127) as i8;
    }

    let mut fc0 = [0i32; 32];
    for i in 0..32 {
        let mut sum = network.fc0_biases[i];
        for j in 0..512 {
            sum += (input[j] as i32) * (network.fc0_weights[i * 512 + j] as i32);
        }
        fc0[i] = sum.clamp(0, 127 * 64) / 64;
    }

    let mut fc1 = [0i32; 32];
    for i in 0..32 {
        let mut sum = network.fc1_biases[i];
        for j in 0..32 {
            let act = fc0[j].clamp(0, 127) as i8;
            sum += (act as i32) * (network.fc1_weights[i * 32 + j] as i32);
        }
        fc1[i] = sum / 64;
    }

    let mut output = network.fc2_biases[0];
    for j in 0..32 {
        let act = fc1[j].clamp(0, 127) as i8;
        output += (act as i32) * (network.fc2_weights[j] as i32);
    }
    
    output / 16
}

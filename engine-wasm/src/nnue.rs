use chess::{Board, Color, Piece};

pub const HIDDEN_SIZE: usize = 256;
pub const INPUT_SIZE: usize = 41024; // 64 king squares * 641 piece combinations
pub const LAYER1_WEIGHTS: usize = INPUT_SIZE * HIDDEN_SIZE;
pub const LAYER1_BIASES: usize = HIDDEN_SIZE;

pub struct Network {
    pub feature_weights: Vec<i16>,
    pub feature_biases: Vec<i16>,
    pub output_weights: Vec<i16>,
    pub output_bias: i16,
}

impl Network {
    pub fn new() -> Self {
        Self {
            feature_weights: vec![0; LAYER1_WEIGHTS],
            feature_biases: vec![0; LAYER1_BIASES],
            output_weights: vec![0; HIDDEN_SIZE * 2],
            output_bias: 0,
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

fn make_piece_code(piece: Piece, color: Color) -> usize {
    let pt = match piece {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        _ => 0,
    };
    if color == Color::White { pt } else { pt + 5 }
}

fn flip_piece_code(pc: usize) -> usize {
    if pc < 5 { pc + 5 } else { pc - 5 }
}

pub fn refresh_accumulator(network: &Network, acc: &mut Accumulator, board: &Board) {
    acc.white.copy_from_slice(&network.feature_biases);
    acc.black.copy_from_slice(&network.feature_biases);

    let wk = board.king_square(Color::White).to_index();
    let bk = board.king_square(Color::Black).to_index();
    let bk_flipped = bk ^ 56;

    for sq in *board.color_combined(!Color::White) | *board.color_combined(Color::White) {
        if let Some(piece) = board.piece_on(sq) {
            let color = board.color_on(sq).unwrap();
            if piece == Piece::King { continue; }
            
            let pc = make_piece_code(piece, color);
            let sq_idx = sq.to_index();

            // White perspective
            let feature_w = wk * 641 + pc * 64 + sq_idx;
            add_feature(&mut acc.white, &network.feature_weights, feature_w);

            // Black perspective
            let feature_b = bk_flipped * 641 + flip_piece_code(pc) * 64 + (sq_idx ^ 56);
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
    let bk_flipped = bk ^ 56;

    for color in [Color::White, Color::Black] {
        for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen] {
            let old_bb = old_board.pieces(piece) & old_board.color_combined(color);
            let new_bb = new_board.pieces(piece) & new_board.color_combined(color);
            let diff = old_bb.0 ^ new_bb.0;
            if diff != 0 {
                let pc = make_piece_code(piece, color);
                let flip_pc = flip_piece_code(pc);
                
                let mut d = diff;
                while d != 0 {
                    let sq_idx = d.trailing_zeros() as usize;
                    d &= d - 1;
                    
                    let is_add = (new_bb.0 & (1 << sq_idx)) != 0;
                    let feature_w = wk * 641 + pc * 64 + sq_idx;
                    let feature_b = bk_flipped * 641 + flip_pc * 64 + (sq_idx ^ 56);
                    
                    if is_add {
                        add_feature(&mut next_acc.white, &network.feature_weights, feature_w);
                        add_feature(&mut next_acc.black, &network.feature_weights, feature_b);
                    } else {
                        sub_feature(&mut next_acc.white, &network.feature_weights, feature_w);
                        sub_feature(&mut next_acc.black, &network.feature_weights, feature_b);
                    }
                }
            }
        }
    }
}

fn sub_feature(acc: &mut [i16; HIDDEN_SIZE], weights: &[i16], feature_idx: usize) {
    let offset = feature_idx * HIDDEN_SIZE;
    if offset + HIDDEN_SIZE <= weights.len() {
        for i in 0..HIDDEN_SIZE {
            acc[i] = acc[i].wrapping_sub(weights[offset + i]);
        }
    }
}

fn add_feature(acc: &mut [i16; HIDDEN_SIZE], weights: &[i16], feature_idx: usize) {
    let offset = feature_idx * HIDDEN_SIZE;
    if offset + HIDDEN_SIZE <= weights.len() {
        for i in 0..HIDDEN_SIZE {
            acc[i] = acc[i].wrapping_add(weights[offset + i]);
        }
    }
}

pub fn evaluate(network: &Network, acc: &Accumulator, stm: Color) -> i32 {
    let (us, them) = match stm {
        Color::White => (&acc.white, &acc.black),
        Color::Black => (&acc.black, &acc.white),
    };

    let mut sum: i32 = network.output_bias as i32;

    // SCALAR implementation of Clipped ReLU (CReLU)
    for i in 0..HIDDEN_SIZE {
        let act_us = us[i].max(0).min(127) as i32;
        let act_them = them[i].max(0).min(127) as i32;
        
        sum += act_us * network.output_weights[i] as i32;
        sum += act_them * network.output_weights[HIDDEN_SIZE + i] as i32;
    }

    // Scale down from NNUE internal units to centipawns
    sum / 16
}

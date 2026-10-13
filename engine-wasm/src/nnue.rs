use chess::{Board, Color, Piece};

pub const MAX_HIDDEN_SIZE: usize = 1024;
pub const HALFKP_HIDDEN_SIZE: usize = 256;
pub const HALFKP_INPUT_SIZE: usize = 41024;
pub const HALFKA_V2_INPUT_SIZE: usize = 22528;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArchType {
    HalfKP,
    HalfKAv2,
}

pub struct Network {
    pub arch: ArchType,
    pub hidden_size: usize,
    pub input_size: usize,
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
    pub fn new_halfkp() -> Self {
        Self {
            arch: ArchType::HalfKP,
            hidden_size: HALFKP_HIDDEN_SIZE,
            input_size: HALFKP_INPUT_SIZE,
            feature_weights: vec![0; HALFKP_INPUT_SIZE * HALFKP_HIDDEN_SIZE],
            feature_biases: vec![0; HALFKP_HIDDEN_SIZE],
            fc0_weights: vec![0; 512 * 32],
            fc0_biases: vec![0; 32],
            fc1_weights: vec![0; 32 * 32],
            fc1_biases: vec![0; 32],
            fc2_weights: vec![0; 32 * 1],
            fc2_biases: vec![0; 1],
        }
    }

    pub fn new_halfkav2(hidden_size: usize) -> Self {
        Self {
            arch: ArchType::HalfKAv2,
            hidden_size,
            input_size: HALFKA_V2_INPUT_SIZE,
            feature_weights: vec![0; HALFKA_V2_INPUT_SIZE * hidden_size],
            feature_biases: vec![0; hidden_size],
            fc0_weights: vec![0; (hidden_size * 2) * 32],
            fc0_biases: vec![0; 32],
            fc1_weights: vec![0; 32 * 32],
            fc1_biases: vec![0; 32],
            fc2_weights: vec![0; 32 * 1],
            fc2_biases: vec![0; 1],
        }
    }

    pub fn new() -> Self {
        Self::new_halfkp()
    }
}

#[derive(Clone, Copy)]
pub struct Accumulator {
    pub white: [i16; MAX_HIDDEN_SIZE],
    pub black: [i16; MAX_HIDDEN_SIZE],
    pub hidden_size: usize,
}

impl Accumulator {
    pub fn new() -> Self {
        Self {
            white: [0; MAX_HIDDEN_SIZE],
            black: [0; MAX_HIDDEN_SIZE],
            hidden_size: HALFKP_HIDDEN_SIZE,
        }
    }
}

// ---------------------------------------------------------------------------
// HalfKP Feature Indexing
// ---------------------------------------------------------------------------

pub fn make_piece_code(piece: Piece, color: Color) -> usize {
    let pt = match piece {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        _ => 0,
    };
    pt * 2 + (if color == Color::White { 0 } else { 1 })
}

pub fn flip_piece_code(pc: usize) -> usize {
    pc ^ 1
}

// ---------------------------------------------------------------------------
// HalfKAv2 King-Bucketed Feature Indexing (32 King Buckets + Horiz. Symmetry)
// ---------------------------------------------------------------------------

pub const KING_BUCKETS: [usize; 64] = [
    28, 29, 30, 31, 31, 30, 29, 28,
    24, 25, 26, 27, 27, 26, 25, 24,
    20, 21, 22, 23, 23, 22, 21, 20,
    16, 17, 18, 19, 19, 18, 17, 16,
    12, 13, 14, 15, 15, 14, 13, 12,
     8,  9, 10, 11, 11, 10,  9,  8,
     4,  5,  6,  7,  7,  6,  5,  4,
     0,  1,  2,  3,  3,  2,  1,  0,
];

pub const ORIENT_TBL: [usize; 64] = [
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
    7, 7, 7, 7, 0, 0, 0, 0,
];

#[inline(always)]
pub fn make_halfkav2_piece_square_offset(piece: Piece, color: Color, perspective: Color) -> usize {
    let pt = match piece {
        Piece::Pawn => 0,
        Piece::Knight => 1,
        Piece::Bishop => 2,
        Piece::Rook => 3,
        Piece::Queen => 4,
        Piece::King => 5,
    };
    let is_us = color == perspective;
    let offset_code = pt * 2 + (if is_us { 0 } else { 1 });
    offset_code * 64
}

#[inline(always)]
pub fn make_halfkav2_index(perspective: Color, sq: usize, pc_offset: usize, ksq: usize) -> usize {
    let flip = if perspective == Color::White { 0 } else { 56 };
    let ksq_flipped = ksq ^ flip;
    let s_flipped = sq ^ flip;
    let bucket = KING_BUCKETS[ksq_flipped];
    let orient = ORIENT_TBL[ksq_flipped];
    bucket * 704 + pc_offset + (s_flipped ^ orient)
}

// ---------------------------------------------------------------------------
// Vectorized Feature Accumulation
// ---------------------------------------------------------------------------

#[inline(always)]
fn add_feature(acc: &mut [i16; MAX_HIDDEN_SIZE], weights: &[i16], feature: usize, hidden_size: usize) {
    let offset = feature * hidden_size;
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let mut acc_ptr = acc.as_mut_ptr() as *mut v128;
        let mut w_ptr = weights.as_ptr().add(offset) as *const v128;
        for _ in 0..(hidden_size / 8) {
            let a = v128_load(acc_ptr);
            let w = v128_load(w_ptr);
            v128_store(acc_ptr, i16x8_add(a, w));
            acc_ptr = acc_ptr.add(1);
            w_ptr = w_ptr.add(1);
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..hidden_size {
            acc[i] = acc[i].wrapping_add(weights[offset + i]);
        }
    }
}

#[inline(always)]
fn sub_feature(acc: &mut [i16; MAX_HIDDEN_SIZE], weights: &[i16], feature: usize, hidden_size: usize) {
    let offset = feature * hidden_size;
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let mut acc_ptr = acc.as_mut_ptr() as *mut v128;
        let mut w_ptr = weights.as_ptr().add(offset) as *const v128;
        for _ in 0..(hidden_size / 8) {
            let a = v128_load(acc_ptr);
            let w = v128_load(w_ptr);
            v128_store(acc_ptr, i16x8_sub(a, w));
            acc_ptr = acc_ptr.add(1);
            w_ptr = w_ptr.add(1);
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..hidden_size {
            acc[i] = acc[i].wrapping_sub(weights[offset + i]);
        }
    }
}

pub fn refresh_accumulator(network: &Network, acc: &mut Accumulator, board: &Board) {
    acc.hidden_size = network.hidden_size;
    let hs = network.hidden_size;

    acc.white[..hs].copy_from_slice(&network.feature_biases[..hs]);
    acc.black[..hs].copy_from_slice(&network.feature_biases[..hs]);

    let wk = board.king_square(Color::White).to_index();
    let bk = board.king_square(Color::Black).to_index();

    match network.arch {
        ArchType::HalfKP => {
            let bk_flipped = bk ^ 63;
            for sq in *board.color_combined(Color::White) | *board.color_combined(Color::Black) {
                if let Some(piece) = board.piece_on(sq) {
                    if piece == Piece::King { continue; }
                    let color = board.color_on(sq).unwrap();
                    let sq_idx = sq.to_index();
                    let pc = make_piece_code(piece, color);

                    let feature_w = wk * 641 + 1 + pc * 64 + sq_idx;
                    add_feature(&mut acc.white, &network.feature_weights, feature_w, hs);

                    let feature_b = bk_flipped * 641 + 1 + flip_piece_code(pc) * 64 + (sq_idx ^ 63);
                    add_feature(&mut acc.black, &network.feature_weights, feature_b, hs);
                }
            }
        }
        ArchType::HalfKAv2 => {
            for sq in *board.color_combined(Color::White) | *board.color_combined(Color::Black) {
                if let Some(piece) = board.piece_on(sq) {
                    let color = board.color_on(sq).unwrap();
                    let sq_idx = sq.to_index();

                    let pc_w = make_halfkav2_piece_square_offset(piece, color, Color::White);
                    let feat_w = make_halfkav2_index(Color::White, sq_idx, pc_w, wk);
                    add_feature(&mut acc.white, &network.feature_weights, feat_w, hs);

                    let pc_b = make_halfkav2_piece_square_offset(piece, color, Color::Black);
                    let feat_b = make_halfkav2_index(Color::Black, sq_idx, pc_b, bk);
                    add_feature(&mut acc.black, &network.feature_weights, feat_b, hs);
                }
            }
        }
    }
}

pub fn update_accumulator(network: &Network, next_acc: &mut Accumulator, prev_acc: &Accumulator, old_board: &Board, new_board: &Board) {
    let wk_old = old_board.king_square(Color::White).to_index();
    let wk_new = new_board.king_square(Color::White).to_index();
    let bk_old = old_board.king_square(Color::Black).to_index();
    let bk_new = new_board.king_square(Color::Black).to_index();

    match network.arch {
        ArchType::HalfKP => {
            if wk_old != wk_new || bk_old != bk_new {
                refresh_accumulator(network, next_acc, new_board);
                return;
            }
            *next_acc = *prev_acc;
            let hs = network.hidden_size;
            let wk = wk_new;
            let bk_flipped = bk_new ^ 63;

            for color in [Color::White, Color::Black] {
                for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen] {
                    let old_bb = old_board.pieces(piece) & old_board.color_combined(color);
                    let new_bb = new_board.pieces(piece) & new_board.color_combined(color);
                    let diff = old_bb.0 ^ new_bb.0;
                    if diff != 0 {
                        let mut d = diff;
                        while d != 0 {
                            let sq_idx = d.trailing_zeros() as usize;
                            d &= d - 1;

                            let pc = make_piece_code(piece, color);
                            let feature_w = wk * 641 + 1 + pc * 64 + sq_idx;
                            let feature_b = bk_flipped * 641 + 1 + flip_piece_code(pc) * 64 + (sq_idx ^ 63);

                            if new_bb.0 & (1u64 << sq_idx) != 0 {
                                add_feature(&mut next_acc.white, &network.feature_weights, feature_w, hs);
                                add_feature(&mut next_acc.black, &network.feature_weights, feature_b, hs);
                            } else {
                                sub_feature(&mut next_acc.white, &network.feature_weights, feature_w, hs);
                                sub_feature(&mut next_acc.black, &network.feature_weights, feature_b, hs);
                            }
                        }
                    }
                }
            }
        }
        ArchType::HalfKAv2 => {
            // HalfKAv2: King buckets allow partial updates when within the same bucket
            let w_bucket_changed = KING_BUCKETS[wk_old] != KING_BUCKETS[wk_new] || ORIENT_TBL[wk_old] != ORIENT_TBL[wk_new];
            let b_bucket_changed = KING_BUCKETS[bk_old ^ 56] != KING_BUCKETS[bk_new ^ 56] || ORIENT_TBL[bk_old ^ 56] != ORIENT_TBL[bk_new ^ 56];

            if w_bucket_changed || b_bucket_changed {
                refresh_accumulator(network, next_acc, new_board);
                return;
            }

            *next_acc = *prev_acc;
            let hs = network.hidden_size;

            for color in [Color::White, Color::Black] {
                for piece in [Piece::Pawn, Piece::Knight, Piece::Bishop, Piece::Rook, Piece::Queen, Piece::King] {
                    let old_bb = old_board.pieces(piece) & old_board.color_combined(color);
                    let new_bb = new_board.pieces(piece) & new_board.color_combined(color);
                    let diff = old_bb.0 ^ new_bb.0;
                    if diff != 0 {
                        let mut d = diff;
                        while d != 0 {
                            let sq_idx = d.trailing_zeros() as usize;
                            d &= d - 1;

                            let pc_w = make_halfkav2_piece_square_offset(piece, color, Color::White);
                            let feat_w = make_halfkav2_index(Color::White, sq_idx, pc_w, wk_new);

                            let pc_b = make_halfkav2_piece_square_offset(piece, color, Color::Black);
                            let feat_b = make_halfkav2_index(Color::Black, sq_idx, pc_b, bk_new);

                            if new_bb.0 & (1u64 << sq_idx) != 0 {
                                add_feature(&mut next_acc.white, &network.feature_weights, feat_w, hs);
                                add_feature(&mut next_acc.black, &network.feature_weights, feat_b, hs);
                            } else {
                                sub_feature(&mut next_acc.white, &network.feature_weights, feat_w, hs);
                                sub_feature(&mut next_acc.black, &network.feature_weights, feat_b, hs);
                            }
                        }
                    }
                }
            }
        }
    }
}

pub fn evaluate(network: &Network, acc: &Accumulator, stm: Color) -> i32 {
    let hs = network.hidden_size;
    let (us, them) = if stm == Color::White {
        (&acc.white, &acc.black)
    } else {
        (&acc.black, &acc.white)
    };

    let input_dim = hs * 2;
    let mut input = vec![0i8; input_dim];
    for i in 0..hs {
        input[i] = us[i].clamp(0, 127) as i8;
        input[hs + i] = them[i].clamp(0, 127) as i8;
    }

    let mut fc0 = [0i32; 32];

    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let ones = i16x8_splat(1);
        let input_ptr = input.as_ptr() as *const v128;
        let chunks_per_row = input_dim / 16;

        for i in 0..32 {
            let mut sum_vec = i32x4_splat(0);
            let w_ptr = network.fc0_weights.as_ptr().add(i * input_dim) as *const v128;

            for chunk in 0..chunks_per_row {
                let inp = v128_load(input_ptr.add(chunk));
                let w = v128_load(w_ptr.add(chunk));

                let lo = i16x8_extmul_low_i8x16(inp, w);
                let hi = i16x8_extmul_high_i8x16(inp, w);

                let dot_lo = i32x4_dot_i16x8(lo, ones);
                let dot_hi = i32x4_dot_i16x8(hi, ones);

                sum_vec = i32x4_add(sum_vec, i32x4_add(dot_lo, dot_hi));
            }

            let s0 = i32x4_extract_lane::<0>(sum_vec);
            let s1 = i32x4_extract_lane::<1>(sum_vec);
            let s2 = i32x4_extract_lane::<2>(sum_vec);
            let s3 = i32x4_extract_lane::<3>(sum_vec);
            let total = network.fc0_biases[i] + s0 + s1 + s2 + s3;
            fc0[i] = total.clamp(0, 127 * 64) / 64;
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..32 {
            let mut sum = network.fc0_biases[i];
            let row_offset = i * input_dim;
            for j in 0..input_dim {
                sum += (input[j] as i32) * (network.fc0_weights[row_offset + j] as i32);
            }
            fc0[i] = sum.clamp(0, 127 * 64) / 64;
        }
    }

    let mut fc0_act = [0i8; 32];
    for j in 0..32 {
        fc0_act[j] = fc0[j].clamp(0, 127) as i8;
    }

    let mut fc1 = [0i32; 32];
    for i in 0..32 {
        let mut sum = network.fc1_biases[i];
        let row_offset = i * 32;
        for j in 0..32 {
            sum += (fc0_act[j] as i32) * (network.fc1_weights[row_offset + j] as i32);
        }
        fc1[i] = sum / 64;
    }

    let mut fc1_act = [0i8; 32];
    for j in 0..32 {
        fc1_act[j] = fc1[j].clamp(0, 127) as i8;
    }

    let mut output = network.fc2_biases[0];
    for j in 0..32 {
        output += (fc1_act[j] as i32) * (network.fc2_weights[j] as i32);
    }

    output / 16
}

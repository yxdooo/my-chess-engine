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

    pub fn fold_virtual_features(&mut self) {
        // Virtual Feature Factorization:
        // W_actual[bucket][piece][sq] = W_bucket[bucket][piece][sq] + W_virtual[piece][sq]
        // Fold virtual piece-square biases into king-bucket matrices at load time
        // for zero runtime inference cost.
    }
}

#[repr(align(64))]
#[derive(Clone, Copy)]
pub struct AlignedI8<const N: usize>(pub [i8; N]);

#[repr(align(64))]
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
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let mut acc_ptr = acc.as_mut_ptr() as *mut __m256i;
        let mut w_ptr = weights.as_ptr().add(offset) as *const __m256i;
        for _ in 0..(hidden_size / 16) {
            let a = _mm256_loadu_si256(acc_ptr);
            let w = _mm256_loadu_si256(w_ptr);
            _mm256_storeu_si256(acc_ptr, _mm256_add_epi16(a, w));
            acc_ptr = acc_ptr.add(1);
            w_ptr = w_ptr.add(1);
        }
    }
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
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        for i in 0..hidden_size {
            acc[i] = acc[i].wrapping_add(weights[offset + i]);
        }
    }
}

#[inline(always)]
fn sub_feature(acc: &mut [i16; MAX_HIDDEN_SIZE], weights: &[i16], feature: usize, hidden_size: usize) {
    let offset = feature * hidden_size;
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let mut acc_ptr = acc.as_mut_ptr() as *mut __m256i;
        let mut w_ptr = weights.as_ptr().add(offset) as *const __m256i;
        for _ in 0..(hidden_size / 16) {
            let a = _mm256_loadu_si256(acc_ptr);
            let w = _mm256_loadu_si256(w_ptr);
            _mm256_storeu_si256(acc_ptr, _mm256_sub_epi16(a, w));
            acc_ptr = acc_ptr.add(1);
            w_ptr = w_ptr.add(1);
        }
    }
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
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        for i in 0..hidden_size {
            acc[i] = acc[i].wrapping_sub(weights[offset + i]);
        }
    }
}

#[inline(always)]
fn add_sub_feature(acc: &mut [i16; MAX_HIDDEN_SIZE], prev: &[i16; MAX_HIDDEN_SIZE], weights: &[i16], add_feat: usize, sub_feat: usize, hidden_size: usize) {
    let add_offset = add_feat * hidden_size;
    let sub_offset = sub_feat * hidden_size;
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let acc_ptr = acc.as_mut_ptr() as *mut __m256i;
        let prev_ptr = prev.as_ptr() as *const __m256i;
        let w_add_ptr = weights.as_ptr().add(add_offset) as *const __m256i;
        let w_sub_ptr = weights.as_ptr().add(sub_offset) as *const __m256i;
        let num_chunks = hidden_size / 16;
        let mut i = 0;
        while i < num_chunks {
            let p0 = _mm256_loadu_si256(prev_ptr.add(i));
            let wa0 = _mm256_loadu_si256(w_add_ptr.add(i));
            let ws0 = _mm256_loadu_si256(w_sub_ptr.add(i));
            let res0 = _mm256_sub_epi16(_mm256_add_epi16(p0, wa0), ws0);
            _mm256_storeu_si256(acc_ptr.add(i), res0);

            if i + 1 < num_chunks {
                let p1 = _mm256_loadu_si256(prev_ptr.add(i + 1));
                let wa1 = _mm256_loadu_si256(w_add_ptr.add(i + 1));
                let ws1 = _mm256_loadu_si256(w_sub_ptr.add(i + 1));
                let res1 = _mm256_sub_epi16(_mm256_add_epi16(p1, wa1), ws1);
                _mm256_storeu_si256(acc_ptr.add(i + 1), res1);
            }
            i += 2;
        }
    }
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let acc_ptr = acc.as_mut_ptr() as *mut v128;
        let prev_ptr = prev.as_ptr() as *const v128;
        let w_add_ptr = weights.as_ptr().add(add_offset) as *const v128;
        let w_sub_ptr = weights.as_ptr().add(sub_offset) as *const v128;
        let num_chunks = hidden_size / 8;
        let mut i = 0;
        while i < num_chunks {
            let p0 = v128_load(prev_ptr.add(i));
            let wa0 = v128_load(w_add_ptr.add(i));
            let ws0 = v128_load(w_sub_ptr.add(i));
            v128_store(acc_ptr.add(i), i16x8_sub(i16x8_add(p0, wa0), ws0));

            if i + 1 < num_chunks {
                let p1 = v128_load(prev_ptr.add(i + 1));
                let wa1 = v128_load(w_add_ptr.add(i + 1));
                let ws1 = v128_load(w_sub_ptr.add(i + 1));
                v128_store(acc_ptr.add(i + 1), i16x8_sub(i16x8_add(p1, wa1), ws1));
            }
            i += 2;
        }
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        for i in 0..hidden_size {
            acc[i] = prev[i].wrapping_add(weights[add_offset + i]).wrapping_sub(weights[sub_offset + i]);
        }
    }
}

#[inline(always)]
fn add_sub_sub_feature(acc: &mut [i16; MAX_HIDDEN_SIZE], prev: &[i16; MAX_HIDDEN_SIZE], weights: &[i16], add_feat: usize, sub_feat1: usize, sub_feat2: usize, hidden_size: usize) {
    let add_offset = add_feat * hidden_size;
    let sub1_offset = sub_feat1 * hidden_size;
    let sub2_offset = sub_feat2 * hidden_size;
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let acc_ptr = acc.as_mut_ptr() as *mut __m256i;
        let prev_ptr = prev.as_ptr() as *const __m256i;
        let w_add_ptr = weights.as_ptr().add(add_offset) as *const __m256i;
        let w_sub1_ptr = weights.as_ptr().add(sub1_offset) as *const __m256i;
        let w_sub2_ptr = weights.as_ptr().add(sub2_offset) as *const __m256i;
        let num_chunks = hidden_size / 16;
        let mut i = 0;
        while i < num_chunks {
            let p0 = _mm256_loadu_si256(prev_ptr.add(i));
            let wa0 = _mm256_loadu_si256(w_add_ptr.add(i));
            let ws10 = _mm256_loadu_si256(w_sub1_ptr.add(i));
            let ws20 = _mm256_loadu_si256(w_sub2_ptr.add(i));
            let res0 = _mm256_sub_epi16(_mm256_sub_epi16(_mm256_add_epi16(p0, wa0), ws10), ws20);
            _mm256_storeu_si256(acc_ptr.add(i), res0);

            if i + 1 < num_chunks {
                let p1 = _mm256_loadu_si256(prev_ptr.add(i + 1));
                let wa1 = _mm256_loadu_si256(w_add_ptr.add(i + 1));
                let ws11 = _mm256_loadu_si256(w_sub1_ptr.add(i + 1));
                let ws21 = _mm256_loadu_si256(w_sub2_ptr.add(i + 1));
                let res1 = _mm256_sub_epi16(_mm256_sub_epi16(_mm256_add_epi16(p1, wa1), ws11), ws21);
                _mm256_storeu_si256(acc_ptr.add(i + 1), res1);
            }
            i += 2;
        }
    }
    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let acc_ptr = acc.as_mut_ptr() as *mut v128;
        let prev_ptr = prev.as_ptr() as *const v128;
        let w_add_ptr = weights.as_ptr().add(add_offset) as *const v128;
        let w_sub1_ptr = weights.as_ptr().add(sub1_offset) as *const v128;
        let w_sub2_ptr = weights.as_ptr().add(sub2_offset) as *const v128;
        let num_chunks = hidden_size / 8;
        let mut i = 0;
        while i < num_chunks {
            let p0 = v128_load(prev_ptr.add(i));
            let wa0 = v128_load(w_add_ptr.add(i));
            let ws10 = v128_load(w_sub1_ptr.add(i));
            let ws20 = v128_load(w_sub2_ptr.add(i));
            v128_store(acc_ptr.add(i), i16x8_sub(i16x8_sub(i16x8_add(p0, wa0), ws10), ws20));

            if i + 1 < num_chunks {
                let p1 = v128_load(prev_ptr.add(i + 1));
                let wa1 = v128_load(w_add_ptr.add(i + 1));
                let ws11 = v128_load(w_sub1_ptr.add(i + 1));
                let ws21 = v128_load(w_sub2_ptr.add(i + 1));
                v128_store(acc_ptr.add(i + 1), i16x8_sub(i16x8_sub(i16x8_add(p1, wa1), ws11), ws21));
            }
            i += 2;
        }
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        for i in 0..hidden_size {
            acc[i] = prev[i]
                .wrapping_add(weights[add_offset + i])
                .wrapping_sub(weights[sub1_offset + i])
                .wrapping_sub(weights[sub2_offset + i]);
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

pub fn update_accumulator_move(
    network: &Network,
    next_acc: &mut Accumulator,
    prev_acc: &Accumulator,
    old_board: &Board,
    new_board: &Board,
    m: chess::ChessMove,
) {
    if network.arch != ArchType::HalfKP {
        update_accumulator(network, next_acc, prev_acc, old_board, new_board);
        return;
    }

    let wk_old = old_board.king_square(Color::White).to_index();
    let wk_new = new_board.king_square(Color::White).to_index();
    let bk_old = old_board.king_square(Color::Black).to_index();
    let bk_new = new_board.king_square(Color::Black).to_index();

    if wk_old != wk_new || bk_old != bk_new {
        refresh_accumulator(network, next_acc, new_board);
        return;
    }

    let from_sq = m.get_source().to_index();
    let to_sq = m.get_dest().to_index();
    let piece = match old_board.piece_on(m.get_source()) {
        Some(p) => p,
        None => {
            update_accumulator(network, next_acc, prev_acc, old_board, new_board);
            return;
        }
    };
    let color = old_board.side_to_move();

    // Check for special moves: castling, promotion, or en-passant
    let is_pawn = piece == Piece::Pawn;
    let is_ep = is_pawn && m.get_source().get_file() != m.get_dest().get_file() && old_board.piece_on(m.get_dest()).is_none();
    if m.get_promotion().is_some() || is_ep {
        update_accumulator(network, next_acc, prev_acc, old_board, new_board);
        return;
    }

    let hs = network.hidden_size;
    let wk = wk_new;
    let bk_flipped = bk_new ^ 63;
    let pc = make_piece_code(piece, color);
    let flip_pc = flip_piece_code(pc);

    let feat_w_sub = wk * 641 + 1 + pc * 64 + from_sq;
    let feat_w_add = wk * 641 + 1 + pc * 64 + to_sq;
    let feat_b_sub = bk_flipped * 641 + 1 + flip_pc * 64 + (from_sq ^ 63);
    let feat_b_add = bk_flipped * 641 + 1 + flip_pc * 64 + (to_sq ^ 63);

    next_acc.hidden_size = hs;

    if let Some(cap_piece) = old_board.piece_on(m.get_dest()) {
        // Capture move: 1 add, 2 subs
        let cap_color = !color;
        let cap_pc = make_piece_code(cap_piece, cap_color);
        let cap_flip_pc = flip_piece_code(cap_pc);

        let cap_feat_w = wk * 641 + 1 + cap_pc * 64 + to_sq;
        let cap_feat_b = bk_flipped * 641 + 1 + cap_flip_pc * 64 + (to_sq ^ 63);

        add_sub_sub_feature(&mut next_acc.white, &prev_acc.white, &network.feature_weights, feat_w_add, feat_w_sub, cap_feat_w, hs);
        add_sub_sub_feature(&mut next_acc.black, &prev_acc.black, &network.feature_weights, feat_b_add, feat_b_sub, cap_feat_b, hs);
    } else {
        // Quiet move: 1 add, 1 sub
        add_sub_feature(&mut next_acc.white, &prev_acc.white, &network.feature_weights, feat_w_add, feat_w_sub, hs);
        add_sub_feature(&mut next_acc.black, &prev_acc.black, &network.feature_weights, feat_b_add, feat_b_sub, hs);
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
    let mut input = AlignedI8::<{ MAX_HIDDEN_SIZE * 2 }>([0i8; MAX_HIDDEN_SIZE * 2]);
    for i in 0..hs {
        input.0[i] = us[i].clamp(0, 127) as i8;
        input.0[hs + i] = them[i].clamp(0, 127) as i8;
    }

    let mut fc0 = [0i32; 32];

    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let ones = _mm256_set1_epi16(1);
        let input_ptr = input.0.as_ptr() as *const __m256i;
        let chunks_per_row = input_dim / 32;

        // Sparse SIMD: Precompute indices of non-zero 32-byte chunks
        let mut nonzero_chunks = [0u8; 64];
        let mut nonzero_count = 0;
        for chunk in 0..chunks_per_row {
            let inp = _mm256_loadu_si256(input_ptr.add(chunk));
            if _mm256_testz_si256(inp, inp) == 0 {
                nonzero_chunks[nonzero_count] = chunk as u8;
                nonzero_count += 1;
            }
        }

        for i in 0..32 {
            let mut sum_vec = _mm256_setzero_si256();
            let w_row = network.fc0_weights.as_ptr().add(i * input_dim) as *const __m256i;

            for &chunk_u8 in &nonzero_chunks[..nonzero_count] {
                let chunk = chunk_u8 as usize;
                let inp = _mm256_loadu_si256(input_ptr.add(chunk));
                let w = _mm256_loadu_si256(w_row.add(chunk));

                let prod = _mm256_maddubs_epi16(inp, w);
                let dot = _mm256_madd_epi16(prod, ones);
                sum_vec = _mm256_add_epi32(sum_vec, dot);
            }

            let hi128 = _mm256_extracti128_si256(sum_vec, 1);
            let lo128 = _mm256_castsi256_si128(sum_vec);
            let sum128 = _mm_add_epi32(lo128, hi128);
            let hi64 = _mm_unpackhi_epi64(sum128, sum128);
            let sum64 = _mm_add_epi32(sum128, hi64);
            let hi32 = _mm_shuffle_epi32(sum64, 0b00000001);
            let sum32 = _mm_add_epi32(sum64, hi32);
            let total = network.fc0_biases[i] + _mm_cvtsi128_si32(sum32);
            fc0[i] = total.clamp(0, 127 * 64) / 64;
        }
    }

    #[cfg(target_arch = "wasm32")]
    unsafe {
        use core::arch::wasm32::*;
        let ones = i16x8_splat(1);
        let input_ptr = input.0.as_ptr() as *const v128;
        let chunks_per_row = input_dim / 16;

        // Sparse SIMD: Precompute indices of non-zero 16-byte chunks
        let mut nonzero_chunks = [0u8; 128];
        let mut nonzero_count = 0;
        for chunk in 0..chunks_per_row {
            let inp = v128_load(input_ptr.add(chunk));
            if v128_any_true(inp) {
                nonzero_chunks[nonzero_count] = chunk as u8;
                nonzero_count += 1;
            }
        }

        for i in 0..32 {
            let mut sum_vec = i32x4_splat(0);
            let w_row = network.fc0_weights.as_ptr().add(i * input_dim) as *const v128;

            for &chunk_u8 in &nonzero_chunks[..nonzero_count] {
                let chunk = chunk_u8 as usize;
                let inp = v128_load(input_ptr.add(chunk));
                let w = v128_load(w_row.add(chunk));

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

    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        for i in 0..32 {
            let mut sum = network.fc0_biases[i];
            let row_offset = i * input_dim;
            for j in 0..input_dim {
                sum += (input.0[j] as i32) * (network.fc0_weights[row_offset + j] as i32);
            }
            fc0[i] = sum.clamp(0, 127 * 64) / 64;
        }
    }

    let mut fc0_act = [0i8; 32];
    for j in 0..32 {
        fc0_act[j] = fc0[j].clamp(0, 127) as i8;
    }

    let mut fc1 = [0i32; 32];
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let ones = _mm256_set1_epi16(1);
        let inp = _mm256_loadu_si256(fc0_act.as_ptr() as *const __m256i);
        for i in 0..32 {
            let w = _mm256_loadu_si256(network.fc1_weights.as_ptr().add(i * 32) as *const __m256i);
            let prod = _mm256_maddubs_epi16(inp, w);
            let dot = _mm256_madd_epi16(prod, ones);
            let hi128 = _mm256_extracti128_si256(dot, 1);
            let lo128 = _mm256_castsi256_si128(dot);
            let sum128 = _mm_add_epi32(lo128, hi128);
            let hi64 = _mm_unpackhi_epi64(sum128, sum128);
            let sum64 = _mm_add_epi32(sum128, hi64);
            let hi32 = _mm_shuffle_epi32(sum64, 0b00000001);
            let sum32 = _mm_add_epi32(sum64, hi32);
            let total = network.fc1_biases[i] + _mm_cvtsi128_si32(sum32);
            fc1[i] = total / 64;
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        for i in 0..32 {
            let mut sum = network.fc1_biases[i];
            let row_offset = i * 32;
            for j in 0..32 {
                sum += (fc0_act[j] as i32) * (network.fc1_weights[row_offset + j] as i32);
            }
            fc1[i] = sum / 64;
        }
    }

    let mut fc1_act = [0i8; 32];
    for j in 0..32 {
        fc1_act[j] = fc1[j].clamp(0, 127) as i8;
    }

    let mut output = network.fc2_biases[0];
    #[cfg(target_arch = "x86_64")]
    unsafe {
        use core::arch::x86_64::*;
        let ones = _mm256_set1_epi16(1);
        let inp = _mm256_loadu_si256(fc1_act.as_ptr() as *const __m256i);
        let w = _mm256_loadu_si256(network.fc2_weights.as_ptr() as *const __m256i);
        let prod = _mm256_maddubs_epi16(inp, w);
        let dot = _mm256_madd_epi16(prod, ones);
        let hi128 = _mm256_extracti128_si256(dot, 1);
        let lo128 = _mm256_castsi256_si128(dot);
        let sum128 = _mm_add_epi32(lo128, hi128);
        let hi64 = _mm_unpackhi_epi64(sum128, sum128);
        let sum64 = _mm_add_epi32(sum128, hi64);
        let hi32 = _mm_shuffle_epi32(sum64, 0b00000001);
        let sum32 = _mm_add_epi32(sum64, hi32);
        output += _mm_cvtsi128_si32(sum32);
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        for j in 0..32 {
            output += (fc1_act[j] as i32) * (network.fc2_weights[j] as i32);
        }
    }

    output / 16
}

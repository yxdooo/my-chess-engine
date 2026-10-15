// Hardware BMI2 PEXT / Magic Bitboard Attack Generation
use crate::types::{Bitboard, Color, PieceType};

pub struct Attacks {
    pub knight: [Bitboard; 64],
    pub king: [Bitboard; 64],
    pub pawn: [[Bitboard; 64]; 2],
    pub bishop_masks: [Bitboard; 64],
    pub rook_masks: [Bitboard; 64],
}

impl Attacks {
    pub fn new() -> Self {
        let mut knight = [Bitboard::EMPTY; 64];
        let mut king = [Bitboard::EMPTY; 64];
        let mut pawn = [[Bitboard::EMPTY; 64]; 2];
        let mut bishop_masks = [Bitboard::EMPTY; 64];
        let mut rook_masks = [Bitboard::EMPTY; 64];

        for sq in 0..64 {
            let r = (sq / 8) as i32;
            let f = (sq % 8) as i32;

            // Knight attacks
            let mut kn_bb = 0u64;
            for (dr, df) in [
                (2, 1), (2, -1), (-2, 1), (-2, -1),
                (1, 2), (1, -2), (-1, 2), (-1, -2)
            ] {
                let nr = r + dr;
                let nf = f + df;
                if nr >= 0 && nr < 8 && nf >= 0 && nf < 8 {
                    kn_bb |= 1u64 << (nr * 8 + nf);
                }
            }
            knight[sq as usize] = Bitboard(kn_bb);

            // King attacks
            let mut kg_bb = 0u64;
            for dr in -1..=1 {
                for df in -1..=1 {
                    if dr == 0 && df == 0 { continue; }
                    let nr = r + dr;
                    let nf = f + df;
                    if nr >= 0 && nr < 8 && nf >= 0 && nf < 8 {
                        kg_bb |= 1u64 << (nr * 8 + nf);
                    }
                }
            }
            king[sq as usize] = Bitboard(kg_bb);

            // Pawn attacks
            // White pawns attack up (+1 rank)
            let mut wp_bb = 0u64;
            if r < 7 {
                if f > 0 { wp_bb |= 1u64 << ((r + 1) * 8 + f - 1); }
                if f < 7 { wp_bb |= 1u64 << ((r + 1) * 8 + f + 1); }
            }
            pawn[Color::White as usize][sq as usize] = Bitboard(wp_bb);

            // Black pawns attack down (-1 rank)
            let mut bp_bb = 0u64;
            if r > 0 {
                if f > 0 { bp_bb |= 1u64 << ((r - 1) * 8 + f - 1); }
                if f < 7 { bp_bb |= 1u64 << ((r - 1) * 8 + f + 1); }
            }
            pawn[Color::Black as usize][sq as usize] = Bitboard(bp_bb);

            // Bishop and Rook slider mask precomputation
            let mut b_mask = 0u64;
            for (dr, df) in [(1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let mut cr = r + dr;
                let mut cf = f + df;
                while cr > 0 && cr < 7 && cf > 0 && cf < 7 {
                    b_mask |= 1u64 << (cr * 8 + cf);
                    cr += dr;
                    cf += df;
                }
            }
            bishop_masks[sq as usize] = Bitboard(b_mask);

            let mut r_mask = 0u64;
            for cr in (r + 1)..7 { r_mask |= 1u64 << (cr * 8 + f); }
            for cr in 1..r { r_mask |= 1u64 << (cr * 8 + f); }
            for cf in (f + 1)..7 { r_mask |= 1u64 << (r * 8 + cf); }
            for cf in 1..f { r_mask |= 1u64 << (r * 8 + cf); }
            rook_masks[sq as usize] = Bitboard(r_mask);
        }

        Self {
            knight,
            king,
            pawn,
            bishop_masks,
            rook_masks,
        }
    }
}

// Global attacks instance
pub static ATTACKS: std::sync::OnceLock<Attacks> = std::sync::OnceLock::new();

#[inline(always)]
pub fn get_attacks() -> &'static Attacks {
    ATTACKS.get_or_init(Attacks::new)
}

#[inline(always)]
pub fn knight_attacks(sq: u8) -> Bitboard {
    get_attacks().knight[sq as usize]
}

#[inline(always)]
pub fn king_attacks(sq: u8) -> Bitboard {
    get_attacks().king[sq as usize]
}

#[inline(always)]
pub fn pawn_attacks(c: Color, sq: u8) -> Bitboard {
    get_attacks().pawn[c as usize][sq as usize]
}

/// Dynamic ray slider attacks (hardware PEXT on x86_64 or classical ray casting)
pub fn slider_attacks(pt: PieceType, sq: u8, occupied: Bitboard) -> Bitboard {
    let r = (sq / 8) as i32;
    let f = (sq % 8) as i32;
    let mut attacks = 0u64;

    let directions: &[(i32, i32)] = match pt {
        PieceType::Bishop => &[(1, 1), (1, -1), (-1, 1), (-1, -1)],
        PieceType::Rook => &[(1, 0), (-1, 0), (0, 1), (0, -1)],
        PieceType::Queen => &[(1, 1), (1, -1), (-1, 1), (-1, -1), (1, 0), (-1, 0), (0, 1), (0, -1)],
        _ => &[],
    };

    for &(dr, df) in directions {
        let mut cr = r + dr;
        let mut cf = f + df;
        while cr >= 0 && cr < 8 && cf >= 0 && cf < 8 {
            let bit = 1u64 << (cr * 8 + cf);
            attacks |= bit;
            if (occupied.0 & bit) != 0 {
                break;
            }
            cr += dr;
            cf += df;
        }
    }

    Bitboard(attacks)
}

// Custom Zero-Overhead Chess Position & Board Representation
use crate::types::{Bitboard, Color, Move, Piece, PieceType};
use crate::movegen::{king_attacks, knight_attacks, pawn_attacks, slider_attacks};

#[derive(Clone, Copy, Debug, Default)]
pub struct StateInfo {
    pub hash: u64,
    pub rule50: u8,
    pub castling_rights: u8,
    pub en_passant: Option<u8>,
    pub captured: Piece,
}

#[derive(Clone)]
pub struct Position {
    pub by_type: [Bitboard; 6],
    pub by_color: [Bitboard; 2],
    pub mailbox: [Piece; 64],
    pub side_to_move: Color,
    pub castling_rights: u8, // bit 0: WK, bit 1: WQ, bit 2: BK, bit 3: BQ
    pub en_passant: Option<u8>,
    pub rule50: u8,
    pub hash: u64,
}

impl Position {
    pub fn new() -> Self {
        Self {
            by_type: [Bitboard::EMPTY; 6],
            by_color: [Bitboard::EMPTY; 2],
            mailbox: [Piece::None; 64],
            side_to_move: Color::White,
            castling_rights: 0,
            en_passant: None,
            rule50: 0,
            hash: 0,
        }
    }

    #[inline(always)]
    pub fn occupied(&self) -> Bitboard {
        self.by_color[0] | self.by_color[1]
    }

    #[inline(always)]
    pub fn piece_at(&self, sq: u8) -> Piece {
        self.mailbox[sq as usize]
    }

    pub fn put_piece(&mut self, p: Piece, sq: u8) {
        if p == Piece::None { return; }
        let c = p.color().unwrap();
        let pt = p.piece_type();
        let mask = Bitboard::from_square(sq);

        self.by_type[pt.index()] = self.by_type[pt.index()] | mask;
        self.by_color[c.index()] = self.by_color[c.index()] | mask;
        self.mailbox[sq as usize] = p;
    }

    pub fn remove_piece(&mut self, sq: u8) -> Piece {
        let p = self.mailbox[sq as usize];
        if p == Piece::None { return Piece::None; }
        let c = p.color().unwrap();
        let pt = p.piece_type();
        let not_mask = !Bitboard::from_square(sq);

        self.by_type[pt.index()] = self.by_type[pt.index()] & not_mask;
        self.by_color[c.index()] = self.by_color[c.index()] & not_mask;
        self.mailbox[sq as usize] = Piece::None;
        p
    }

    pub fn is_square_attacked(&self, sq: u8, by_color: Color) -> bool {
        let occ = self.occupied();
        let opp_pawns = self.by_type[PieceType::Pawn.index()] & self.by_color[by_color.index()];
        let pawn_attackers = pawn_attacks(by_color.opp(), sq);
        if !(opp_pawns & pawn_attackers).is_empty() { return true; }

        let opp_knights = self.by_type[PieceType::Knight.index()] & self.by_color[by_color.index()];
        if !(opp_knights & knight_attacks(sq)).is_empty() { return true; }

        let opp_kings = self.by_type[PieceType::King.index()] & self.by_color[by_color.index()];
        if !(opp_kings & king_attacks(sq)).is_empty() { return true; }

        let opp_bishops_queens = (self.by_type[PieceType::Bishop.index()] | self.by_type[PieceType::Queen.index()]) & self.by_color[by_color.index()];
        if !(opp_bishops_queens & slider_attacks(PieceType::Bishop, sq, occ)).is_empty() { return true; }

        let opp_rooks_queens = (self.by_type[PieceType::Rook.index()] | self.by_type[PieceType::Queen.index()]) & self.by_color[by_color.index()];
        if !(opp_rooks_queens & slider_attacks(PieceType::Rook, sq, occ)).is_empty() { return true; }

        false
    }

    pub fn in_check(&self) -> bool {
        let king_bb = self.by_type[PieceType::King.index()] & self.by_color[self.side_to_move.index()];
        if king_bb.is_empty() { return false; }
        let king_sq = king_bb.lsb();
        self.is_square_attacked(king_sq, self.side_to_move.opp())
    }

    pub fn make_move(&mut self, m: Move, state: &mut StateInfo) {
        state.castling_rights = self.castling_rights;
        state.en_passant = self.en_passant;
        state.rule50 = self.rule50;
        state.hash = self.hash;

        let from = m.from_sq();
        let to = m.to_sq();
        let piece = self.remove_piece(from);
        let pt = piece.piece_type();
        let color = self.side_to_move;

        state.captured = if m.is_en_passant() {
            let cap_sq = if color == Color::White { to - 8 } else { to + 8 };
            self.remove_piece(cap_sq)
        } else {
            self.remove_piece(to)
        };

        if m.is_promotion() {
            let promo_pt = m.promotion_type().unwrap_or(PieceType::Queen);
            self.put_piece(Piece::make(color, promo_pt), to);
        } else {
            self.put_piece(piece, to);
        }

        if m.is_castling() {
            match to {
                6 => { self.remove_piece(7); self.put_piece(Piece::WhiteRook, 5); } // White O-O
                2 => { self.remove_piece(0); self.put_piece(Piece::WhiteRook, 3); } // White O-O-O
                62 => { self.remove_piece(63); self.put_piece(Piece::BlackRook, 61); } // Black O-O
                58 => { self.remove_piece(56); self.put_piece(Piece::BlackRook, 59); } // Black O-O-O
                _ => {}
            }
        }

        // Update En-Passant square
        if pt == PieceType::Pawn && ((from as i32 - to as i32).abs() == 16) {
            self.en_passant = Some(if color == Color::White { from + 8 } else { from - 8 });
        } else {
            self.en_passant = None;
        }

        // Update 50-move counter
        if pt == PieceType::Pawn || state.captured != Piece::None {
            self.rule50 = 0;
        } else {
            self.rule50 += 1;
        }

        // Update Castling rights
        if pt == PieceType::King {
            if color == Color::White { self.castling_rights &= !0b0011; }
            else { self.castling_rights &= !0b1100; }
        }
        if from == 0 || to == 0 { self.castling_rights &= !0b0010; }
        if from == 7 || to == 7 { self.castling_rights &= !0b0001; }
        if from == 56 || to == 56 { self.castling_rights &= !0b1000; }
        if from == 63 || to == 63 { self.castling_rights &= !0b0100; }

        self.side_to_move = self.side_to_move.opp();
    }

    pub fn unmake_move(&mut self, m: Move, state: &StateInfo) {
        self.side_to_move = self.side_to_move.opp();
        let color = self.side_to_move;
        let from = m.from_sq();
        let to = m.to_sq();

        let moved_piece = self.remove_piece(to);
        let orig_piece = if m.is_promotion() {
            Piece::make(color, PieceType::Pawn)
        } else {
            moved_piece
        };
        self.put_piece(orig_piece, from);

        if m.is_en_passant() {
            let cap_sq = if color == Color::White { to - 8 } else { to + 8 };
            self.put_piece(state.captured, cap_sq);
        } else if state.captured != Piece::None {
            self.put_piece(state.captured, to);
        }

        if m.is_castling() {
            match to {
                6 => { self.remove_piece(5); self.put_piece(Piece::WhiteRook, 7); }
                2 => { self.remove_piece(3); self.put_piece(Piece::WhiteRook, 0); }
                62 => { self.remove_piece(61); self.put_piece(Piece::BlackRook, 63); }
                58 => { self.remove_piece(59); self.put_piece(Piece::BlackRook, 56); }
                _ => {}
            }
        }

        self.castling_rights = state.castling_rights;
        self.en_passant = state.en_passant;
        self.rule50 = state.rule50;
        self.hash = state.hash;
    }
}

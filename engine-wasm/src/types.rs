// Custom Zero-Overhead Chess Engine Types
// High-performance bitboard, square, color, piece, and packed move representation.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Color {
    White = 0,
    Black = 1,
}

impl Color {
    #[inline(always)]
    pub fn opp(self) -> Self {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }

    #[inline(always)]
    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PieceType {
    Pawn = 0,
    Knight = 1,
    Bishop = 2,
    Rook = 3,
    Queen = 4,
    King = 5,
    None = 6,
}

impl PieceType {
    pub const ALL: [PieceType; 6] = [
        PieceType::Pawn,
        PieceType::Knight,
        PieceType::Bishop,
        PieceType::Rook,
        PieceType::Queen,
        PieceType::King,
    ];

    #[inline(always)]
    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Piece {
    WhitePawn = 0,
    WhiteKnight = 1,
    WhiteBishop = 2,
    WhiteRook = 3,
    WhiteQueen = 4,
    WhiteKing = 5,
    BlackPawn = 6,
    BlackKnight = 7,
    BlackBishop = 8,
    BlackRook = 9,
    BlackQueen = 10,
    BlackKing = 11,
    #[default]
    None = 12,
}

impl Piece {
    #[inline(always)]
    pub fn make(c: Color, pt: PieceType) -> Self {
        if pt == PieceType::None {
            return Piece::None;
        }
        let code = (c as u8) * 6 + (pt as u8);
        unsafe { std::mem::transmute(code) }
    }

    #[inline(always)]
    pub fn piece_type(self) -> PieceType {
        match self {
            Piece::WhitePawn | Piece::BlackPawn => PieceType::Pawn,
            Piece::WhiteKnight | Piece::BlackKnight => PieceType::Knight,
            Piece::WhiteBishop | Piece::BlackBishop => PieceType::Bishop,
            Piece::WhiteRook | Piece::BlackRook => PieceType::Rook,
            Piece::WhiteQueen | Piece::BlackQueen => PieceType::Queen,
            Piece::WhiteKing | Piece::BlackKing => PieceType::King,
            Piece::None => PieceType::None,
        }
    }

    #[inline(always)]
    pub fn color(self) -> Option<Color> {
        match self {
            Piece::WhitePawn | Piece::WhiteKnight | Piece::WhiteBishop | Piece::WhiteRook | Piece::WhiteQueen | Piece::WhiteKing => Some(Color::White),
            Piece::BlackPawn | Piece::BlackKnight | Piece::BlackBishop | Piece::BlackRook | Piece::BlackQueen | Piece::BlackKing => Some(Color::Black),
            Piece::None => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Bitboard(pub u64);

impl Bitboard {
    pub const EMPTY: Bitboard = Bitboard(0);
    pub const ALL: Bitboard = Bitboard(!0);

    #[inline(always)]
    pub const fn from_square(sq: u8) -> Self {
        Bitboard(1u64 << sq)
    }

    #[inline(always)]
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    #[inline(always)]
    pub fn popcnt(self) -> u32 {
        self.0.count_ones()
    }

    #[inline(always)]
    pub fn lsb(self) -> u8 {
        self.0.trailing_zeros() as u8
    }

    #[inline(always)]
    pub fn pop_lsb(&mut self) -> u8 {
        let sq = self.lsb();
        self.0 &= self.0 - 1;
        sq
    }
}

impl std::ops::BitAnd for Bitboard {
    type Output = Self;
    #[inline(always)]
    fn bitand(self, rhs: Self) -> Self {
        Bitboard(self.0 & rhs.0)
    }
}

impl std::ops::BitOr for Bitboard {
    type Output = Self;
    #[inline(always)]
    fn bitor(self, rhs: Self) -> Self {
        Bitboard(self.0 | rhs.0)
    }
}

impl std::ops::BitXor for Bitboard {
    type Output = Self;
    #[inline(always)]
    fn bitxor(self, rhs: Self) -> Self {
        Bitboard(self.0 ^ rhs.0)
    }
}

impl std::ops::Not for Bitboard {
    type Output = Self;
    #[inline(always)]
    fn not(self) -> Self {
        Bitboard(!self.0)
    }
}

// 16-bit Packed Move:
// bits 0..5: source square (0..63)
// bits 6..11: destination square (0..63)
// bits 12..13: promotion piece type (0=Knight, 1=Bishop, 2=Rook, 3=Queen)
// bits 14..15: move flags (0=Quiet, 1=Promotion, 2=EnPassant, 3=Castling)
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub struct Move(pub u16);

pub const MOVE_QUIET: u16 = 0 << 14;
pub const MOVE_PROMOTION: u16 = 1 << 14;
pub const MOVE_EN_PASSANT: u16 = 2 << 14;
pub const MOVE_CASTLING: u16 = 3 << 14;

impl Move {
    pub const NULL: Move = Move(0);

    #[inline(always)]
    pub fn new(from: u8, to: u8, flags: u16, promo: PieceType) -> Self {
        let promo_bits = match promo {
            PieceType::Knight => 0,
            PieceType::Bishop => 1,
            PieceType::Rook => 2,
            PieceType::Queen => 3,
            _ => 0,
        };
        Move((from as u16) | ((to as u16) << 6) | ((promo_bits as u16) << 12) | flags)
    }

    #[inline(always)]
    pub fn from_sq(self) -> u8 {
        (self.0 & 0x3F) as u8
    }

    #[inline(always)]
    pub fn to_sq(self) -> u8 {
        ((self.0 >> 6) & 0x3F) as u8
    }

    #[inline(always)]
    pub fn flags(self) -> u16 {
        self.0 & (3 << 14)
    }

    #[inline(always)]
    pub fn is_promotion(self) -> bool {
        self.flags() == MOVE_PROMOTION
    }

    #[inline(always)]
    pub fn is_en_passant(self) -> bool {
        self.flags() == MOVE_EN_PASSANT
    }

    #[inline(always)]
    pub fn is_castling(self) -> bool {
        self.flags() == MOVE_CASTLING
    }

    #[inline(always)]
    pub fn promotion_type(self) -> Option<PieceType> {
        if !self.is_promotion() {
            return None;
        }
        match (self.0 >> 12) & 3 {
            0 => Some(PieceType::Knight),
            1 => Some(PieceType::Bishop),
            2 => Some(PieceType::Rook),
            3 => Some(PieceType::Queen),
            _ => None,
        }
    }
}

impl std::fmt::Debug for Move {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let from = self.from_sq();
        let to = self.to_sq();
        let from_file = (b'a' + (from % 8)) as char;
        let from_rank = (b'1' + (from / 8)) as char;
        let to_file = (b'a' + (to % 8)) as char;
        let to_rank = (b'1' + (to / 8)) as char;
        let promo = match self.promotion_type() {
            Some(PieceType::Knight) => "n",
            Some(PieceType::Bishop) => "b",
            Some(PieceType::Rook) => "r",
            Some(PieceType::Queen) => "q",
            _ => "",
        };
        write!(f, "{}{}{}{}{}", from_file, from_rank, to_file, to_rank, promo)
    }
}

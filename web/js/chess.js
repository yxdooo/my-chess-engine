/**
 * chess.js — Core chess rule engine
 *
 * Globals exposed: ChessGame, PIECE, COLOR, CASTLE_FLAGS, MOVE_FLAGS, STARTING_FEN
 * Compatible with both <script> tags and importScripts() in Web Workers.
 *
 * Square encoding:  index = rank*8 + file  ->  0=a1, 7=h1, 8=a2, ..., 63=h8
 * Piece encoding:   (color << 3) | type    ->  e.g. WHITE_ROOK = 4, BLACK_ROOK = 12
 */

'use strict';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

const PIECE = Object.freeze({ NONE: 0, PAWN: 1, KNIGHT: 2, BISHOP: 3, ROOK: 4, QUEEN: 5, KING: 6 });
const COLOR = Object.freeze({ WHITE: 0, BLACK: 1 });

// Bit flags stored in castlingRights
const CASTLE_FLAGS = Object.freeze({ WK: 1, WQ: 2, BK: 4, BQ: 8 });

// Move flag bitmask -- a move can combine flags (e.g. CAPTURE | PROMOTION)
const MOVE_FLAGS = Object.freeze({
  QUIET:       0,
  CAPTURE:     1,
  EN_PASSANT:  2,
  CASTLE:      4,
  PROMOTION:   8,
  DOUBLE_PUSH: 16,
});

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// Piece helpers (inlined for hot-path speed)
// ---------------------------------------------------------------------------

function pieceType(p)  { return p & 7; }
function pieceColor(p) { return p >> 3; }
function makePiece(color, type) { return (color << 3) | type; }

// ---------------------------------------------------------------------------
// Square helpers
// ---------------------------------------------------------------------------

function fileOf(sq) { return sq & 7; }
function rankOf(sq) { return sq >> 3; }
function sqName(sq) { return 'abcdefgh'[fileOf(sq)] + (rankOf(sq) + 1); }
function sqFromName(name) {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

// ---------------------------------------------------------------------------
// Pre-computed attack tables -- built once at module load
// ---------------------------------------------------------------------------

const KNIGHT_ATTACKS = new Array(64);
const KING_ATTACKS   = new Array(64);

(function buildAttackTables() {
  const knightDeltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  const kingDeltas   = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for (let sq = 0; sq < 64; sq++) {
    const r = rankOf(sq), f = fileOf(sq);
    KNIGHT_ATTACKS[sq] = [];
    for (const [dr, df] of knightDeltas) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) KNIGHT_ATTACKS[sq].push(nr * 8 + nf);
    }
    KING_ATTACKS[sq] = [];
    for (const [dr, df] of kingDeltas) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) KING_ATTACKS[sq].push(nr * 8 + nf);
    }
  }
}());

// Sliding piece directions
const BISHOP_DIRS = [-9, -7, 7, 9];
const ROOK_DIRS   = [-8, -1, 1, 8];

// ---------------------------------------------------------------------------
// FEN character <-> piece code mappings
// ---------------------------------------------------------------------------

const FEN_TO_PIECE = {
  p: makePiece(COLOR.BLACK, PIECE.PAWN),   P: makePiece(COLOR.WHITE, PIECE.PAWN),
  n: makePiece(COLOR.BLACK, PIECE.KNIGHT), N: makePiece(COLOR.WHITE, PIECE.KNIGHT),
  b: makePiece(COLOR.BLACK, PIECE.BISHOP), B: makePiece(COLOR.WHITE, PIECE.BISHOP),
  r: makePiece(COLOR.BLACK, PIECE.ROOK),   R: makePiece(COLOR.WHITE, PIECE.ROOK),
  q: makePiece(COLOR.BLACK, PIECE.QUEEN),  Q: makePiece(COLOR.WHITE, PIECE.QUEEN),
  k: makePiece(COLOR.BLACK, PIECE.KING),   K: makePiece(COLOR.WHITE, PIECE.KING),
};

const PIECE_TO_FEN   = ['', 'P', 'N', 'B', 'R', 'Q', 'K', '', '', 'p', 'n', 'b', 'r', 'q', 'k'];
const TYPE_TO_LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K'];

// ---------------------------------------------------------------------------
// Castle-rights mask -- clears bits when a corner or king square is touched
// ---------------------------------------------------------------------------

const _CASTLE_MASKS = (function () {
  const m = new Uint8Array(64).fill(0xFF);
  m[0]  &= ~CASTLE_FLAGS.WQ;
  m[7]  &= ~CASTLE_FLAGS.WK;
  m[56] &= ~CASTLE_FLAGS.BQ;
  m[63] &= ~CASTLE_FLAGS.BK;
  m[4]  &= ~(CASTLE_FLAGS.WK | CASTLE_FLAGS.WQ);
  m[60] &= ~(CASTLE_FLAGS.BK | CASTLE_FLAGS.BQ);
  return m;
}());

function _castleRightsMask(sq) { return _CASTLE_MASKS[sq]; }

// ---------------------------------------------------------------------------
// ChessGame
// ---------------------------------------------------------------------------

class ChessGame {
  constructor(fen) {
    this.board = new Uint8Array(64);
    this._history    = [];  // undo stack for _applyMove / _undoMove
    this._posHistory = [];  // hash strings for repetition; updated only by makeMove / undoMove
    this.loadFEN(fen !== undefined ? fen : STARTING_FEN);
  }

  // -------------------------------------------------------------------------
  // FEN parsing / serialisation
  // -------------------------------------------------------------------------

  loadFEN(fen) {
    this.board.fill(0);
    const parts = fen.trim().split(/\s+/);

    // FEN rank 8 is board rank 7; ranks are stored bottom-up
    const rows = parts[0].split('/');
    for (let rank = 7; rank >= 0; rank--) {
      const row = rows[7 - rank];
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          this.board[rank * 8 + file] = FEN_TO_PIECE[ch];
          file++;
        }
      }
    }

    this.sideToMove     = parts[1] === 'w' ? COLOR.WHITE : COLOR.BLACK;
    this.castlingRights = 0;
    for (const ch of (parts[2] || '-')) {
      if (ch === 'K') this.castlingRights |= CASTLE_FLAGS.WK;
      if (ch === 'Q') this.castlingRights |= CASTLE_FLAGS.WQ;
      if (ch === 'k') this.castlingRights |= CASTLE_FLAGS.BK;
      if (ch === 'q') this.castlingRights |= CASTLE_FLAGS.BQ;
    }
    this.epSquare       = (parts[3] && parts[3] !== '-') ? sqFromName(parts[3]) : -1;
    this.halfMoveClock  = parseInt(parts[4] || '0', 10);
    this.fullMoveNumber = parseInt(parts[5] || '1', 10);

    this._history    = [];
    this._posHistory = [];
  }

  toFEN() {
    let fen = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[rank * 8 + file];
        if (p === 0) {
          empty++;
        } else {
          if (empty > 0) { fen += empty; empty = 0; }
          fen += PIECE_TO_FEN[p];
        }
      }
      if (empty > 0) fen += empty;
      if (rank > 0) fen += '/';
    }

    let castleStr = '';
    if (this.castlingRights & CASTLE_FLAGS.WK) castleStr += 'K';
    if (this.castlingRights & CASTLE_FLAGS.WQ) castleStr += 'Q';
    if (this.castlingRights & CASTLE_FLAGS.BK) castleStr += 'k';
    if (this.castlingRights & CASTLE_FLAGS.BQ) castleStr += 'q';

    return [
      fen,
      this.sideToMove === COLOR.WHITE ? 'w' : 'b',
      castleStr || '-',
      this.epSquare >= 0 ? sqName(this.epSquare) : '-',
      this.halfMoveClock,
      this.fullMoveNumber,
    ].join(' ');
  }

  // -------------------------------------------------------------------------
  // Attack detection
  // -------------------------------------------------------------------------

  isSquareAttacked(sq, byColor) {
    const board = this.board;

    // Pawn attacks: a white pawn on rank r attacks rank r+1; we look backward
    const pawnRankDir = byColor === COLOR.WHITE ? -1 : 1;
    const pawnRank = rankOf(sq) - pawnRankDir;
    if (pawnRank >= 0 && pawnRank < 8) {
      const pawn = makePiece(byColor, PIECE.PAWN);
      for (const df of [-1, 1]) {
        const f = fileOf(sq) + df;
        if (f >= 0 && f < 8 && board[pawnRank * 8 + f] === pawn) return true;
      }
    }

    // Knights
    const knight = makePiece(byColor, PIECE.KNIGHT);
    for (const s of KNIGHT_ATTACKS[sq]) {
      if (board[s] === knight) return true;
    }

    // King
    const king = makePiece(byColor, PIECE.KING);
    for (const s of KING_ATTACKS[sq]) {
      if (board[s] === king) return true;
    }

    // Bishops / queens (diagonal rays)
    const bishop = makePiece(byColor, PIECE.BISHOP);
    const queen  = makePiece(byColor, PIECE.QUEEN);
    for (const dir of BISHOP_DIRS) {
      let cur = sq;
      while (true) {
        const prevFile = fileOf(cur);
        cur += dir;
        if (cur < 0 || cur > 63) break;
        if (Math.abs(fileOf(cur) - prevFile) !== 1) break; // diagonal wrap guard
        const p = board[cur];
        if (p !== 0) {
          if (p === bishop || p === queen) return true;
          break;
        }
      }
    }

    // Rooks / queens (orthogonal rays)
    const rook = makePiece(byColor, PIECE.ROOK);
    for (const dir of ROOK_DIRS) {
      let cur = sq;
      while (true) {
        const prevFile = fileOf(cur);
        cur += dir;
        if (cur < 0 || cur > 63) break;
        // Horizontal directions must not wrap around board edges
        if ((dir === 1 || dir === -1) && Math.abs(fileOf(cur) - prevFile) !== 1) break;
        const p = board[cur];
        if (p !== 0) {
          if (p === rook || p === queen) return true;
          break;
        }
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Pseudo-legal move generation
  // -------------------------------------------------------------------------

  _generatePseudoLegal() {
    const moves = [];
    const board = this.board;
    const us    = this.sideToMove;
    const them  = us ^ 1;
    const fwd   = us === COLOR.WHITE ? 8 : -8;
    const rank2 = us === COLOR.WHITE ? 1 : 6;  // starting pawn rank
    const rank7 = us === COLOR.WHITE ? 6 : 1;  // pre-promotion rank

    const push = function(from, to, piece, captured, flags, promotion) {
      moves.push({ from: from, to: to, piece: piece, captured: captured,
                   flags: flags, promotion: promotion || 0 });
    };

    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (p === 0 || pieceColor(p) !== us) continue;
      const type = pieceType(p);

      // --- Pawn ---
      if (type === PIECE.PAWN) {
        const rank  = rankOf(sq);
        const toSq  = sq + fwd;

        // Single push
        if (toSq >= 0 && toSq <= 63 && board[toSq] === 0) {
          if (rank === rank7) {
            for (const promo of [PIECE.QUEEN, PIECE.ROOK, PIECE.BISHOP, PIECE.KNIGHT]) {
              push(sq, toSq, p, 0, MOVE_FLAGS.PROMOTION, promo);
            }
          } else {
            push(sq, toSq, p, 0, MOVE_FLAGS.QUIET, 0);
          }
          // Double push only when path is clear and pawn is on its starting rank
          if (rank === rank2 && board[toSq + fwd] === 0) {
            push(sq, toSq + fwd, p, 0, MOVE_FLAGS.DOUBLE_PUSH, 0);
          }
        }

        // Diagonal captures and en passant
        for (const df of [-1, 1]) {
          const nf = fileOf(sq) + df;
          if (nf < 0 || nf > 7) continue;
          const capSq = sq + fwd + df;
          if (capSq < 0 || capSq > 63) continue;
          const target = board[capSq];
          if (target !== 0 && pieceColor(target) === them) {
            if (rank === rank7) {
              for (const promo of [PIECE.QUEEN, PIECE.ROOK, PIECE.BISHOP, PIECE.KNIGHT]) {
                push(sq, capSq, p, target, MOVE_FLAGS.CAPTURE | MOVE_FLAGS.PROMOTION, promo);
              }
            } else {
              push(sq, capSq, p, target, MOVE_FLAGS.CAPTURE, 0);
            }
          }
          if (capSq === this.epSquare) {
            push(sq, capSq, p, makePiece(them, PIECE.PAWN), MOVE_FLAGS.EN_PASSANT, 0);
          }
        }
      }

      // --- Knight ---
      else if (type === PIECE.KNIGHT) {
        for (const to of KNIGHT_ATTACKS[sq]) {
          const target = board[to];
          if (target === 0) {
            push(sq, to, p, 0, MOVE_FLAGS.QUIET, 0);
          } else if (pieceColor(target) === them) {
            push(sq, to, p, target, MOVE_FLAGS.CAPTURE, 0);
          }
        }
      }

      // --- King ---
      else if (type === PIECE.KING) {
        for (const to of KING_ATTACKS[sq]) {
          const target = board[to];
          if (target === 0) {
            push(sq, to, p, 0, MOVE_FLAGS.QUIET, 0);
          } else if (pieceColor(target) === them) {
            push(sq, to, p, target, MOVE_FLAGS.CAPTURE, 0);
          }
        }
        // Castling: intermediate squares must be empty; legality validated in generateMoves
        const cr = this.castlingRights;
        if (us === COLOR.WHITE) {
          if ((cr & CASTLE_FLAGS.WK) && board[5] === 0 && board[6] === 0)
            push(sq, 6, p, 0, MOVE_FLAGS.CASTLE, 0);
          if ((cr & CASTLE_FLAGS.WQ) && board[3] === 0 && board[2] === 0 && board[1] === 0)
            push(sq, 2, p, 0, MOVE_FLAGS.CASTLE, 0);
        } else {
          if ((cr & CASTLE_FLAGS.BK) && board[61] === 0 && board[62] === 0)
            push(sq, 62, p, 0, MOVE_FLAGS.CASTLE, 0);
          if ((cr & CASTLE_FLAGS.BQ) && board[59] === 0 && board[58] === 0 && board[57] === 0)
            push(sq, 58, p, 0, MOVE_FLAGS.CASTLE, 0);
        }
      }

      // --- Sliding pieces: bishop, rook, queen ---
      else {
        const dirs = (type === PIECE.BISHOP) ? BISHOP_DIRS
                   : (type === PIECE.ROOK)   ? ROOK_DIRS
                   : BISHOP_DIRS.concat(ROOK_DIRS);

        for (const dir of dirs) {
          let cur = sq;
          while (true) {
            const prevFile = fileOf(cur);
            cur += dir;
            if (cur < 0 || cur > 63) break;
            // File-wrap guard: diagonals and horizontals must change file by exactly 1
            if (dir !== 8 && dir !== -8 && Math.abs(fileOf(cur) - prevFile) !== 1) break;

            const target = board[cur];
            if (target === 0) {
              push(sq, cur, p, 0, MOVE_FLAGS.QUIET, 0);
            } else {
              if (pieceColor(target) === them) push(sq, cur, p, target, MOVE_FLAGS.CAPTURE, 0);
              break; // ray is blocked by any piece
            }
          }
        }
      }
    }

    return moves;
  }

  // -------------------------------------------------------------------------
  // Low-level move application (engine internal, no posHistory update)
  // -------------------------------------------------------------------------

  _applyMove(move) {
    const board = this.board;
    const { from, to, piece, captured, flags, promotion } = move;
    const us = this.sideToMove;

    this._history.push({
      move:           move,
      castlingRights: this.castlingRights,
      epSquare:       this.epSquare,
      halfMoveClock:  this.halfMoveClock,
    });

    board[to]   = promotion ? makePiece(us, promotion) : piece;
    board[from] = 0;

    // En passant: the captured pawn is on the same rank as the capturing pawn
    if (flags & MOVE_FLAGS.EN_PASSANT) {
      board[to + (us === COLOR.WHITE ? -8 : 8)] = 0;
    }

    // Move the rook alongside the king
    if (flags & MOVE_FLAGS.CASTLE) {
      if (to === 6)  { board[7]  = 0; board[5]  = makePiece(us, PIECE.ROOK); }
      if (to === 2)  { board[0]  = 0; board[3]  = makePiece(us, PIECE.ROOK); }
      if (to === 62) { board[63] = 0; board[61] = makePiece(us, PIECE.ROOK); }
      if (to === 58) { board[56] = 0; board[59] = makePiece(us, PIECE.ROOK); }
    }

    // Set ep square only on a double pawn push; midpoint between from and to
    this.epSquare = (flags & MOVE_FLAGS.DOUBLE_PUSH) ? ((from + to) >> 1) : -1;

    // Revoke castling rights if king or rook squares are touched
    this.castlingRights &= _castleRightsMask(from) & _castleRightsMask(to);

    if ((flags & MOVE_FLAGS.CAPTURE) || pieceType(piece) === PIECE.PAWN) {
      this.halfMoveClock = 0;
    } else {
      this.halfMoveClock++;
    }

    if (us === COLOR.BLACK) this.fullMoveNumber++;
    this.sideToMove ^= 1;
  }

  // -------------------------------------------------------------------------
  // Low-level undo (engine internal)
  // -------------------------------------------------------------------------

  _undoMove() {
    const state = this._history.pop();
    if (!state) return;

    const board = this.board;
    const { move, castlingRights, epSquare, halfMoveClock } = state;
    const { from, to, piece, captured, flags } = move;

    this.sideToMove ^= 1;
    const us = this.sideToMove;

    board[from] = piece; // restore original (pre-promotion) piece
    board[to]   = 0;

    if (captured && !(flags & MOVE_FLAGS.EN_PASSANT)) {
      board[to] = captured; // restore captured piece on its square
    }

    if (flags & MOVE_FLAGS.EN_PASSANT) {
      // Restore the en-passant captured pawn to its actual square (not `to`)
      board[to + (us === COLOR.WHITE ? -8 : 8)] = captured;
    }

    if (flags & MOVE_FLAGS.CASTLE) {
      if (to === 6)  { board[5]  = 0; board[7]  = makePiece(us, PIECE.ROOK); }
      if (to === 2)  { board[3]  = 0; board[0]  = makePiece(us, PIECE.ROOK); }
      if (to === 62) { board[61] = 0; board[63] = makePiece(us, PIECE.ROOK); }
      if (to === 58) { board[59] = 0; board[56] = makePiece(us, PIECE.ROOK); }
    }

    this.castlingRights = castlingRights;
    this.epSquare       = epSquare;
    this.halfMoveClock  = halfMoveClock;
    if (us === COLOR.BLACK) this.fullMoveNumber--;
  }

  // -------------------------------------------------------------------------
  // Legal move generation: apply each pseudo-legal move and check king safety
  // -------------------------------------------------------------------------

  generateMoves() {
    const pseudo = this._generatePseudoLegal();
    const legal  = [];
    const us     = this.sideToMove;
    const them   = us ^ 1;
    const kingPiece = makePiece(us, PIECE.KING);

    for (const move of pseudo) {
      // Castling has additional transit-square constraints not capturable post-move
      if (move.flags & MOVE_FLAGS.CASTLE) {
        if (this.isSquareAttacked(move.from, them)) continue;   // king starts in check
        if (this.isSquareAttacked((move.from + move.to) >> 1, them)) continue; // transit attacked
      }

      this._applyMove(move);

      // Locate the king and verify it is not in check
      let kingSq = -1;
      const b = this.board;
      for (let s = 0; s < 64; s++) {
        if (b[s] === kingPiece) { kingSq = s; break; }
      }
      const illegal = kingSq === -1 || this.isSquareAttacked(kingSq, them);

      this._undoMove();
      if (!illegal) legal.push(move);
    }

    return legal;
  }

  // -------------------------------------------------------------------------
  // UI-facing move wrappers — maintain _posHistory for repetition detection
  // -------------------------------------------------------------------------

  makeMove(move) {
    this._applyMove(move);
    this._posHistory.push(this._boardHash());
  }

  undoMove() {
    this._undoMove();
    this._posHistory.pop();
  }

  _boardHash() {
    return this.board.join(',') + '|' + this.sideToMove + '|' + this.castlingRights + '|' + this.epSquare;
  }

  // -------------------------------------------------------------------------
  // Game-state queries
  // -------------------------------------------------------------------------

  isCheck() {
    const us = this.sideToMove;
    const kingPiece = makePiece(us, PIECE.KING);
    for (let s = 0; s < 64; s++) {
      if (this.board[s] === kingPiece) return this.isSquareAttacked(s, us ^ 1);
    }
    return false;
  }

  isCheckmate() {
    return this.isCheck() && this.generateMoves().length === 0;
  }

  isStalemate() {
    return !this.isCheck() && this.generateMoves().length === 0;
  }

  isDraw() {
    if (this.halfMoveClock >= 100) return true;
    if (this._isInsufficientMaterial()) return true;
    // Threefold repetition: count how many times the current position hash appears in history
    const hash = this._boardHash();
    let count = 0;
    for (const h of this._posHistory) { if (h === hash) count++; }
    return count >= 2; // two previous + current = three occurrences
  }

  _isInsufficientMaterial() {
    const pieces = { 0: [], 1: [] };
    for (let s = 0; s < 64; s++) {
      const p = this.board[s];
      if (p) pieces[pieceColor(p)].push(pieceType(p));
    }
    for (const side of [COLOR.WHITE, COLOR.BLACK]) {
      for (const t of pieces[side]) {
        if (t === PIECE.PAWN || t === PIECE.ROOK || t === PIECE.QUEEN) return false;
      }
    }
    const wc = pieces[COLOR.WHITE].length;
    const bc = pieces[COLOR.BLACK].length;
    if (wc === 1 && bc === 1) return true; // K vs K
    if (wc === 2 && bc === 1)
      return pieces[COLOR.WHITE].includes(PIECE.BISHOP) || pieces[COLOR.WHITE].includes(PIECE.KNIGHT);
    if (wc === 1 && bc === 2)
      return pieces[COLOR.BLACK].includes(PIECE.BISHOP) || pieces[COLOR.BLACK].includes(PIECE.KNIGHT);
    return false;
  }

  isGameOver() {
    return this.isCheckmate() || this.isStalemate() || this.isDraw();
  }

  getResult() {
    if (this.isCheckmate()) return this.sideToMove === COLOR.WHITE ? '0-1' : '1-0';
    if (this.isStalemate() || this.isDraw()) return '1/2-1/2';
    return '*';
  }

  // -------------------------------------------------------------------------
  // Move notation
  // -------------------------------------------------------------------------

  moveToUCI(move) {
    const promo = move.promotion ? TYPE_TO_LETTER[move.promotion].toLowerCase() : '';
    return sqName(move.from) + sqName(move.to) + promo;
  }

  moveToSAN(move) {
    const type      = pieceType(move.piece);
    const isCapture = !!(move.flags & (MOVE_FLAGS.CAPTURE | MOVE_FLAGS.EN_PASSANT));

    if (move.flags & MOVE_FLAGS.CASTLE) {
      return (move.to > move.from ? 'O-O' : 'O-O-O') + this._sanSuffix(move);
    }

    let san = '';
    if (type === PIECE.PAWN) {
      if (isCapture) san += 'abcdefgh'[fileOf(move.from)];
      if (isCapture) san += 'x';
      san += sqName(move.to);
      if (move.promotion) san += '=' + TYPE_TO_LETTER[move.promotion];
    } else {
      san += TYPE_TO_LETTER[type];
      const ambig = this._findAmbiguity(move);
      // Prefer file disambiguation (column letter) over rank; use both only when necessary
      if (ambig.needFile && ambig.needRank) san += sqName(move.from);
      else if (ambig.needFile)              san += 'abcdefgh'[fileOf(move.from)];
      else if (ambig.needRank)              san += (rankOf(move.from) + 1);
      if (isCapture) san += 'x';
      san += sqName(move.to);
    }
    return san + this._sanSuffix(move);
  }

  /** Temporarily apply move to determine check/checkmate suffix. */
  _sanSuffix(move) {
    this._applyMove(move);
    let suffix = '';
    if (this.isCheckmate())  suffix = '#';
    else if (this.isCheck()) suffix = '+';
    this._undoMove();
    return suffix;
  }

  /**
   * Find whether another legal piece of the same type can also reach move.to.
   * Returns { needFile, needRank } — true means that coordinate is needed for disambiguation.
   */
  _findAmbiguity(move) {
    const type = pieceType(move.piece);
    const us   = this.sideToMove;
    const them = us ^ 1;
    const kingPiece = makePiece(us, PIECE.KING);
    let needFile = false, needRank = false;

    for (const m of this._generatePseudoLegal()) {
      if (m.from === move.from) continue;
      if (m.to   !== move.to)   continue;
      if (pieceType(m.piece)  !== type) continue;
      if (pieceColor(m.piece) !== us)   continue;

      // Check that the alternative move is also legal
      this._applyMove(m);
      let kingSq = -1;
      const b = this.board;
      for (let s = 0; s < 64; s++) { if (b[s] === kingPiece) { kingSq = s; break; } }
      const illegal = kingSq === -1 || this.isSquareAttacked(kingSq, them);
      this._undoMove();
      if (illegal) continue;

      // Determine which coordinate resolves the ambiguity
      if (fileOf(m.from) !== fileOf(move.from)) needFile = true;
      else needRank = true;
    }

    return { needFile: needFile, needRank: needRank };
  }

  /**
   * Parse a UCI move string into a legal Move object, or return null if invalid.
   * Handles optional promotion character (e.g. "e7e8q").
   */
  parseUCI(uci) {
    if (!uci || uci.length < 4) return null;
    const from      = sqFromName(uci.slice(0, 2));
    const to        = sqFromName(uci.slice(2, 4));
    const promoChar = uci[4];
    const promoType = promoChar ? TYPE_TO_LETTER.indexOf(promoChar.toUpperCase()) : 0;

    for (const move of this.generateMoves()) {
      if (move.from !== from || move.to !== to) continue;
      if (promoType > 0 && move.promotion !== promoType) continue;
      return move;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Deep copy -- engine searches on the clone must not corrupt UI state
  // -------------------------------------------------------------------------

  clone() {
    const c = new ChessGame();
    c.board.set(this.board);
    c.sideToMove      = this.sideToMove;
    c.castlingRights  = this.castlingRights;
    c.epSquare        = this.epSquare;
    c.halfMoveClock   = this.halfMoveClock;
    c.fullMoveNumber  = this.fullMoveNumber;
    c._history    = this._history.map(function(s) { return { move: Object.assign({}, s.move), castlingRights: s.castlingRights, epSquare: s.epSquare, halfMoveClock: s.halfMoveClock }; });
    c._posHistory = this._posHistory.slice();
    return c;
  }
}

// ---------------------------------------------------------------------------
// Expose globals for <script> / importScripts() environments.
// In a browser window these simply become window.ChessGame etc.
// In a Web Worker they become the worker's global scope.
// This block is intentionally a no-op in strict ES-module environments.
// ---------------------------------------------------------------------------
/* global self */
(function (root) {
  root.PIECE        = PIECE;
  root.COLOR        = COLOR;
  root.CASTLE_FLAGS = CASTLE_FLAGS;
  root.MOVE_FLAGS   = MOVE_FLAGS;
  root.STARTING_FEN = STARTING_FEN;
  root.ChessGame    = ChessGame;
}(typeof globalThis !== 'undefined' ? globalThis
  : typeof self     !== 'undefined' ? self
  : typeof window   !== 'undefined' ? window
  : typeof global   !== 'undefined' ? global
  : {}));

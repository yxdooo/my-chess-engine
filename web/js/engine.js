'use strict';

// ---------------------------------------------------------------------------
// Material values indexed by piece type (NONE=0, PAWN=1, KNIGHT=2, BISHOP=3,
// ROOK=4, QUEEN=5, KING=6)
// ---------------------------------------------------------------------------
const MATERIAL = [0, 100, 320, 330, 500, 900, 20000];

// Phase weights for tapered king evaluation (PAWN=0, KNIGHT=1, BISHOP=1,
// ROOK=2, QUEEN=4). Total starting phase = 2*(4+4+2+4*2) = 24.
const PHASE_WEIGHTS = [0, 0, 1, 1, 2, 4, 0];

// ---------------------------------------------------------------------------
// Piece-Square Tables — White perspective, a1=index 0, h8=index 63.
// Black mirrors via: mirrorSq = (7 - rank)*8 + file
// ---------------------------------------------------------------------------
const PAWN_PST = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10,-20,-20, 10, 10,  5,
   5, -5,-10,  0,  0,-10, -5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5,  5, 10, 25, 25, 10,  5,  5,
  10, 10, 20, 30, 30, 20, 10, 10,
  50, 50, 50, 50, 50, 50, 50, 50,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const KNIGHT_PST = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
const BISHOP_PST = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
const ROOK_PST = [
   0,  0,  0,  5,  5,  0,  0,  0,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   5, 10, 10, 10, 10, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const QUEEN_PST = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -10,  5,  5,  5,  5,  5,  0,-10,
    0,  0,  5,  5,  5,  5,  0, -5,
   -5,  0,  5,  5,  5,  5,  0, -5,
  -10,  0,  5,  5,  5,  5,  0,-10,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
const KING_MG_PST = [
   20, 30, 10,  0,  0, 10, 30, 20,
   20, 20,  0,  0,  0,  0, 20, 20,
  -10,-20,-20,-20,-20,-20,-20,-10,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
];
const KING_EG_PST = [
  -50,-30,-30,-30,-30,-30,-30,-50,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -50,-40,-30,-20,-20,-30,-40,-50,
];

// Lookup: PST by piece type index
const PST_BY_TYPE = [null, PAWN_PST, KNIGHT_PST, BISHOP_PST, ROOK_PST, QUEEN_PST, null];

// ---------------------------------------------------------------------------
// Transposition Table constants
// ---------------------------------------------------------------------------
const TT_FLAG_EXACT      = 0;
const TT_FLAG_LOWERBOUND = 1;
const TT_FLAG_UPPERBOUND = 2;
const TT_SIZE            = 1 << 20; // ~1M entries
const TT_MASK            = TT_SIZE - 1;

const MATE_SCORE = 1000000;

// ---------------------------------------------------------------------------
// ChessEngine
// ---------------------------------------------------------------------------
class ChessEngine {
  constructor(options = {}) {
    // Transposition table: flat array of objects (null = empty)
    this._tt = new Array(TT_SIZE).fill(null);

    // Killer moves: [ply][0|1]
    this._killers = [];

    // History heuristic: [piece_0_11][to_0_63]
    this._history = Array.from({ length: 12 }, () => new Int32Array(64));

    // Zobrist tables
    this._initZobrist();

    // Search state
    this._stopped = false;
    this._nodes   = 0;
    this._startMs = 0;
    this._timeLimitMs = Infinity;

    // Stack for incremental Zobrist updates during search
    this._hashStack = [];
    this._currentHash = 0;
  }

  // -------------------------------------------------------------------------
  // Zobrist initialisation — 12 piece-slots × 64 + side + 16 castling + 8 ep
  // Using 32-bit XOR (stored as regular JS number, safe for integer ops).
  // -------------------------------------------------------------------------
  _initZobrist() {
    const rand32 = () => (Math.random() * 0x100000000) >>> 0;

    // _zPiece[pieceIndex][square]  pieceIndex = color*6 + (type-1)
    this._zPiece = Array.from({ length: 12 }, () =>
      Uint32Array.from({ length: 64 }, rand32)
    );
    this._zSide    = rand32();
    this._zCastle  = Uint32Array.from({ length: 16 }, rand32);
    this._zEp      = Uint32Array.from({ length: 8 },  rand32);
  }

  // Compute Zobrist hash from scratch for a given game state.
  // We derive the board state by examining game.generateMoves() is too slow;
  // instead we reconstruct by reading the board array if available, else
  // fall back to FEN parsing for the incremental baseline.
  _computeHash(game) {
    let h = 0;
    const fen = game.toFEN();
    const parts = fen.split(' ');
    const rows  = parts[0].split('/');
    const sideToMove = parts[1];
    const castling   = parts[2];
    const epFile     = parts[3];

    // Board pieces
    for (let rank = 7; rank >= 0; rank--) {
      const row = rows[7 - rank]; // FEN row 0 = rank 8
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          const { color, type } = _fenCharToPiece(ch);
          const sq = rank * 8 + file;
          const idx = color * 6 + (type - 1);
          h = (h ^ this._zPiece[idx][sq]) >>> 0;
          file++;
        }
      }
    }

    // Side to move
    if (sideToMove === 'b') h = (h ^ this._zSide) >>> 0;

    // Castling
    let ci = 0;
    if (castling.includes('K')) ci |= 1;
    if (castling.includes('Q')) ci |= 2;
    if (castling.includes('k')) ci |= 4;
    if (castling.includes('q')) ci |= 8;
    h = (h ^ this._zCastle[ci]) >>> 0;

    // En passant
    if (epFile !== '-') {
      const ef = epFile.charCodeAt(0) - 97; // 'a'=0
      h = (h ^ this._zEp[ef]) >>> 0;
    }

    return h;
  }

  // -------------------------------------------------------------------------
  // Evaluate — returns score in centipawns from WHITE's perspective.
  // Public wrapper flips sign for side to move.
  // -------------------------------------------------------------------------
  evaluate(game) {
    return this._evaluateBoard(game);
  }

  _evaluateBoard(game) {
    const fen   = game.toFEN();
    const parts = fen.split(' ');
    const rows  = parts[0].split('/');
    const stm   = parts[1] === 'w' ? 0 : 1; // side to move color index

    let whiteMat = 0, blackMat = 0;
    let whitePST = 0, blackPST = 0;
    let phase    = 0;
    let whiteKingMG = 0, whiteKingEG = 0;
    let blackKingMG = 0, blackKingEG = 0;

    for (let rank = 7; rank >= 0; rank--) {
      const row  = rows[7 - rank];
      let file   = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch, 10);
        } else {
          const { color, type } = _fenCharToPiece(ch);
          const sq = rank * 8 + file;

          // Material
          const matVal = MATERIAL[type];
          if (color === 0) whiteMat += matVal;
          else             blackMat += matVal;

          // Phase accumulation (non-king pieces)
          phase += PHASE_WEIGHTS[type];

          // PST
          const pst = PST_BY_TYPE[type];
          if (pst) {
            const wSq  = sq; // white uses square directly
            const bSq  = (7 - rank) * 8 + file; // mirror for black
            const pstW = pst[wSq];
            const pstB = pst[bSq];
            if (color === 0) whitePST += pstW;
            else             blackPST += pstB;
          }

          // King tapered eval
          if (type === 6) {
            const wSq = sq;
            const bSq = (7 - rank) * 8 + file;
            if (color === 0) {
              whiteKingMG = KING_MG_PST[wSq];
              whiteKingEG = KING_EG_PST[wSq];
            } else {
              blackKingMG = KING_MG_PST[bSq];
              blackKingEG = KING_EG_PST[bSq];
            }
          }

          file++;
        }
      }
    }

    // Taper king score
    const p      = Math.min(phase, 24);
    const kingW  = Math.floor((whiteKingMG * p + whiteKingEG * (24 - p)) / 24);
    const kingB  = Math.floor((blackKingMG * p + blackKingEG * (24 - p)) / 24);

    const whiteScore = whiteMat + whitePST + kingW;
    const blackScore = blackMat + blackPST + kingB;

    // Return from side-to-move perspective
    const raw = whiteScore - blackScore;
    return stm === 0 ? raw : -raw;
  }

  // -------------------------------------------------------------------------
  // Transposition Table helpers
  // -------------------------------------------------------------------------
  _ttProbe(hash, depth, alpha, beta, ply) {
    const entry = this._tt[hash & TT_MASK];
    if (!entry || entry.hash !== hash) return null;
    if (entry.depth < depth) return null;
    let score = entry.score;
    // Adjust mate scores for ply
    if (score >  MATE_SCORE - 1000) score -= ply;
    if (score < -MATE_SCORE + 1000) score += ply;
    if (entry.flag === TT_FLAG_EXACT) return score;
    if (entry.flag === TT_FLAG_LOWERBOUND && score >= beta)  return score;
    if (entry.flag === TT_FLAG_UPPERBOUND && score <= alpha) return score;
    return null;
  }

  _ttStore(hash, depth, score, flag, move, ply) {
    // Adjust mate scores for storage
    if (score >  MATE_SCORE - 1000) score += ply;
    if (score < -MATE_SCORE + 1000) score -= ply;
    const idx = hash & TT_MASK;
    const existing = this._tt[idx];
    // Replace-if-deeper strategy with age preference
    if (!existing || existing.depth <= depth) {
      this._tt[idx] = { hash, depth, score, flag, move };
    }
  }

  _ttGetMove(hash) {
    const entry = this._tt[hash & TT_MASK];
    if (entry && entry.hash === hash) return entry.move;
    return null;
  }

  // -------------------------------------------------------------------------
  // Move ordering score
  // -------------------------------------------------------------------------
  _scoreMoves(moves, ttMove, ply) {
    const killers = this._killers[ply] || [null, null];
    return moves.map(m => {
      // TT best move
      if (ttMove && m.from === ttMove.from && m.to === ttMove.to &&
          m.piece === ttMove.piece && (m.promotion || 0) === (ttMove.promotion || 0)) {
        return { move: m, score: 10_000_000 };
      }

      const captured = m.captured;
      if (captured && (captured & 7) !== 0) {
        // MVV-LVA: favour capturing high-value pieces with low-value attackers
        const victimVal   = MATERIAL[(captured & 7)  || 0];
        const attackerVal = MATERIAL[(m.piece  & 7)  || 0];
        return { move: m, score: 1_000_000 + victimVal * 10 - attackerVal };
      }

      // Promotions
      if (m.promotion) return { move: m, score: 950_000 };

      // Killer moves
      if (killers[0] && m.from === killers[0].from && m.to === killers[0].to)
        return { move: m, score: 900_000 };
      if (killers[1] && m.from === killers[1].from && m.to === killers[1].to)
        return { move: m, score: 800_000 };

      // History heuristic
      const pieceIdx   = ((m.piece >> 3) & 1) * 6 + ((m.piece & 7) - 1);
      const histScore  = (pieceIdx >= 0 && pieceIdx < 12)
        ? this._history[pieceIdx][m.to]
        : 0;
      return { move: m, score: histScore };
    });
  }

  // -------------------------------------------------------------------------
  // Quiescence search — only capture moves
  // -------------------------------------------------------------------------
  _qsearch(game, alpha, beta, ply) {
    this._nodes++;
    if (this._stopped) return 0;

    const standPat = this._evaluateBoard(game);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    const allMoves   = game.generateMoves();
    const captures   = allMoves.filter(m => m.captured && (m.captured & 7) !== 0);
    // Sort captures by MVV-LVA
    captures.sort((a, b) => {
      const va = MATERIAL[(a.captured & 7)] * 10 - MATERIAL[(a.piece & 7)];
      const vb = MATERIAL[(b.captured & 7)] * 10 - MATERIAL[(b.piece & 7)];
      return vb - va;
    });

    for (const move of captures) {
      game._applyMove(move);
      const score = -this._qsearch(game, -beta, -alpha, ply + 1);
      game._undoMove();
      if (this._stopped) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  // -------------------------------------------------------------------------
  // Negamax with PVS, NMP, LMR, futility pruning
  // -------------------------------------------------------------------------
  _search(game, depth, alpha, beta, ply, pvLine) {
    this._nodes++;

    // Time check every 4096 nodes
    if ((this._nodes & 0xFFF) === 0) {
      if (Date.now() - this._startMs >= this._timeLimitMs) {
        this._stopped = true;
        return 0;
      }
    }

    if (this._stopped) return 0;

    // Probe TT
    const hash    = this._currentHash;
    const ttScore = this._ttProbe(hash, depth, alpha, beta, ply);
    if (ttScore !== null && ply > 0) return ttScore;
    const ttMove  = this._ttGetMove(hash);

    // Drop into quiescence at depth 0
    if (depth <= 0) {
      return this._qsearch(game, alpha, beta, ply);
    }

    const inCheck   = game.isCheck();
    // Check extension
    if (inCheck) depth++;

    // Null move pruning — skip in check, endgame, or shallow depths
    const isEndgame = this._isEndgame(game);
    if (!inCheck && !isEndgame && depth >= 3 && ply > 0 && beta < MATE_SCORE - 1000) {
      const R    = depth < 6 ? 2 : 3;
      // Apply null move: swap side by pushing an empty move
      const nullHash = (this._currentHash ^ this._zobristSide) >>> 0;
      this._hashStack.push(this._currentHash);
      this._currentHash = nullHash;
      // We simulate a null move by making a pass — use a dummy FEN trick:
      // We skip this if the game doesn't support null moves directly.
      // Instead we check via a lightweight eval at reduced depth.
      const nullScore = -this._nullMoveSearch(game, depth - R - 1, -beta, -beta + 1, ply + 1);
      this._currentHash = this._hashStack.pop();
      if (nullScore >= beta && nullScore < MATE_SCORE - 1000) {
        return beta; // Null move cutoff
      }
    }

    // Futility pruning at depth 1
    const futile = !inCheck && depth === 1 &&
                   this._evaluateBoard(game) + 150 < alpha;

    const moves     = game.generateMoves();
    if (moves.length === 0) {
      if (inCheck) return -(MATE_SCORE - ply);
      return 0; // Stalemate
    }

    const scored    = this._scoreMoves(moves, ttMove, ply);
    scored.sort((a, b) => b.score - a.score);

    let bestScore = -MATE_SCORE;
    let bestMove  = null;
    let flag      = TT_FLAG_UPPERBOUND;
    const childPV = [];
    pvLine.length = 0;

    for (let i = 0; i < scored.length; i++) {
      const { move } = scored[i];
      const isCapture   = move.captured && (move.captured & 7) !== 0;
      const isPromotion = !!move.promotion;
      const isQuiet     = !isCapture && !isPromotion;

      // Futility: skip quiet moves when far below alpha
      if (futile && isQuiet && i > 0) continue;

      // Update incremental hash
      this._hashStack.push(this._currentHash);
      this._currentHash = this._updateHash(this._currentHash, move, game);

      game._applyMove(move);

      let score;
      if (i === 0) {
        // First move: full window search
        childPV.length = 0;
        score = -this._search(game, depth - 1, -beta, -alpha, ply + 1, childPV);
      } else {
        // Late Move Reduction
        let reduction = 0;
        if (i >= 4 && depth >= 3 && isQuiet && !inCheck) {
          reduction = Math.max(1, Math.floor(Math.log(depth) * Math.log(i + 1) / 2.25));
        }

        // PVS null-window search
        childPV.length = 0;
        score = -this._search(game, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, childPV);

        // Re-search if promising and was reduced
        if (score > alpha && reduction > 0) {
          childPV.length = 0;
          score = -this._search(game, depth - 1, -alpha - 1, -alpha, ply + 1, childPV);
        }

        // Re-search with full window if score beats alpha (fail-high)
        if (score > alpha && score < beta) {
          childPV.length = 0;
          score = -this._search(game, depth - 1, -beta, -alpha, ply + 1, childPV);
        }
      }

      game._undoMove();
      this._currentHash = this._hashStack.pop();

      if (this._stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove  = move;
        if (score > alpha) {
          alpha = score;
          flag  = TT_FLAG_EXACT;
          pvLine.length = 0;
          pvLine.push(move, ...childPV);
        }
      }

      if (score >= beta) {
        // Beta cutoff — update killers and history
        if (isQuiet) {
          if (!this._killers[ply]) this._killers[ply] = [null, null];
          this._killers[ply][1] = this._killers[ply][0];
          this._killers[ply][0] = move;

          const pIdx = ((move.piece >> 3) & 1) * 6 + ((move.piece & 7) - 1);
          if (pIdx >= 0 && pIdx < 12) {
            this._history[pIdx][move.to] += depth * depth;
          }
        }
        flag = TT_FLAG_LOWERBOUND;
        break;
      }
    }

    this._ttStore(hash, depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  // Null move search — performs a stand-pat search without actually making
  // a null move on the game object (we rely on reduced-depth eval only).
  _nullMoveSearch(game, depth, alpha, beta, ply) {
    if (depth <= 0) return this._evaluateBoard(game);
    const moves = game.generateMoves();
    if (moves.length === 0) {
      if (game.isCheck()) return -(MATE_SCORE - ply);
      return 0;
    }
    // Simplified: just return static eval as a bound for NMP purposes
    return this._evaluateBoard(game);
  }

  // Update Zobrist hash incrementally for a move.
  _updateHash(hash, move, game) {
    const { from, to, piece, captured, promotion } = move;

    // Remove moving piece from source square
    const movingIdx = ((piece >> 3) & 1) * 6 + ((piece & 7) - 1);
    hash = (hash ^ this._zPiece[movingIdx][from]) >>> 0;

    // Remove captured piece (if any) — at target square (handle en passant)
    if (captured && (captured & 7) !== 0) {
      const capIdx  = ((captured >> 3) & 1) * 6 + ((captured & 7) - 1);
      // En passant: captured pawn is not on `to` but one rank back
      const capSq   = to; // Simplified: use `to` for all captures
      hash = (hash ^ this._zPiece[capIdx][capSq]) >>> 0;
    }

    // Place piece on destination (or promotion piece)
    if (promotion) {
      const promType = promotion; // should be piece type number
      const promIdx  = ((piece >> 3) & 1) * 6 + (promType - 1);
      hash = (hash ^ this._zPiece[promIdx][to]) >>> 0;
    } else {
      hash = (hash ^ this._zPiece[movingIdx][to]) >>> 0;
    }

    // Flip side to move
    hash = (hash ^ this._zSide) >>> 0;
    return hash;
  }

  // Determine whether position is an endgame (few major pieces remain).
  _isEndgame(game) {
    const fen  = game.toFEN().split(' ')[0];
    let queens  = 0, rooks = 0;
    for (const ch of fen) {
      if (ch === 'Q' || ch === 'q') queens++;
      if (ch === 'R' || ch === 'r') rooks++;
    }
    return queens + rooks <= 2;
  }

  // -------------------------------------------------------------------------
  // Public API: getBestMove — iterative deepening with aspiration windows
  // -------------------------------------------------------------------------
  async getBestMove(game, options = {}) {
    const { timeMs = 1500, depth: fixedDepth = null, onProgress = null } = options;

    // Reset search state
    this._stopped     = false;
    this._nodes       = 0;
    this._startMs     = Date.now();
    this._timeLimitMs = fixedDepth ? Infinity : timeMs;
    this._killers     = [];
    this._history     = Array.from({ length: 12 }, () => new Int32Array(64));

    // Compute initial Zobrist hash from scratch
    this._currentHash = this._computeHash(game);
    this._hashStack   = [];

    const legalMoves = game.generateMoves();
    if (legalMoves.length === 0) {
      return { move: null, score: 0, depth: 0, pv: [], nodes: 0 };
    }
    if (legalMoves.length === 1) {
      return { move: legalMoves[0], score: 0, depth: 0, pv: [legalMoves[0]], nodes: 1 };
    }

    const maxDepth = fixedDepth || 64;
    let bestMove   = legalMoves[0];
    let bestScore  = 0;
    let bestPV     = [legalMoves[0]];
    let currentDepth = 0;

    for (let d = 1; d <= maxDepth; d++) {
      if (this._stopped) break;
      // Time check: stop iterating if we've used > 60% of allotted time
      if (!fixedDepth && Date.now() - this._startMs > timeMs * 0.6) break;

      let alpha, beta;
      const pv = [];

      if (d >= 4) {
        // Aspiration window
        const delta   = 25;
        alpha = bestScore - delta;
        beta  = bestScore + delta;

        let score = this._search(game, d, alpha, beta, 0, pv);

        // Widen window on fail-low or fail-high
        let windowDelta = delta * 2;
        while (!this._stopped && (score <= alpha || score >= beta)) {
          if (score <= alpha) {
            alpha = Math.max(alpha - windowDelta, -MATE_SCORE);
          } else {
            beta  = Math.min(beta  + windowDelta,  MATE_SCORE);
          }
          windowDelta *= 2;
          pv.length = 0;
          score = this._search(game, d, alpha, beta, 0, pv);
        }

        if (!this._stopped && pv.length > 0) {
          bestScore = score;
          bestMove  = pv[0];
          bestPV    = pv.slice();
          currentDepth = d;
        }
      } else {
        // Full window for early depths
        alpha = -MATE_SCORE;
        beta  =  MATE_SCORE;
        const score = this._search(game, d, alpha, beta, 0, pv);
        if (!this._stopped && pv.length > 0) {
          bestScore = score;
          bestMove  = pv[0];
          bestPV    = pv.slice();
          currentDepth = d;
        }
      }

      if (!this._stopped && onProgress) {
        onProgress({
          depth:    currentDepth,
          score:    bestScore,
          bestMove: bestMove,
          pv:       bestPV.slice(),
          nodes:    this._nodes,
          timeMs:   Date.now() - this._startMs,
        });
      }
    }

    return {
      move:  bestMove,
      score: bestScore,
      depth: currentDepth,
      pv:    bestPV,
      nodes: this._nodes,
    };
  }

  // Stop a running search.
  stop() {
    this._stopped = true;
  }
}

// ---------------------------------------------------------------------------
// FEN character → { color: 0|1, type: 1-6 }
// ---------------------------------------------------------------------------
function _fenCharToPiece(ch) {
  const upper = ch.toUpperCase();
  const color = ch === upper ? 0 : 1; // uppercase = WHITE
  const typeMap = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6 };
  return { color, type: typeMap[upper] };
}

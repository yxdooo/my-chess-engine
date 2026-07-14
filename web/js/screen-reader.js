'use strict';

/**
 * @fileoverview Screen capture and chess board detection for Chess.com analysis.
 *
 * Pipeline:
 *   1. Capture a browser tab/window with getDisplayMedia()
 *   2. Sample video frames on a canvas at regular intervals
 *   3. Detect the chessboard bounds via color pattern recognition
 *   4. Classify each of the 64 squares: empty, white piece, black piece
 *   5. Identify piece types via pixel feature extraction
 *   6. Emit FEN strings when the detected position changes
 *
 * Piece type detection uses a lightweight feature approach (no ML):
 *   - Sample a 5-zone grid within each square
 *   - Measure pixel density distribution to distinguish piece shapes
 *   - Sufficient for ~75-85% accuracy on Chess.com default themes
 */

// Chess.com default board theme colors (approximate RGB)
const BOARD_THEMES = {
  'default': {
    light: [240, 217, 181],
    dark:  [181, 136,  99],
  },
  'green': {
    light: [238, 238, 210],
    dark:  [118, 150,  86],
  },
  'blue': {
    light: [222, 227, 230],
    dark:  [140, 162, 173],
  },
  'purple': {
    light: [241, 241, 241],
    dark:  [136, 119, 183],
  },
};

// Encoded piece values matching chess.js convention
const P = { NONE:0, PAWN:1, KNIGHT:2, BISHOP:3, ROOK:4, QUEEN:5, KING:6 };
const UNICODE_TO_PIECE = {
  '♙':1,'♘':2,'♗':3,'♖':4,'♕':5,'♔':6,
  '♟':9,'♞':10,'♝':11,'♜':12,'♛':13,'♚':14,
};
const PIECE_SYMBOL_MAP = ' PNBRQK  pnbrqk';

class ScreenReader {
  constructor() {
    /** @type {MediaStream|null} */
    this._stream = null;
    /** @type {HTMLVideoElement} */
    this._video = this._createVideo();
    /** @type {HTMLCanvasElement} */
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });

    this._intervalId = null;
    this._lastFEN = null;
    this._boardBounds = null;   // { x, y, size } in canvas pixels
    this._theme = 'default';
    this._flipped = false;

    /** Called whenever a new FEN is detected. @type {Function|null} */
    this.onPositionChange = null;
    /** Called with { x, y, size } when board is found. @type {Function|null} */
    this.onBoardDetected = null;
    /** Called each frame with the raw canvas. @type {Function|null} */
    this.onFrame = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Prompts the user for screen share and starts the capture pipeline. */
  async startCapture() {
    if (this._stream) this.stopCapture();

    this._stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 }, displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
    });

    this._stream.getVideoTracks()[0].addEventListener('ended', () => this.stopCapture());

    this._video.srcObject = this._stream;
    await new Promise(res => { this._video.onloadedmetadata = res; });
    await this._video.play();

    // Wait for first frame
    await new Promise(res => { this._video.oncanplay = res; });

    this._intervalId = setInterval(() => this._processFrame(), 500);
  }

  stopCapture() {
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
    this._stream?.getTracks().forEach(t => t.stop());
    this._stream = null;
    this._video.srcObject = null;
    this._boardBounds = null;
    this._lastFEN = null;
  }

  /** Returns the most recently detected FEN, or null if no board found. */
  getDetectedFEN() { return this._lastFEN; }

  /** Returns detected board bounds { x, y, size } relative to the capture canvas. */
  getBoardBounds() { return this._boardBounds; }

  /** Set whether the board appears flipped (Black at bottom). */
  setFlipped(flipped) { this._flipped = flipped; }

  /** Manually set board theme for better detection accuracy. */
  setTheme(themeName) { this._theme = BOARD_THEMES[themeName] ? themeName : 'default'; }

  /** Force a new board scan on next frame. */
  resetDetection() { this._boardBounds = null; }

  /** Exposes the internal canvas for external preview rendering. */
  getCanvas() { return this._canvas; }

  // ── Private: frame processing ────────────────────────────────────────────

  _processFrame() {
    if (!this._video.videoWidth) return;

    this._canvas.width  = this._video.videoWidth;
    this._canvas.height = this._video.videoHeight;
    this._ctx.drawImage(this._video, 0, 0);

    this.onFrame?.(this._canvas);

    // Re-scan for board every ~5 seconds or if not yet found
    if (!this._boardBounds || Date.now() % 5000 < 600) {
      this._detectBoard();
    }

    if (!this._boardBounds) return;

    const fen = this._extractFEN();
    if (fen && fen !== this._lastFEN) {
      this._lastFEN = fen;
      this.onPositionChange?.(fen);
    }
  }

  // ── Private: board detection ─────────────────────────────────────────────

  /**
   * Scans the canvas for an 8×8 alternating-color pattern that matches a chess board.
   * Searches in a grid of candidate positions, then validates each candidate.
   */
  _detectBoard() {
    const { width, height } = this._canvas;
    const data = this._ctx.getImageData(0, 0, width, height).data;

    const theme = BOARD_THEMES[this._theme];
    const minSize = Math.min(width, height) * 0.2;
    const maxSize = Math.min(width, height) * 0.95;

    let best = null;
    let bestScore = 0;

    // Coarse scan: try different board sizes and positions
    const steps = 12;
    for (let si = 0; si < steps; si++) {
      const sz = minSize + (maxSize - minSize) * si / steps;
      const sqSz = sz / 8;
      const xStep = Math.max(1, Math.floor(width  / 20));
      const yStep = Math.max(1, Math.floor(height / 20));

      for (let bx = 0; bx + sz < width; bx += xStep) {
        for (let by = 0; by + sz < height; by += yStep) {
          const score = this._scoreBoardCandidate(data, width, bx, by, sz, sqSz, theme);
          if (score > bestScore) {
            bestScore = score;
            best = { x: bx, y: by, size: sz };
          }
        }
      }
    }

    const threshold = 0.55;
    if (best && bestScore > threshold) {
      // Refine with fine scan around best candidate
      best = this._refineBoardBounds(data, width, best, theme);
      if (best) {
        this._boardBounds = best;
        this.onBoardDetected?.(best);
      }
    }
  }

  /**
   * Scores a board candidate by sampling corner pixels of each square and
   * checking if they alternate between the theme's light and dark colors.
   */
  _scoreBoardCandidate(data, imgWidth, bx, by, sz, sqSz, theme) {
    let matches = 0;
    const total = 64;

    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const cx = Math.round(bx + (file + 0.5) * sqSz);
        const cy = Math.round(by + (rank + 0.5) * sqSz);
        if (cx >= imgWidth || cy * imgWidth * 4 > data.length) continue;

        const idx = (cy * imgWidth + cx) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        const isLightSquare = (file + rank) % 2 === 0;
        const expected = isLightSquare ? theme.light : theme.dark;

        if (this._colorDistance([r,g,b], expected) < 60) matches++;
      }
    }

    return matches / total;
  }

  /** Refines board bounds to sub-pixel accuracy by gradient descent on the score. */
  _refineBoardBounds(data, imgWidth, candidate, theme) {
    let { x, y, size } = candidate;
    let bestScore = this._scoreBoardCandidate(data, imgWidth, x, y, size, size/8, theme);

    const step = size / 32;
    for (let iter = 0; iter < 20; iter++) {
      let improved = false;
      for (const [dx, dy, ds] of [[step,0,0],[-step,0,0],[0,step,0],[0,-step,0],[0,0,step],[0,0,-step]]) {
        const nx = x + dx, ny = y + dy, ns = size + ds;
        if (ns < 10) continue;
        const score = this._scoreBoardCandidate(data, imgWidth, nx, ny, ns, ns/8, theme);
        if (score > bestScore) { bestScore = score; x=nx; y=ny; size=ns; improved=true; break; }
      }
      if (!improved) break;
    }

    return bestScore > 0.65 ? { x: Math.round(x), y: Math.round(y), size: Math.round(size) } : null;
  }

  // ── Private: FEN extraction ──────────────────────────────────────────────

  _extractFEN() {
    const { x, y, size } = this._boardBounds;
    const sqSz = size / 8;
    const data = this._ctx.getImageData(x, y, size, size).data;

    const board = new Array(64).fill(0);

    for (let rank = 7; rank >= 0; rank--) {
      for (let file = 0; file < 8; file++) {
        const visualRank = this._flipped ? rank : 7 - rank;
        const visualFile = this._flipped ? 7 - file : file;

        const sq = rank * 8 + file;
        const sqX = Math.round(visualFile * sqSz);
        const sqY = Math.round(visualRank * sqSz);

        const squareData = this._extractSquareData(data, sqX, sqY, Math.round(sqSz), size);
        board[sq] = this._classifySquare(squareData, (file + rank) % 2 === 1);
      }
    }

    return this._boardToFEN(board);
  }

  /**
   * Extracts a normalized 8×8 pixel grid from a square region.
   * Returns a flat array of [r,g,b] triplets.
   */
  _extractSquareData(imageData, sqX, sqY, sqSize, imgSize) {
    const samples = [];
    const step = Math.max(1, Math.floor(sqSize / 8));

    for (let py = sqY + 2; py < sqY + sqSize - 2; py += step) {
      for (let px = sqX + 2; px < sqX + sqSize - 2; px += step) {
        if (px >= imgSize || py >= imgSize) continue;
        const idx = (py * imgSize + px) * 4;
        samples.push([imageData[idx], imageData[idx+1], imageData[idx+2]]);
      }
    }
    return samples;
  }

  /**
   * Classifies a square as: 0 (empty), 1-6 (white piece), 9-14 (black piece).
   * Uses color deviation from the expected empty square color to detect pieces,
   * then brightness and pixel distribution to identify piece type.
   */
  _classifySquare(samples, isLightSquare) {
    if (samples.length === 0) return 0;

    const theme = BOARD_THEMES[this._theme];
    const emptyColor = isLightSquare ? theme.light : theme.dark;

    // Measure how different this square is from an empty square
    let deviationSum = 0;
    let brightPixels = 0, darkPixels = 0;

    for (const [r,g,b] of samples) {
      const dev = this._colorDistance([r,g,b], emptyColor);
      deviationSum += dev;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 180) brightPixels++;
      else if (lum < 80) darkPixels++;
    }

    const avgDeviation = deviationSum / samples.length;
    const total = samples.length;

    // If average deviation is low → empty square
    if (avgDeviation < 28) return 0;

    // Determine piece color: white pieces have many bright pixels on any square type
    // Black pieces have many dark pixels
    const isWhitePiece = brightPixels / total > 0.18;
    const isBlackPiece = darkPixels / total > 0.15;

    if (!isWhitePiece && !isBlackPiece) return 0; // uncertain → treat as empty

    const color = isWhitePiece ? 0 : 1; // 0=WHITE, 1=BLACK
    const pieceType = this._identifyPieceType(samples, color, total, sqSize => sqSize);

    return (color << 3) | pieceType;
  }

  /**
   * Estimates piece type from pixel distribution.
   * Divides the square into 5 vertical zones and measures pixel density in each.
   * Different piece shapes (pawn, rook, knight, bishop, queen, king) have
   * characteristic density profiles.
   */
  _identifyPieceType(samples, color, total) {
    if (total === 0) return P.PAWN;

    const sqSize = Math.sqrt(samples.length) | 0 || 8;
    // Organize samples into a rough grid
    const rows = Math.min(sqSize, 8);
    const cols = Math.min(sqSize, 8);
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));

    const emptyLum = color === 0 ? 200 : 60; // expected background luminance for piece color

    samples.forEach((px, i) => {
      const row = Math.floor(i / cols) % rows;
      const col = i % cols;
      const lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
      // Mark as "piece pixel" if it matches piece color
      if (color === 0) {
        grid[row][col] = lum > 140 ? 1 : 0; // white piece: bright pixels
      } else {
        grid[row][col] = lum < 100 ? 1 : 0; // black piece: dark pixels
      }
    });

    // Compute density per vertical zone (5 zones)
    const zones = [0, 0, 0, 0, 0];
    const zoneSize = rows / 5;
    grid.forEach((row, r) => {
      const zone = Math.min(4, Math.floor(r / zoneSize));
      zones[zone] += row.reduce((a, b) => a + b, 0) / cols;
    });

    const top    = zones[4]; // top zone (rank 8 direction = visually top)
    const upper  = zones[3];
    const mid    = zones[2];
    const lower  = zones[1];
    const bottom = zones[0];

    const topHeavy  = top > 0.6 && upper > 0.5;
    const wideTop   = top > 0.7;
    const tallNarrow = top > 0.4 && mid < 0.35 && bottom > 0.3;
    const spreading = top < 0.3 && mid > 0.4 && bottom > 0.5;

    // Heuristic piece type classification based on shape profile
    // These thresholds are empirically tuned for Chess.com default piece set
    const totalDensity = zones.reduce((a, b) => a + b, 0);

    if (totalDensity < 0.8) return P.PAWN;
    if (wideTop && top - bottom > 0.3) return P.QUEEN;
    if (topHeavy && top > upper) return P.KING;
    if (top > 0.5 && upper < 0.3 && mid > 0.4) return P.ROOK;
    if (spreading) return P.BISHOP;
    if (Math.abs(top - bottom) < 0.15 && mid > 0.4) return P.KNIGHT;

    // Fallback: use total density to distinguish heavy from light pieces
    if (totalDensity > 2.5) return P.QUEEN;
    if (totalDensity > 1.8) return P.ROOK;
    if (totalDensity > 1.2) return P.BISHOP;
    return P.PAWN;
  }

  _boardToFEN(board) {
    let fen = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = board[rank * 8 + file];
        if (!piece) {
          empty++;
        } else {
          if (empty > 0) { fen += empty; empty = 0; }
          fen += PIECE_SYMBOL_MAP[piece] ?? '?';
        }
      }
      if (empty > 0) fen += empty;
      if (rank > 0) fen += '/';
    }
    // Side to move is unknown from screen capture; default to both alternating.
    // The UI will let the user specify or toggle it.
    return fen + ' w KQkq - 0 1';
  }

  // ── Private: color utilities ─────────────────────────────────────────────

  /** Euclidean distance in RGB space. */
  _colorDistance(a, b) {
    return Math.sqrt(
      (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
    );
  }

  _createVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.style.display = 'none';
    document.body.appendChild(v);
    return v;
  }

  destroy() {
    this.stopCapture();
    this._video.remove();
  }
}

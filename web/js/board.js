'use strict';

/**
 * @fileoverview Chess board rendering, drag-and-drop interaction, and move input handling.
 *
 * Renders an 8×8 board using DOM elements. Handles user input via pointer events
 * and communicates legal moves to the caller via an `onMove` callback.
 *
 * Depends on: chess.js (ChessGame, PIECE, COLOR, MOVE_FLAGS)
 */

// Unicode piece characters indexed by encoded piece value (1-6 white, 9-14 black)
const PIECE_UNICODE = ['', '♙', '♘', '♗', '♖', '♕', '♔', '', '', '♟', '♞', '♝', '♜', '♛', '♚'];

class ChessBoard {
  /**
   * @param {HTMLElement} container   - Element to render the board inside
   * @param {object}      opts
   * @param {string}      [opts.perspective='white'] - 'white' or 'black'
   * @param {boolean}     [opts.interactive=true]
   * @param {Function}    [opts.onMove]              - Called with (move: Move)
   */
  constructor(container, opts = {}) {
    this._container   = container;
    this._perspective = opts.perspective ?? 'white';
    this._interactive = opts.interactive ?? true;
    this._onMove      = opts.onMove ?? null;

    /** @type {ChessGame|null} */
    this._game = null;
    this._legalMoves  = [];
    this._selected    = -1;     // source square of pending move
    this._lastMove    = null;   // { from, to }
    this._arrows      = [];     // [{ from, to, color }]
    this._pendingPromotion = null; // { from, to, legalMoves }

    this._sqEls = new Array(64).fill(null);
    this._dragging = null;      // { sq, el, startX, startY }

    this._build();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Re-renders the board for the given game state. */
  setPosition(game) {
    this._game = game;
    this._legalMoves = this._interactive ? game.generateMoves() : [];
    this._selected = -1;
    this._render();
  }

  /** Highlights the last move (from/to squares). */
  setLastMove(move) {
    this._lastMove = move ? { from: move.from, to: move.to } : null;
    this._renderHighlights();
  }

  flip() {
    this._perspective = this._perspective === 'white' ? 'black' : 'white';
    if (this._game) this._render();
  }

  setInteractive(on) {
    this._interactive = on;
    this._legalMoves = on && this._game ? this._game.generateMoves() : [];
    this._selected = -1;
    this._renderHighlights();
  }

  /**
   * Draws an arrow overlay on the board.
   * @param {number} from
   * @param {number} to
   * @param {string} [color='rgba(245,158,11,0.75)']
   */
  showArrow(from, to, color = 'rgba(245,158,11,0.75)') {
    this._arrows = this._arrows.filter(a => !(a.from === from && a.to === to));
    this._arrows.push({ from, to, color });
    this._renderArrows();
  }

  clearArrows() {
    this._arrows = [];
    this._renderArrows();
  }

  // ── Private: build DOM ───────────────────────────────────────────────────

  _build() {
    this._container.innerHTML = '';
    this._container.style.position = 'relative';

    const grid = document.createElement('div');
    grid.className = 'board-grid';
    grid.id = 'board-grid';

    for (let i = 0; i < 64; i++) {
      const el = document.createElement('div');
      const visualIndex = i;
      const sq = this._visualToSq(visualIndex);
      const isLight = ((sq & 7) + (sq >> 3)) % 2 === 1;
      el.className = 'sq ' + (isLight ? 'light' : 'dark');
      el.dataset.sq = sq;
      el.addEventListener('pointerdown', e => this._onPointerDown(e, sq));
      el.addEventListener('click', () => this._onClick(sq));
      this._sqEls[sq] = el;
      grid.appendChild(el);
    }

    this._grid = grid;
    this._container.appendChild(grid);

    // SVG arrow overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    this._arrowSvg = svg;
    this._container.appendChild(svg);

    // Floating drag ghost
    this._dragGhost = document.createElement('div');
    this._dragGhost.className = 'piece dragging';
    this._dragGhost.style.display = 'none';
    document.body.appendChild(this._dragGhost);

    document.addEventListener('pointermove', e => this._onPointerMove(e));
    document.addEventListener('pointerup',   e => this._onPointerUp(e));
  }

  // ── Private: rendering ───────────────────────────────────────────────────

  _render() {
    this._rebuildGrid();
    this._renderPieces();
    this._renderHighlights();
    this._renderArrows();
  }

  /** Reorder DOM children to match perspective without full rebuild. */
  _rebuildGrid() {
    const squares = Array.from(this._grid.children);
    const ordered = squares.sort((a, b) => {
      const sa = parseInt(a.dataset.sq), sb = parseInt(b.dataset.sq);
      return this._sqToVisual(sa) - this._sqToVisual(sb);
    });
    ordered.forEach(el => this._grid.appendChild(el));
  }

  _renderPieces() {
    if (!this._game) return;
    for (let sq = 0; sq < 64; sq++) {
      const el = this._sqEls[sq];
      const existingPiece = el.querySelector('.piece');
      if (existingPiece) el.removeChild(existingPiece);

      const piece = this._game.board[sq];
      if (!piece) continue;

      const pieceEl = document.createElement('div');
      pieceEl.className = 'piece ' + (piece < 8 ? 'white' : 'black');
      pieceEl.textContent = PIECE_UNICODE[piece];
      pieceEl.dataset.sq = sq;
      el.appendChild(pieceEl);
    }
  }

  _renderHighlights() {
    for (const el of this._sqEls) {
      if (!el) continue;
      el.classList.remove('selected', 'last-from', 'last-to', 'in-check', 'hint', 'hint-capture');
    }

    if (this._lastMove) {
      this._sqEls[this._lastMove.from]?.classList.add('last-from');
      this._sqEls[this._lastMove.to]?.classList.add('last-to');
    }

    if (this._game?.isCheck()) {
      // Find the king in check
      const kingPiece = this._game.sideToMove === COLOR.WHITE ? 6 : 14;
      for (let sq = 0; sq < 64; sq++) {
        if (this._game.board[sq] === kingPiece) {
          this._sqEls[sq]?.classList.add('in-check');
          break;
        }
      }
    }

    if (this._selected >= 0) {
      this._sqEls[this._selected]?.classList.add('selected');
      const moves = this._legalMoves.filter(m => m.from === this._selected);
      for (const m of moves) {
        const el = this._sqEls[m.to];
        if (!el) continue;
        el.classList.add(m.captured ? 'hint-capture' : 'hint');
      }
    }
  }

  _renderArrows() {
    // Remove old arrows (keep defs)
    Array.from(this._arrowSvg.children).forEach(c => {
      if (c.tagName !== 'defs') c.remove();
    });

    const size = this._container.offsetWidth || 480;
    const sqSize = size / 8;

    for (const arrow of this._arrows) {
      this._drawArrow(arrow.from, arrow.to, arrow.color, sqSize);
    }
  }

  _drawArrow(from, to, color, sqSize) {
    const arrowId = `ah-${from}-${to}`.replace(/[^a-zA-Z0-9-]/g, '');

    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', arrowId);
    marker.setAttribute('markerWidth', '4');
    marker.setAttribute('markerHeight', '4');
    marker.setAttribute('refX', '2.5');
    marker.setAttribute('refY', '2');
    marker.setAttribute('orient', 'auto');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0,0 4,2 0,4');
    poly.setAttribute('fill', color);
    marker.appendChild(poly);
    this._arrowSvg.querySelector('defs').appendChild(marker);

    const [fx, fy] = this._sqCenter(from, sqSize);
    const [tx, ty] = this._sqCenter(to, sqSize);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', fx); line.setAttribute('y1', fy);
    line.setAttribute('x2', tx); line.setAttribute('y2', ty);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', sqSize * 0.12);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('marker-end', `url(#${arrowId})`);
    this._arrowSvg.appendChild(line);
  }

  _sqCenter(sq, sqSize) {
    const vis = this._sqToVisual(sq);
    const col = vis % 8;
    const row = Math.floor(vis / 8);
    return [(col + 0.5) * sqSize, (row + 0.5) * sqSize];
  }

  // ── Private: input handling ──────────────────────────────────────────────

  _onClick(sq) {
    if (!this._interactive || !this._game || this._dragging) return;
    if (this._game.isGameOver()) return;
    if (this._pendingPromotion) return;

    const sideToMove = this._game.sideToMove;
    const piece = this._game.board[sq];

    // If clicking own piece: select (or re-select)
    if (piece && (piece < 8 ? COLOR.WHITE : COLOR.BLACK) === sideToMove) {
      this._selected = sq;
      this._renderHighlights();
      return;
    }

    // If a source is selected: attempt move
    if (this._selected >= 0) {
      const moves = this._legalMoves.filter(m => m.from === this._selected && m.to === sq);
      if (moves.length > 0) {
        this._tryMove(moves);
        return;
      }
    }

    // Deselect on empty square or opponent piece with no prior selection
    this._selected = -1;
    this._renderHighlights();
  }

  _onPointerDown(e, sq) {
    if (!this._interactive || !this._game || this._game.isGameOver()) return;
    const piece = this._game.board[sq];
    if (!piece) return;
    const sideToMove = this._game.sideToMove;
    if ((piece < 8 ? COLOR.WHITE : COLOR.BLACK) !== sideToMove) return;

    e.preventDefault();
    this._selected = sq;
    this._renderHighlights();

    // Begin drag
    const rect = this._sqEls[sq].getBoundingClientRect();
    this._dragging = { sq, startX: e.clientX, startY: e.clientY };
    this._dragGhost.textContent = PIECE_UNICODE[piece];
    this._dragGhost.className = 'piece dragging ' + (piece < 8 ? 'white' : 'black');
    this._dragGhost.style.display = 'flex';
    this._dragGhost.style.width = rect.width + 'px';
    this._dragGhost.style.height = rect.height + 'px';
    this._updateDragPos(e.clientX, e.clientY, rect.width);

    // Hide original piece during drag
    const pieceEl = this._sqEls[sq].querySelector('.piece');
    if (pieceEl) pieceEl.style.opacity = '0.3';
  }

  _onPointerMove(e) {
    if (!this._dragging) return;
    const rect = this._sqEls[this._dragging.sq].getBoundingClientRect();
    this._updateDragPos(e.clientX, e.clientY, rect.width);
  }

  _onPointerUp(e) {
    if (!this._dragging) return;
    this._dragGhost.style.display = 'none';

    // Restore piece opacity
    const pieceEl = this._sqEls[this._dragging.sq]?.querySelector('.piece');
    if (pieceEl) pieceEl.style.opacity = '';

    // Determine drop square from element under pointer
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const sqEl = el?.closest('[data-sq]');
    const toSq = sqEl ? parseInt(sqEl.dataset.sq) : -1;

    const fromSq = this._dragging.sq;
    this._dragging = null;

    if (toSq >= 0 && toSq !== fromSq) {
      const moves = this._legalMoves.filter(m => m.from === fromSq && m.to === toSq);
      if (moves.length > 0) {
        this._tryMove(moves);
        return;
      }
    }

    this._renderHighlights();
  }

  _updateDragPos(x, y, size) {
    this._dragGhost.style.left = (x - size / 2) + 'px';
    this._dragGhost.style.top  = (y - size / 2) + 'px';
  }

  _tryMove(moves) {
    if (moves.length === 1) {
      this._submitMove(moves[0]);
    } else {
      // Multiple moves = promotion choices
      this._showPromotionUI(moves);
    }
  }

  _submitMove(move) {
    this._selected = -1;
    this._pendingPromotion = null;
    this._onMove?.(move);
  }

  _showPromotionUI(moves) {
    this._pendingPromotion = { moves };

    const overlay = document.createElement('div');
    overlay.className = 'promo-overlay';

    const card = document.createElement('div');
    card.className = 'glass promo-card';
    card.innerHTML = '<h3>Choose promotion piece</h3><div class="promo-pieces"></div>';

    const pieceTypes = [PIECE.QUEEN, PIECE.ROOK, PIECE.BISHOP, PIECE.KNIGHT];
    const color = this._game.sideToMove;
    const piecesEl = card.querySelector('.promo-pieces');

    for (const pt of pieceTypes) {
      const encoded = (color << 3) | pt;
      const btn = document.createElement('div');
      btn.className = 'promo-piece';
      btn.textContent = PIECE_UNICODE[encoded];
      btn.addEventListener('click', () => {
        const move = moves.find(m => m.promotion === pt);
        overlay.remove();
        if (move) this._submitMove(move);
      });
      piecesEl.appendChild(btn);
    }

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ── Private: coordinate utilities ───────────────────────────────────────

  /** Converts square index to visual grid position (0=top-left). */
  _sqToVisual(sq) {
    const rank = sq >> 3;
    const file = sq & 7;
    if (this._perspective === 'white') {
      return (7 - rank) * 8 + file;
    } else {
      return rank * 8 + (7 - file);
    }
  }

  _visualToSq(vis) {
    const row = Math.floor(vis / 8);
    const col = vis % 8;
    if (this._perspective === 'white') {
      return (7 - row) * 8 + col;
    } else {
      return row * 8 + (7 - col);
    }
  }
}

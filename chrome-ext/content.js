let currentFEN = '';
let overlayCanvas = null;
let flipBoard = false;
let debounceTimer = null;

console.log("[Content] Chess Engine V2 content script loaded!");

function initOverlay() {
  const boardEl = document.querySelector('wc-chess-board, chess-board');
  if (!boardEl) return;

  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.style.position = 'absolute';
    overlayCanvas.style.top = '0';
    overlayCanvas.style.left = '0';
    overlayCanvas.style.width = '100%';
    overlayCanvas.style.height = '100%';
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.zIndex = '9999';
    boardEl.appendChild(overlayCanvas);
  }
  
  flipBoard = boardEl.classList.contains('flipped');
  overlayCanvas.width = boardEl.clientWidth;
  overlayCanvas.height = boardEl.clientHeight;
}

function parseBoard() {
  const boardEl = document.querySelector('wc-chess-board, chess-board');
  if (!boardEl) {
      console.log("[Content] Board not found!");
      return null;
  }

  flipBoard = boardEl.classList.contains('flipped');
  const pieces = boardEl.querySelectorAll('.piece');
  
  const board = new Array(64).fill(null);
  let whiteKing = false;
  let blackKing = false;
  
  pieces.forEach(p => {
    let pieceClass = '';
    let squareClass = '';
    p.classList.forEach(cls => {
      if (cls.match(/^[wb][prnbqk]$/)) pieceClass = cls;
      if (cls.match(/^square-[a-h1-8][1-8]$/)) squareClass = cls;
    });

    if (pieceClass && squareClass) {
      let file, rank;
      if (isNaN(parseInt(squareClass[7]))) {
          file = squareClass.charCodeAt(7) - 97;
          rank = parseInt(squareClass[8]) - 1;
      } else {
          file = parseInt(squareClass[7]) - 1;
          rank = parseInt(squareClass[8]) - 1;
      }
      let char = pieceClass[1];
      if (pieceClass[0] === 'w') char = char.toUpperCase();
      board[rank * 8 + file] = char;
      
      if (char === 'K') whiteKing = true;
      if (char === 'k') blackKing = true;
    }
  });

  if (!whiteKing || !blackKing) {
      console.log("[Content] Missing kings! White:", whiteKing, "Black:", blackKing);
      return null;
  }

  let fen = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r * 8 + f];
      if (p) {
        if (empty > 0) fen += empty;
        empty = 0;
        fen += p;
      } else {
        empty++;
      }
    }
    if (empty > 0) fen += empty;
    if (r > 0) fen += '/';
  }
  
  let wK_moved = false;
  let bK_moved = false;

  let stm = 'w';
  const moveNodes = document.querySelectorAll('wc-move-list .node:not(.icon-font-chess), .move-list-item .node');
  
  let maxPly = 0;
  document.querySelectorAll('[data-ply]').forEach(el => {
      const p = parseInt(el.getAttribute('data-ply'), 10);
      if (!isNaN(p) && p > maxPly) maxPly = p;
  });

  if (maxPly > 0) {
      stm = (maxPly % 2 === 1) ? 'b' : 'w';
  } else if (moveNodes && moveNodes.length > 0) {
      stm = (moveNodes.length % 2 === 1) ? 'b' : 'w';
  }

  if (moveNodes && moveNodes.length > 0) {
    // Check if kings have moved to determine castling rights
    moveNodes.forEach((node, index) => {
      let text = node.innerText.trim();
      let isWhite = index % 2 === 0;
      if (isWhite) {
          if (text.startsWith('K') || text.startsWith('O-O')) wK_moved = true;
      } else {
          if (text.startsWith('K') || text.startsWith('O-O')) bK_moved = true;
      }
    });
  }

  let castling = '';
  if (!wK_moved && board[4] === 'K') {
    if (board[7] === 'R') castling += 'K';
    if (board[0] === 'R') castling += 'Q';
  }
  if (!bK_moved && board[60] === 'k') {
    if (board[63] === 'r') castling += 'k';
    if (board[56] === 'r') castling += 'q';
  }
  if (castling === '') castling = '-';

  return fen + ' ' + stm + ' ' + castling + ' - 0 1';
}

function getMyTimeLeft() {
    const activeClock = document.querySelector('.clock-component.clock-active, .clock-time-monospaced');
    if (!activeClock) return null; 
    
    let text = activeClock.innerText.trim(); 
    let seconds = 600; 
    
    try {
        if (text.includes(':')) {
            const parts = text.split(':');
            seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
        } else {
            seconds = parseFloat(text);
        }
    } catch(e) {}
    
    return seconds;
}

function drawArrow(fromIdx, toIdx, color) {
  initOverlay();
  if (!overlayCanvas) return;
  const ctx = overlayCanvas.getContext('2d');
  

  const sqSize = overlayCanvas.width / 8;
  
  const getXY = (idx) => {
    let f = idx % 8;
    let r = Math.floor(idx / 8); 
    let visual_r = 7 - r;
    
    if (flipBoard) {
      f = 7 - f;
      visual_r = 7 - visual_r;
    }
    return {
      x: (f + 0.5) * sqSize,
      y: (visual_r + 0.5) * sqSize
    };
  };

  const start = getXY(fromIdx);
  const end = getXY(toIdx);

  const headlen = sqSize * 0.4;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = 'rgba(46, 204, 113, 0.85)';
  ctx.lineWidth = sqSize * 0.15;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - headlen * Math.cos(angle - Math.PI / 6), end.y - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(end.x - headlen * Math.cos(angle + Math.PI / 6), end.y - headlen * Math.sin(angle + Math.PI / 6));
  ctx.lineTo(end.x, end.y);
  ctx.fillStyle = 'rgba(46, 204, 113, 0.85)';
  ctx.fill();
}

function processPosition(networkFen = null) {
    const fen = networkFen || parseBoard();
    if (fen && fen !== currentFEN) {
      console.log("[Content] New FEN detected:", fen);
      currentFEN = fen;
      if (overlayCanvas) overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      
      const timeLeft = getMyTimeLeft();
      console.log("[Content] Time left:", timeLeft);
      
      const stm = fen.split(' ')[1];
      const myColor = flipBoard ? 'b' : 'w';
      const isMyTurn = (stm === myColor);

      chrome.runtime.sendMessage({ type: 'NEW_POSITION', fen: fen, timeLeft: timeLeft, isMyTurn: isMyTurn }, response => {
        if (chrome.runtime.lastError) {
            console.error("[Content] Messaging error:", chrome.runtime.lastError);
            return;
        }
        
        if (isMyTurn && response && response.pv && response.pv.length > 0) {
          if (overlayCanvas) overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          
          const colors = [
              'rgba(46, 204, 113, 0.95)', // Green
              'rgba(231, 76, 60, 0.85)',  // Red
              'rgba(52, 152, 219, 0.75)'  // Blue
          ];
          
          const maxMoves = Math.min(response.pv.length, 3);
          for (let i = maxMoves - 1; i >= 0; i--) {
              let move = response.pv[i];
              if (typeof move === 'string') move = move.replace(/['"]/g, '');
              if (move && move.length >= 4) {
                  const f = move.charCodeAt(0) - 97;
                  const r = move.charCodeAt(1) - 49;
                  const tf = move.charCodeAt(2) - 97;
                  const tr = move.charCodeAt(3) - 49;
                  
                  if (f >= 0 && f <= 7 && r >= 0 && r <= 7 && tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7) {
                      drawArrow(r * 8 + f, tr * 8 + tf, colors[i]);
                  }
              }
          }
        }
      });
    }
}

const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    processPosition();
  }, 400); 
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check after a slight delay to ensure board is loaded
setTimeout(processPosition, 1000);

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'FORCE_EVALUATE') { currentFEN = ''; processPosition(); } });

// Listen for FEN data coming from the intercepted WebSocket
window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data || event.data.type !== 'CHESS_WS_MESSAGE') return;
    try {
        const payload = event.data.payload;
        // Fully compliant FEN regex (including En Passant and move counters)
        const fenRegex = /([rnbqkbnrRNBQKBNR1-8]+\/){7}[rnbqkbnrRNBQKBNR1-8]+ [wb] (K?Q?k?q?|-) ([a-h][36]|-) \d+ \d+/;
        const match = payload.match(fenRegex);
        if (match && match[0]) {
            processPosition(match[0]);
        }
    } catch (e) {
        console.error("[Content] Error:", e);
    }
});

/** @type {string} The last FEN position that was sent for analysis. */
let currentFEN = "";

/** @type {string[]} Normalized FEN history for repetition detection. */
let fenHistory = [];

/**
 * Cache of ponder search results: normalized FEN -> { bestMove, pv }.
 * Populated by the background script's ponder response.
 * @type {Object.<string, {bestMove: string, pv: string[]}>}
 */
let ponderCache = {};

/** @type {HTMLCanvasElement|null} Overlay canvas drawn on top of the board. */
let overlayCanvas = null;

/** @type {boolean} Whether the board is currently flipped (playing as Black). */
let flipBoard = false;

/** @type {number|null} Debounce timer ID for MutationObserver. */
let debounceTimer = null;

/** @type {string} Cached engine mode. */
let currentEngineMode = "autoplay";

chrome.storage.local.get("engineMode", (res) => {
    if (res.engineMode) currentEngineMode = res.engineMode;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.engineMode) {
        currentEngineMode = changes.engineMode.newValue;
    }
});

/**
 * Normalizes a FEN string to its first 4 fields
 * (position, side-to-move, castling, en-passant).
 * Must stay consistent with background.js normalizeFen.
 * @param {string} fen
 * @returns {string}
 */
function normalizeFen(fen) {
    if (!fen) return "";
    return fen.split(" ").slice(0, 4).join(" ");
}

// ---------------------------------------------------------------------------
// Overlay / Arrow Drawing
// ---------------------------------------------------------------------------

/**
 * Ensures the overlay canvas is attached to the board element.
 * Also syncs canvas dimensions and flip state.
 */
function initOverlay() {
    const boardEl = document.querySelector("wc-chess-board, chess-board, cg-board");
    if (!boardEl) return;

    if (!overlayCanvas) {
        overlayCanvas = document.createElement("canvas");
        overlayCanvas.style.position = "absolute";
        overlayCanvas.style.top = "0";
        overlayCanvas.style.left = "0";
        overlayCanvas.style.width = "100%";
        overlayCanvas.style.height = "100%";
        overlayCanvas.style.pointerEvents = "none";
        overlayCanvas.style.zIndex = "9999";
        boardEl.appendChild(overlayCanvas);
    }

    const isFlipped = boardEl.classList.contains("flipped") || boardEl.classList.contains("orientation-black");
    const boardWidth = boardEl.clientWidth;
    const boardHeight = boardEl.clientHeight;

    if (overlayCanvas.width !== boardWidth || overlayCanvas.height !== boardHeight || flipBoard !== isFlipped) {
        flipBoard = isFlipped;
        overlayCanvas.width = boardWidth;
        overlayCanvas.height = boardHeight;
    }
}

/**
 * Clears the overlay canvas.
 */
function clearOverlay() {
    if (overlayCanvas) {
        overlayCanvas
            .getContext("2d")
            .clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

/**
 * Draws an arrow on the overlay canvas from one square index to another.
 * @param {number} fromIdx - Source square index (0-63, rank-major).
 * @param {number} toIdx   - Target square index (0-63, rank-major).
 * @param {string} color   - CSS color string (rgba recommended).
 */
function drawArrow(fromIdx, toIdx, color) {
    initOverlay();
    if (!overlayCanvas) return;

    const ctx = overlayCanvas.getContext("2d");
    const sqSize = overlayCanvas.width / 8;

    /**
     * Converts a square index to canvas centre coordinates.
     * @param {number} idx
     * @returns {{x: number, y: number}}
     */
    const getXY = (idx) => {
        let file = idx % 8;
        let visualRank = 7 - Math.floor(idx / 8);
        if (flipBoard) {
            file = 7 - file;
            visualRank = 7 - visualRank;
        }
        return {
            x: (file + 0.5) * sqSize,
            y: (visualRank + 0.5) * sqSize,
        };
    };

    const start = getXY(fromIdx);
    const end = getXY(toIdx);
    const headLen = sqSize * 0.4;
    const angle = Math.atan2(end.y - start.y, end.x - start.x);

    // Arrow shaft
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = sqSize * 0.15;
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
        end.x - headLen * Math.cos(angle - Math.PI / 6),
        end.y - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        end.x - headLen * Math.cos(angle + Math.PI / 6),
        end.y - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.lineTo(end.x, end.y);
    ctx.fillStyle = color;
    ctx.fill();
}

// ---------------------------------------------------------------------------
// Move Execution
// ---------------------------------------------------------------------------

/**
 * Dispatches a sequence of mouse/pointer events at a given viewport position.
 * Used to simulate a click on a chess board square.
 * @param {number} clientX
 * @param {number} clientY
 */
function simulateClick(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return;

    const eventArgs = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 1,
    };

    // Fire the full sequence that the browser would normally fire for a real click.
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter",
                         "pointermove", "mousemove",
                         "pointerdown", "mousedown",
                         "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(
            type.startsWith("pointer")
                ? new PointerEvent(type, { ...eventArgs, pointerId: 1, isPrimary: true })
                : new MouseEvent(type, eventArgs)
        );
    }
}

/**
 * Selects a promotion piece in the promotion modal.
 * Tries Chess.com and generic modal approaches.
 * Defaults to queen promotion if nothing else is found.
 * @param {string} promotionChar - One of 'q', 'r', 'b', 'n'
 */
function selectPromotion(promotionChar) {
    // Chess.com promotion modal
    const chessComModal = document.querySelector(
        ".promotion-piece-" + promotionChar +
        ", [data-promotion-piece=\"" + promotionChar + "\"]"
    );
    if (chessComModal) {
        chessComModal.click();
        return;
    }

    // Lichess promotion modal
    const lichessModal = document.querySelector(
        "cg-board .promotion-choice ." + promotionChar +
        ", .lichess-promotion ." + promotionChar
    );
    if (lichessModal) {
        lichessModal.click();
        return;
    }

    // Generic fallback: click the first promotion square (usually queen)
    const genericModal = document.querySelector(
        ".promotion-choice piece, .promotion-piece"
    );
    if (genericModal) genericModal.click();
}

/**
 * Plays a move on the board by simulating the mouse clicks a user would make.
 * Supports Chess.com (wc-chess-board / chess-board) and Lichess (cg-board).
 *
 * @param {string} uci - UCI move string, e.g. "e2e4" or "e7e8q" (promotion).
 * @returns {boolean} True if the move was attempted, false if the board wasn't found.
 */
function playMove(uci) {
    if (!uci || uci.length < 4) return false;

    const fromFile = uci.charCodeAt(0) - 97; // 'a'=0 … 'h'=7
    const fromRank = uci.charCodeAt(1) - 49; // '1'=0 … '8'=7
    const toFile   = uci.charCodeAt(2) - 97;
    const toRank   = uci.charCodeAt(3) - 49;
    const promotionChar = uci.length === 5 ? uci[4] : null; // 'q','r','b','n'

    // Validate coordinates
    if (
        fromFile < 0 || fromFile > 7 || fromRank < 0 || fromRank > 7 ||
        toFile   < 0 || toFile   > 7 || toRank   < 0 || toRank   > 7
    ) {
        console.warn("[Content] playMove: invalid UCI coordinates:", uci);
        return false;
    }

    const boardEl = document.querySelector(
        "wc-chess-board, chess-board, cg-board"
    );
    if (!boardEl) {
        console.warn("[Content] playMove: board element not found");
        return false;
    }

    const rect = boardEl.getBoundingClientRect();
    const sqSize = rect.width / 8;

    /**
     * Converts logical file/rank to viewport coordinates of the square centre.
     * Accounts for board flip.
     * @param {number} file - 0-7 (a=0)
     * @param {number} rank - 0-7 (rank1=0)
     * @returns {{x: number, y: number}}
     */
    function squareToViewport(file, rank) {
        const visualFile = flipBoard ? 7 - file : file;
        const visualRank = flipBoard ? rank : 7 - rank;
        return {
            x: rect.left + (visualFile + 0.5) * sqSize,
            y: rect.top  + (visualRank + 0.5) * sqSize,
        };
    }

    const from = squareToViewport(fromFile, fromRank);
    const to   = squareToViewport(toFile, toRank);

    // Step 1: Click source square (piece selection) with reaction delay
    const reactionDelay = 200 + Math.floor(Math.random() * 300);
    setTimeout(() => {
        const boardElNow = document.querySelector("wc-chess-board, chess-board, cg-board");
        if (!boardElNow) return;
        const rectNow = boardElNow.getBoundingClientRect();
        const sqSizeNow = rectNow.width / 8;
        const fromNow = {
            x: rectNow.left + ((flipBoard ? 7 - fromFile : fromFile) + 0.5) * sqSizeNow,
            y: rectNow.top + ((flipBoard ? fromRank : 7 - fromRank) + 0.5) * sqSizeNow
        };
        simulateClick(fromNow.x, fromNow.y);

        // Step 2: Click destination square after a short delay (natural timing with jitter)
        const delay = 150 + Math.floor(Math.random() * 200);
        setTimeout(() => {
            const boardElFinal = document.querySelector("wc-chess-board, chess-board, cg-board");
            if (!boardElFinal) return;
            const rectFinal = boardElFinal.getBoundingClientRect();
            const sqSizeFinal = rectFinal.width / 8;
            const toFinal = {
                x: rectFinal.left + ((flipBoard ? 7 - toFile : toFile) + 0.5) * sqSizeFinal,
                y: rectFinal.top + ((flipBoard ? toRank : 7 - toRank) + 0.5) * sqSizeFinal
            };
            simulateClick(toFinal.x, toFinal.y);

            // Step 3: Handle promotion modal if needed
            if (promotionChar) {
                const promoDelay = 120 + Math.floor(Math.random() * 60);
                setTimeout(() => selectPromotion(promotionChar), promoDelay);
            }
        }, delay);
    }, reactionDelay);

    return true;
}

// ---------------------------------------------------------------------------
// Board Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the current board state from the DOM and returns a FEN string,
 * or null if the board or both kings cannot be found.
 * @returns {string|null}
 */
function parseBoard() {
    const boardEl = document.querySelector("wc-chess-board, chess-board, cg-board, .cg-board, .board");
    if (!boardEl) return null;

    flipBoard = boardEl.classList.contains("flipped") || boardEl.classList.contains("orientation-black");
    const pieces = boardEl.querySelectorAll(".piece");
    const boardWidth = boardEl.clientWidth;

    const board = new Array(64).fill(null);
    let whiteKing = false;
    let blackKing = false;

    pieces.forEach((p) => {
        let pieceClass = "";
        let squareClass = "";
        p.classList.forEach((cls) => {
            if (/^[wb][prnbqk]$/.test(cls)) pieceClass = cls;
            if (/^square-[a-h1-8][1-8]$/.test(cls)) squareClass = cls;
        });

        let char = null;
        if (pieceClass) {
            char = pieceClass[1];
            if (pieceClass[0] === "w") char = char.toUpperCase();
        } else {
            const isWhite = p.classList.contains("white");
            if (p.classList.contains("pawn")) char = isWhite ? "P" : "p";
            else if (p.classList.contains("rook")) char = isWhite ? "R" : "r";
            else if (p.classList.contains("knight")) char = isWhite ? "N" : "n";
            else if (p.classList.contains("bishop")) char = isWhite ? "B" : "b";
            else if (p.classList.contains("queen")) char = isWhite ? "Q" : "q";
            else if (p.classList.contains("king")) char = isWhite ? "K" : "k";
        }

        if (!char) return;

        // Ignore pieces that are fading out or hidden (e.g., captured pieces during animation)
        const computedStyle = window.getComputedStyle(p);
        if (parseFloat(computedStyle.opacity) < 1 || computedStyle.display === "none") return;
        if (p.classList.contains("fade-out")) return;
        // Ignore hints or highlights if any slipped in
        if (p.classList.contains("highlight") || p.classList.contains("hint")) return;

        let file = -1;
        let rank = -1;

        if (squareClass) {
            // Format: "square-e4" or "square-14"
            const col = squareClass[7];
            if (isNaN(parseInt(col, 10))) {
                file = col.charCodeAt(0) - 97;
                rank = parseInt(squareClass[8], 10) - 1;
            } else {
                file = parseInt(col, 10) - 1;
                rank = parseInt(squareClass[8], 10) - 1;
            }
        } else if (p.style && p.style.transform) {
            // Fallback: parse translate(x, y) from inline style
            const match = p.style.transform.match(
                /translate\((.*?)[px%]+,\s*(.*?)[px%]+\)/
            );
            if (match) {
                const x = parseFloat(match[1]);
                const y = parseFloat(match[2]);
                const sqW = p.style.transform.includes("px")
                    ? boardWidth / 8
                    : 100;
                file = Math.round(x / sqW);
                rank = 7 - Math.round(y / sqW);
                if (flipBoard) {
                    file = 7 - file;
                    rank = 7 - rank;
                }
            }
        }

        if (file < 0 || file > 7 || rank < 0 || rank > 7) return;

        board[rank * 8 + file] = char;

        if (char === "K") whiteKing = true;
        if (char === "k") blackKing = true;
    });

    if (!whiteKing || !blackKing) return null;

    // Build FEN piece placement
    let fenPlacement = "";
    for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
            const p = board[r * 8 + f];
            if (p) {
                if (empty > 0) fenPlacement += empty;
                empty = 0;
                fenPlacement += p;
            } else {
                empty++;
            }
        }
        if (empty > 0) fenPlacement += empty;
        if (r > 0) fenPlacement += "/";
    }

    // Determine side to move from move list
    let stm = "w";
    const moveNodes = document.querySelectorAll(
        "wc-move-list .node:not(.icon-font-chess), .move-list-item .node, l4x rm, l4x u32"
    );

    let maxPly = 0;
    document.querySelectorAll("[data-ply]").forEach((el) => {
        const p = parseInt(el.getAttribute("data-ply"), 10);
        if (!isNaN(p) && p > maxPly) maxPly = p;
    });

    if (maxPly > 0) {
        stm = maxPly % 2 === 1 ? "b" : "w";
    } else if (moveNodes && moveNodes.length > 0) {
        stm = moveNodes.length % 2 === 1 ? "b" : "w";
    }

    // Determine castling rights by checking if kings or rooks have moved
    let wKingMoved = false;
    let bKingMoved = false;
    if (moveNodes && moveNodes.length > 0) {
        moveNodes.forEach((node, index) => {
            const text = node.innerText.trim();
            const isWhite = index % 2 === 0;
            if (isWhite && (text.startsWith("K") || text.startsWith("O-O"))) {
                wKingMoved = true;
            } else if (
                !isWhite &&
                (text.startsWith("K") || text.startsWith("O-O"))
            ) {
                bKingMoved = true;
            }
        });
    }

    let castling = "";
    if (!wKingMoved && board[4] === "K") {
        if (board[7] === "R") castling += "K";
        if (board[0] === "R") castling += "Q";
    }
    if (!bKingMoved && board[60] === "k") {
        if (board[63] === "r") castling += "k";
        if (board[56] === "r") castling += "q";
    }
    if (castling === "") castling = "-";

    return `${fenPlacement} ${stm} ${castling} - 0 1`;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Reads the active player's remaining clock time from the DOM.
 * @returns {number|null} Seconds remaining, or null if not found.
 */
function getMyTimeLeft() {
    let myClock = document.querySelector(
        ".clock-bottom .clock-time-monospaced, .clock-bottom.clock-component, [data-cy='clock-bottom'] .clock-time-monospaced, .clock-bottom, #board-layout-player-bottom .clock-time-monospaced, .rclock-bottom .time, .cg-clock-bottom"
    );
    if (!myClock) {
        // Fallback: if multiple clocks exist in DOM, we are always the bottom (last) clock!
        const allClocks = document.querySelectorAll(".clock-component .clock-time-monospaced, .clock-component, .clock-time-monospaced");
        if (allClocks && allClocks.length >= 2) {
            myClock = allClocks[allClocks.length - 1];
        } else if (allClocks && allClocks.length === 1) {
            myClock = allClocks[0];
        }
    }
    if (!myClock) return null;

    const text = myClock.innerText.trim();
    try {
        if (text.includes(":")) {
            const parts = text.split(":");
            return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
        }
        return parseFloat(text);
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Position Processing
// ---------------------------------------------------------------------------

/**
 * Draws best-move arrows from a list of principal variation lines.
 * @param {string[][]} pvLines    - Array of PV arrays (each PV is a move list).
 * @param {boolean}   isMyTurn   - True if the arrows are for our move.
 */
function renderArrows(pvLines, isMyTurn) {
    clearOverlay();

    // Draw lower-priority lines first so the primary line renders on top.
    for (let lineIdx = pvLines.length - 1; lineIdx >= 0; lineIdx--) {
        const pv = pvLines[lineIdx];

        let colors;
        if (isMyTurn) {
            colors = [
                "rgba(46, 204, 113, 0.95)", // Green  – best move
                "rgba(231, 76, 60, 0.85)",  // Red    – opponent reply
                "rgba(52, 152, 219, 0.75)", // Blue   – our second move
            ];
        } else {
            const baseAlpha =
                lineIdx === 0 ? 0.75 : lineIdx === 1 ? 0.45 : 0.25;
            colors = [
                `rgba(149, 165, 166, ${baseAlpha})`,
                `rgba(149, 165, 166, ${(baseAlpha * 0.7).toFixed(2)})`,
                `rgba(149, 165, 166, ${(baseAlpha * 0.5).toFixed(2)})`,
            ];
        }

        const maxMoves = Math.min(pv.length, 3);
        // Draw in reverse so earlier moves render on top.
        for (let i = maxMoves - 1; i >= 0; i--) {
            let move = pv[i];
            if (typeof move === "string") move = move.replace(/['"]/g, "");
            if (!move || move.length < 4) continue;

            const f  = move.charCodeAt(0) - 97;
            const r  = move.charCodeAt(1) - 49;
            const tf = move.charCodeAt(2) - 97;
            const tr = move.charCodeAt(3) - 49;

            if (
                f >= 0 && f <= 7 && r >= 0 && r <= 7 &&
                tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7
            ) {
                drawArrow(r * 8 + f, tr * 8 + tf, colors[i]);
            }
        }
    }
}

/**
 * Main entry point. Called when a position change is detected.
 * Sends the FEN to the background script and renders the analysis arrows.
 * On a ponder cache hit for our turn, also plays the move automatically.
 * @param {string|null} networkFen - FEN from the WebSocket interceptor, or null to parse from DOM.
 */
function processPosition(networkFen = null) {
    const fen = networkFen || parseBoard();
    if (!fen || fen === currentFEN) return;

    currentFEN = fen;
    clearOverlay();

    const timeLeft = getMyTimeLeft();
    const stm = fen.split(" ")[1];
    const myColor = flipBoard ? "b" : "w";
    const isMyTurn = stm === myColor;
    const normFen = normalizeFen(fen);

    // Reset FEN history on a new game.
    if (fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w")) {
        fenHistory = [];
    }
    fenHistory.push(normFen);
    if (fenHistory.length > 50) {
        fenHistory.shift(); // Limit history to prevent payload bloat
    }
    const historyStr = fenHistory.join("|");

    // Check if a ponder result is already cached for this position.
    // If so, play the move instantly and show the arrow.
    if (isMyTurn && ponderCache[normFen]) {
        const cached = ponderCache[normFen];
        ponderCache = {};

        if (cached.bestMove) {
            // Show the arrow first, then conditionally play the move
            if (cached.pv && cached.pv.length > 0) {
                renderArrows([cached.pv], true);
            }
            if (currentEngineMode === "autoplay") {
                const delay = 150 + Math.floor(Math.random() * 200);
                setTimeout(() => playMove(cached.bestMove), delay);
            }
        }
        return;
    }
    ponderCache = {};

    chrome.runtime.sendMessage(
        {
            type: "NEW_POSITION",
            fen,
            timeLeft,
            isMyTurn,
            history: historyStr,
        },
        (response) => {
            if (chrome.runtime.lastError) {
                console.error(
                    "[Content] Messaging error:",
                    chrome.runtime.lastError.message
                );
                return;
            }
            if (!response) return;

            // Cache ponder result for our next turn.
            if (response.cachedForFen) {
                const norm = normalizeFen(response.cachedForFen);
                ponderCache[norm] = response;
            }

            // Play the move if it's our turn and in autoplay mode.
            if (isMyTurn && response.bestMove && currentEngineMode === "autoplay") {
                playMove(response.bestMove);
            }

            // Collect PV lines to render as arrows.
            let pvLines = [];
            if (!isMyTurn && response.multiPv && response.multiPv.length > 0) {
                pvLines = response.multiPv
                    .map((m) => m.pv)
                    .filter((p) => p && p.length > 0);
            } else if (isMyTurn && response.pv) {
                pvLines = [response.pv];
            }

            if (pvLines.length > 0) {
                renderArrows(pvLines, isMyTurn);
            }
        }
    );
}

// ---------------------------------------------------------------------------
// MutationObserver – watch for DOM changes (chess.com)
// ---------------------------------------------------------------------------

let activeObserver = null;
let observedElements = [];
let isProcessing = false;
let lastProcessTime = 0;

function setupObserver() {
    const board = document.querySelector("wc-chess-board, .board, #board-single");
    const moveList = document.querySelector("wc-move-list, .move-list-container, .vertical-move-list");
    
    let targets = [];
    if (board) targets.push(board);
    if (moveList) targets.push(moveList);
    if (targets.length === 0) targets.push(document.body);

    // Skip if observing the exact same elements
    if (observedElements.length === targets.length && observedElements.every((el, i) => el === targets[i])) {
        return;
    }

    if (activeObserver) activeObserver.disconnect();
    
    activeObserver = new MutationObserver((mutations) => {
        // Optimization: Ignore pure style/class mutations (piece animations) if structural changes are rare
        // but since pieces can move via style transform, we must be careful.
        // We use a leading-edge + trailing-edge approach to prevent freeze.
        const now = Date.now();
        if (now - lastProcessTime > 100 && !isProcessing) {
             isProcessing = true;
             lastProcessTime = now;
             setTimeout(() => {
                 processPosition();
                 isProcessing = false;
             }, 0);
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
             if (Date.now() - lastProcessTime > 100 && !isProcessing) {
                 isProcessing = true;
                 lastProcessTime = Date.now();
                 setTimeout(() => {
                     processPosition();
                     isProcessing = false;
                 }, 0);
             }
        }, 400);
    });

    for (const target of targets) {
        if (target === document.body) {
            activeObserver.observe(target, { childList: true });
        } else {
            // Need attributes to detect piece sliding/class changes
            activeObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        }
    }
    
    observedElements = targets;
}

setupObserver();
// Periodically re-check and attach to board if navigation occurred or SPA page updated
setInterval(() => {
    setupObserver();
    processPosition();
}, 2500);

// Initial analysis after the board has had time to render.
setTimeout(() => processPosition(), 1000);

// Force re-evaluation on demand (triggered by popup when engine is started).
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "FORCE_EVALUATE") {
        currentFEN = "";
        processPosition();
    }
});

// ---------------------------------------------------------------------------
// WebSocket Interceptor – listen for FEN data from inject.js (chess.com live)
// ---------------------------------------------------------------------------

window.addEventListener("message", (event) => {
    if (
        event.source !== window ||
        !event.data ||
        event.data.type !== "CHESS_WS_MESSAGE"
    ) {
        return;
    }

    try {
        const payload = event.data.payload;
        // Match a fully-qualified FEN string (all 6 fields).
        const fenRegex =
            /([rnbqkbnrRNBQKBNR1-8]+\/){7}[rnbqkbnrRNBQKBNR1-8]+ [wb] (K?Q?k?q?|-) ([a-h][36]|-) \d+ \d+/;
        const match = payload.match(fenRegex);
        if (match && match[0]) {
            processPosition(match[0]);
        }
    } catch (e) {
        console.error("[Content] WebSocket message parse error:", e);
    }
});

// ---------------------------------------------------------------------------
// Pondering Background Listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PONDER_RESULT") {
        const response = msg.data;
        if (response && response.cachedForFen) {
            const norm = normalizeFen(response.cachedForFen);
            ponderCache[norm] = response;
            
            // (playMove is not called here; processPosition will pick it up on our turn)

            // Render arrows
            let pvLines = [];
            if (response.multiPv && response.multiPv.length > 0) {
                pvLines = response.multiPv
                    .map((m) => m.pv)
                    .filter((p) => p && p.length > 0);
            } else if (response.pv) {
                pvLines = [response.pv];
            }
            if (pvLines.length > 0) {
                renderArrows(pvLines, false);
            }
        }
    }
});

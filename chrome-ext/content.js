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
    const boardEl = document.querySelector("wc-chess-board, chess-board");
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

    flipBoard = boardEl.classList.contains("flipped");
    overlayCanvas.width = boardEl.clientWidth;
    overlayCanvas.height = boardEl.clientHeight;
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
// Board Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the current board state from the DOM and returns a FEN string,
 * or null if the board or both kings cannot be found.
 * @returns {string|null}
 */
function parseBoard() {
    const boardEl = document.querySelector("wc-chess-board, chess-board");
    if (!boardEl) return null;

    flipBoard = boardEl.classList.contains("flipped");
    const pieces = boardEl.querySelectorAll(".piece");

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

        if (!pieceClass) return;

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
                    ? boardEl.clientWidth / 8
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

        let char = pieceClass[1];
        if (pieceClass[0] === "w") char = char.toUpperCase();
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
        "wc-move-list .node:not(.icon-font-chess), .move-list-item .node"
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
    const activeClock = document.querySelector(
        ".clock-component.clock-active, .clock-time-monospaced"
    );
    if (!activeClock) return null;

    const text = activeClock.innerText.trim();
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
    const historyStr = fenHistory.join("|");

    // Check if a ponder result is already cached for this position.
    if (isMyTurn && ponderCache[normFen]) {
        const cached = ponderCache[normFen];
        ponderCache = {};
        if (cached.pv && cached.pv.length > 0) {
            renderArrows([cached.pv], true);
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

            // Collect PV lines to render.
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

const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processPosition, 400);
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial analysis after the board has had time to render.
setTimeout(processPosition, 1000);

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

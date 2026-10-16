const LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVEL.DEBUG;
const CTX = 'Content';
const STYLES = {
    DEBUG: 'color:#7f8c8d;font-weight:normal',
    INFO:  'color:#27ae60;font-weight:bold',
    WARN:  'color:#f39c12;font-weight:bold',
    ERROR: 'color:#e74c3c;font-weight:bold',
};
const BADGE = { DEBUG: '🔍', INFO: '✅', WARN: '⚠️', ERROR: '🔴' };

function _log(level, module, message, data) {
    if (LEVEL[level] < MIN_LEVEL) return;
    const ts = new Date().toISOString().slice(11, 23);
    const header = `%c${BADGE[level]} [Aether·${CTX}][${ts}][${module}] ${message}`;

    if (data !== undefined) {
        console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](header, STYLES[level], data);
    } else {
        console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](header, STYLES[level]);
    }
}

const _timers = {};

const log = {
    debug: (module, msg, data) => _log('DEBUG', module, msg, data),
    info:  (module, msg, data) => _log('INFO',  module, msg, data),
    warn:  (module, msg, data) => _log('WARN',  module, msg, data),
    error: (module, msg, data) => _log('ERROR', module, msg, data),
    time: (label) => { _timers[label] = performance.now(); },
    timeEnd: (label) => {
        const elapsed = _timers[label] !== undefined ? (performance.now() - _timers[label]).toFixed(1) : '?';
        delete _timers[label];
        _log('DEBUG', 'Timer', `${label} → ${elapsed}ms`);
        return parseFloat(elapsed);
    },
    engineResult: (result, label = '') => {
        if (!result) { _log('ERROR', 'Engine', `${label} null result`); return; }
        const { bestMove, score, depth, nodes, timeMs } = result;
        const nps = timeMs > 0 ? Math.round((nodes || 0) / (timeMs / 1000)).toLocaleString() : '?';
        _log('INFO', 'Engine', `${label}move=${bestMove ?? 'null'} score=${score ?? '?'}cp depth=${depth ?? '?'} nodes=${(nodes||0).toLocaleString()} nps=${nps} time=${timeMs ?? '?'}ms`);
    }
};

log.info('Content', 'Logger initialized');

const AETHER_VERSION = "2.4.9";

/** @type {string} The last FEN position that was sent for analysis. */
let currentFEN = "";

/** @type {boolean} True while a search request is in-flight to prevent duplicate message storms. */
let isSearchInFlight = false;

/** Maximum number of prior positions kept for repetition detection. */
const MAX_FEN_HISTORY = 50;

/** @type {string[]} Normalized FEN history for repetition detection. */
let fenHistory = [];

/** Persistent board tracking for exact en-passant, 50-move clock and castling memory */
let prevBoardArray = null;
let halfmoveClock = 0;
let persistentCastling = {
    wKingMoved: false,
    bKingMoved: false,
    wRookAMoved: false,
    wRookHMoved: false,
    bRookAMoved: false,
    bRookHMoved: false,
};

/** Live debug telemetry and HUD state */
let lastDeterminedStm = "w";
let recentDebugLogs = [];
let lastExecutedMove = null;
let lastEngineStats = null;

function addDebugLog(msg) {
    const time = new Date().toTimeString().slice(0, 8);
    recentDebugLogs.unshift(`[${time}] ${msg}`);
    if (recentDebugLogs.length > 5) recentDebugLogs.pop();
    updateDebugHUD();
}

function renderDebugHUD() {
    if (!document.body) return;
    let hud = document.getElementById("aether-debug-hud");
    if (!hud) {
        hud = document.createElement("div");
        hud.id = "aether-debug-hud";
        hud.style.cssText = `
            position: fixed;
            bottom: 16px;
            right: 16px;
            width: 310px;
            background: rgba(15, 23, 42, 0.94);
            backdrop-filter: blur(8px);
            border: 1px solid rgba(46, 204, 113, 0.5);
            border-radius: 10px;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
            font-size: 11px;
            z-index: 2147483647;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.6);
            overflow: hidden;
            transition: all 0.2s ease;
        `;
        document.body.appendChild(hud);
    }

    const myColor = flipBoard ? "b" : "w";
    const isMyTurn = lastDeterminedStm === myColor;
    const isCollapsed = hud.getAttribute("data-collapsed") === "true";

    if (isCollapsed) {
        hud.innerHTML = `
            <div style="padding: 6px 12px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; background: #0f172a;" id="aether-hud-header">
                <span style="font-weight: bold; color: #2ecc71;">⚡ Aether v${AETHER_VERSION}</span>
                <span style="background: ${isMyTurn ? '#22c55e' : '#64748b'}; color: #fff; padding: 2px 6px; border-radius: 4px; font-weight: bold;">
                    ${isMyTurn ? "MY TURN" : "WAITING"}
                </span>
                <button id="aether-hud-toggle" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:14px;">➕</button>
            </div>
        `;
    } else {
        hud.innerHTML = `
            <div style="padding: 8px 12px; background: #1e293b; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: space-between;" id="aether-hud-header">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="color: #2ecc71; font-weight: bold; font-size: 12px;">⚡ Aether Chess</span>
                    <span style="background: rgba(46,204,113,0.15); color: #2ecc71; padding: 1px 5px; border-radius: 3px; font-size: 10px;">v${AETHER_VERSION}</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <span style="color: #94a3b8; font-size: 10px;">${(currentEngineMode || 'autoplay').toUpperCase()}</span>
                    <button id="aether-hud-toggle" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:12px;" title="Minimize">➖</button>
                </div>
            </div>
            <div style="padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
                <!-- Status Row -->
                <div style="display: flex; gap: 6px;">
                    <div style="flex: 1; background: ${isMyTurn ? 'rgba(34, 197, 94, 0.18)' : 'rgba(100, 116, 139, 0.12)'}; border: 1px solid ${isMyTurn ? '#22c55e' : '#475569'}; border-radius: 6px; padding: 6px 8px; text-align: center;">
                        <div style="color: #94a3b8; font-size: 9px; text-transform: uppercase;">Turn Status</div>
                        <div style="color: ${isMyTurn ? '#4ade80' : '#cbd5e1'}; font-weight: bold; font-size: 12px; margin-top: 2px;">
                            ${isMyTurn ? "🟢 MY TURN" : "⏳ OPPONENT"}
                        </div>
                    </div>
                    <div style="flex: 1; background: rgba(30, 41, 59, 0.6); border: 1px solid #334155; border-radius: 6px; padding: 6px 8px; text-align: center;">
                        <div style="color: #94a3b8; font-size: 9px; text-transform: uppercase;">Color / STM</div>
                        <div style="color: #f8fafc; font-weight: bold; font-size: 12px; margin-top: 2px;">
                            ${myColor === 'w' ? 'White' : 'Black'} / ${lastDeterminedStm.toUpperCase()}
                        </div>
                    </div>
                </div>

                <!-- Engine Stats -->
                <div style="background: rgba(30, 41, 59, 0.4); border-radius: 6px; padding: 6px 8px; font-size: 10px; color: #cbd5e1;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                        <span>Eval: <strong style="color: #38bdf8;">${lastEngineStats ? (lastEngineStats.score > 0 ? '+' : '') + (lastEngineStats.score/100).toFixed(2) : '-'}</strong></span>
                        <span>Depth: <strong>${lastEngineStats?.depth || '-'}</strong></span>
                        <span>Nodes: <strong>${lastEngineStats?.nodes ? (lastEngineStats.nodes > 1000 ? Math.round(lastEngineStats.nodes/1000) + 'k' : lastEngineStats.nodes) : '-'}</strong></span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span>Best: <strong style="color: #4ade80;">${lastEngineStats?.bestMove || '-'}</strong></span>
                        <span>Played: <strong style="color: #facc15;">${lastExecutedMove || '-'}</strong></span>
                    </div>
                </div>

                <!-- Recent Activity Feed -->
                <div style="background: #090d16; border-radius: 4px; padding: 6px; font-family: monospace; font-size: 9px; color: #94a3b8; max-height: 55px; overflow-y: hidden;">
                    ${recentDebugLogs.map(l => `<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${l}</div>`).join('') || '<div>Waiting for moves...</div>'}
                </div>

                <!-- Action Buttons -->
                <div style="display: flex; gap: 6px; margin-top: 2px;">
                    <button id="aether-force-btn" style="flex: 1; background: #2563eb; color: white; border: none; border-radius: 4px; padding: 5px; cursor: pointer; font-weight: bold; font-size: 10px;">
                        ▶ Force Move
                    </button>
                    <button id="aether-copy-btn" style="flex: 1; background: #334155; color: #f1f5f9; border: none; border-radius: 4px; padding: 5px; cursor: pointer; font-weight: bold; font-size: 10px;">
                        📋 Copy Debug
                    </button>
                </div>
            </div>
        `;
    }

    const toggleBtn = hud.querySelector("#aether-hud-toggle");
    if (toggleBtn) {
        toggleBtn.onclick = () => {
            const current = hud.getAttribute("data-collapsed") === "true";
            hud.setAttribute("data-collapsed", current ? "false" : "true");
            renderDebugHUD();
        };
    }
    const forceBtn = hud.querySelector("#aether-force-btn");
    if (forceBtn) {
        forceBtn.onclick = () => {
            addDebugLog("User triggered [Force Move]");
            isSearchInFlight = false;
            currentFEN = "";
            processPosition();
        };
    }
    const copyBtn = hud.querySelector("#aether-copy-btn");
    if (copyBtn) {
        copyBtn.onclick = () => {
            const report = {
                version: AETHER_VERSION,
                currentFEN,
                myColor,
                lastDeterminedStm,
                isMyTurn,
                flipBoard,
                engineMode: currentEngineMode,
                lastEngineStats,
                lastExecutedMove,
                recentLogs: recentDebugLogs,
                boardPiecesCount: prevBoardArray ? prevBoardArray.filter(Boolean).length : null,
                domBoardFound: !!document.querySelector("wc-chess-board, chess-board"),
            };
            navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
                copyBtn.innerText = "✅ Copied!";
                setTimeout(() => { if (copyBtn) copyBtn.innerText = "📋 Copy Debug"; }, 1500);
            });
        };
    }
}

function updateDebugHUD() {
    try {
        renderDebugHUD();
    } catch (_) {}
}

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

/** @type {number|null} Polling interval ID. */
let pollInterval = null;

/** @type {boolean} Flag indicating if extension context has been invalidated (e.g. extension reload). */
let isOrphaned = false;

function isContextValid() {
    if (isOrphaned) return false;
    try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
            cleanupOrphanedScript();
            return false;
        }
        return true;
    } catch (_) {
        cleanupOrphanedScript();
        return false;
    }
}

function cleanupOrphanedScript() {
    if (isOrphaned) return;
    isOrphaned = true;
    if (activeObserver) {
        try { activeObserver.disconnect(); } catch (_) {}
        activeObserver = null;
    }
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

function safeStorageSet(data) {
    if (!isContextValid()) return;
    try {
        chrome.storage.local.set(data, () => {
            if (chrome.runtime?.lastError) {
                const msg = chrome.runtime.lastError.message || "";
                if (msg.includes("context invalidated")) {
                    cleanupOrphanedScript();
                }
            }
        });
    } catch (e) {
        if (e?.message?.includes("context invalidated") || !isContextValid()) {
            cleanupOrphanedScript();
        }
    }
}

/** @type {string} Cached engine mode. */
let currentEngineMode = "autoplay";

try {
    if (isContextValid()) {
        chrome.storage.local.get("engineMode", (res) => {
            if (!isContextValid()) return;
            if (chrome.runtime?.lastError) return;
            if (res && res.engineMode) currentEngineMode = res.engineMode;
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (!isContextValid()) return;
            if (area === "local" && changes.engineMode) {
                currentEngineMode = changes.engineMode.newValue;
            }
        });
    }
} catch (_) {}

/**
 * Normalizes a FEN string to its first 4 fields
 * (position, side-to-move, castling, en-passant).
 * Must stay consistent with background.js normalizeFen.
 * @param {string} fen
 * @returns {string}
 */
function normalizeFen(fen) {
    if (!fen) return "";
    // Keep every position field that can change legal moves.
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
function findPieceElement(boardEl, file, rank) {
    if (!boardEl) return null;
    const colChar = String.fromCharCode(97 + file);
    const rowChar = String.fromCharCode(49 + rank);
    const sqNum = `${file + 1}${rank + 1}`;
    const sqAlg = `${colChar}${rowChar}`;
    return boardEl.querySelector(
        `.piece.square-${sqNum}, .piece.square-${sqAlg}, ` +
        `[class*="piece"][class*="square-${sqNum}"], [class*="piece"][class*="square-${sqAlg}"], ` +
        `piece.${sqAlg}, .square-${sqNum} .piece, .square-${sqAlg} .piece`
    );
}

function findSquareElement(boardEl, file, rank) {
    if (!boardEl) return null;
    const colChar = String.fromCharCode(97 + file);
    const rowChar = String.fromCharCode(49 + rank);
    const sqNum = `${file + 1}${rank + 1}`;
    const sqAlg = `${colChar}${rowChar}`;
    return boardEl.querySelector(
        `.square-${sqNum}, .square-${sqAlg}, ` +
        `[class*="square-${sqNum}"], [class*="square-${sqAlg}"]`
    );
}

function dispatchPointEvent(el, type, x, y, buttons = 0) {
    if (!el) return;
    const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: buttons,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: buttons > 0 ? 0.5 : 0
    };
    el.dispatchEvent(new PointerEvent(type, init));
    const mType = type.replace("pointer", "mouse");
    el.dispatchEvent(new MouseEvent(mType, init));
}

function executeDOMClickMove(boardEl, fromX, fromY, toX, toY, fromPieceEl, toSquareEl, destPieceEl) {
    const fromTarget = fromPieceEl || boardEl;
    const toTarget = destPieceEl || toSquareEl || boardEl;

    // 1. Click source square / piece
    dispatchPointEvent(fromTarget, "pointerdown", fromX, fromY, 1);
    dispatchPointEvent(fromTarget, "pointerup", fromX, fromY, 0);
    fromTarget.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: fromX,
        clientY: fromY,
        button: 0,
        buttons: 0
    }));

    // 2. Click destination square / piece after short natural interval (40ms)
    setTimeout(() => {
        dispatchPointEvent(toTarget, "pointerdown", toX, toY, 1);
        dispatchPointEvent(toTarget, "pointerup", toX, toY, 0);
        toTarget.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: toX,
            clientY: toY,
            button: 0,
            buttons: 0
        }));
    }, 40);
}

/**
 * Promotion picker UI state.
 * @type {{ resolve: Function|null, el: HTMLElement|null }}
 */
const _promoUI = { resolve: null, el: null };

/**
 * Shows a stylish promotion piece picker overlay and resolves with the chosen piece char.
 * @param {string} engineChar - The engine's preferred piece ('q', 'r', 'b', 'n')
 * @returns {Promise<string>} Resolves with the chosen char
 */
function showPromotionPicker(engineChar) {
    return Promise.resolve(engineChar || "q");
}

/**
 * Selects a promotion piece in the promotion modal.
 * @param {string} promotionChar - One of 'q', 'r', 'b', 'n'
 */
function selectPromotion(promotionChar) {
    if (!promotionChar) promotionChar = 'q';
    
    // Chess.com promotion modal
    const chessComModal = document.querySelector(
        `.promotion-piece.w${promotionChar}, .promotion-piece.b${promotionChar}, .promotion-piece-${promotionChar}, [data-promotion-piece="${promotionChar}"], .promotion-menu .w${promotionChar}, .promotion-menu .b${promotionChar}, .promotion-window .${promotionChar}`
    );
    if (chessComModal) {
        chessComModal.click();
        return;
    }

    // Lichess promotion modal
    const charToName = { 'q': 'queen', 'r': 'rook', 'b': 'bishop', 'n': 'knight' };
    const pName = charToName[promotionChar] || 'queen';
    const lichessModal = document.querySelector(
        `cg-board .promotion-choice .${pName}, .lichess-promotion .${pName}, #promotion-choice piece.${pName}`
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
 * Plays a move on the board by invoking the native game controller (MAIN world)
 * or dispatching resilient mouse/pointer events (DOM fallback).
 * Supports Chess.com (wc-chess-board / chess-board) and Lichess (cg-board).
 *
 * @param {string} uci - UCI move string, e.g. "e2e4" or "e7e8q" (promotion).
 * @returns {boolean} True if the move was attempted, false if the board wasn't found.
 */
function playMove(uci) {
    if (!uci || uci.length < 4) return false;

    const fromFile = uci.charCodeAt(0) - 97;
    const fromRank = uci.charCodeAt(1) - 49;
    const toFile   = uci.charCodeAt(2) - 97;
    const toRank   = uci.charCodeAt(3) - 49;
    const promotionChar = uci.length === 5 ? uci[4] : null;

    if (fromFile < 0 || fromFile > 7 || fromRank < 0 || fromRank > 7 || toFile < 0 || toFile > 7 || toRank < 0 || toRank > 7) return false;

    const boardEl = document.querySelector("wc-chess-board, chess-board, cg-board, .board");
    if (!boardEl) return false;

    const fromSq = uci.slice(0, 2);
    const toSq = uci.slice(2, 4);

    lastExecutedMove = uci;
    addDebugLog(`Autoplay executing: ${uci}`);

    // Fast-path 1: Request native controller execution in MAIN world (Chess.com)
    window.postMessage({
        type: "AETHER_PLAY_MOVE",
        uci,
        from: fromSq,
        to: toSq,
        promotion: promotionChar || undefined
    }, "*");

    // Path 2: Verified Click-to-Move fallback
    // Give native controller 70ms to execute without injecting conflicting mouse events.
    setTimeout(() => {
        const boardElNow = document.querySelector("wc-chess-board, chess-board, cg-board, .board");
        if (!boardElNow) return;

        // If native controller already moved the piece, skip DOM clicks!
        const initialPiece = findPieceElement(boardElNow, fromFile, fromRank);
        if (!initialPiece) {
            addDebugLog(`Piece moved natively: ${uci}`);
            return;
        }

        const rectNow = boardElNow.getBoundingClientRect();
        const sqSizeNow = rectNow.width / 8;
        
        let fromX = rectNow.left + ((flipBoard ? 7 - fromFile : fromFile) + 0.5) * sqSizeNow;
        let fromY = rectNow.top + ((flipBoard ? fromRank : 7 - fromRank) + 0.5) * sqSizeNow;
        let toX   = rectNow.left + ((flipBoard ? 7 - toFile : toFile) + 0.5) * sqSizeNow;
        let toY   = rectNow.top + ((flipBoard ? toRank : 7 - toRank) + 0.5) * sqSizeNow;

        const pieceEl = findPieceElement(boardElNow, fromFile, fromRank);
        if (pieceEl) {
            const pRect = pieceEl.getBoundingClientRect();
            fromX = pRect.left + pRect.width / 2;
            fromY = pRect.top + pRect.height / 2;
        }

        const destSquareEl = findSquareElement(boardElNow, toFile, toRank);
        const destPieceEl = findPieceElement(boardElNow, toFile, toRank);
        if (destPieceEl) {
            const dpRect = destPieceEl.getBoundingClientRect();
            toX = dpRect.left + dpRect.width / 2;
            toY = dpRect.top + dpRect.height / 2;
        } else if (destSquareEl) {
            const dRect = destSquareEl.getBoundingClientRect();
            toX = dRect.left + dRect.width / 2;
            toY = dRect.top + dRect.height / 2;
        }

        addDebugLog(`DOM click-to-move executing: ${uci}`);
        executeDOMClickMove(boardElNow, fromX, fromY, toX, toY, pieceEl, destSquareEl, destPieceEl);

        // Safety watchdog: at 700ms, only if still stuck and still our turn, do a clean re-sync
        setTimeout(() => {
            const checkPieceStillThere = findPieceElement(boardElNow, fromFile, fromRank);
            if (checkPieceStillThere && currentEngineMode === "autoplay" && !isSearchInFlight) {
                const currentStm = lastDeterminedStm;
                const myColor = flipBoard ? "b" : "w";
                if (currentStm === myColor) {
                    addDebugLog(`Move ${uci} unconfirmed after 700ms — resyncing board`);
                    currentFEN = "";
                    processPosition();
                }
            }
        }, 700);

        if (promotionChar) {
            setTimeout(() => selectPromotion(promotionChar), 60);
        }
    }, 70);

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
    try {
        const boardEl = document.querySelector("wc-chess-board, chess-board, cg-board, .cg-board, .board");
        if (!boardEl) return null;

    // Detect board flip (am I playing as black?)
    // Method 1: class-based
    flipBoard = boardEl.classList.contains("flipped") || boardEl.classList.contains("orientation-black");
    // Method 2: chess.com online — look for the player panel at the bottom
    // If current user's username appears in the bottom player section, they are white (not flipped)
    // If in a live game, chess.com sets data-user or data-player-color on the board element
    if (!flipBoard) {
        const boardColor = boardEl.getAttribute("data-player-color") ||
                           boardEl.getAttribute("data-user-color");
        if (boardColor === "black") flipBoard = true;
    }
    // Method 3: Look at the bottom clock player name vs top clock player name
    // chess.com live games: bottom = me. Check if I castled on my right side (queenside) to infer color
    // Fallback: look for "flipped" class on board wrapper
    if (!flipBoard) {
        const wrapper = boardEl.closest(".board-component, .board-layout, wc-chess-board");
        if (wrapper && (wrapper.classList.contains("flipped") || wrapper.getAttribute("board-orientation") === "black")) {
            flipBoard = true;
        }
    }
    const pieces = boardEl.querySelectorAll(".piece, piece, [class*='piece']");
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
        if (parseFloat(computedStyle.opacity) < 0.5 || computedStyle.display === "none") return;
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
                /translate(?:3d)?\(([-.\d]+)[^\d,]*,\s*([-.\d]+)/
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

    // Determine side to move using board highlights, active clocks, and move list
    let maxPly = 0;
    document.querySelectorAll("[data-ply]").forEach((el) => {
        const p = parseInt(el.getAttribute("data-ply"), 10);
        if (!isNaN(p) && p > maxPly) maxPly = p;
    });

    const moveNodes = document.querySelectorAll(
        "wc-move-list .node:not(.icon-font-chess), .move-list-item .node, l4x rm, l4x u32"
    );

    const isStartPos = board[4] === "K" && board[60] === "k" &&
                       board[0] === "R" && board[7] === "R" &&
                       board[56] === "r" && board[63] === "r" &&
                       board[8] === "P" && board[15] === "P" &&
                       board[48] === "p" && board[55] === "p";

    let stm = "w";
    let highlightDetermined = false;

    if (isStartPos) {
        stm = "w";
        highlightDetermined = true;
    }

    // Layer 2: Board State Diffing (Physical piece movement tracking between ticks)
    // Whenever pieces move, the color of the arriving piece reveals who just moved!
    if (!highlightDetermined && prevBoardArray) {
        let arrivedPieces = [];
        let vacatedPieces = [];
        for (let i = 0; i < 64; i++) {
            const curr = board[i];
            const prev = prevBoardArray[i];
            if (curr !== prev) {
                if (curr !== null) arrivedPieces.push(curr);
                if (prev !== null && curr === null) vacatedPieces.push(prev);
            }
        }

        if (arrivedPieces.length > 0) {
            const wArrived = arrivedPieces.filter(p => p >= "A" && p <= "Z").length;
            const bArrived = arrivedPieces.filter(p => p >= "a" && p <= "z").length;
            if (wArrived > 0 && bArrived === 0) {
                // White piece moved -> Black's turn ('b')
                stm = "b";
                highlightDetermined = true;
            } else if (bArrived > 0 && wArrived === 0) {
                // Black piece moved -> White's turn ('w')
                stm = "w";
                highlightDetermined = true;
            } else if (wArrived > 0 && bArrived > 0) {
                // Castling or promotion/capture
                const wVac = vacatedPieces.filter(p => p >= "A" && p <= "Z").length;
                const bVac = vacatedPieces.filter(p => p >= "a" && p <= "z").length;
                stm = wVac > bVac ? "b" : "w";
                highlightDetermined = true;
            }
        } else if (vacatedPieces.length === 0) {
            // Exactly zero board changes -> preserve previous determined turn!
            stm = lastDeterminedStm;
            highlightDetermined = true;
        }
    }

    // Layer 3: Board square highlights (.highlight on Chess.com, square.last-move on Lichess)
    // Whenever a move is completed, the origin square is empty, and the destination square contains the moved piece!
    if (!highlightDetermined) {
        try {
            const hlEls = boardEl.querySelectorAll(".highlight, square.last-move");
            if (hlEls && hlEls.length >= 2) {
                const hlSquares = [];
                hlEls.forEach((el) => {
                    el.classList.forEach((cls) => {
                        let f = -1, r = -1;
                        const m1 = cls.match(/^square-([a-h])([1-8])$/);
                        if (m1) {
                            f = m1[1].charCodeAt(0) - 97;
                            r = parseInt(m1[2], 10) - 1;
                        }
                        const m2 = cls.match(/^square-(\d)(\d)$/);
                        if (m2) {
                            f = parseInt(m2[1], 10) - 1;
                            r = parseInt(m2[2], 10) - 1;
                        }
                        if (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
                            const sq = r * 8 + f;
                            if (!hlSquares.includes(sq)) hlSquares.push(sq);
                        }
                    });
                });

                const emptyHls = hlSquares.filter(sq => board[sq] === null);
                const pieceHls = hlSquares.filter(sq => board[sq] !== null);

                if (emptyHls.length >= 1 && pieceHls.length >= 1) {
                    let movedPiece = null;
                    if (pieceHls.length === 1) {
                        movedPiece = board[pieceHls[0]];
                    } else {
                        // In check situations, king in check is also highlighted.
                        // Filter for non-king piece, or use the piece that isn't the defender king.
                        const nonKings = pieceHls.filter(sq => board[sq] !== "K" && board[sq] !== "k");
                        if (nonKings.length > 0) {
                            movedPiece = board[nonKings[0]];
                        } else {
                            movedPiece = board[pieceHls[0]];
                        }
                    }

                    if (movedPiece) {
                        const isWhiteMoved = movedPiece >= "A" && movedPiece <= "Z";
                        stm = isWhiteMoved ? "b" : "w";
                        highlightDetermined = true;
                    }
                }
            }
        } catch (_) {}
    }

    if (!highlightDetermined) {
        // Fallback 1: Active clock detection (the ticking clock belongs to the player whose turn it is)
        try {
            const bottomClock = document.querySelector(".clock-bottom, [data-cy='clock-bottom'], #board-layout-player-bottom");
            const topClock = document.querySelector(".clock-top, [data-cy='clock-top'], #board-layout-player-top");
            const isBottomActive = bottomClock && (
                bottomClock.classList.contains("clock-player-turn") ||
                bottomClock.classList.contains("running") ||
                bottomClock.querySelector(".clock-player-turn, .running, .clock-running") !== null
            );
            const isTopActive = topClock && (
                topClock.classList.contains("clock-player-turn") ||
                topClock.classList.contains("running") ||
                topClock.querySelector(".clock-player-turn, .running, .clock-running") !== null
            );
            if (isBottomActive && !isTopActive) {
                stm = flipBoard ? "b" : "w";
                highlightDetermined = true;
            } else if (isTopActive && !isBottomActive) {
                stm = flipBoard ? "w" : "b";
                highlightDetermined = true;
            }
        } catch (_) {}
    }

    if (!highlightDetermined) {
        // Fallback 2: Move list / data-ply count
        if (maxPly > 0) {
            stm = maxPly % 2 === 1 ? "b" : "w";
        } else if (moveNodes && moveNodes.length > 0) {
            stm = moveNodes.length % 2 === 1 ? "b" : "w";
        } else {
            const allMoves = document.querySelectorAll(
                "wc-move-list .move, wc-move-list .node, " +
                ".move-list .move, .vertical-move-list .move, " +
                ".rmoves .move, [data-ply]"
            );
            if (allMoves.length > 0) {
                stm = allMoves.length % 2 === 1 ? "b" : "w";
            }
        }
    }

    // Keep maxPly synchronized with physical board stm
    if (stm === "w" && maxPly % 2 === 1) maxPly++;
    if (stm === "b" && maxPly % 2 === 0 && maxPly > 0) maxPly++;

    // Reset persistent tracking ONLY if a new starting position is detected
    if (isStartPos) {
        persistentCastling = {
            wKingMoved: false,
            bKingMoved: false,
            wRookAMoved: false,
            wRookHMoved: false,
            bRookAMoved: false,
            bRookHMoved: false,
        };
        halfmoveClock = 0;
        prevBoardArray = null;
    }

    // Update persistent castling loss: if king or rook is no longer on initial square, right is lost forever
    if (board[4] !== "K") persistentCastling.wKingMoved = true;
    if (board[60] !== "k") persistentCastling.bKingMoved = true;
    if (board[0] !== "R") persistentCastling.wRookAMoved = true;
    if (board[7] !== "R") persistentCastling.wRookHMoved = true;
    if (board[56] !== "r") persistentCastling.bRookAMoved = true;
    if (board[63] !== "r") persistentCastling.bRookHMoved = true;

    // Check move nodes for explicit king / rook moves or castles
    let wKingMoved = persistentCastling.wKingMoved;
    let bKingMoved = persistentCastling.bKingMoved;
    if (moveNodes && moveNodes.length > 0) {
        moveNodes.forEach((node, index) => {
            const text = node.innerText.trim();
            const isWhite = index % 2 === 0;
            if (isWhite) {
                if (text.startsWith("K") || text.startsWith("O-O")) wKingMoved = true;
                if (text.startsWith("Ra") || text.startsWith("R1") || text === "O-O-O") persistentCastling.wRookAMoved = true;
                if (text.startsWith("Rh") || text === "O-O") persistentCastling.wRookHMoved = true;
            } else {
                if (text.startsWith("K") || text.startsWith("O-O")) bKingMoved = true;
                if (text.startsWith("Ra") || text.startsWith("R8") || text === "O-O-O") persistentCastling.bRookAMoved = true;
                if (text.startsWith("Rh") || text === "O-O") persistentCastling.bRookHMoved = true;
            }
        });
    }

    let castling = "";
    if (!wKingMoved && board[4] === "K") {
        if (!persistentCastling.wRookHMoved && board[7] === "R") castling += "K";
        if (!persistentCastling.wRookAMoved && board[0] === "R") castling += "Q";
    }
    if (!bKingMoved && board[60] === "k") {
        if (!persistentCastling.bRookHMoved && board[63] === "r") castling += "k";
        if (!persistentCastling.bRookAMoved && board[56] === "r") castling += "q";
    }
    if (castling === "") castling = "-";

    // En-passant detection from previous board or DOM highlights
    let epSquare = "-";
    if (prevBoardArray) {
        if (stm === "b") {
            // White moved. Check if White pawn jumped from rank 2 (8..15) to rank 4 (24..31)
            for (let f = 0; f < 8; f++) {
                if (prevBoardArray[8 + f] === "P" && board[8 + f] === null && board[24 + f] === "P") {
                    epSquare = String.fromCharCode(97 + f) + "3";
                    break;
                }
            }
        } else {
            // Black moved. Check if Black pawn jumped from rank 7 (48..55) to rank 5 (32..39)
            for (let f = 0; f < 8; f++) {
                if (prevBoardArray[48 + f] === "p" && board[48 + f] === null && board[32 + f] === "p") {
                    epSquare = String.fromCharCode(97 + f) + "6";
                    break;
                }
            }
        }
    }

    if (epSquare === "-") {
        const highlights = document.querySelectorAll(
            "wc-chess-board .highlight, chess-board .highlight, cg-board square.last-move"
        );
        let hlSquares = [];
        highlights.forEach((el) => {
            el.classList.forEach((cls) => {
                const m = cls.match(/^square-([a-h][1-8])$/);
                if (m) hlSquares.push(m[1]);
            });
        });
        if (hlSquares.length >= 2) {
            for (let i = 0; i < hlSquares.length; i++) {
                for (let j = 0; j < hlSquares.length; j++) {
                    if (i === j) continue;
                    const from = hlSquares[i];
                    const to = hlSquares[j];
                    if (stm === "b" && from[0] === to[0] && from[1] === "2" && to[1] === "4") {
                        const sqIdx = (4 - 1) * 8 + (to.charCodeAt(0) - 97);
                        if (board[sqIdx] === "P") epSquare = to[0] + "3";
                    } else if (stm === "w" && from[0] === to[0] && from[1] === "7" && to[1] === "5") {
                        const sqIdx = (5 - 1) * 8 + (to.charCodeAt(0) - 97);
                        if (board[sqIdx] === "p") epSquare = to[0] + "6";
                    }
                }
            }
        }
    }

    // Halfmove clock tracking (pawn move or capture resets to 0)
    if (prevBoardArray) {
        let isCaptureOrPawn = false;
        let prevCount = 0;
        let currCount = 0;
        for (let i = 0; i < 64; i++) {
            if (prevBoardArray[i]) prevCount++;
            if (board[i]) currCount++;
        }
        if (currCount < prevCount) {
            isCaptureOrPawn = true;
        } else {
            for (let i = 0; i < 64; i++) {
                if (board[i] === "P" && prevBoardArray[i] !== "P") isCaptureOrPawn = true;
                if (board[i] === "p" && prevBoardArray[i] !== "p") isCaptureOrPawn = true;
            }
        }
        if (isCaptureOrPawn) {
            halfmoveClock = 0;
        } else {
            halfmoveClock++;
        }
    }

    lastDeterminedStm = stm;
    prevBoardArray = [...board];
    const fullmove = Math.max(1, Math.floor(maxPly / 2) + 1);

    return `${fenPlacement} ${stm} ${castling} ${epSquare} ${halfmoveClock} ${fullmove}`;
    } catch (e) {
        log.error('Board', 'Error parsing board DOM', e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Reads the active player's remaining clock time from the DOM.
 * @returns {number|null} Seconds remaining, or null if not found.
 */

let lastMyTime = null;
let inferredIncMs = 0.0;
let moveCount = 0;

function parseClockText(text) {
    if (!text) return null;
    try {
        const lines = text.split(/[\n\s]+/).map(l => l.trim());
        for (const line of lines) {
            let match = line.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
            if (match) {
                return (parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) * 1000 + (match[3] ? parseInt(match[3], 10) * (match[3].length === 1 ? 100 : 10) : 0);
            }
            match = line.match(/^(\d+)(?:\.(\d+))?$/);
            if (match) {
                const sec = parseInt(match[1], 10);
                if (sec <= 60 || match[2]) {
                    return sec * 1000 + (match[2] ? parseInt(match[2], 10) * (match[2].length === 1 ? 100 : 10) : 0);
                }
            }
        }
        return null;
    } catch (_) { return null; }
}

function getClocks() {
    let myClock = document.querySelector(".clock-bottom .clock-time-monospaced, .clock-bottom.clock-component, [data-cy='clock-bottom'] .clock-time-monospaced, .clock-bottom, #board-layout-player-bottom .clock-time-monospaced, .rclock-bottom .time, .cg-clock-bottom");
    let oppClock = document.querySelector(".clock-top .clock-time-monospaced, .clock-top.clock-component, [data-cy='clock-top'] .clock-time-monospaced, .clock-top, #board-layout-player-top .clock-time-monospaced, .rclock-top .time, .cg-clock-top");
    
    if (!myClock || !oppClock) {
        const allClocks = document.querySelectorAll(".clock-component .clock-time-monospaced, .clock-component, .clock-time-monospaced");
        if (allClocks && allClocks.length >= 2) {
            myClock = allClocks[allClocks.length - 1];
            oppClock = allClocks[0];
        } else if (allClocks && allClocks.length === 1) {
            myClock = allClocks[0];
        }
    }
    
    let my_ms = myClock ? parseClockText(myClock.innerText.trim()) : null;
    let opp_ms = oppClock ? parseClockText(oppClock.innerText.trim()) : null;
    return { my_ms, opp_ms };
}

function getMyTimeLeft() {
    const c = getClocks();
    return c.my_ms ? c.my_ms / 1000.0 : null;
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
    if (!isContextValid()) return;
    if (isSearchInFlight) {
        log.debug('Board', 'Search already in flight, skipping duplicate position processing');
        return;
    }
    try {
        const fen = networkFen || parseBoard();
        if (!fen) {
            // This is completely normal during page load or when waiting for a match.
            // We use debug instead of warn to avoid spamming the console.
            log.info('Board', 'Failed to parse FEN from DOM (parseBoard returned null)');
            return;
        }
        const normFen = normalizeFen(fen);
        if (normFen === currentFEN) return;

        currentFEN = normFen;
    clearOverlay();

    const timeLeft = getMyTimeLeft();
    const stm = fen.split(" ")[1];
    
    // Better color detection for online games:
    // If flipBoard detection is uncertain, try to infer from pawn structure
    // White pawns start on rank 2, black on rank 7
    // If our board is "normal" orientation (not flipped), we play as white
    let myColor = flipBoard ? "b" : "w";
    
    // Additional check: look for chess.com player color attribute
    const boardEl = document.querySelector("wc-chess-board, chess-board");
    if (boardEl) {
        const orient = boardEl.getAttribute("board-orientation") ||
                       boardEl.getAttribute("data-orientation");
        if (orient === "black") myColor = "b";
        else if (orient === "white") myColor = "w";
    }
    
    const isMyTurn = stm === myColor;
    
    log.info('Board', `Parsed FEN`, { fenShort: fen.substring(0, 50), myColor, stm, isMyTurn, flipBoard });
    addDebugLog(`Parsed board: STM=${stm.toUpperCase()} Turn=${isMyTurn ? 'YES' : 'NO'}`);
    updateDebugHUD();

    // Reset FEN history on a new game.
    if (fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w")) {
        fenHistory = [];
    }
    // History contract: `|`-joined normalized FENs of PRIOR positions only
    // (the current position is excluded, matching uci.rs and match_runner.py).
    // Re-processing the same position (e.g. DOM re-render) must not add duplicates.
    if (fenHistory[fenHistory.length - 1] !== normFen) {
        fenHistory.push(normFen);
        if (fenHistory.length > MAX_FEN_HISTORY) {
            fenHistory.shift(); // Limit history to prevent payload bloat
        }
    }
    const historyStr = fenHistory.slice(0, -1).join("|");

    // Check if a ponder result is already cached for this position.
    // If so, display arrows instantly. Play move if autoplay is on.
    if (isMyTurn && ponderCache[normFen]) {
        const cached = ponderCache[normFen];
        if (cached.bestMove) {
            log.info('Engine', `Ponder hit! Instantly displaying move: ${cached.bestMove}`);
            renderArrows([cached.pv], isMyTurn);
            
            // Update popup stats with cached ponder result
            safeStorageSet({
                engineStats: {
                    score: cached.score,
                    depth: cached.depth,
                    nodes: cached.nodes,
                    timeMs: cached.timeMs,
                }
            });
            
            if (currentEngineMode === "autoplay") {
                playMove(cached.bestMove);
            }
            
            // Return early to prevent starting a new shallow search that would overwrite our deep ponder result!
            return;
        }
    }
    ponderCache = {};

    
    const clocks = getClocks();
    if (clocks.my_ms !== null && lastMyTime !== null && clocks.my_ms > lastMyTime) {
        let diff = clocks.my_ms - lastMyTime;
        if (diff > 0 && diff < 30000) {
            let inc = diff;
            if (inferredIncMs === 0) inferredIncMs = inc;
            else inferredIncMs = inferredIncMs * 0.7 + inc * 0.3;
            if (inferredIncMs > 15000) inferredIncMs = 0; // Reject absurd increments
        }
    }
    if (isMyTurn && clocks.my_ms !== null) {
        lastMyTime = clocks.my_ms;
    }

    if (!isContextValid()) return;

    if (!isMyTurn) {
        log.debug('Board', 'Opponent turn - skipping engine search to keep workers free');
        return;
    }

    try {
        isSearchInFlight = true;
        chrome.runtime.sendMessage(
            {
                type: "NEW_POSITION",
                fen,
                timeLeft: timeLeft,
                my_ms: clocks.my_ms !== null ? clocks.my_ms : 0,
                opp_ms: clocks.opp_ms !== null ? clocks.opp_ms : 0,
                inc_ms: inferredIncMs,
                isMyTurn,
                history: historyStr,
            },

            (response) => {
                isSearchInFlight = false;
                if (!isContextValid()) return;
                if (chrome.runtime.lastError) {
                    const msg = chrome.runtime.lastError.message || "";
                    if (msg.includes("context invalidated") || msg.includes("Extension context invalidated")) {
                        cleanupOrphanedScript();
                        return;
                    }
                    log.error('Background', 'Messaging error', chrome.runtime.lastError);
                    return;
                }
                if (!response || !response.bestMove) {
                    if (isMyTurn) {
                        addDebugLog('⚠️ Null move received — retrying in 400ms');
                        setTimeout(() => {
                            if (isMyTurn) {
                                currentFEN = "";
                                processPosition();
                            }
                        }, 400);
                    }
                    return;
                }

                lastEngineStats = response;
                updateDebugHUD();
                
                // Abort if the board has already changed to a DIFFERENT chess position
                const normPlacement = normFen.split(" ")[0];
                const currentPlacement = (currentFEN || "").split(" ")[0];
                if (currentPlacement && currentPlacement !== normPlacement) {
                    addDebugLog('Stale engine response (board moved)');
                    return;
                }
                if (!currentFEN) {
                    currentFEN = normFen;
                }

                addDebugLog(`Search done: ${response.bestMove} (${response.score || 0}cp d=${response.depth || 0})`);

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
    } catch (sendErr) {
        isSearchInFlight = false;
        if (sendErr?.message?.includes("context invalidated") || !isContextValid()) {
            cleanupOrphanedScript();
            return;
        }
        log.error('Board', 'Messaging dispatch error', sendErr);
    }
    } catch (e) {
        isSearchInFlight = false;
        if (e?.message?.includes("context invalidated") || !isContextValid()) {
            cleanupOrphanedScript();
            return;
        }
        log.error('Board', 'Error during processPosition', e);
    }
}

// ---------------------------------------------------------------------------
// MutationObserver – watch for DOM changes (chess.com)
// ---------------------------------------------------------------------------

let activeObserver = null;
let observedElements = [];
let isProcessing = false;
let lastProcessTime = 0;

function setupObserver() {
    if (!isContextValid()) return;

    // For online games, chess.com uses #board-layout-main or .board-layout-main
    const board = document.querySelector(
        "wc-chess-board, .board, #board-single, #board-layout-main, .board-layout-main, .board-board, [data-cy='chess-board']"
    );
    const moveList = document.querySelector(
        "wc-move-list, .move-list-container, .vertical-move-list, .move-list, [data-cy='move-list']"
    );
    
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
        if (!isContextValid()) return;
        // Optimization: Ignore pure style/class mutations (piece animations) if structural changes are rare
        // but since pieces can move via style transform, we must be careful.
        // We use a leading-edge + trailing-edge approach to prevent freeze.
        const now = Date.now();
        if (now - lastProcessTime > 100 && !isProcessing) {
             isProcessing = true;
             lastProcessTime = now;
             setTimeout(() => {
                 if (!isContextValid()) return;
                 processPosition();
                 isProcessing = false;
             }, 0);
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
             if (!isContextValid()) return;
             if (Date.now() - lastProcessTime > 100 && !isProcessing) {
                 isProcessing = true;
                 lastProcessTime = Date.now();
                 setTimeout(() => {
                     if (!isContextValid()) return;
                     processPosition();
                     isProcessing = false;
                 }, 0);
             }
        }, 50);
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
try { renderDebugHUD(); } catch (_) {}

try {
    window.__AETHER_DEBUG__ = {
        getState: () => ({
            version: AETHER_VERSION,
            currentFEN,
            lastDeterminedStm,
            myColor: flipBoard ? "b" : "w",
            isMyTurn: lastDeterminedStm === (flipBoard ? "b" : "w"),
            lastEngineStats,
            lastExecutedMove,
            logs: recentDebugLogs,
            boardFound: !!document.querySelector("wc-chess-board, chess-board"),
        }),
        forceMove: () => {
            isSearchInFlight = false;
            currentFEN = "";
            processPosition();
        },
        play: (uci) => playMove(uci),
    };
    log.info('Debug', 'Aether Debug tools ready at window.__AETHER_DEBUG__');
} catch (_) {}

// Periodically re-check and attach to board if navigation occurred or SPA page updated
pollInterval = setInterval(() => {
    if (!isContextValid()) return;
    setupObserver();
    processPosition();
    try { renderDebugHUD(); } catch (_) {}
}, 2500);

// Initial analysis after the board has had time to render.
setTimeout(() => {
    if (isContextValid()) {
        try { renderDebugHUD(); } catch (_) {}
        processPosition();
    }
}, 1000);

// Force re-evaluation on demand (triggered by popup when engine is started).
chrome.runtime.onMessage.addListener((msg) => {
    if (!isContextValid()) return;
    if (msg.type === "FORCE_EVALUATE") {
        currentFEN = "";
        processPosition();
    }
});

// ---------------------------------------------------------------------------
// WebSocket Interceptor – listen for FEN data from inject.js (chess.com live)
// ---------------------------------------------------------------------------

window.addEventListener("message", (event) => {
    if (!isContextValid()) return;
    if (event.source !== window || !event.data) return;

    if (event.data.type === "AETHER_MOVE_SUCCESS") {
        addDebugLog(`Native controller confirmed: ${event.data.uci}`);
        return;
    }

    if (event.data.type !== "CHESS_WS_MESSAGE") {
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
    if (!isContextValid()) return;
    if (msg.type === "PONDER_RESULT") {
        const response = msg.data;
        if (response && response.cachedForFen) {
            const norm = normalizeFen(response.cachedForFen);
            ponderCache[norm] = response;
            
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

            // Late ponder hit: If it's already our turn and the board matches the ponder FEN, play it immediately
            if (currentFEN && normalizeFen(currentFEN) === norm) {
                const stm = currentFEN.split(" ")[1];
                let myColor = flipBoard ? "b" : "w";
                const boardEl = document.querySelector("wc-chess-board, chess-board");
                if (boardEl) {
                    const orient = boardEl.getAttribute("board-orientation") || boardEl.getAttribute("data-orientation");
                    if (orient === "black") myColor = "b";
                    else if (orient === "white") myColor = "w";
                }
                if (stm === myColor) {
                    log.info('Engine', `Late Ponder hit! Instantly displaying move: ${response.bestMove}`);
                    safeStorageSet({
                        engineStats: {
                            score: response.score,
                            depth: response.depth,
                            nodes: response.nodes,
                            timeMs: response.timeMs,
                        }
                    });
                    if (currentEngineMode === "autoplay") {
                        playMove(response.bestMove);
                    }
                }
            }
        }
    }
});




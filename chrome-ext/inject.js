/**
 * inject.js – WebSocket Interceptor (runs in MAIN world)
 *
 * Patches window.WebSocket to intercept chess game messages sent over
 * WebSocket connections (e.g. Chess.com live games). Any message containing
 * FEN, PGN, or move data is forwarded to the content script via postMessage.
 *
 * NOTE: This script runs in the MAIN world (see manifest.json) so it has
 * access to the page's own WebSocket constructor.
 */

const OriginalWebSocket = window.WebSocket;

function WebSocketProxy(...args) {
    const ws = Reflect.construct(OriginalWebSocket, args);

    ws.addEventListener("message", (event) => {
        try {
            const data = event.data;
            if (
                typeof data === "string" &&
                (data.includes("fen") ||
                    data.includes("pgn") ||
                    data.includes("move"))
            ) {
                window.postMessage(
                    { type: "CHESS_WS_MESSAGE", payload: data },
                    "*"
                );
            }
        } catch (_) {
            // Ignore interception errors to avoid breaking the page.
        }
    });

    return ws;
}

// Preserve prototype chain and static constants (CONNECTING, OPEN, CLOSING, CLOSED)
WebSocketProxy.prototype = OriginalWebSocket.prototype;
Object.setPrototypeOf(WebSocketProxy, OriginalWebSocket);
["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((prop) => {
    if (prop in OriginalWebSocket) {
        Object.defineProperty(WebSocketProxy, prop, {
            value: OriginalWebSocket[prop],
            writable: false,
            enumerable: true,
            configurable: true,
        });
    }
});

window.WebSocket = WebSocketProxy;

// ---------------------------------------------------------------------------
// Native Move Execution (runs in MAIN world with direct board.game access)
// ---------------------------------------------------------------------------
function findChessComGame(board) {
    if (!board) return null;
    if (board.game && typeof board.game.move === "function") return board.game;
    if (board._game && typeof board._game.move === "function") return board._game;
    if (board.controller && board.controller.game && typeof board.controller.game.move === "function") return board.controller.game;
    if (board.controller && typeof board.controller.move === "function") return board.controller;
    if (window.chesscom?.game && typeof window.chesscom.game.move === "function") return window.chesscom.game;
    if (window.game && typeof window.game.move === "function") return window.game;
    return null;
}

function tryExecuteChessComMove(board, from, to, promotion, uci) {
    if (!board) return false;

    // Check for native user-move controller methods on Chess.com
    // These methods (userMove / makeMove) broadcast the move packet to the live WebSocket server.
    const candidates = [
        board.controller,
        board.game,
        board._game,
        window.chesscom?.game,
        window.game,
        board
    ].filter(Boolean);

    for (const c of candidates) {
        if (typeof c.userMove === "function") {
            try {
                const res = c.userMove({ from, to, promotion: promotion || undefined });
                if (res !== false && res !== null) return true;
            } catch (_) {}
            try {
                const res = c.userMove(from, to, promotion || undefined);
                if (res !== false && res !== null) return true;
            } catch (_) {}
        }
        if (typeof c.makeMove === "function") {
            try {
                const res = c.makeMove({ from, to, promotion: promotion || undefined });
                if (res !== false && res !== null) return true;
            } catch (_) {}
            try {
                const res = c.makeMove(from, to, promotion || undefined);
                if (res !== false && res !== null) return true;
            } catch (_) {}
        }
    }

    // Notice: We deliberately DO NOT call g.move(...) here.
    // In Chess.com live games, g.move modifies the local UI/analysis model only,
    // without notifying the WebSocket server, which causes online move desynchronization.
    // By returning false, content.js executes the robust DOM pointer drag-and-drop sequence
    // that Chess.com's web component natively responds to.
    return false;
}

window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "AETHER_PLAY_MOVE") return;

    const { uci, from, to, promotion } = event.data;

    try {
        const board = document.querySelector("wc-chess-board, chess-board, .board");
        if (board) {
            const success = tryExecuteChessComMove(board, from, to, promotion, uci);
            if (success) {
                window.postMessage({ type: "AETHER_MOVE_SUCCESS", uci }, "*");
                return;
            }
        }
    } catch (e) {
        console.warn("[Aether] Native game.move execution error:", e);
    }
});

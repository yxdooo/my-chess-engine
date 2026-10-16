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
    return null;
}

function tryExecuteChessComMove(board, from, to, promotion, uci) {
    if (!board) return false;

    // 1. Native game controller on Chess.com
    const g = findChessComGame(board);
    if (g) {
        try {
            g.move({
                from: from,
                to: to,
                promotion: promotion || undefined,
                animate: false,
                userGenerated: true
            });
            return true;
        } catch (e1) {
            try {
                g.move({ from, to, promotion: promotion || undefined });
                return true;
            } catch (e2) {
                try {
                    g.move(from, to, promotion);
                    return true;
                } catch (e3) {
                    try {
                        g.move(uci);
                        return true;
                    } catch (e4) {}
                }
            }
        }
    }

    // 2. Direct board methods
    if (typeof board.movePiece === "function") {
        try {
            board.movePiece(from, to);
            return true;
        } catch (_) {}
    }
    if (typeof board.makeMove === "function") {
        try {
            board.makeMove(from, to);
            return true;
        } catch (_) {}
    }

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

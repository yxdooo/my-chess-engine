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

window.WebSocket = function WebSocketProxy(url, protocols) {
    const ws = new OriginalWebSocket(url, protocols);

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
};

// Preserve the original prototype so instanceof checks still work.
window.WebSocket.prototype = OriginalWebSocket.prototype;

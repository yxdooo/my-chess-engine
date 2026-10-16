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

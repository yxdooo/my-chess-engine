const OriginalWebSocket = window.WebSocket;

window.WebSocket = function(url, protocols) {
    const ws = new OriginalWebSocket(url, protocols);
    
    ws.addEventListener('message', function(event) {
        try {
            const data = event.data;
            if (typeof data === 'string') {
                if (data.includes('fen') || data.includes('pgn') || data.includes('move')) {
                    window.postMessage({
                        type: 'CHESS_WS_MESSAGE',
                        payload: data
                    }, '*');
                }
            }
        } catch (e) {
            // Ignore interception errors
        }
    });
    
    return ws;
};

window.WebSocket.prototype = OriginalWebSocket.prototype;
console.log("[ChessEngine] WebSocket Interceptor Injected.");

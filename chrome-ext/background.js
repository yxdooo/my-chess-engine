// Aggressive opening book: FEN (position + side + castling + ep) -> UCI move
const AGGRESSIVE_BOOK = {
    // Englund Gambit
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -": "e7e5",
    "rnbqkbnr/pppp1ppp/8/4P3/8/8/PPP1PPPP/RNBQKBNR b KQkq -": "b8c6",

    // Stafford Gambit
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "g8f6",
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f3e5",
    "rnbqkb1r/pppp1ppp/5n2/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6",

    // Scholar's Mate Trap
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq -": "c6d4",

    // Caro-Kann Fantasy Variation Trap
    "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/5P2/PPP3PP/RNBQKBNR b KQkq -": "d5e4",
    "rnbqkbnr/pp2pppp/2p5/8/3Pp3/5P2/PPP3PP/RNBQKBNR w KQkq -": "f3e4",
    "rnbqkbnr/pp2pppp/2p5/8/3PP3/8/PPP3PP/RNBQKBNR b KQkq -": "e7e5",
};

let creatingOffscreen = null;

/**
 * Normalizes a FEN string to its first 4 fields (position, side, castling, en-passant).
 * Used as a consistent cache key across background and content scripts.
 * @param {string} fen
 * @returns {string}
 */
const normalizeFen = (fen) => {
    if (!fen) return "";
    return fen.split(" ").slice(0, 4).join(" ");
};

/**
 * Fetches a URL with a hard timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeout - milliseconds
 * @returns {Promise<Response>}
 */
const fetchWithTimeout = (url, options, timeout = 1500) => {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), timeout)
        ),
    ]);
};

/**
 * Ensures the offscreen document exists. Safe to call concurrently.
 * @param {string} path
 */
async function setupOffscreenDocument(path) {
    if (await hasDocument()) return;

    if (creatingOffscreen) {
        // Another call is already in progress – wait for it.
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = chrome.offscreen
        .createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.WORKERS],
            justification: "Running SMP Web Workers for chess calculation",
        })
        .then(() => {
            // Wait for the document to spawn and register its listeners.
            return new Promise((r) => setTimeout(r, 150));
        })
        .finally(() => {
            creatingOffscreen = null;
        });

    await creatingOffscreen;
}

/**
 * Returns true if an offscreen document with offscreen.html is already open.
 * @returns {Promise<boolean>}
 */
async function hasDocument() {
    const matchedClients = await clients.matchAll();
    return matchedClients.some((c) => c.url.includes("offscreen.html"));
}

/**
 * Computes per-move thinking time based on remaining clock time and ELO.
 * @param {number|null} timeLeft - seconds remaining on clock
 * @param {number} elo
 * @returns {number} milliseconds to think
 */
function computeEngineTime(timeLeft, elo) {
    if (timeLeft !== null && timeLeft !== undefined) {
        if (timeLeft < 15) return 100;
        if (timeLeft < 45) return 500;
        if (timeLeft < 90) return 1500;
        if (timeLeft < 180) return 3000;
        if (timeLeft < 300) return 5000;
        if (timeLeft < 600) return 8000;
        return 12000;
    }
    // No clock info – use ELO-based fallback
    if (elo < 1000) return 300;
    if (elo < 2000) return 1000;
    return 2500;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Pre-warm the offscreen document when the engine is started.
    if (message.type === "START_ENGINE") {
        setupOffscreenDocument("offscreen.html");
        return false;
    }

    // Stop the engine: update storage so content scripts stop requesting analysis.
    if (message.type === "STOP_ENGINE") {
        chrome.storage.local.set({ isActive: false });
        return false;
    }

    if (message.type === "NEW_POSITION") {
        chrome.storage.local.get(
            ["isActive", "elo", "targetWorkers", "hashSize"],
            (result) => {
                if (!result.isActive) {
                    sendResponse({ bestMove: null });
                    return;
                }

                const elo = result.elo || 3000;
                const workerCount = result.targetWorkers || 4;
                const hashSize = result.hashSize || 128;
                const engineTime = computeEngineTime(message.timeLeft, elo);
                const normFen = normalizeFen(message.fen);

                // 1. Check aggressive opening book.
                if (message.isMyTurn && AGGRESSIVE_BOOK[normFen]) {
                    const trapMove = AGGRESSIVE_BOOK[normFen];
                    sendResponse({ bestMove: trapMove, pv: [trapMove] });
                    return;
                }

                // 2. For our turn: try cloud resources before falling back to engine.
                if (message.isMyTurn) {
                    // Masters opening explorer (only for ELO >= 1600)
                    fetchWithTimeout(
                        "https://explorer.lichess.ovh/masters?fen=" +
                            encodeURIComponent(message.fen),
                        {},
                        1000
                    )
                        .then((r) => r.json())
                        .then((data) => {
                            if (
                                data.moves &&
                                data.moves.length > 0 &&
                                elo >= 1600
                            ) {
                                sendResponse({
                                    bestMove: data.moves[0].uci,
                                    pv: [data.moves[0].uci],
                                });
                            } else {
                                callOffscreenEngine(
                                    message.fen,
                                    engineTime,
                                    elo,
                                    workerCount,
                                    true,
                                    message.history,
                                    hashSize,
                                    sendResponse
                                );
                            }
                        })
                        .catch(() => {
                            callOffscreenEngine(
                                message.fen,
                                engineTime,
                                elo,
                                workerCount,
                                true,
                                message.history,
                                hashSize,
                                sendResponse
                            );
                        });
                } else {
                    // Opponent's turn: start pondering (search opponent's position).
                    callOffscreenEngine(
                        message.fen,
                        engineTime,
                        elo,
                        workerCount,
                        false,
                        message.history,
                        hashSize,
                        sendResponse
                    );
                }
            }
        );
        return true; // Keep the message channel open for async response.
    }
});

/**
 * Dispatches a search request to the offscreen SMP engine, then optionally
 * starts a ponder search on the predicted opponent reply.
 */
function callOffscreenEngine(
    fen,
    timeMs,
    elo,
    workerCount,
    isMyTurn,
    history,
    hashSize,
    sendResponse
) {
    setupOffscreenDocument("offscreen.html").then(() => {
        chrome.runtime.sendMessage(
            {
                type: "START_SMP_SEARCH",
                fen,
                timeMs,
                elo,
                activeWorkerCount: workerCount,
                isMyTurn,
                history,
                hashSize,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error(
                        "[Background] Offscreen error:",
                        chrome.runtime.lastError.message
                    );
                    sendResponse({ bestMove: null });
                    return;
                }

                if (isMyTurn) {
                    sendResponse(response);
                    return;
                }

                // Pondering: search the position after the opponent's expected move.
                if (response && response.ponderFen) {
                    chrome.runtime.sendMessage(
                        {
                            type: "START_SMP_SEARCH",
                            fen: response.ponderFen,
                            timeMs,
                            elo,
                            activeWorkerCount: workerCount,
                            isMyTurn: true,
                            history,
                            hashSize,
                        },
                        (ponderResponse) => {
                            if (
                                !chrome.runtime.lastError &&
                                ponderResponse &&
                                sendResponse
                            ) {
                                ponderResponse.cachedForFen = response.ponderFen;
                                sendResponse(ponderResponse);
                            } else {
                                sendResponse(response);
                            }
                        }
                    );
                } else {
                    sendResponse(response);
                }
            }
        );
    });
}

/**
 * Aggressive opening book: FEN (position + side + castling + en-passant) -> UCI move.
 * En-passant field is critical – it must match the normalized FEN from the engine.
 */
const AGGRESSIVE_BOOK = {
    // ---- Responses to 1. e4 ----
    // Play the Sicilian (1...c5) against 1. e4
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3": "c7c5",

    // Stafford Gambit: 1. e4 e5 2. Nf3 Nf6!?
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "g8f6",
    // After 2...Nf6 3. Nxe5 (White grabs the pawn)
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f3e5",
    // After 3. Nxe5: Black plays 3...Nc6!
    "rnbqkb1r/pppp1ppp/5n2/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6",
    // Traxler Counterattack: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 Bc5!!
    "r1bqk2r/pppp1ppp/2n2n2/2b1p1N1/2B1P3/8/PPPP1PPP/RNBQK2R b KQkq -": "f8c5",

    // Scandinavian (1. e4 d5 2. exd5) – play the modern 2...Nf6
    "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6": "e4d5",
    "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq -": "g8f6",
    // After 2...Nf6 3. d4
    "rnbqkb1r/ppp1pppp/5n2/3P4/3P4/8/PPP2PPP/RNBQKBNR b KQkq -": "f6d5",

    // Scholar's Mate Trap (trap Nd4 fork)
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq -": "c6d4",

    // Caro-Kann Fantasy Variation Trap
    "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/5P2/PPP3PP/RNBQKBNR b KQkq -": "d5e4",
    "rnbqkbnr/pp2pppp/2p5/8/3Pp3/5P2/PPP3PP/RNBQKBNR w KQkq -": "f3e4",
    "rnbqkbnr/pp2pppp/2p5/8/3PP3/8/PPP3PP/RNBQKBNR b KQkq -": "e7e5",

    // ---- Responses to 1. d4 ----
    // Englund Gambit: 1. d4 e5!?
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "e7e5",
    // After 2. dxe5 (White takes) – Nc6
    "rnbqkbnr/pppp1ppp/8/4P3/8/8/PPP1PPPP/RNBQKBNR b KQkq -": "b8c6",
    // After 2...Nc6 3. Nf3 – Qe7 (classic Englund)
    "r1bqkbnr/pppp1ppp/2n5/4P3/8/5N2/PPP1PPPP/RNBQKB1R b KQkq -": "d8e7",

    // Budapest Gambit: 1. d4 Nf6 2. c4 e5!?
    "rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3": "e7e5",
    // After 3. dxe5 Ng4 (Budapest Gambit main line)
    "rnbqkb1r/pppp1ppp/8/4P3/2P3n1/8/PP2PPPP/RNBQKBNR w KQkq -": "b1c3",

    // ---- Engine plays White ----
    // Against 1...e5: go Italian (Nf3 then Bc4)
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6": "g1f3",
    // Italian Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f1c4",
    // Against Sicilian: Nf3 then d4
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3",
    // Against French (1...e6): d4
    "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    // Against Caro-Kann (1...c6): d4
    "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    // London System: 1. d4 d5 2. Nf3
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6": "g1f3",
    // London: after Nf3, Bf4
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq -": "g8f6",
    "rnbqkb1r/ppp1pppp/5n2/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq -": "c1f4",
    // Against 1. d4 Nf6: play c4 (English/Queen's Indian territory)
    "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "c2c4",
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
function computeEngineTime(timeLeft, elo, increment = 0) {
    if (timeLeft !== null && timeLeft !== undefined) {
        // Safe target time calculation: base time fraction + majority of increment
        const baseTime = (timeLeft * 1000) / 20; 
        const incTime = increment * 1000 * 0.8;
        let targetTime = baseTime + incTime;
        
        // Strict limits for low time
        if (timeLeft < 15) return 100 + (increment > 0 ? incTime : 0);
        if (timeLeft < 45) return 500 + (increment > 0 ? incTime : 0);
        
        return Math.floor(targetTime);
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
                const workerCount  = result.targetWorkers || 4;
                const hashSize     = result.hashSize || 128;
                const increment    = result.increment || 0;
                const engineTime   = computeEngineTime(message.timeLeft, elo, increment);
                const normFen      = normalizeFen(message.fen);

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
                    console.error("[Background] Offscreen error:", chrome.runtime.lastError.message);
                    if (sendResponse) sendResponse({ bestMove: null });
                    return;
                }

                if (isMyTurn) {
                    if (response && response.score !== undefined) {
                        chrome.storage.local.set({
                            engineStats: {
                                score: response.score,
                                depth: response.depth,
                                nodes: response.nodes,
                                timeMs: response.timeMs,
                            },
                        });
                    }
                    if (sendResponse) sendResponse(response);
                }

                // Pondering: search the position after our expected move and the opponent's expected reply.
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
                            if (!chrome.runtime.lastError && ponderResponse) {
                                ponderResponse.cachedForFen = response.ponderFen;
                                // Broadcast ponder result to all tabs
                                chrome.tabs.query({url: ["*://*.chess.com/*", "*://*.lichess.org/*"]}, (tabs) => {
                                    for (let tab of tabs) {
                                        chrome.tabs.sendMessage(tab.id, {
                                            type: "PONDER_RESULT",
                                            data: ponderResponse
                                        });
                                    }
                                });
                            }
                        }
                    );
                } else if (!isMyTurn && sendResponse) {
                    sendResponse(response);
                }
            }
        );
    });
}

import { log } from "./logger.js";

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
    // Italian Game
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

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(["isActive"], (result) => {
        if (result.isActive === undefined) {
            chrome.storage.local.set({
                isActive: true,
                elo: 3000,
                cpuMode: "max",
                targetWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
                hashSize: 128,
                increment: 0,
                engineMode: "autoplay"
            });
        }
    });
});

let engineActive = false;
let globalTimeLimit = 3000;
let globalHashSize = 32;

let creatingOffscreen = null;

/**
 * Normalizes a FEN string to its first 4 fields (position, side, castling, en-passant).
 * Used as a consistent cache key across background and content scripts.
 * @param {string} fen
 * @returns {string}
 */
const normalizeFen = (fen) => {
    if (!fen) return "";
    // Piece placement, side to move, castling, and en-passant all affect move legality.
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
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(id));
};

/**
 * Ensures the offscreen document exists. Safe to call concurrently.
 * @param {string} path
 */
async function setupOffscreenDocument(path) {
    if (creatingOffscreen) {
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = (async () => {
        if (await hasDocument()) return;
        
        await chrome.offscreen.createDocument({
            url: path,
            reasons: [(chrome.offscreen.Reason && chrome.offscreen.Reason.WORKERS) || "DOM_PARSER"],
            justification: "Running SMP Web Workers for chess calculation",
        });
        
        // Wait for the document to spawn and register its listeners.
        await new Promise((r) => setTimeout(r, 150));
    })();

    try {
        await creatingOffscreen;
        log.debug('Background', 'Offscreen document created or already exists');
    } catch (e) {
        log.error('Background', 'Failed to create offscreen document', e);
    } finally {
        creatingOffscreen = null;
    }
}

function resetOffscreenIdleTimeout() {
    chrome.alarms.create("closeOffscreen", { delayInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "closeOffscreen") {
        if (await hasDocument()) {
            log.info('Background', 'Closing idle offscreen document');
            chrome.offscreen.closeDocument();
        }
    }
});

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
    if (timeLeft !== null && timeLeft !== undefined && !isNaN(timeLeft)) {
        // Safe target time calculation: 1/30th of remaining time
        const baseTime = (timeLeft * 1000) / 30; 
        const incTime = increment * 1000 * 0.8;
        let targetTime = baseTime + incTime;
        
        // Strict limits for low time
        if (timeLeft < 10) return Math.max(100, incTime); // Panic mode
        if (timeLeft < 30) return Math.floor(Math.min(targetTime, 500 + incTime)); // Fast mode
        
        if (!isNaN(targetTime)) {
            // Cap soft limit at 2000ms (Rust engine will stretch this up to 6000ms if needed via hard limit)
            return Math.floor(Math.min(targetTime, 2000));
        }
    }
    // No clock info (bot games, analysis) – use ELO-based fallback
    if (elo < 1000) return 300;
    if (elo < 2000) return 800;
    if (elo < 3000) return 1500;
    return 2000;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "START_ENGINE") {
        log.info('Background', 'Received START_ENGINE message');
        setupOffscreenDocument("offscreen.html");
        return false;
    }

    if (message.type === "STOP_ENGINE") {
        log.info('Background', 'Received STOP_ENGINE message');
        chrome.storage.local.set({ isActive: false });
        return false;
    }

    if (message.type === "NEW_POSITION") {
        chrome.storage.local.get(
            ["isActive", "elo", "targetWorkers", "hashSize", "increment"],
            (result) => {
                if (!result.isActive) {
                    log.debug('Background', 'Engine is inactive, dropping NEW_POSITION');
                    sendResponse({ bestMove: null });
                    return;
                }

                const elo = result.elo || 3000;
                const workerCount  = Math.min(8, Math.max(1, result.targetWorkers || ((navigator.hardwareConcurrency || 4) - 1)));
                const hashSize     = result.hashSize || 128;
                const increment    = result.increment || 0;
                const engineTime   = computeEngineTime(message.timeLeft, elo, increment);
                const normFen      = normalizeFen(message.fen);
                const pieceCount   = normFen.split(' ')[0].replace(/[\/0-9]/g, '').length;

                log.info('Background', `NEW_POSITION received: turn=${message.isMyTurn} clock=${message.timeLeft}s timeToThink=${engineTime}ms pieces=${pieceCount}`);
                log.debug('Background', `FEN: ${message.fen}`);

                const fallbackToEngine = () => {
                    if (message.isMyTurn && AGGRESSIVE_BOOK[normFen]) {
                        const trapMove = AGGRESSIVE_BOOK[normFen];
                        log.info('Background', `Played book trap move: ${trapMove}`);
                        sendResponse({ bestMove: trapMove, pv: [trapMove] });
                        return;
                    }

                    if (message.isMyTurn) {
                        fetchWithTimeout(
                            "https://explorer.lichess.ovh/masters?fen=" +
                                encodeURIComponent(message.fen),
                            {},
                            1000
                        )
                            .then((r) => {
                                if (!r.ok) throw new Error("Explorer API failed");
                                if (!r.headers.get("content-type")?.includes("application/json")) {
                                    throw new Error("Invalid content type");
                                }
                                return r.json();
                            })
                            .then((data) => {
                                if (
                                    data.moves &&
                                    data.moves.length > 0 &&
                                    elo >= 1600
                                ) {
                                    log.info('Background', `Played opening master book move: ${data.moves[0].uci}`);
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
                            .catch((err) => {
                                log.warn('Background', 'Explorer API failed, falling back to engine', err);
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
                };

                if (pieceCount <= 7) {
                    fetchWithTimeout(
                        "https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(message.fen),
                        {},
                        2000
                    )
                        .then((r) => r.json())
                        .then((data) => {
                            if (data && data.moves && data.moves.length > 0) {
                                log.info('Background', `Played syzygy TB move: ${data.moves[0].uci}`);
                                sendResponse({
                                    bestMove: data.moves[0].uci,
                                    pv: [data.moves[0].uci],
                                });
                            } else {
                                fallbackToEngine();
                            }
                        })
                        .catch((err) => {
                            log.warn('Background', 'TB API failed, falling back to engine', err);
                            fallbackToEngine();
                        });
                    return;
                }

                fallbackToEngine();
            }
        );
        return true; 
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
    resetOffscreenIdleTimeout();
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
                    log.warn('Background', `Offscreen error (sending to fallback): ${chrome.runtime.lastError.message}`);
                    runFallbackWorker(fen, timeMs, elo, history, hashSize, isMyTurn, sendResponse, workerCount);
                    return;
                }
                handleSearchResponse(response, isMyTurn, sendResponse, timeMs, elo, workerCount, history, hashSize);
            }
        );
    }).catch((e) => {
        log.error('Background', 'Offscreen setup failed, routing to fallback', e);
        runFallbackWorker(fen, timeMs, elo, history, hashSize, isMyTurn, sendResponse, workerCount);
    });
}

let fallbackWorker = null;
let fallbackWorkerReady = false;
let fallbackAbortFlag = null;
let currentFallbackSearchId = 0;
let fallbackMessageQueue = [];
let fallbackIdleTimeoutId = null;
let pendingFallbackResponse = null;

function startFallbackIdleTimeout() {
    if (fallbackIdleTimeoutId) clearTimeout(fallbackIdleTimeoutId);
    fallbackIdleTimeoutId = setTimeout(() => {
        if (fallbackWorker) {
            log.info('Background', 'Fallback worker idle for 2 minutes, terminating.');
            fallbackWorker.terminate();
            fallbackWorker = null;
            fallbackWorkerReady = false;
            fallbackMessageQueue = [];
        }
    }, 120000);
}

function clearFallbackIdleTimeout() {
    if (fallbackIdleTimeoutId) {
        clearTimeout(fallbackIdleTimeoutId);
        fallbackIdleTimeoutId = null;
    }
}

function runFallbackWorker(fen, timeMs, elo, history, hashSize, isMyTurn, sendResponse, workerCount) {
    clearFallbackIdleTimeout();
    let sabSupported = false;
    try {
        new SharedArrayBuffer(1);
        sabSupported = true;
    } catch (e) {
        sabSupported = false;
    }

    if (pendingFallbackResponse && pendingFallbackResponse !== sendResponse) {
        try { pendingFallbackResponse({ bestMove: null }); } catch(e) {}
    }
    pendingFallbackResponse = sendResponse;

    if (fallbackWorker) {
        if (!sabSupported) {
            fallbackWorker.terminate();
            fallbackWorker = null;
            fallbackWorkerReady = false;
            fallbackMessageQueue = [];
        } else if (fallbackAbortFlag) {
            fallbackAbortFlag[0] = 1;
        }
    }

    if (sabSupported) {
        fallbackAbortFlag = new Uint8Array(new SharedArrayBuffer(1));
    } else {
        fallbackAbortFlag = null;
    }

    currentFallbackSearchId++;
    const searchId = currentFallbackSearchId;

    if (!fallbackWorker) {
        fallbackWorker = new Worker("worker.js", { type: "module" });
        if (sabSupported) {
            const fallbackMemory = new WebAssembly.Memory({ initial: 2048, maximum: 16384, shared: true });
            fallbackWorker.postMessage({ type: "INIT", memory: fallbackMemory });
        } else {
            fallbackWorker.postMessage({ type: "INIT" });
        }
        fallbackWorkerReady = false;
    }

    fallbackWorker.onmessage = (e) => {
        if (e.data.type === "READY") {
            fallbackWorkerReady = true;
            for (const msg of fallbackMessageQueue) {
                fallbackWorker.postMessage(msg);
            }
            fallbackMessageQueue = [];
        } else if (e.data.type === "RESULT") {
            startFallbackIdleTimeout();
            if (e.data.searchId !== undefined && e.data.searchId !== searchId) return;
            const response = {
                bestMove: e.data.bestMove,
                pv: e.data.pv,
                ponderFen: e.data.ponderFen,
                multiPv: [{ bestMove: e.data.bestMove, pv: e.data.pv, ponderFen: e.data.ponderFen }],
                score: e.data.score,
                depth: e.data.depth,
                nodes: e.data.nodes,
                timeMs: e.data.timeMs || timeMs,
            };
            handleSearchResponse(response, isMyTurn, sendResponse, timeMs, elo, workerCount, history, hashSize);
            if (pendingFallbackResponse === sendResponse) {
                pendingFallbackResponse = null;
            }
        }
    };
    
    fallbackWorker.onerror = (err) => {
        log.error('Background', 'Fallback worker crashed:', err);
        if (pendingFallbackResponse) {
            try { pendingFallbackResponse({ bestMove: null }); } catch(e) {}
            pendingFallbackResponse = null;
        }
        if (fallbackWorker) {
            fallbackWorker.terminate();
            fallbackWorker = null;
            fallbackWorkerReady = false;
            fallbackMessageQueue = [];
        }
    };

    const searchMessages = [
        {
            type: "SET_HASH_SIZE",
            size: hashSize
        },
        {
            type: "SEARCH",
            fen, timeMs, elo,
            splitId: 0,
            splitCount: 1,
            history: history || "",
            abortFlag: fallbackAbortFlag,
            searchId: searchId
        }
    ];

    if (fallbackWorkerReady) {
        searchMessages.forEach(msg => fallbackWorker.postMessage(msg));
    } else {
        fallbackMessageQueue.push(...searchMessages);
    }
}

function handleSearchResponse(response, isMyTurn, sendResponse, timeMs, elo, workerCount, history, hashSize) {
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
    }
    
    // Always respond once so the content script doesn't hang.
    if (sendResponse) sendResponse(response);

    if (response && response.ponderFen && isMyTurn) {
        // Pondering: only ponder after our move (we know the position after our move)
        resetOffscreenIdleTimeout();
        setupOffscreenDocument("offscreen.html").then(() => {
            chrome.runtime.sendMessage(
                {
                    type: "START_SMP_SEARCH",
                    fen: response.ponderFen,
                    timeMs, elo, activeWorkerCount: workerCount, isMyTurn: true, history, hashSize,
                },
                (ponderResponse) => {
                    if (!chrome.runtime.lastError && ponderResponse) {
                        ponderResponse.cachedForFen = response.ponderFen;
                        log.info('Background', `Ponder search returned best move for next turn: ${ponderResponse.bestMove}`);
                        chrome.tabs.query({url: ["*://*.chess.com/*", "*://*.lichess.org/*"]}, (tabs) => {
                            for (let tab of tabs) {
                                chrome.tabs.sendMessage(tab.id, {
                                    type: "PONDER_RESULT",
                                    data: ponderResponse
                                }).catch(() => {});
                            }
                        });
                    } else if (chrome.runtime.lastError) {
                        log.error('Background', 'Ponder search error', chrome.runtime.lastError);
                    }
                }
            );
        }).catch((err) => {
            log.warn('Background', 'Pondering failed to setup offscreen', err);
        });
    }
}


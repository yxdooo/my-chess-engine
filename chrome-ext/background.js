import { log } from "./logger.js";

/**
 * Master opening book: FEN (position + side + castling + en-passant) -> UCI move.
 * Provides instant, top-tier Grandmaster opening book choices.
 */
const MASTER_BOOK = {
    // ---- Responses to 1. e4 as Black ----
    // Sicilian Defense against 1. e4
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3": "c7c5",
    // 1. e4 e5
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -": "e7e5",
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6",
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "a7a6",

    // French Defense response: 2. d4 d5
    "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    "rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3": "d7d5",

    // Caro-Kann response: 2. d4 d5
    "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq d3": "d7d5",

    // Scandinavian response: 2. exd5
    "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6": "e4d5",
    "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq -": "d8d5",

    // ---- Responses to 1. d4 ----
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "g8f6",
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -": "g8f6",
    "rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3": "e7e6",
    "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "c2c4",

    // ---- Playing White ----
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f1b5",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3",
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq d6": "c2c4",
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
                    if (message.isMyTurn && MASTER_BOOK[normFen]) {
                        const bookMove = MASTER_BOOK[normFen];
                        log.info('Background', `Played master book move: ${bookMove}`);
                        sendResponse({ bestMove: bookMove, pv: [bookMove] });
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


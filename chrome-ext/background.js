import { log } from "./logger.js";

const SYZYGY_CACHE = new Map();


/**
 * Master opening book: FEN (position + side + castling + en-passant) -> UCI move.
 * Provides instant, top-tier Grandmaster opening book choices.
 */
const MASTER_BOOK = {
    // ---- Responses to 1. e4 as Black ----
    // Sicilian Defense against 1. e4
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -": "c7c5",
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6",
    "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "a7a6",
    // Bishops Opening 2. Bc4
    "rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq -": "g8f6",
    // 2. d3
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/3P4/PPP2PPP/RNBQKBNR b KQkq -": "b8c6",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2NP4/PPP2PPP/R1BQKBNR b KQkq -": "g8f6",

    // French Defense response: 2. d4 d5
    "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    "rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq -": "d7d5",

    // Caro-Kann response: 2. d4 d5
    "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
    "rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq -": "d7d5",

    // Scandinavian response: 2. exd5
    "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "e4d5",
    "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq -": "d8d5",

    // ---- Responses to 1. d4 ----
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -": "g8f6",
    "rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq c3": "e7e6",
    "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "c2c4",
    // Nimzo-Indian Defense: 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 -> 4. Qc2 (prevents 4. e4 blunder)
    "rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq -": "d1c2",
    "rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/2N5/PPQ1PPPP/R1B1KBNR w KQ -": "a2a3",
    // King's Indian Defense
    "rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP3PPP/R1BQKBNR w KQkq -": "g1f3",

    // ---- Responses to 1. Nf3 (Reti) ----
    "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq -": "d2d4",
    "rnbqkbnr/ppp1pppp/8/3p4/8/5N2/PPPPPPPP/RNBQKB1R w KQkq -": "d2d4",
    "rnbqkb1r/ppp1pppp/5n2/3p4/8/5NP1/PPPPPP1P/RNBQKB1R w KQkq -": "f1g2",
    "rnbqkb1r/pppppp1p/5np1/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq -": "c2c4",
    "rnbqkb1r/pppp1ppp/4pn2/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq -": "c2c4",

    // ---- Responses to 1. c4 (English) ----
    "rnbqkbnr/pppp1ppp/8/4p3/2P5/2N5/PP1PPPPP/R1BQKBNR b KQkq -": "g8f6",
    "rnbqkb1r/pppp1ppp/5n2/4p3/2P5/2N5/PP1PPPPP/R1BQKBNR w KQkq -": "g1f3",
    "rnbqkbnr/pp1ppppp/8/2p5/2P5/2N5/PP1PPPPP/R1BQKBNR b KQkq -": "b8c6",
    "r1bqkbnr/pp1ppppp/2n5/2p5/2P5/2N5/PP1PPPPP/R1BQKBNR w KQkq -": "g2g3",

    // ---- Playing White ----
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f1b5",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3",
    "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "d2d4",
    "rnbqkbnr/pp2pppp/3p4/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq -": "f3d4",
    "rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq -": "b1c3",
    "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq -": "c1e3",
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f3e5",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "d2d3",
    "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "c2c4",
    "rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -": "b1c3",
    // English Opening response to 1... e5 -> 2. Nc3
    "rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq -": "b1c3",
};


chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(["isActive"], (result) => {
        if (result.isActive === undefined) {
            chrome.storage.local.set({
                isActive: true,
                elo: 3000,
                cpuMode: "max",
                targetWorkers: Math.min(16, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)),
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
        
        try {
            await chrome.offscreen.createDocument({
                url: path,
                reasons: [(chrome.offscreen.Reason && chrome.offscreen.Reason.WORKERS) || "DOM_PARSER"],
                justification: "Running SMP Web Workers for chess calculation",
            });
            // Wait for the document to spawn and register its listeners.
            await new Promise((r) => setTimeout(r, 150));
        } catch (e) {
            if (!e?.message?.includes("Only a single offscreen document")) {
                throw e;
            }
        }
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
    if (chrome.runtime && 'getContexts' in chrome.runtime) {
        try {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [chrome.runtime.getURL('offscreen.html')]
            });
            return Boolean(contexts && contexts.length > 0);
        } catch (_) {}
    }
    try {
        const matchedClients = await clients.matchAll();
        return matchedClients.some((c) => c.url.includes("offscreen.html"));
    } catch (_) {
        return false;
    }
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
        log.info('Background', 'Received START_ENGINE message', { targetWorkers: message.targetWorkers, hashSize: message.hashSize });
        chrome.storage.local.set({ isActive: true });
        setupOffscreenDocument("offscreen.html").then(() => {
            chrome.runtime.sendMessage({
                type: "CONFIGURE_POOL",
                targetWorkers: message.targetWorkers,
                hashSize: message.hashSize
            }).catch(() => {});
        });
        return false;
    }

    if (message.type === "STOP_ENGINE") {
        log.info('Background', 'Received STOP_ENGINE message');
        chrome.storage.local.set({ isActive: false });
        return false;
    }

    if (message.type === "NEW_POSITION") {
        chrome.storage.local.get(
            ["isActive", "elo", "targetWorkers", "hashSize", "increment", "searchSpeed"],
            (result) => {
                if (result.isActive === false) {
                    log.debug('Background', 'Engine is inactive, dropping NEW_POSITION');
                    sendResponse({ bestMove: null });
                    return;
                }

                const elo = result.elo || 3000;
                const workerCount  = Math.min(16, Math.max(1, result.targetWorkers || ((navigator.hardwareConcurrency || 4) - 1)));
                const hashSize     = result.hashSize || 128;
                const searchSpeed  = result.searchSpeed || "auto";

                const increment    = result.increment || 0;
                const my_ms = message.my_ms || 0;
                const opp_ms = message.opp_ms || 0;
                const inc_ms = message.inc_ms || 0;
                const gameMode = message.gameMode || "";
                const movesToGo = 0;

                const normFen      = normalizeFen(message.fen);
                const pieceCount   = normFen.split(' ')[0].replace(/[\/0-9]/g, '').length;

                log.info('Background', `NEW_POSITION received: turn=${message.isMyTurn} clock=${message.timeLeft}s my_ms=${my_ms}ms mode=${gameMode} speed=${searchSpeed} workers=${workerCount} hash=${hashSize}MB pieces=${pieceCount}`);
                log.debug('Background', `FEN: ${message.fen}`);

                const fallbackToEngine = () => {
                    if (message.isMyTurn && MASTER_BOOK[normFen]) {
                        const bookMove = MASTER_BOOK[normFen];
                        log.info('Background', `Played master book move: ${bookMove}`);
                        const stats = { bestMove: bookMove, pv: [bookMove], score: 0, depth: 1, nodes: 1, timeMs: 5 };
                        chrome.storage.local.set({ engineStats: stats });
                        sendResponse(stats);
                        return;
                    }

                    // Directly dispatch to offscreen SMP engine — utilizes embedded Polyglot master book and SF14 NNUE
                    callOffscreenEngine(message.fen, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, message.isMyTurn, message.history, hashSize, sendResponse, searchSpeed, gameMode);
                };

                if (pieceCount <= 7) {
                    // Check local memory cache first (0ms instantaneous lookup)
                    if (SYZYGY_CACHE.has(message.fen)) {
                        const cached = SYZYGY_CACHE.get(message.fen);
                        log.info('Background', `Played cached syzygy TB move: ${cached.bestMove}`);
                        chrome.storage.local.set({ engineStats: cached });
                        sendResponse(cached);
                        return;
                    }

                    // Strict Clock Guard: Only make network tablebase requests if we have at least 3 seconds (my_ms >= 3000) or untimed/bot games (my_ms === 0).
                    // In Bullet or time scrambles, network latency risks flagging on time.
                    if (my_ms >= 3000 || my_ms === 0) {
                        const tbTimeout = my_ms === 0 ? 1200 : Math.min(600, Math.floor(my_ms / 6));
                        fetchWithTimeout(
                            "https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(message.fen),
                            {},
                            tbTimeout
                        )
                            .then((r) => r.json())
                            .then((data) => {
                                if (data && data.moves && data.moves.length > 0) {
                                    log.info('Background', `Played syzygy TB move: ${data.moves[0].uci}`);
                                    const tbScore = data.category === "win" ? 29000 : data.category === "loss" ? -29000 : 0;
                                    const stats = {
                                        bestMove: data.moves[0].uci,
                                        pv: [data.moves[0].uci],
                                        score: tbScore,
                                        depth: 99,
                                        nodes: 1,
                                        timeMs: 50,
                                    };
                                    SYZYGY_CACHE.set(message.fen, stats);
                                    chrome.storage.local.set({ engineStats: stats });
                                    sendResponse(stats);
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
                }

                fallbackToEngine();
            }
        );
        return true; 
    }
});

function calculateSearchBudget(my_ms, inc_ms, speedMode = "auto", gameMode = "") {
    const inc = inc_ms || 0;

    // Explicit user speed presets
    if (speedMode === "bullet") {
        return { searchTimeMs: 400, maxTimeMs: 700 };
    }
    if (speedMode === "blitz") {
        return { searchTimeMs: 2000, maxTimeMs: 3000 };
    }
    if (speedMode === "rapid") {
        return { searchTimeMs: 6500, maxTimeMs: 9000 };
    }
    if (speedMode === "untimed") {
        return { searchTimeMs: 3200, maxTimeMs: 4800 };
    }

    // Auto-adaptive calculation:
    // If no clock info (e.g. Chess.com Bot games, puzzles, untimed):
    if (!my_ms || my_ms <= 0) {
        // 2800ms gives depth 17-20 with 8M-16M nodes on modern multi-worker WASM.
        // Crushes 2600-2700 GM bots with precision.
        return { searchTimeMs: 2800, maxTimeMs: 4200 };
    }

    // Panic / Hyper-bullet / Time scramble (<= 15s remaining)
    if (my_ms <= 15000) {
        const target = Math.min(250, Math.max(80, (my_ms / 25) + inc * 0.6));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.25) };
    }

    // Time scramble (15s - 35s remaining)
    if (my_ms <= 35000) {
        const target = Math.min(500, Math.max(180, (my_ms / 28) + inc * 0.7));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.3) };
    }

    // Bullet (35s - 75s)
    if (my_ms <= 75000) {
        const target = Math.min(950, Math.max(300, (my_ms / 32) + inc * 0.75));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.3) };
    }

    // Fast Blitz (1m 15s - 3m)
    if (my_ms <= 180000) {
        const target = Math.min(2400, Math.max(800, (my_ms / 35) + inc * 0.8));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.35) };
    }

    // Blitz (3m - 5m)
    if (my_ms <= 300000) {
        const target = Math.min(4000, Math.max(1400, (my_ms / 38) + inc * 0.8));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.35) };
    }

    // Rapid (5m - 10m)
    // In a 10-minute game, 5s - 8s per move lets the engine search 18-22 ply deep
    if (my_ms <= 600000) {
        const target = Math.min(8000, Math.max(3000, (my_ms / 40) + inc * 0.85));
        return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.4) };
    }

    // Classical (> 10 min)
    const target = Math.min(12000, Math.max(4500, (my_ms / 45) + inc * 0.85));
    return { searchTimeMs: Math.round(target), maxTimeMs: Math.round(target * 1.4) };
}

/**
 * Dispatches a search request to the offscreen SMP engine with an aligned time budget.
 */
function callOffscreenEngine(
    fen,
    my_ms, opp_ms, inc_ms, movesToGo,
    elo,
    workerCount,
    isMyTurn,
    history,
    hashSize,
    sendResponse,
    searchSpeed = "auto",
    gameMode = ""
) {
    resetOffscreenIdleTimeout();
    const budget = calculateSearchBudget(my_ms, inc_ms, searchSpeed, gameMode);

    setupOffscreenDocument("offscreen.html").then(() => {
        let responded = false;
        const failsafeTimeout = setTimeout(() => {
            if (!responded) {
                responded = true;
                log.warn('Background', 'Offscreen document timed out — falling back to single worker');
                runFallbackWorker(fen, my_ms, opp_ms, inc_ms, movesToGo, elo, history, hashSize, isMyTurn, sendResponse, workerCount);
            }
        }, Math.max(5000, (budget.maxTimeMs || 2500) + 3000));

        chrome.runtime.sendMessage(
            {
                type: "START_SMP_SEARCH",
                fen,
                searchTimeMs: budget.searchTimeMs,
                maxTimeMs: budget.maxTimeMs,
                my_ms, opp_ms, inc_ms, movesToGo,
                elo,
                activeWorkerCount: workerCount,
                isMyTurn,
                history,
                hashSize,
            },
            (response) => {
                if (responded) return;
                responded = true;
                clearTimeout(failsafeTimeout);

                if (chrome.runtime.lastError) {
                    log.warn('Background', `Offscreen error (sending to fallback): ${chrome.runtime.lastError.message}`);
                    runFallbackWorker(fen, my_ms, opp_ms, inc_ms, movesToGo, elo, history, hashSize, isMyTurn, sendResponse, workerCount);
                    return;
                }
                handleSearchResponse(response, isMyTurn, sendResponse, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, history, hashSize);
            }
        );
    }).catch((e) => {
        log.error('Background', 'Offscreen setup failed, routing to fallback', e);
        runFallbackWorker(fen, my_ms, opp_ms, inc_ms, movesToGo, elo, history, hashSize, isMyTurn, sendResponse, workerCount);
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

function runFallbackWorker(fen, my_ms, opp_ms, inc_ms, movesToGo, elo, history, hashSize, isMyTurn, sendResponse, workerCount) {
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
        fallbackWorker.postMessage({ type: "INIT" });
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
                timeMs: e.data.timeMs !== undefined ? e.data.timeMs : my_ms,
            };
            handleSearchResponse(response, isMyTurn, sendResponse, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, history, hashSize);
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

    const fallbackBudget = calculateSearchBudget(my_ms, inc_ms);
    const searchMessages = [
        {
            type: "SET_HASH_SIZE",
            size: hashSize
        },
        {
            type: "SEARCH",
            fen,
            searchTimeMs: fallbackBudget.searchTimeMs,
            maxTimeMs: fallbackBudget.maxTimeMs,
            my_ms, opp_ms, inc_ms, movesToGo, elo,
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

function handleSearchResponse(response, isMyTurn, sendResponse, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, history, hashSize) {
    if (isMyTurn) {
        if (response && response.score !== undefined) {
            chrome.storage.local.set({
                engineStats: {
                    score: response.score,
                    depth: response.depth,
                    nodes: response.nodes,
                    timeMs: response.timeMs !== undefined ? response.timeMs : 0,
                },
            });
        }
    }
    
    // Always respond once so the content script doesn't hang.
    if (sendResponse) sendResponse(response);
    // Background pondering disabled to prevent worker thread lockups and failsafe timeouts.
}


let ponderCache = {};
const AGGRESSIVE_BOOK = {
    // Englund Gambit
    "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq": "e7e5",
    "rnbqkbnr/pppp1ppp/8/4P3/8/8/PPP1PPPP/RNBQKBNR b KQkq": "b8c6",
    
    // Stafford Gambit
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq": "g8f6",
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq": "f3e5",
    "rnbqkb1r/pppp1ppp/5n2/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq": "b8c6",
    
    // Scholar's Mate Trap
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq": "c6d4",
    
    // Caro-Kann Fantasy Variation Trap
    "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/5P2/PPP3PP/RNBQKBNR b KQkq": "d5e4",
    "rnbqkbnr/pp2pppp/2p5/8/3Pp3/5P2/PPP3PP/RNBQKBNR w KQkq": "f3e4",
    "rnbqkbnr/pp2pppp/2p5/8/3PP3/8/PPP3PP/RNBQKBNR b KQkq": "e7e5"
};
let creatingOffscreen = false;

const normalizeFen = (f) => {
    if (!f) return "";
    return f.split(' ').slice(0, 3).join(' ');
};

async function setupOffscreenDocument(path) {
    if (await hasDocument()) {
        return;
    }
    if (creatingOffscreen) {
        await creatingOffscreen;
    } else {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.WORKERS || chrome.offscreen.Reason.DOM_SCRAPING],
            justification: 'Running SMP Web Workers for chess calculation'
        });
        await creatingOffscreen;
        creatingOffscreen = null;
    }
}

async function hasDocument() {
    const matchedClients = await clients.matchAll();
    return matchedClients.some(c => c.url.includes(chrome.runtime.id));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_ENGINE') {
    setupOffscreenDocument('offscreen.html');
  }
  
  if (message.type === 'NEW_POSITION') {
    chrome.storage.local.get(['isActive', 'elo', 'targetWorkers'], (result) => {
        if (!result.isActive) {
          console.log("[Background] Engine is disabled in storage. Ignoring.");
          sendResponse({ bestMove: null });
          return;
        }
        
        const currentElo = result.elo || 3000;
        const activeWorkerCount = result.targetWorkers || 4;
        const normFen = normalizeFen(message.fen);
        
        // Check Aggressive Opening Book first
        if (message.isMyTurn) {
            const fenParts = message.fen.split(' ');
            const bookKey = fenParts[0] + ' ' + fenParts[1] + ' ' + fenParts[2];
            if (AGGRESSIVE_BOOK[bookKey]) {
                const trapMove = AGGRESSIVE_BOOK[bookKey];
                console.log("[Background] TRAP TRIGGERED:", trapMove);
                sendResponse({ bestMove: trapMove, pv: [trapMove] });
                ponderCache = {};
                return;
            }
        }
        
        if (message.isMyTurn && ponderCache[normFen]) {
            console.log("[Background] PONDER HIT! INSTANT REPLY for", normFen, "->", ponderCache[normFen].bestMove);
            sendResponse({ bestMove: ponderCache[normFen].bestMove, pv: [ponderCache[normFen].bestMove] });
            ponderCache = {}; 
            return;
        }
        ponderCache = {};
        
        let engineTime = 1500;
        if (message.timeLeft !== null && message.timeLeft !== undefined) {
            let seconds = message.timeLeft;
            if (seconds < 10) engineTime = 100;
            else if (seconds < 30) engineTime = 400;
            else if (seconds < 60) engineTime = 1000;
            else if (seconds < 300) engineTime = 2500;
            else engineTime = 4000;
        } else {
            if (currentElo < 1000) engineTime = 300;
            else if (currentElo < 2000) engineTime = 1000;
            else engineTime = 2500; 
        }
        
        fetch("https://explorer.lichess.ovh/masters?fen=" + encodeURIComponent(message.fen), {
            headers: { "User-Agent": "ChessEngineV2-Ext (contact: dev@example.com)" }
        })
          .then(r => r.json())
          .then(data => {
            if (data.moves && data.moves.length > 0 && currentElo >= 1600 && message.isMyTurn) {
              sendResponse({ bestMove: data.moves[0].uci, pv: [data.moves[0].uci] });
            } else {
                fetch("https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(message.fen), {
                    headers: { "User-Agent": "ChessEngineV2-Ext (contact: dev@example.com)" }
                })
                .then(r => r.json())
                .then(tb => {
                  if (tb.moves && tb.moves.length > 0 && currentElo >= 2000 && message.isMyTurn) {
                    sendResponse({ bestMove: tb.moves[0].uci, pv: [tb.moves[0].uci] });
                  } else {
                    callOffscreenSMP(message.fen, engineTime, currentElo, activeWorkerCount, message.isMyTurn, sendResponse);
                  }
                }).catch(() => {
                    callOffscreenSMP(message.fen, engineTime, currentElo, activeWorkerCount, message.isMyTurn, sendResponse);
                });
            }
          }).catch(() => {
              callOffscreenSMP(message.fen, engineTime, currentElo, activeWorkerCount, message.isMyTurn, sendResponse);
          });
    });
    return true; 
  }
});

function callOffscreenSMP(fen, timeMs, currentElo, activeWorkerCount, isMyTurn, sendResponse) {
    setupOffscreenDocument('offscreen.html').then(() => {
        chrome.runtime.sendMessage({
            type: 'START_SMP_SEARCH',
            fen: fen,
            timeMs: timeMs,
            elo: currentElo,
            activeWorkerCount: activeWorkerCount
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[Background] Error calling offscreen:", chrome.runtime.lastError);
                sendResponse({ bestMove: null });
            } else {
                if (!isMyTurn && response && response.ponderFen && response.pv && response.pv.length >= 2) {
                    const nextNorm = normalizeFen(response.ponderFen);
                    ponderCache[nextNorm] = { bestMove: response.pv[1] };
                    console.log("[Background] Pondering finished. Cached expected reply for", nextNorm, "->", response.pv[1]);
                }
                sendResponse(response);
            }
        });
    });
}



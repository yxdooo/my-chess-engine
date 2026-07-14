let ponderCache = {};
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
        
        if (message.isMyTurn && ponderCache[normFen]) {
            console.log("[Background] PONDER HIT! INSTANT REPLY for", normFen, "->", ponderCache[normFen].bestMove);
            sendResponse({ bestMove: ponderCache[normFen].bestMove });
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
        
        fetch("https://explorer.lichess.ovh/masters?fen=" + encodeURIComponent(message.fen))
          .then(r => r.json())
          .then(data => {
            if (data.moves && data.moves.length > 0 && currentElo >= 1600 && message.isMyTurn) {
              sendResponse({ bestMove: data.moves[0].uci });
            } else {
                fetch("https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(message.fen))
                .then(r => r.json())
                .then(tb => {
                  if (tb.moves && tb.moves.length > 0 && currentElo >= 2000 && message.isMyTurn) {
                    sendResponse({ bestMove: tb.moves[0].uci });
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

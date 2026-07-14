'use strict';

// Web Worker entry point for the chess engine.
// Expects chess.js (which defines ChessGame and related globals) and engine.js
// to be in the same directory.
importScripts('./chess.js', './engine.js');

const engine = new ChessEngine({ ttSizeMb: 32 });

self.onmessage = function({ data }) {
  if (data.type === 'search') {
    const game = new ChessGame(data.fen);
    engine.getBestMove(game, {
      timeMs:     data.timeMs,
      depth:      data.depth,
      onProgress: (info) => self.postMessage({ type: 'progress', payload: info }),
    }).then(result => self.postMessage({ type: 'result', payload: result }));
  } else if (data.type === 'stop') {
    engine.stop();
  }
};

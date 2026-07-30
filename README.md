# Aether Chess Engine v2.2

**Aether** is a highly optimized, multi-threaded WebAssembly chess engine and Chrome extension written purely in Rust. With the v2.2 update, Aether transforms into a hybrid powerhouse combining **Deep Search Heuristics**, **Neural Networks (NNUE)**, and **Cloud Tablebases** for an estimated Elo of **3000+**.

## 🚀 Engine Features (v2.2)

- **Blazing-Fast WASM Core** – The entire chess engine is written in Rust and compiled to WebAssembly for near-native performance directly in your browser.
- **Offline NNUE Evaluation (New!)** – Replaced PeSTO Piece-Square Tables with a state-of-the-art **HalfKP Architecture NNUE**. Evaluates positions with neural precision. Works 100% offline via embedded `.nnue` binary loaded into WASM memory.
  - Features real-time **Incremental Delta Updates** for massive NPS boosts.
- **Endgame Mastery via Syzygy (New!)** – Integrates Lichess Syzygy Tablebases. For any position with 7 or fewer pieces, the engine intercepts the search and queries mathematically perfect mate/WDL moves in milliseconds.
- **Advanced Engine Heuristics** – 
  - **Futility Pruning (FP) & Reverse Futility Pruning (RFP)**
  - **ProbCut & Singular Extensions**
  - **History Malus, Countermove & Follow-up History Tables**
  - **Principal Variation Search (PVS/Negamax)** with strict Aspiration Windows.
  - **Null Move Pruning (NMP)** with verification to prevent zugzwang bugs.
  - **Static Exchange Evaluation (SEE)**
- **Transposition Table** – Multi-threaded WASM data-race free TT utilizing 64-bit atomic split XOR hashing (`Ordering::Acquire`/`Release`).

## 🛠️ Architecture & Chrome Extension

Aether isn't just an engine; it comes bundled with a powerful Chrome Extension that interacts directly with popular chess sites (e.g. Lichess).
- Built with **Manifest V3**.
- DOM Observers wrapped in `requestAnimationFrame` to prevent layout thrashing.
- Background worker acts as the central coordinator between the Offscreen Document (WASM Motor) and the Active Tab.

```
chess-engine/
├── chrome-ext/        Manifest V3 Extension (Content scripts, workers, UI)
├── build_prod.js      Production bundler & minifier script (esbuild)
├── package.json       NPM scripts and dependencies
└── engine-wasm/
    ├── src/lib.rs     Rust chess engine source (Bitboards, Negamax, SEE, Eval)
    ├── src/nnue.rs    Neural Network (HalfKP) implementation
    └── Cargo.toml     Rust dependencies
```

## 📦 Build Instructions

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable or nightly for WebAssembly)
- Node.js (for building the production bundle)
- wasm-pack

### Compile the Engine

```bash
# 1. Install dependencies
npm install

# 2. Build the production WASM and JS bundles
node build_prod.js
```

> **Note:** The `build_prod.js` script automatically invokes `wasm-pack` to compile the Rust engine, copies the generated WASM into the extension package, minifies the JS via esbuild, and outputs the production-ready extension into the `dist/` directory.

### Install in Chrome
1. Navigate to `chrome://extensions/`
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` directory.

## ⚖️ License

MIT License

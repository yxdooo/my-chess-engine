# Aether Chess Engine

**Aether** is a highly optimized, multi-threaded WebAssembly chess engine packaged as a Chrome Extension. It provides real-time best-move arrows directly on live chessboards on Chess.com and Lichess.

> [!WARNING]
> This engine is for educational and research purposes only. Using chess engines in live online games against other humans without their consent violates the Terms of Service of platforms like Chess.com and Lichess.

## 🚀 Features

- **Blazing-Fast WASM Core** – The entire chess engine is written in Rust and compiled to WebAssembly for near-native performance directly in your browser.
- **Lazy SMP (Symmetric Multiprocessing)** – Uses a dedicated Web Worker pool coordinated via Chrome's Offscreen API to distribute the search tree across multiple CPU cores.
- **PeSTO / NNUE Hybrid Evaluation** – Advanced evaluation combining piece-square tables (PeSTO), pawn structure analysis (isolated, doubled, passed pawns), king safety, and a real NNUE network as the primary evaluator.
- **Advanced Search Heuristics** – Iterative deepening with aspiration windows, Null Move Pruning, Reverse Futility Pruning, Razoring, Late Move Reductions, Killer/History move ordering, and Check Extensions.
- **Quiescence Search with TT** – Dedicated tactical resolution with Delta Pruning and transposition table integration.
- **Cloud Tablebase & Explorer** – Falls back seamlessly to the Lichess Masters Opening Explorer and Syzygy 7-man Tablebases for perfect play in openings and endgames.
- **Pondering** – Searches the opponent's expected position during their thinking time for instant replies.
- **Glassmorphic UI** – Premium dark-themed popup with controls for ELO strength, CPU core count, and hash table size.
- **Production Build Pipeline** – Obfuscated build via `javascript-obfuscator` for IP protection and minimal extension footprint.

## 🛠️ Architecture

```
chrome-ext/
├── manifest.json      Extension manifest (MV3)
├── background.js      Service worker – orchestrates analysis requests,
│                      manages offscreen document, fetches cloud data
├── content.js         Content script – parses board DOM, draws arrows,
│                      intercepts WebSocket FEN data
├── inject.js          MAIN-world script – patches WebSocket constructor
│                      to intercept live game messages
├── offscreen.html     Hidden DOM environment required for Web Workers
├── offscreen.js       SMP coordinator – distributes search across workers
├── worker.js          Worker thread – loads WASM engine, runs searches
├── popup.html/js      Extension popup UI
└── engine_wasm.*      Generated WASM glue files (from wasm-pack)

engine-wasm/
├── src/lib.rs         Rust chess engine source
├── Cargo.toml
└── nn-*.nnue          NNUE network weights (embedded via include_bytes!)
```

## 📦 Build Instructions

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js & NPM (v18+)

### 1. Compile the WASM Engine

```bash
cd engine-wasm
wasm-pack build --target web --release
```

### 2. Copy Generated Files to the Extension

```bash
cp pkg/engine_wasm.js ../chrome-ext/
cp pkg/engine_wasm_bg.wasm ../chrome-ext/
cp pkg/ ../chrome-ext/pkg/
```

> **Note:** `engine_wasm.js` and `engine_wasm_bg.wasm` are generated build artifacts and are not committed to source control. They must be generated from the Rust source before loading the extension.

### 3. Production Build (Obfuscation)

```bash
npm install
node build_prod.js
```

The script copies `chrome-ext/` to `dist/` and heavily obfuscates JavaScript source files using `javascript-obfuscator`. The `engine_wasm.js` and `worker.js` files are excluded from obfuscation (WASM glue and ES module imports are incompatible with the obfuscator).

## 🎮 Installation (End Users)

1. Download `Aether-Engine.zip` from the [Releases](../../releases) page.
2. Extract the zip into a folder on your computer.
3. Open Google Chrome and navigate to `chrome://extensions/`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the extracted folder.
6. Pin the extension, navigate to a chessboard on Chess.com or Lichess, set your desired strength, and click **Start Engine**.

## ⚖️ License

MIT License

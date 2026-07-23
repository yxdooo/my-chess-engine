# Aether Chess Engine

**Aether** is a highly optimized, multi-threaded WebAssembly chess engine packaged as a Chrome Extension. It provides real-time best-move arrows directly on live chessboards on Chess.com and Lichess, as well as full Auto-Play capabilities.

> [!WARNING]
> This engine is for educational and research purposes only. Using chess engines in live online games against other humans without their consent violates the Terms of Service of platforms like Chess.com and Lichess.

## 🚀 Features

- **Blazing-Fast WASM Core** – The entire chess engine is written in Rust and compiled to WebAssembly for near-native performance directly in your browser.
- **Lazy SMP (Symmetric Multiprocessing)** – Uses a dedicated Web Worker pool coordinated via Chrome's Offscreen API to distribute the search tree across multiple CPU cores.
- **Dual Modes (Analysis & Auto-Play)** – Choose between rendering best-move arrows (Analysis Mode) or letting the engine automatically play the best moves using pointer event simulation (Auto-Play Mode).
- **Advanced Engine Heuristics** – 
  - Iterative Deepening with strict Aspiration Windows (±25cp).
  - ProbCut (Probabilistic Cut) for deep pruning of statistically losing lines.
  - Static Exchange Evaluation (SEE) for tactical capture resolution and pruning.
  - Multi-Cut Pruning for rapid beta-cutoff detection.
  - Null Move Pruning, Reverse Futility Pruning, Razoring, and Late Move Reductions.
  - History Move Ordering with "gravity" (aging scores) to prevent stale moves.
- **PeSTO / NNUE Hybrid Evaluation** – Advanced evaluation combining piece-square tables (PeSTO), pawn structure analysis, king safety, and a real NNUE network.
- **Aggressive Opening Book** – Plays venomous gambits and traps (e.g., Stafford Gambit, Englund Gambit, Traxler) instantly without computing.
- **Cloud Tablebase & Explorer** – Falls back seamlessly to the Lichess Masters Opening Explorer and Syzygy 7-man Tablebases.
- **Real-Time Stats Panel** – Live display of engine Score (Centipawn/Mate), Depth, Nodes evaluated, and Time used.
- **Time Management** – Intelligent clock management supporting both base time and increment.

## 🛠️ Architecture

```
chrome-ext/
├── manifest.json      Extension manifest (MV3)
├── background.js      Service worker – orchestrates analysis, offscreen document, time logic
├── content.js         Content script – board DOM parsing, arrow rendering, auto-play simulation
├── inject.js          MAIN-world script – intercepts WebSocket FEN data
├── offscreen.html     Hidden DOM environment required for Web Workers
├── offscreen.js       SMP coordinator – distributes search across workers, aggregates stats
├── worker.js          Worker thread – loads WASM engine, runs searches
├── popup.html/js      Extension popup UI
└── engine_wasm.*      Generated WASM glue files (from wasm-pack)

engine-wasm/
├── src/lib.rs         Rust chess engine source
├── Cargo.toml
└── nn-*.nnue          NNUE network weights
```

## 📦 Build Instructions

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

### 1. Compile the WASM Engine

```bash
cd engine-wasm
wasm-pack build --target web --release
```

### 2. Copy Generated Files to the Extension

```bash
# In PowerShell:
Copy-Item "pkg\engine_wasm.js" -Destination "..\chrome-ext\"
Copy-Item "pkg\engine_wasm_bg.wasm" -Destination "..\chrome-ext\"
```

> **Note:** `engine_wasm.js` and `engine_wasm_bg.wasm` are generated build artifacts and are not committed to source control. They must be generated from the Rust source before loading the extension.

## 🎮 Installation

1. Clone or download this repository.
2. Build the WASM engine as described above.
3. Open Google Chrome and navigate to `chrome://extensions/`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the `chrome-ext/` folder.
6. Pin the extension, navigate to a chessboard on Chess.com or Lichess, set your desired strength and mode, and click **Start Engine**.

## ⚖️ License

MIT License

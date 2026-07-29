# Aether Chess Engine

**Aether** is a highly optimized, multi-threaded WebAssembly chess engine written purely in Rust. It utilizes modern bitboard operations, k-less transposition tables, and aggressive pruning techniques to achieve high performance.

## 🚀 Engine Features

- **Blazing-Fast WASM Core** – The entire chess engine is written in Rust and compiled to WebAssembly for near-native performance directly in your browser.
- **Lazy SMP (Symmetric Multiprocessing)** – Uses a dedicated Web Worker pool coordinated via a shared `TranspositionTable` backed by WebAssembly `SharedArrayBuffer` atomics to distribute the search tree across multiple CPU cores without locks.
- **Advanced Engine Heuristics** – 
  - **Principal Variation Search (PVS/Negamax)** with strict Aspiration Windows.
  - **Static Exchange Evaluation (SEE)** for tactical capture resolution, pruning, and check extension filtering.
  - **Logarithmic Late Move Reductions (LMR)** with history heuristic integration for aggressive forward pruning.
  - **Null Move Pruning (NMP)** with depth-1 verification search to prevent false horizon mates.
  - **Singular Extensions** with dynamic halfmove clock detection to strictly honor 50-move draws.
  - **Multi-Cut Pruning** for rapid beta-cutoff detection.
- **Positional Evaluation** – 
  - **O(1) Bitwise Pawn Structure Analysis** (Passed, Isolated, Doubled) for lightning-fast evaluation without looping.
  - **King Safety Tropism** punishing enemy proximity (Manhattan/Chebyshev distance) to the King.
  - **Rook Open/Semi-Open File Bonuses** and Bishop Pair synergies.
  - Tapered Evaluation combining piece-square tables (PeSTO) dynamically blending Midgame and Endgame weights based on material phase.
- **Transposition Table** – Lock-free, collision-resistant transposition tables utilizing upper 16-bit hash signatures.

## 🛠️ Architecture

```
chess-engine/
├── build_prod.js      Production bundler & minifier script (esbuild)
├── package.json       NPM scripts and dependencies
└── engine-wasm/
    ├── src/lib.rs     Rust chess engine source (Bitboards, Negamax, SEE, Eval)
    └── Cargo.toml     Rust dependencies (chess crate)
```

## 📦 Build Instructions

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- Node.js (for building the production bundle)

### Compile the Engine

```bash
# 1. Install dependencies
npm install

# 2. Build the production WASM and JS bundles
node build_prod.js
```

> **Note:** The `build_prod.js` script automatically invokes Cargo to compile the Rust engine into WebAssembly, optimizes it, and bundles the result into a `dist/` directory.

## ⚖️ License

MIT License

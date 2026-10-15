# Aether Chess Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-2021_Edition-orange.svg)](https://www.rust-lang.org/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-SIMD128-654FF0.svg)](https://webassembly.org/)
[![UCI Protocol](https://img.shields.io/badge/UCI-Compatible-lightgrey.svg)](https://en.wikipedia.org/wiki/Universal_Chess_Interface)

Aether is a modular, high-performance chess engine implemented in Rust, supporting both native desktop execution via the Universal Chess Interface (UCI) protocol and browser execution via WebAssembly (WASM) inside a Google Chrome Manifest V3 extension.

The engine pairs an alpha-beta search framework (Principal Variation Search) with a quantized Stockfish 14 HalfKP neural network (NNUE), accelerated by WebAssembly SIMD128 intrinsics, an atomic lock-free transposition table in shared linear memory, and multi-worker Lazy SMP thread orchestration.

Detailed algorithmic specifications, formulas, and data structures are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Performance and Strength

- **Estimated Rating**: ~2400–2600 CCRL under blitz and rapid time controls when running with the Stockfish 14 HalfKP neural network and 4-thread SMP.
- **Node Throughput**:
  - Native x86_64 desktop binary: ~800,000–1,500,000 NPS per core.
  - WebAssembly (SIMD128 enabled): ~350,000–700,000 NPS per worker thread in Chromium runtimes.
- **Transposition Table Efficiency**: Lock-free atomic 2-bucket cluster layout eliminates mutex contention in multi-threaded search.

---

## Key Features

### Evaluation
- **Stockfish 14 HalfKP NNUE**: Quantized $41{,}024 \to 256 \times 2 \to 32 \to 32 \to 1$ integer feedforward neural network.
- **Incremental Accumulators**: Fast feature accumulation updated via bitboard XOR differences during search plies.
- **Vectorized Inference**: WebAssembly SIMD128 vector instructions (`v128`, `i16x8_add`, `i16x8_sub`, `i16x8_extmul`, `i32x4_dot_i16x8`) on `wasm32`.
- **HalfKAv2 Infrastructure**: Integrated 32-bucket king-relative geometry with horizontal symmetry mapping for future model iterations.
- **Classical PeSTO Fallback**: Tapered midgame/endgame evaluation with piece-square tables, pawn structure evaluation, king safety zones, and a 131,072-entry lock-free pawn hash table.
- **Pawn Correction History**: 16,384-entry per-side table adjusting positional scores based on pawn hash keys.

### Search
- **Negamax / PVS**: Principal Variation Search with geometric aspiration windows ($\pm 50\text{ cp}$ initial delta).
- **Transposition Table**: Lock-free 64-bit atomic representation (`AtomicU64`) utilizing an XOR hash verification scheme (`stored_hash ^ stored_data == hash`) to prevent torn reads. Two-entry bucket cluster with depth-preferred and always-replace replacement policies.
- **Move Ordering**: TT move, Static Exchange Evaluation (SEE) positive captures, promotions, killer moves (2 plies), countermoves, butterfly history, follow-up history, and capture history.
- **Selectivity & Pruning**:
  - Reverse Futility Pruning (RFP / Static Null Move Pruning)
  - Null Move Pruning (NMP) with adaptive reduction ($R = 3 + \lfloor d/3 \rfloor$) and zugzwang verification
  - ProbCut with SEE thresholding
  - Futility Pruning (FP) and Quiet SEE Pruning
  - Late Move Pruning (LMP)
  - Singular Extensions at depth $\ge 8$ with multi-candidate fail-low verification
  - Check Extensions on PV nodes
  - Stockfish-tuned logarithmic Late Move Reductions (LMR)
- **Quiescence Search**: Tactical resolution with stand-pat bounds, delta pruning, and full SEE capture filtering.

### Concurrency & Multi-Threading
- **True Shared Memory SMP**: WebAssembly workers communicate across a unified linear memory instance (`WebAssembly.Memory({ shared: true })` backed by `SharedArrayBuffer`).
- **Root Move Splitting**: Main worker searches natural heuristic order; helper workers receive modulo-assigned root bonuses ($+500{,}000$) to explore disjoint subtrees and populate the shared TT without duplicate effort.
- **Result Aggregation & Outlier Rejection**: Discards lagging shallow search results ($\text{depth} < d_{\max} - 1$) to eliminate horizon-effect blunders from multi-worker race conditions.
- **UCI Persistent Thread Pool**: Spawns worker threads once at engine initialization, eliminating thread creation overhead between moves.

### Opening Book & Time Management
- **Polyglot Compliance**: Standard Polyglot Zobrist hashing (`POLYGLOT_RANDOM_ARRAY[781]`) with en-passant legality verification and binary bisection probing.
- **Embedded Master Book**: Built-in master opening book covering standard ECO A00–E99 grandmaster lines.
- **Custom Opening Books**: Supports loading external Polyglot `.bin` files dynamically via UCI options.
- **Dynamic Clock Allocator**: Allocates move budgets based on remaining time, increment, piece count scaling ($12 \dots 40$ moves to go), hard clock fraction ceilings ($30\%$ usable, $50\%$ absolute), and emergency fail-safe modes (< 2000 ms).
- **Search-Time Scaling**: Adjusts search time dynamically based on move stability, score drop, and easy-move detection.

---

## Project Structure

```
chess-engine/
├── ARCHITECTURE.md                 # Detailed technical architecture & formulas
├── README.md                       # Project overview and build documentation
├── build_prod.js                   # Production bundler & minifier script (esbuild)
├── build_master_polyglot_book.py   # Polyglot binary book compiler
├── package.json                    # Node.js dependencies & scripts
├── test_aggregation_suite.mjs     # Multi-worker aggregation test suite
├── verify_nnue_quality.py          # NNUE tactical & positional validation script
├── chrome-ext/                     # Manifest V3 Chrome Extension
│   ├── background.js               # Service worker (messaging, Syzygy API proxy)
│   ├── content.js                  # DOM observer, board state extractor, canvas overlay
│   ├── offscreen.html              # Offscreen document entry point
│   ├── offscreen.js                # Web Worker pool coordinator & result aggregator
│   ├── worker.js                   # WASM engine worker runner
│   ├── net.nnue                    # Embedded Stockfish 14 HalfKP neural network
│   ├── manifest.json               # Chrome Extension Manifest V3 configuration
│   └── popup.html / popup.js       # Extension configuration UI
└── engine-wasm/                    # Rust Engine Source
    ├── Cargo.toml                  # Rust crate configuration & dependencies
    ├── master_book.bin             # Compiled master opening book binary
    ├── src/
    │   ├── lib.rs                  # Core engine: Bitboards, Negamax, PVS, TT, SEE
    │   ├── nnue.rs                 # HalfKP & HalfKAv2 NNUE forward pass & SIMD128
    │   ├── polyglot.rs             # Polyglot hashing, reader, and binary search
    │   ├── timeman.rs              # Dynamic time management & clock allocation
    │   ├── book.rs                 # Static fallback opening lines
    │   └── bin/
    │       └── uci.rs              # Desktop Universal Chess Interface (UCI) binary
```

---

## Build Instructions

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+ recommended; nightly toolchain required for WASM target features `+simd128,+atomics,+bulk-memory`).
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (`cargo install wasm-pack`).
- [Node.js](https://nodejs.org/) (v18+ recommended).
- [Python 3](https://www.python.org/) with `python-chess` (for test scripts).

---

### Building the Desktop UCI Engine

Compile the native UCI executable using Cargo:

```bash
cd engine-wasm
cargo build --release --bin uci
```

The resulting binary will be located at:
- **Windows**: `engine-wasm/target/release/uci.exe`
- **Linux / macOS**: `engine-wasm/target/release/uci`

#### Running under Chess GUIs

Aether adheres strictly to the UCI protocol and can be loaded into any compliant chess GUI (e.g., Arena, Cutechess, BanksiaGUI, Fritz):

1. Open your chess GUI's engine management dialog.
2. Select **New Engine** and point to `engine-wasm/target/release/uci.exe`.
3. Configure available UCI options:
   - `Hash`: Transposition table size in megabytes (default: `64`, range: `1`–`2048`).
   - `Threads`: Number of search worker threads (default: `4`, range: `1`–`128`).
   - `BookFile`: Path to an optional external Polyglot `.bin` opening book.

---

### Building the Chrome Extension

To build the optimized WebAssembly binary and production extension bundle:

```bash
# 1. Install Node.js build dependencies
npm install

# 2. Build WASM with SIMD128 and bundle with esbuild
node build_prod.js
```

The build script invokes `wasm-pack` with target features `+simd128,+atomics,+bulk-memory`, copies all extension assets into the `dist/` folder, and minifies the JavaScript scripts in parallel.

#### Loading into Google Chrome

1. Navigate to `chrome://extensions/` in Chrome.
2. Enable **Developer mode** via the toggle in the upper-right corner.
3. Click **Load unpacked**.
4. Select the `dist/` directory inside this repository.

---

## Verification & Automated Testing

The codebase includes automated test suites covering move generation, search pruning heuristics, neural evaluation sanity, and multi-threaded worker aggregation.

### 1. Rust Unit and Regression Suite

Runs core engine unit tests, perft validation, static exchange evaluation, and Polyglot hash tests:

```bash
cargo test --target x86_64-pc-windows-msvc --manifest-path engine-wasm/Cargo.toml
```

**Test Coverage (15 tests passing, 0 failures)**:
- `timeman::tests::emergency_mode_below_two_seconds`: Validates clock budgeting when remaining time is critical.
- `timeman::tests::budget_never_exceeds_remaining_clock`: Ensures hard bounds on clock allocation.
- `polyglot::tests::test_polyglot_startpos_hash`: Bit-exact Polyglot Zobrist hash on standard starting position (`0x463b96181691fc9c`).
- `polyglot::tests::test_polyglot_known_fens`: Verifies Polyglot hashes against standard test suites.
- `polyglot::tests::test_probe_embedded_book`: Verifies move lookup from the embedded master book.
- `tests::test_see_basic`, `tests::test_see_losing_capture`: Bitboard Static Exchange Evaluation correctness.
- `tests::perft_start_position`, `tests::perft_kiwipete`: Move generation correctness on standard perft positions.
- `tests::test_nnue_accumulator_incremental_matches_refresh`: Confirms incremental feature accumulation exactly matches complete accumulator refreshes.

### 2. NNUE Quality Verification

Verifies positional and tactical evaluation behavior under the Stockfish 14 HalfKP neural network:

```bash
python verify_nnue_quality.py
```

**Results (4/4 tests passing, 100%)**:
- **Légal's Mate**: Identifies tactical mate-in-2 (`d5f6`, score $+28{,}997\text{ cp}$).
- **Giuoco Pianissimo**: Validates balanced opening evaluation within normal variance ($\approx 0\text{ cp}$).
- **Material Advantage**: Confirms material deficit penalties on Queen odds positions ($29\text{ cp}$ vs $2145\text{ cp}$).
- **Endgame Conversion**: Validates win detection in K+R vs K endgames ($+1846\text{ cp}$).

### 3. Multi-Worker Aggregation Suite

Validates worker aggregation, shallow blunder rejection, and tie-breaking logic:

```bash
node test_aggregation_suite.mjs
```

**Results (16/16 tests passing, 100%)**:
- **Horizon Effect Rejection**: Rejects shallow blunders (depth 4) in favor of deeper evaluations (depth 12).
- **Depth Dominance**: Ensures deeper completed iterations take precedence over higher scores from shallower depths.
- **MultiPV Deduplication**: Extracts clean, non-duplicated candidate lines across workers.

---

## UCI Command Reference

| Command | Arguments | Description |
|:---|:---|:---|
| `uci` | — | Identifies the engine and outputs supported options. |
| `isready` | — | Synchronizes host and engine, replies with `readyok`. |
| `setoption name Hash value <N>` | `N` in MB | Configures transposition table allocation size. |
| `setoption name Threads value <N>` | `N` in threads | Configures persistent search thread pool size. |
| `setoption name BookFile value <path>` | `<path>` | Loads an external Polyglot `.bin` opening book. |
| `ucinewgame` | — | Clears transposition tables, pawn caches, and history heuristics. |
| `position [startpos \| fen <FEN>] [moves ...]` | FEN, moves | Sets the board state and past move history. |
| `go [wtime <N>] [btime <N>] [winc <N>] [binc <N>] [movetime <N>]` | Clock settings | Initiates search with dynamic time allocation. |
| `quit` | — | Terminates worker threads and exits the engine. |

---

## License

This project is licensed under the [MIT License](LICENSE).

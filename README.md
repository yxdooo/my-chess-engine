# Chess Engine V2 - Chrome Extension

A highly optimized, multi-threaded WebAssembly (Rust) chess engine disguised as a Chrome Extension. Built specifically for providing real-time best move visual arrows directly on live chess boards like Chess.com.

## ?? Features
- **Blazing Fast Wasm Core:** The engine is written in Rust and compiled to WebAssembly. It easily reaches depths of 20+ within seconds.
- **SMP (Symmetric Multi-Processing):** Uses Chrome's `Offscreen Documents` and `Web Workers` to spawn up to 16 threads, bypassing typical extension sandbox limitations.
- **Pondering & Instant Abort:** Computes the opponent's best moves while they think (`ponderCache`) and can instantly abort and switch branches if the opponent plays an unexpected move.
- **Transposition Tables (TT):** Uses 1,000,000 TT entries for zero-latency move lookups.
- **Cloud Databases:** Uses Lichess Explorer (up to 1600 ELO) and Tablebases (up to 2000 ELO) for instant openings and endgames before switching to the brute-force Rust engine for midgame.
- **Board Overlay:** Seamlessly draws non-intrusive green arrows directly onto the DOM indicating the optimal move.

## ?? Repository Structure
- `/chrome-ext/`: The actual Chrome Extension source code. Load this folder into Chrome (`chrome://extensions` -> Load Unpacked).
- `/engine-wasm/`: The Rust source code that powers the engine. Includes a custom Alpha-Beta pruning algorithm with Null Move Pruning, Late Move Reductions, and Singular Extensions.
- `/web/`: An archive of the legacy standalone web interface.

## ?? Building the Wasm Module
If you wish to modify the Rust engine, you must recompile the Wasm module:
1. Ensure you have `Rust`, `Cargo`, and `wasm-pack` installed.
2. Navigate to `engine-wasm`: `cd engine-wasm`
3. Build the module into the extension directory: `wasm-pack build --target web --out-dir ../chrome-ext/pkg`

## ??? Installation
1. Go to `chrome://extensions/`
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Select the `chrome-ext` folder from this repository.
5. Open any match on Chess.com, click the extension icon, set your desired ELO, and click **Ignite Engine**.

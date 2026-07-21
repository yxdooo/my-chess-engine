# Chess Engine V2 - Chrome Extension

A highly optimized, multi-threaded WebAssembly (Rust) chess engine disguised as a Chrome Extension. Built specifically for providing real-time best move visual arrows directly on live chess boards like Chess.com.

## 🚀 Features
- **Blazing Fast Wasm Core (SIMD & NNUE):** The engine is written in Rust, compiled to WebAssembly with SIMD (+simd128) support, and powered by an NNUE/PeSTO hybrid evaluation function.
- **SMP (Symmetric Multi-Processing):** Uses Chrome's `Offscreen Documents` and `Web Workers` to spawn up to 16 threads, bypassing typical extension sandbox limitations.
- **Network Level FEN Interception:** By injecting an interceptor into the page, the extension grabs live WebSockets PGN/FEN strings directly from the network (bypassing brittle DOM scraping), guaranteeing 100% accuracy for En Passant and Move counters.
- **Dynamic Time Management:** Intelligently allocates calculation time, responding instantly on forced moves, and extending search times during complex tactical sequences (fail-low responses).
- **Pondering & Instant Abort:** Computes the opponent's best moves while they think (`ponderCache`) and can instantly abort and switch branches.
- **Cloud Databases:** Uses Lichess Explorer and Tablebases with API-compliant User-Agent headers for instant openings and endgames.

## 📂 Repository Structure
- `/chrome-ext/`: The Chrome Extension source code. Includes `inject.js` for WebSocket payload interception.
- `/engine-wasm/`: The Rust source code that powers the engine. Includes support for compiling with a `net.nnue` binary weight file via `include_bytes!`.
- `/web/`: An archive of the legacy standalone web interface.

## 🛠️ Building the Wasm Module
If you wish to modify the Rust engine, you must recompile the Wasm module:
1. Ensure you have `Rust`, `Cargo`, and `wasm-pack` installed.
2. *(Optional for NNUE)*: Replace the dummy `engine-wasm/src/net.nnue` file with a real HalfKP NNUE net file.
3. Navigate to `engine-wasm`: `cd engine-wasm`
4. Build the module with SIMD optimizations: `wasm-pack build --target web --out-dir ../chrome-ext/pkg`

## 📦 Installation
1. Go to `chrome://extensions/`
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Select the `chrome-ext` folder from this repository.
5. Open any match on Chess.com, click the extension icon, set your desired ELO, and click **Ignite Engine**.

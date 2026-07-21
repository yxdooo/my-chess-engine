# Aether Chess Engine

**Aether** is a highly optimized, multi-threaded WebAssembly (Rust) chess engine disguised as a Chrome Extension. Built specifically for providing real-time best move visual arrows directly on live chess boards like Chess.com.

> [!WARNING]
> This engine is for educational and research purposes only. Using chess engines in live online games against other humans without their consent violates the Terms of Service of platforms like Chess.com and Lichess.

## 🚀 Features

- **Blazing Fast WASM Core**: The entire chess engine is written in Rust and compiled to WebAssembly, ensuring near-native performance directly in your browser.
- **Lazy SMP (Symmetric Multiprocessing)**: Utilizes a dedicated Web Worker pool coordinated by Chrome's Offscreen API to distribute the search tree across multiple CPU cores.
- **PeSTO's Evaluation / Pseudo-NNUE**: Features an advanced handcrafted evaluation function combining piece-square tables, pawn structure analysis (isolated, doubled, passed pawns), and king safety.
- **Quiescence Search & TT**: Advanced search heuristics including Razoring, Check Extensions, and a dedicated Transposition Table (Hash) for resolving tactical skirmishes.
- **Cloud Tablebase & Explorer Integration**: Falls back seamlessly to Lichess Masters Explorer and 7-man Syzygy Tablebases for instant perfect play in the opening and endgame.
- **Glassmorphic UI**: Beautiful, premium dark-themed popup interface with granular controls over ELO strength, Core count, and Hash size.
- **Production Ready**: Fully obfuscated build pipeline for maximum IP protection and minimal extension size.

## 🛠️ Architecture

1. **`popup.js/html`**: The user interface for configuring engine settings.
2. **`background.js` (Service Worker)**: The orchestrator. It manages the connection between the active chess tab and the hidden offscreen document, passing FEN strings and fetching cloud data.
3. **`offscreen.html / offscreen.js`**: A hidden DOM environment necessary for spawning multiple Web Workers (since Chrome MV3 Service Workers cannot spawn dedicated workers).
4. **`worker.js`**: The worker thread that imports the WASM binary and executes the `search` function.
5. **`engine-wasm/`**: The core Rust crate containing the custom chess engine.

## 📦 Build Instructions

### Prerequisites
- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js & NPM

### 1. Compile the WASM Engine
Navigate to the `engine-wasm` directory and build the WebAssembly target:
```bash
cd engine-wasm
wasm-pack build --target web --release
```

### 2. Prepare the Extension
Copy the generated WASM files to the extension source folder:
```bash
cp pkg/engine_wasm.js ../chrome-ext/
cp pkg/engine_wasm_bg.wasm ../chrome-ext/
```

### 3. Production Build (Obfuscation)
Run the Node build script from the root directory to generate the production-ready `dist/` folder:
```bash
npm install
node build_prod.js
```
The script will strip `console.log` statements and heavily obfuscate the JavaScript source code using `javascript-obfuscator`.

## 🎮 Installation for End Users

1. Go to the main page of this repository and click on **`Aether-Engine.zip`**, then click the **Download** button (or click the raw download button).
2. Extract the downloaded `Aether-Engine.zip` file into a folder on your computer.
3. Open Google Chrome and navigate to `chrome://extensions/`
4. Enable **Developer mode** in the top right corner.
5. Click **Load unpacked** and select the extracted folder.
6. Pin the extension to your toolbar, navigate to a chessboard, set your desired strength, and click **Start Engine**.

## ⚖️ License
MIT License

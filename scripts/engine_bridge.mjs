import fs from "fs";`nimport { fileURLToPath } from "url";`nimport path from "path";`n`nconst ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import readline from "readline";
import initWasm, { ChessEngine } from "../chrome-ext/pkg/engine_wasm.js";

const wasmBytes = fs.readFileSync(path.join(ROOT, "chrome-ext/pkg/engine_wasm_bg.wasm"));
await initWasm({ module_or_path: wasmBytes });

const engine = new ChessEngine();
const netBytes = fs.readFileSync(path.join(ROOT, "chrome-ext/net.nnue"));
engine.load_network(new Uint8Array(netBytes));

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
        const req = JSON.parse(line);
        if (req.type === "MOVE") {
            const res = engine.get_best_move(
                req.fen,
                req.timeMs || 1000,
                req.elo || 3500,
                0,
                1,
                req.history || "",
                null
            );
            console.log(res);
        } else if (req.type === "PING") {
            console.log(JSON.stringify({ type: "PONG" }));
        }
    } catch (err) {
        console.error("Bridge Error:", err);
    }
});


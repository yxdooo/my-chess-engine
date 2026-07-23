/**
 * build_prod.js – Production Build Script
 *
 * Copies the chrome-ext source directory to dist/, then obfuscates all
 * JavaScript files except:
 *   - engine_wasm.js  (WASM glue – uses specific identifier names)
 *   - worker.js       (ES module imports are incompatible with obfuscator)
 *
 * Usage:
 *   npm install
 *   node build_prod.js
 *
 * Load the generated dist/ folder in Chrome via chrome://extensions > Load unpacked.
 */

const fs   = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const SRC_DIR  = path.join(__dirname, "chrome-ext");
const DIST_DIR = path.join(__dirname, "dist");

// Files that must NOT be obfuscated.
const OBFUSCATION_EXCLUSIONS = new Set(["engine_wasm.js", "worker.js"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively copies a directory tree from src to dest.
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath  = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Recursively obfuscates all eligible .js files in a directory.
 * Skips files listed in OBFUSCATION_EXCLUSIONS.
 * @param {string} directory
 */
function obfuscateDirectory(directory) {
    for (const file of fs.readdirSync(directory)) {
        const fullPath = path.join(directory, file);

        if (fs.statSync(fullPath).isDirectory()) {
            obfuscateDirectory(fullPath);
            continue;
        }

        if (!fullPath.endsWith(".js")) continue;
        if (OBFUSCATION_EXCLUSIONS.has(file)) {
            console.log(`  Skipped (excluded): ${file}`);
            continue;
        }

        const code = fs.readFileSync(fullPath, "utf8");

        const obfuscated = JavaScriptObfuscator.obfuscate(code, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.75,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.4,
            debugProtection: false,
            debugProtectionInterval: 0,
            disableConsoleOutput: true,
            identifierNamesGenerator: "hexadecimal",
            log: false,
            numbersToExpressions: true,
            renameGlobals: false,
            selfDefending: true,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 10,
            stringArray: true,
            stringArrayCallsTransform: true,
            stringArrayCallsTransformThreshold: 0.5,
            stringArrayEncoding: ["base64"],
            stringArrayIndexShift: true,
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayWrappersCount: 1,
            stringArrayWrappersChainedCalls: true,
            stringArrayWrappersParametersMaxCount: 2,
            stringArrayWrappersType: "variable",
            stringArrayThreshold: 0.75,
            unicodeEscapeSequence: false,
        }).getObfuscatedCode();

        fs.writeFileSync(fullPath, obfuscated);
        console.log(`  Obfuscated: ${file}`);
    }
}

// ---------------------------------------------------------------------------
// Build Steps
// ---------------------------------------------------------------------------

console.log("=== Aether Engine – Production Build ===\n");

// 1. Clean and copy source files.
if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
copyDir(SRC_DIR, DIST_DIR);
console.log(`[1/2] Copied source to dist/\n`);

// 2. Obfuscate eligible JavaScript files.
console.log("[2/2] Obfuscating JavaScript files...");
obfuscateDirectory(DIST_DIR);

console.log("\n✓ Production build complete. Load the dist/ folder in Chrome.");

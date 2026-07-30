/**
 * build_prod.js – Production Build Script
 *
 * Copies the chrome-ext source directory to dist/, then minifies all
 * JavaScript files using esbuild in parallel.
 *
 * Usage:
 *   npm install
 *   node build_prod.js
 *
 * Load the generated dist/ folder in Chrome via chrome://extensions > Load unpacked.
 */

const fs   = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const SRC_DIR  = path.join(__dirname, "chrome-ext");
const DIST_DIR = path.join(__dirname, "dist");

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
 * Recursively minifies all .js files in a directory using esbuild.
 * @param {string} directory
 */
async function minifyDirectory(directory) {
    const jsFiles = [];

    function findJs(dir) {
        for (const file of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                findJs(fullPath);
            } else if (fullPath.endsWith(".js")) {
                jsFiles.push(fullPath);
            }
        }
    }

    findJs(directory);

    try {
        await esbuild.build({
            entryPoints: jsFiles,
            outdir: directory,
            allowOverwrite: true,
            minify: true,
            target: 'es2020',
        });
        console.log(`  Successfully minified ${jsFiles.length} files in parallel.`);
    } catch (e) {
        console.error(`  Failed to minify files`, e);
    }
}

const { execSync } = require("child_process");

async function build() {
    console.log("=== Aether Engine – Production Build ===\n");

    console.log("[0/3] Building WebAssembly...");
    try {
        execSync("set RUSTUP_TOOLCHAIN=nightly&& wasm-pack build --target web --release", {
            cwd: path.join(__dirname, "engine-wasm"),
            stdio: "inherit",
            env: { ...process.env, RUSTUP_TOOLCHAIN: "nightly" }
        });
    } catch (e) {
        console.error("WASM build failed.");
        process.exit(1);
    }

    // 1. Copy compiled WASM to chrome-ext/pkg
    const WASM_PKG_DIR = path.join(__dirname, "engine-wasm", "pkg");
    const EXT_PKG_DIR = path.join(SRC_DIR, "pkg");
    if (!fs.existsSync(EXT_PKG_DIR)) fs.mkdirSync(EXT_PKG_DIR, { recursive: true });
    copyDir(WASM_PKG_DIR, EXT_PKG_DIR);
    console.log(`[1/3] Copied WASM pkg to chrome-ext/pkg\n`);

    // 2. Clean and copy source files.
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    copyDir(SRC_DIR, DIST_DIR);
    console.log(`[1/2] Copied source to dist/\n`);

    // 2. Minify JavaScript files.
    console.log("[2/2] Minifying JavaScript files...");
    await minifyDirectory(DIST_DIR);

    console.log("\n✓ Production build complete. Load the dist/ folder in Chrome.");
}

build().catch(console.error);

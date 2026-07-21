const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const srcDir = path.join(__dirname, 'chrome-ext');
const distDir = path.join(__dirname, 'dist');

// Copy directory recursively
function copyDir(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    
    let entries = fs.readdirSync(src, { withFileTypes: true });
    for (let entry of entries) {
        let srcPath = path.join(src, entry.name);
        let destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

console.log("Starting Production Build...");
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}
copyDir(srcDir, distDir);
console.log("Copied files to dist/");

// Obfuscate and clean JS files
function processDirectory(directory) {
    const files = fs.readdirSync(directory);
    for (const file of files) {
        const fullPath = path.join(directory, file);
        if (fs.statSync(fullPath).isDirectory()) {
            processDirectory(fullPath);
        } else if (fullPath.endsWith('.js') && !fullPath.includes('engine_wasm.js')) {
            // Read file
            let code = fs.readFileSync(fullPath, 'utf8');
            
            // Obfuscate
            const obfuscated = JavaScriptObfuscator.obfuscate(code, {
                compact: true,
                controlFlowFlattening: true,
                controlFlowFlatteningThreshold: 0.75,
                deadCodeInjection: true,
                deadCodeInjectionThreshold: 0.4,
                debugProtection: false,
                debugProtectionInterval: 0,
                disableConsoleOutput: true,
                identifierNamesGenerator: 'hexadecimal',
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
                stringArrayEncoding: ['base64'],
                stringArrayIndexShift: true,
                stringArrayRotate: true,
                stringArrayShuffle: true,
                stringArrayWrappersCount: 1,
                stringArrayWrappersChainedCalls: true,
                stringArrayWrappersParametersMaxCount: 2,
                stringArrayWrappersType: 'variable',
                stringArrayThreshold: 0.75,
                unicodeEscapeSequence: false
            }).getObfuscatedCode();
            
            fs.writeFileSync(fullPath, obfuscated);
            console.log(`Processed & Obfuscated: ${file}`);
        }
    }
}

processDirectory(distDir);
console.log("Production build finished successfully! Load the 'dist' folder in Chrome.");

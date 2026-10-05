import re

with open('build_prod.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('execSync("set RUSTUP_TOOLCHAIN=nightly&& wasm-pack build --target web --release"', '//execSync("set RUSTUP_TOOLCHAIN=nightly&& wasm-pack build --target web --release"')
text = text.replace('stdio: "inherit",', '//stdio: "inherit",')
text = text.replace('env: { ...process.env, RUSTUP_TOOLCHAIN: "nightly", RUSTFLAGS: "-C target-feature=+simd128,+atomics,+bulk-memory -C link-arg=--import-memory -C link-arg=--export-table -C link-arg=--max-memory=4294967296" }', '//env: { ...process.env, RUSTUP_TOOLCHAIN: "nightly", RUSTFLAGS: "-C target-feature=+simd128,+atomics,+bulk-memory -C link-arg=--import-memory -C link-arg=--export-table -C link-arg=--max-memory=4294967296" }')
text = text.replace('});', '//});')

with open('build_prod.js', 'w', encoding='utf-8') as f:
    f.write(text)

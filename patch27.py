import re

with open('build_prod.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('execSync("set RUSTUP_TOOLCHAIN=nightly&& wasm-pack build --target web --release"', '//execSync("set RUSTUP_TOOLCHAIN=nightly&& wasm-pack build --target web --release"')

with open('build_prod.js', 'w', encoding='utf-8') as f:
    f.write(text)

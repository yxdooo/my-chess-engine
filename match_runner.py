"""Convenience entry point for the clocked Aether vs Stockfish match harness.

The implementation lives in `engine-wasm/tourney.py`. The engine receives the real
game history through UCI `position ... moves ...`, which `uci.rs` converts into the
`|`-joined normalized FEN contract used by the Rust engine for repetition detection.

Usage:
    python match_runner.py --tc all --games 6
"""

import os
import runpy
import sys

TOURNEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine-wasm", "tourney.py")

if __name__ == "__main__":
    sys.argv[0] = TOURNEY_PATH
    runpy.run_path(TOURNEY_PATH, run_name="__main__")


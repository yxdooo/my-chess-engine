# Phase 6 Bugfixes
Completed the following changes in `engine-wasm/src/lib.rs`:
1. Updated `see_value` to set `captured_val = 0` when `board.piece_on(dest)` is `None`, instead of returning 0.
2. Updated `see_value` to use `piece_value(prom)` for the `attacker_val` if `m.get_promotion()` is `Some(prom)`, and added the material gain (`prom_val - pawn_val`) to `captured_val`.
3. Modified `is_singular_move` to take `halfmove_clock` as an argument. Inside the search loop, it now calculates `next_halfmove` dynamically.
4. Changed `negamax` verification search to use `depth - 1` instead of `reduced_depth` when `null_score >= MATE - 128`.

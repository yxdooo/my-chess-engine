# Measured baseline (v2.3.1, before time-management work)

Harness: `python tourney.py --tc <base+inc> --games <n>` (from `engine-wasm/`),
Aether native `uci.exe` vs Stockfish `UCI_LimitStrength=true`, `UCI_Elo=2500`,
real clocks, random 4-ply openings, colors alternated.

| Time control | Games | Aether score | Aether flag losses |
|--------------|-------|--------------|--------------------|
| 1+0          | 4     | 0.0 / 4      | 4                  |
| 3+0          | 2     | 0.0 / 2      | 2                  |
| 5+0          | 2     | 0.0 / 2      | 1                  |

Diagnosis: `uci.rs` allocates `remaining / movestogo`, but the search only stops at
the hard limit (3x the budget), so Aether spends 5-6 s per move at 1+0 and flags.
Clock-aware time management is addressed in Step 2.

Sample sizes are small and only meant as a before/after reference; use more games
for statistically meaningful comparisons.

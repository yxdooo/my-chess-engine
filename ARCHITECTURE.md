# Aether Chess Engine: Technical Architecture and System Design

## 1. System Overview

Aether is a modular, high-performance chess engine implemented in Rust, targeting both native desktop execution (x86_64/ARM64) via the Universal Chess Interface (UCI) protocol and in-browser execution via WebAssembly (WASM) inside a Google Chrome Manifest V3 extension.

The engine combines an alpha-beta search algorithm (Principal Variation Search) with neural evaluation based on the Stockfish 14 HalfKP architecture, supplemented by bitboard-based move generation, static exchange evaluation (SEE), an atomic lock-free transposition table, and dynamic time management.

```
+-------------------------------------------------------------------------------+
|                                Host Environment                               |
|                                                                               |
|  [ Chrome Extension MV3 ]                         [ Desktop UCI Environment ] |
|  - Content Script (DOM Observer, Board State)     - Arena / Cutechess / GUI   |
|  - Service Worker (Messaging, Syzygy Proxy)       - Stdin / Stdout UCI loop   |
|  - Offscreen Document (Worker Pool Orchestrator)  - Persistent Worker Pool    |
+---------------------------------------+---------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
|                            Aether Core Engine (Rust)                          |
|                                                                               |
|  [ Search Engine ]                                [ Evaluation Subsystem ]    |
|  - Negamax / PVS with Aspiration Windows          - Stockfish 14 HalfKP NNUE  |
|  - Quiescence Search + Delta Pruning              - HalfKAv2 Bucket Support   |
|  - Pruning: RFP, NMP, ProbCut, Futility, LMP      - Classical PeSTO Fallback  |
|  - Reductions & Extensions: LMR, Singular, Check  - Pawn Structure & Safety   |
|                                                                               |
|  [ Memory & Concurrency ]                         [ Opening & Time Control ]  |
|  - AtomicU64 Lock-Free Transposition Table        - Polyglot Hash & Reader    |
|  - AtomicU64 Pawn Hash Table                      - Embedded ECO Master Book  |
|  - True Shared Memory SMP (WASM & Native)         - Dynamic Clock Allocator   |
+-------------------------------------------------------------------------------+
```

---

## 2. Evaluation Subsystem

The engine supports dual evaluation backends: an incremental neural network (NNUE) based on the Stockfish 14 HalfKP architecture (with architectural support for HalfKAv2 king bucketing), and a classical evaluation function with tapered piece-square tables and pawn hashing.

### 2.1 NNUE Architecture

The primary evaluation network utilizes a quantized integer feedforward topology.

#### Network Topologies

1. **HalfKP (Default SF14 Architecture)**:
   - **Input Dimension**: $41{,}024$ features ($64\text{ king squares} \times 641\text{ piece-square features}$).
   - **Accumulator Dimension**: $256$ units per perspective (White and Black), total $512$ inputs to the hidden layers.
   - **Hidden Layers**: Fully connected layers of size $512 \to 32 \to 32 \to 1$.
   - **Feature Index Calculation**:
     $$\text{feature}_{\text{white}} = K_w \times 641 + 1 + P_{\text{code}} \times 64 + S$$
     $$\text{feature}_{\text{black}} = (K_b \oplus 63) \times 641 + 1 + \text{flip}(P_{\text{code}}) \times 64 + (S \oplus 63)$$
     where $K_w$ and $K_b$ denote the king squares for White and Black, $S$ denotes the piece square index ($0 \dots 63$), and $P_{\text{code}}$ indexes piece type and color.

2. **HalfKAv2 (King-Bucketed Architecture)**:
   - **Input Dimension**: $22{,}528$ features ($32\text{ king buckets} \times 704\text{ piece-square features}$).
   - **King Buckets**: 32 distinct geometric regions with horizontal symmetry mapping (`KING_BUCKETS` and `ORIENT_TBL`).
   - Enables partial accumulator reuse when the king moves within the same spatial bucket.

#### Incremental Feature Accumulation

During tree search, piece moves are represented as bitboard XOR differences:
$$\Delta_{\text{board}} = \text{bb}_{\text{old}} \oplus \text{bb}_{\text{new}}$$

- For non-king moves, features are added or subtracted incrementally from the previous ply accumulator:
  $$\text{Acc}_{ply+1} = \text{Acc}_{ply} + \sum W_{\text{added}} - \sum W_{\text{removed}}$$
- On x86_64 and native platforms, vector operations use standard arithmetic.
- On `wasm32`, vector accumulation is accelerated via WASM SIMD128 intrinsics:
  ```rust
  // 128-bit SIMD vector addition (8 x i16)
  let a = v128_load(acc_ptr);
  let w = v128_load(w_ptr);
  v128_store(acc_ptr, i16x8_add(a, w));
  ```
- If a king moves across bucket boundaries (or in HalfKP, changes square), a full accumulator refresh is computed directly from board occupancy.

#### Layer Feedforward & Quantization

The forward pass transforms the dual perspective accumulators into a scalar centipawn score:
1. **Input Layer**: Activations are clamped to the range $[0, 127]$ (clipped ReLU):
   $$\mathbf{x} = \text{clamp}(\text{Acc}, 0, 127)$$
2. **Layer 0 ($512 \to 32$)**: Computed via SIMD dot-products (`i16x8_extmul` and `i32x4_dot_i16x8` under WASM SIMD128):
   $$\mathbf{h}_0 = \text{clamp}\left(\frac{\mathbf{W}_0 \mathbf{x} + \mathbf{b}_0}{64}, 0, 127\right)$$
3. **Layer 1 ($32 \to 32$)**:
   $$\mathbf{h}_1 = \text{clamp}\left(\frac{\mathbf{W}_1 \mathbf{h}_0 + \mathbf{b}_1}{64}, 0, 127\right)$$
4. **Output Layer ($32 \to 1$)**:
   $$\text{score} = \frac{\mathbf{W}_2 \mathbf{h}_1 + b_2}{16}$$

### 2.2 Classical Fallback Evaluation (PeSTO)

If no NNUE file is loaded, the engine falls back to an optimized classical evaluation function:
- **Tapered Piece-Square Tables (PeSTO)**: Blends midgame and endgame valuations linearly based on non-pawn phase material:
  $$\text{phase} = \sum_{p \in \text{pieces}} \text{PhaseWeight}(p) \quad (\text{range } 0 \dots 24)$$
  $$\text{Eval}_{\text{base}} = \frac{\text{Eval}_{\text{mg}} \times \text{phase} + \text{Eval}_{\text{eg}} \times (24 - \text{phase})}{24}$$
- **Pawn Structure Evaluation**: Evaluates passed pawns, isolated pawns, doubled pawns, phalanxes, backward pawns, and rook alignment behind passers. Scores are cached in a dedicated 131,072-entry atomic lock-free `PawnHashTable`.
- **King Safety**: Assesses pawn shelter, open file exposure near the king, and virtual king attack zones scaled by attacking piece count.
- **Pawn Correction History**: A $2 \times 16{,}384$ entry table indexing positional pawn hashes to correct static evaluation based on search outcomes:
  $$\text{PawnCorr}[stm][\text{hash} \ \& \ 16383] \mathrel{+}= \frac{(\text{score}_{\text{search}} - \text{eval}_{\text{static}}) \times 16 - \text{entry}}{128}$$

---

## 3. Search Engine Architecture

Search operates under a Negamax formulation of Principal Variation Search (PVS) with iterative deepening, aspiration windows, and transposition table cutoffs.

### 3.1 Iterative Deepening & Aspiration Windows

Search proceeds in iterative depth increments ($d = 1, 2, 3, \dots$).
- For depths $d > 4$, search bounds are initialized to an aspiration window centered on the prior iteration's score:
  $$\alpha = \text{score}_{d-1} - \delta, \quad \beta = \text{score}_{d-1} + \delta \quad (\delta_{\text{initial}} = 50\text{ cp})$$
- If a search fails low ($\text{score} \le \alpha$) or fails high ($\text{score} \ge \beta$), $\delta$ is widened geometrically by $1.5\times$:
  $$\delta \leftarrow \delta + \lfloor\delta / 2\rfloor$$
- If $\delta > 2{,}000$, search falls back to $(-\infty, +\infty)$ to guarantee convergence.

### 3.2 Transposition Table (TT)

The transposition table is structured to support multi-threaded concurrent access without mutex locks or thread synchronization overhead.

#### Lock-Free Data-Race-Free Layout
Each entry comprises two 64-bit atomic words (`AtomicU64`):
```rust
struct TTEntry {
    hash: AtomicU64,
    data: AtomicU64,
}
```
`data` is packed into a single 64-bit integer:
- Bits $0 \dots 15$: Best move ($16$ bits: source square $6$b, destination square $6$b, promotion $4$b).
- Bits $16 \dots 31$: Score ($16$-bit signed integer, adjusted for mate distance).
- Bits $32 \dots 37$: Search depth ($6$ bits, $0 \dots 63$).
- Bits $38 \dots 39$: Bound flag ($2$ bits: `EXACT`, `LOWERBOUND`, `UPPERBOUND`).
- Bits $40 \dots 47$: Search generation age ($8$ bits).

#### XOR Hash Verification Scheme
To prevent torn reads across simultaneous writer threads:
- **Write**: `entry.data.store(data, Ordering::Relaxed); entry.hash.store(hash ^ data, Ordering::Release);`
- **Read**: `data = entry.data.load(Ordering::Relaxed); if (entry.hash.load(Ordering::Acquire) ^ data) == hash { ... }`

#### Two-Bucket Cluster Replacement
Entries are grouped into 2-slot buckets (total 32 bytes per bucket):
1. **Slot 0 (Depth-Preferred)**: Replaced if the slot is empty, shares the same key, has depth $\ge \text{old\_depth}$, or belongs to an older generation with $\text{depth} + 4 \ge \text{old\_depth}$. When displaced by a different key, the prior entry is demoted to Slot 1.
2. **Slot 1 (Always-Replace)**: Overwritten on every collision that cannot claim Slot 0.

### 3.3 Move Ordering Pipeline

Moves are scored and sorted dynamically to maximize beta-cutoffs on the first examined branch:

| Priority | Category | Score Range | Description |
|:---:|:---|:---:|:---|
| **1** | TT Best Move | $10{,}000{,}000$ | Move retrieved from the Transposition Table. |
| **2** | Winning / Equal Captures | $100{,}000 \dots 120{,}000$ | $\text{SEE} \ge 0$, sorted by MVV-LVA + Capture History. |
| **3** | Queen Promotions | $95{,}000$ | Uncontested pawn promotions to Queen. |
| **4** | Killer Move 1 | $80{,}000$ | Quiet move causing beta-cutoff at the same ply. |
| **5** | Killer Move 2 | $75{,}000$ | Secondary quiet killer move at the same ply. |
| **6** | Countermove | $70{,}000$ | Move historically refuting opponent's previous move. |
| **7** | Quiet History Moves | $-40{,}000 \dots +40{,}000$ | Butterfly History + Follow-up History (clamped). |
| **8** | Losing Captures | $-50{,}000 \dots -30{,}000$ | $\text{SEE} < 0$, sorted by MVV-LVA + Capture History. |

### 3.4 Pruning and Reduction Heuristics

The search applies hierarchical pruning in pre-move and in-move stages:

1. **Reverse Futility Pruning (RFP / Static Null Move Pruning)**:
   - At non-PV nodes with depth $d \le 6$ and not in check:
   - If $\text{static\_eval} - 75 \times d \ge \beta$, return $\text{static\_eval}$.

2. **Null Move Pruning (NMP)**:
   - At non-PV nodes with depth $d \ge 3$, static evaluation $\ge \beta$, and sufficient non-pawn material:
   - Reduction: $R = 3 + \lfloor d / 3\rfloor + \min\left(3, \left\lfloor\frac{\text{static\_eval} - \beta}{200}\right\rfloor\right)$.
   - Zugzwang verification: If $R$-reduced search score $\ge \text{MATE} - 128$, a verification search at depth $d - 1$ confirms the score.

3. **ProbCut**:
   - At non-PV nodes with depth $d \ge 5$ and $\beta < \text{MATE} - 128$:
   - For captures with $\text{SEE} \ge \text{bound} - \text{static\_eval}$ where $\text{bound} = \beta + 200$:
   - Executes a shallow search at depth $d - 4$; if score $\ge \text{bound}$, cut off immediately.

4. **Futility Pruning (FP)**:
   - At non-PV nodes with depth $d \le 4$, quiet moves after the first evaluated move are skipped if:
     $$\text{static\_eval} + (80 + 100 \times d) \le \alpha$$

5. **Quiet SEE Pruning**:
   - For quiet moves at depth $d \le 3$, if $\text{SEE}(m) < -50 \times d$, the move is pruned.

6. **Late Move Pruning (LMP)**:
   - Quiet moves examined after a depth-dependent move threshold are skipped:
     $$\text{LMP\_Table} = [0, 8, 16, 28, 45, 65] \quad (\text{for } d \le 5)$$

7. **Singular Extensions**:
   - At depth $d \ge 8$, if the TT move has depth $\ge d - 3$ and bound $\ne \text{UPPERBOUND}$:
   - Searches all non-TT moves at depth $s_d = \lfloor(d - 1) / 2\rfloor$ against margin $s_\beta = \text{score}_{\text{TT}} - (15 + 2 \times d)$.
   - If all alternative candidate moves fail low ($< s_\beta$), the TT move is singularly superior and extended by $+1$ ply.

8. **Late Move Reductions (LMR)**:
   - Applied to quiet, non-checking moves examined after the first 3 moves at depth $d \ge 3$:
     $$R = 0.75 + \frac{\ln(d) \times \ln(m)}{1.95}$$
   - Reduced by $1$ on PV nodes, on killer moves, or when history score $> 4{,}000$.
   - Increased by $1$ when history score $< -4{,}000$.

9. **Quiescence Search**:
   - Resolves tactical sequences until quiet. Incorporates stand-pat evaluation, delta pruning ($\text{stand\_pat} + 1{,}225 < \alpha$), and full SEE filtering.

---

## 4. Multi-Threading & SMP Architecture

Aether implements Shared Memory Multi-Processing (SMP) without mutex locking across threads.

```
                                  [ Shared Linear Memory ]
                         +----------------------------------------+
                         |  Global Transposition Table (Atomic)   |
                         |  Global Pawn Hash Table (Atomic)       |
                         +-------------------+--------------------+
                                             |
                     +-----------------------+-----------------------+
                     |                       |                       |
                     v                       v                       v
             [ Worker 0 (Main) ]     [ Worker 1 (Helper) ]   [ Worker N (Helper) ]
             - Depth: d              - Depth: d + (id % 2)   - Depth: d + (id % 2)
             - Root: Natural order   - Root: Modulo bonus    - Root: Modulo bonus
```

### 4.1 True Shared Memory WebAssembly
In the browser environment, Web Workers share a single linear memory space:
```javascript
sharedWasmMemory = new WebAssembly.Memory({
    initial: 512,    // 32 MB
    maximum: 16384,  // 1 GB
    shared: true     // Backed by SharedArrayBuffer
});
```
This enables zero-copy sharing of the transposition table and pawn hash table across all worker threads.

### 4.2 Root Move Distribution (Lazy SMP Diversification)
To prevent workers from duplicating work across the root search tree:
- **Worker 0 (Main)**: Searches moves in natural heuristic order.
- **Helper Workers ($split\_id > 0$)**:
  - The TT best move remains prioritized across all workers ($10{,}000{,}000$).
  - For remaining moves, a priority bonus of $+500{,}000$ is assigned to moves matching $(idx \pmod{split\_count}) == (split\_id \pmod{split\_count})$.
  - Applies a 1-ply depth parity offset based on worker ID: $d \leftarrow d + (split\_id \pmod 2)$.
  - Diversified subtrees immediately populate the shared transposition table, benefiting all concurrent workers.

### 4.3 Multi-Worker Result Aggregation
The aggregation pipeline in `offscreen.js` merges worker outputs:
1. Discards invalid or empty move proposals.
2. Identifies the maximum reached depth: $d_{\max} = \max_i(\text{depth}_i)$.
3. Rejects shallow outliers with $\text{depth} < d_{\max} - 1$ to prevent horizon-effect blunders from overruling deep searches.
4. Ranks qualified candidates by:
   - Primary: Depth descending.
   - Secondary: Evaluation score descending (for side to move).
   - Tertiary: Total nodes searched descending.
   - Quaternary: Canonical Worker 0 preference in exact ties.
5. Extracts distinct candidate moves to form real-time MultiPV lines.

### 4.4 Desktop Persistent Worker Pool
In native UCI mode (`uci.rs`), workers are spawned once at startup and maintained inside persistent threads communicating via `std::sync::mpsc`. Workers retain loaded NNUE weights and hash table pointers between moves, eliminating thread allocation latency.

---

## 5. Polyglot Opening Book Subsystem

Aether includes full support for the Polyglot opening book specification (`polyglot.rs`):
- **Zobrist Key**: Uses standard 64-bit random values (`POLYGLOT_RANDOM_ARRAY[781]`).
- **En-Passant Legality**: En-passant keys are included only when an opponent pawn is adjacent and legally capable of capturing.
- **Binary Search**: Probes 16-byte book entries (`key: u64, move: u16, weight: u16, learn: u32`) via binary bisection (`bisect_key_left`).
- **Hierarchy**:
  1. Custom Polyglot file loaded dynamically via UCI `setoption name BookFile value <path>`.
  2. Embedded Master Polyglot book (`master_book.bin`) compiled into the binary, providing ECO A00–E99 opening coverage.
  3. Static fallback book for standard response positions.

---

## 6. Time Management Subsystem

The time allocator (`timeman.rs`) budgets search time per move based on game clock parameters, piece count, and search stability:

### Base Allocation
$$\text{UsableTime} = \max(0, \text{RemainingTime} - \text{MoveOverhead})$$
$$\text{ExpectedMoves} = 12 + 28 \times \frac{\text{PieceCount} - 2}{30} \quad (\text{clamped } 12 \dots 40)$$
$$\text{OptimumTime} = \frac{\text{UsableTime}}{\text{ExpectedMoves}} + 0.75 \times \text{Increment}$$
$$\text{MaximumTime} = \min(\text{OptimumTime} \times 3.0, \, \text{UsableTime} \times 0.30, \, \text{UsableTime} \times 0.50)$$

### Emergency Fail-Safe
When $\text{UsableTime} < 2{,}000\text{ ms}$:
$$\text{OptimumTime} = \max\left(\frac{\text{UsableTime}}{25}, 10\text{ ms}\right), \quad \text{MaximumTime} = \max\left(\frac{\text{UsableTime}}{8}, \text{OptimumTime}\right)$$

### Dynamic Search-Time Scaling
Between iterative deepening iterations:
- **Move Instability**: If the best move changes, optimum time is scaled by $1.3\times$.
- **Score Collapse**: If score drops by $> 40\text{ cp}$, optimum time is scaled by $1.5\times$.
- **Move Stability**: If the best move is stable for $\ge 4$ iterations, time is reduced by $0.85\times$.
- **Easy Move**: At depth $\ge 8$, if the best move leads the second best by $> 120\text{ cp}$ for $\ge 3$ iterations, time is reduced by $0.80\times$.
- **Cutoff Condition**: Iteration halts if elapsed time exceeds $75\%$ of the calculated optimum budget.

---

## 7. Verification and Automated Testing

Engine correctness is maintained through three automated test suites:

1. **Rust Core Unit & Perft Tests (`cargo test`)**:
   - `test_see_basic`, `test_see_losing_capture`: Verifies bitboard Static Exchange Evaluation correctness.
   - `test_polyglot_startpos_hash`, `test_polyglot_known_fens`: Bit-exact Polyglot Zobrist hash compliance against standard test vectors.
   - `perft_start_position`, `perft_kiwipete`: Move generator legality, pin detection, and leaf node count verification.
   - `test_nnue_accumulator_incremental_matches_refresh`: Confirms that incremental bitboard XOR feature accumulation is mathematically identical to a full refresh across random game plies.
   - `budget_never_exceeds_remaining_clock`, `emergency_mode_below_two_seconds`: Time allocator constraints verification.

2. **Neural Network Tactical Sanity (`python verify_nnue_quality.py`)**:
   - Evaluates tactical mate recognition (Légal's Mate in 2).
   - Validates symmetric opening evaluation (Giuoco Pianissimo).
   - Confirms material deficit penalties (Queen advantage verification).
   - Verifies elementary endgame conversion (K+R vs K).

3. **Multi-Worker Aggregation Suite (`node test_aggregation_suite.mjs`)**:
   - 16 discrete tests validating shallow blunder rejection, depth dominance, tie-breaking criteria, MultiPV line generation, and edge-case handling.

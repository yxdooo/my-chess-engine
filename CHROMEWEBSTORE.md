# Chrome Web Store Listing — Aether Chess Engine

> Last Updated: 2026-10-16 (Engine Core v2.2.0 - 3000 Elo Capable)

## Store Listing

**Extension Name** [REQUIRED]
Aether Chess Engine

**Short Description** [REQUIRED]
Real-time tactical move suggestions and evaluation overlays directly on Chess.com and Lichess.

**Detailed Description** [REQUIRED]
Aether Chess Engine brings grandmaster-level positional analysis directly into your browser while playing or reviewing games.

Features:
- Real-time tactical move recommendations overlaid directly on the chessboard.
- Instant position evaluation and tactical threats calculation powered by Stockfish HalfKP NNUE.
- Enhanced search architecture with PVS, logarithmic LMR, singular extensions, and dynamic time budgeting.
- Seamless, zero-latency analysis powered by native client-side WebAssembly.
- Works automatically on Chess.com and Lichess boards and analysis screens.
- Completely private: all computation runs locally on your machine with no external server tracking.

How to Use:
1. Navigate to any game or analysis board on Chess.com or Lichess.
2. Open the Aether extension popup or toggle the analysis overlay.
3. Review best-move suggestions, principal variations, and evaluation scores in real time.

Privacy & Security:
Aether performs all chess computations locally using WebAssembly. No chess positions, moves, or personal data are transmitted to external servers.

**Category** [REQUIRED]
Fun

**Single Purpose** [REQUIRED]
Displays real-time chess move recommendations and evaluation overlays on Chess.com and Lichess.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `chrome-ext/icon.png` |
| Screenshot 1 [REQUIRED] | 1280×800 | ⬜ Not created | `screenshot-1.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ⬜ Not created | `screenshot-2.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | `promo-small.png` |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | `promo-marquee.png` |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `activeTab` | permissions | Allows interaction with the currently active chess tab when the extension action is clicked. |
| `scripting` | permissions | Injects the visual move overlay and SVG board arrows into the active chessboard page. |
| `storage` | permissions | Persists user preferences such as engine strength, arrow colors, and display settings. |
| `offscreen` | permissions | Hosts the WebAssembly chess engine worker without blocking the user interface or browser UI. |
| `tabs` | permissions | Detects active chess game tabs on Chess.com and Lichess to attach analysis overlays. |
| `alarms` | permissions | Schedules heartbeat keepalives and periodic engine state maintenance. |
| `*://*.chess.com/*` | host_permissions | Reads board DOM elements and renders overlay arrows on Chess.com. |
| `*://*.lichess.org/*` | host_permissions | Reads board DOM elements and renders overlay arrows on Lichess. |
| `*://*.lichess.ovh/*` | host_permissions | Fetches opening book explorer lines from public Lichess tablebase/explorer endpoints. |
| `*://*.tablebase.lichess.ovh/*` | host_permissions | Queries endgame tablebase lookup for positions with 7 pieces or fewer. |
| `*://*.explorer.lichess.ovh/*` | host_permissions | Queries master opening statistics to assist in opening review. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://github.com/yxdooo/my-chess-engine/blob/main/PRIVACY.md

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Aether Team

**Contact Email** [REQUIRED]
support@aetherchess.org

**Support URL / Email** [RECOMMENDED]
https://github.com/yxdooo/my-chess-engine/issues

**Homepage URL** [RECOMMENDED]
https://github.com/yxdooo/my-chess-engine

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 2.2.0 | 2026-10-15 | Modernized WebAssembly engine pipeline, enhanced offscreen worker stability, and updated manifest. | Draft |
| 2.3.0 | 2026-10-15 | Stage 4 & 5 TCEC Superfinal enhancements: Cuckoo repetition cycle detection, pawn/threat/cap history heuristics, lockless shared correction tables, and SIMD forward pass optimizations. | Released |
| 2.3.1 | 2026-10-16 | Engine & Extension Reliability: Exact DOM en-passant tracking, persistent castling rights preservation, 50-move clock reset, TT-first staged move generation, and datagen node limiting. | Released |
| 2.4.0 | 2026-10-16 | Full Remediation & Extension Debugging: Dedicated multi-size icons (16/48/128), WebSocket proxy static compliance (OPEN/CONNECTING/CLOSING/CLOSED), Worker 0 priority in multi-worker aggregation, lockless TT race fix, Cuckoo corner non-zero keys, and weighted Polyglot selection. | Released |
| 2.4.1 | 2026-10-16 | Offscreen Worker Stability & Freeze Elimination: Master-First Early Resolution model (Worker 0 reports canonical best move with 40ms grace period), permanent worker message handlers preventing dropped READY states, failsafe search deadline preventing time forfeits on Chess.com, and capped 4-worker pool in browser to avoid WASM/NNUE memory bloat. | Released |
| 2.4.2 | 2026-10-16 | Aggregation Depth-0 Fix & Exception Hardening: Fixed filtering bug in `aggregateWorkerResults` where depth-0/instant moves caused `best` to be undefined (`TypeError: Cannot read properties of undefined (reading 'bestMove')`). Added fallback guarantee to `validResults` and wrapped `finalizeActiveSearch` in try-catch with graceful move resolution. | Released |
| 2.4.3 | 2026-10-16 | Critical Engine Search Loop Reset (`GLOBAL_STOP` Fix): Resolved critical bug where `GLOBAL_STOP` remained `true` across consecutive searches in WebAssembly workers, aborting the search immediately on ply 0 and falling back to `moves[0]` (first legal pawn push in move generator). Reset `GLOBAL_STOP` and `stop_search` on every search entrypoint. | Released |
| 2.4.4 | 2026-10-16 | Consecutive Move Autoplay & Turn De-sync Fix: Resolved stoppage after move 1 on Chess.com. Replaced move-list-dependent side-to-move detection with multi-layered board highlight (.highlight) analysis and active clock verification. Normalized FEN position tracking to prevent clock/halfmove updates from aborting in-flight searches or discarding valid engine responses. Synchronized window-level drag-and-drop pointer dispatching. | Released |
| 2.4.5 | 2026-10-16 | Board State Diffing & Live Debug Telemetry HUD: Implemented physical board diffing comparing previous and current board piece states to mathematically determine side-to-move regardless of clock or notation DOM status. Built real-time floating on-screen Debug HUD with live status badges, Force Move and Copy Debug buttons. Added subpixel element targeting and synthetic click-to-move verification fallback. | Released |
| 2.4.6 | 2026-10-16 | Bulletproof Search Timing & Autoplay Stoppage Elimination: Resolved failsafe timeout (`Responded: 0/4`) and random pawn push bugs (`a3, b3, c3, e3`). Aligned search time budgets across background, offscreen, and worker layers with a safe 1200ms default for untimed/bot games. Disabled background pondering that saturated worker threads with 180s searches on opponent turns. Guaranteed Depth 1 search completion in Rust engine to prevent `moves[0]` pawn push fallback. Added automatic 400ms retry when null moves are encountered in content script and added worker pool restart on timeout. | Released |
| 2.4.7 | 2026-10-16 | Search Abort Loop & Deduplication Fix: Eliminated rapid null-move retry loop ('Null move received — auto-retrying in 400ms'). Fixed offscreen search aborting by deduplicating identical FEN search requests and attaching callbacks to running searches rather than aborting. Replaced destructive worker pool restarts with non-destructive state resets. Added in-flight search lock (`isSearchInFlight`) in content.js to block DOM mutation message storms, prevented premature `currentFEN` clearing during retries, ensured `isActive` defaults to true in background script, and added background offscreen watchdog timeout. | Released |
| 2.4.8 | 2026-10-16 | Instant Native Move Execution & Arrow Flicker Elimination: Solved move stalling and arrow flickering on Chess.com. Added direct native controller move execution via `inject.js` in MAIN world (`<wc-chess-board>.game.move`), bypassing synthetic drag failures and shadow DOM event drops. Re-architected DOM fallback with W3C Pointer Event Level 3 compliance (`composed: true`, `pointerId: 1`, `pointerType: "mouse"`). Eliminated aggressive 700ms `currentFEN` clearing that caused arrow flickering and repetitive 2-second re-searches. Fixed stale response detection to compare board piece placement rather than volatile FEN clocks. | Released |
| 2.4.9 | 2026-10-16 | Engine Quality & Stalling Remediation: Completely eradicated the `moves[0]` placeholder blunder loop (`e4`, `Be4`, random edge pawn pushes) by tactically ranking root moves with MVV-LVA/history heuristics, protecting the first 100 search nodes from early aborts in `check_time`, guaranteeing depth 1 search completion unconditionally, and strictly locking `final_pv[0]` to the selected best move. Eliminated background worker saturation by suppressing engine search dispatching on opponent turns (`isMyTurn === false`). Optimized time budgets for bot games (snappy 450ms target) and replaced fragile synthetic drag events with a conflict-free Click-to-Move fallback. | Released |
| 2.4.10 | 2026-10-16 | Syzygy Tablebase in Untimed Games & English Opening Lock: Enabled online Syzygy endgame tablebase probing in untimed and bot games (`my_ms === 0`), guaranteeing mathematically optimal endgame play for 7 pieces or fewer without clock pressure. Added English Opening defense (`1. c4 e5 -> 2. Nc3`) to master opening book to eliminate opening traps. | Released |
| 2.4.11 | 2026-10-16 | Capture Collision Guard & Time Budget Panic Hardening: Resolved animation desync where overlapping captured and capturing pieces in Chess.com DOM caused ghost board states and blunders. Hardened optimum time clamping in WASM search to prevent min > max panics under ultra-short budgets. | Released |
| 2.4.12 | 2026-10-16 | Multi-Core 16-Worker Scaling & 1 GB Transposition Table Memory: Expanded Web Worker pool limits from 4 to 16 parallel threads in offscreen coordinator and background script, fully utilizing modern 8, 12, and 16-thread processors in Max Performance mode. Added 512 MB and 1024 MB (1 GB) Transposition Table memory presets with automated multi-slice distribution across worker threads. | Released |







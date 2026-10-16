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
| 2.4.1 | 2026-10-16 | Offscreen Worker Stability & Freeze Elimination: Master-First Early Resolution model (Worker 0 reports canonical best move with 40ms grace period), permanent worker message handlers preventing dropped READY states, failsafe search deadline preventing time forfeits on Chess.com, and capped 4-worker pool in browser to avoid WASM/NNUE memory bloat. | Ready |

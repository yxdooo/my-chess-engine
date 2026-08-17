import chess
import chess.engine
import asyncio
import sys
import os

# Force UTF-8 output on Windows to avoid cp1254 encoding errors
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# ---------------------------------------------------------------------------
# Tournament configuration
# ---------------------------------------------------------------------------
OUR_ENGINE   = "target/x86_64-pc-windows-msvc/release/uci.exe"
STOCKFISH    = r"C:\Users\ygtyg\OneDrive\Desktop\projects\chess-engine\stockfish\stockfish-windows-x86-64-avx2.exe"

TIME_LIMIT   = 1.0   # seconds per move (1s = proper test)
TIME_LIMIT   = 0.1   # seconds per move
N_GAMES      = 2    # number of games

# Stockfish strength cap (1 = very weak, 20 = full strength; None = full strength)
# Skill 10  ≈ 2000 ELO  (good for testing our engine's current level)
# Skill 15  ≈ 2800 ELO
# Skill 20  = full strength (~3600 ELO — almost certainly all losses)
STOCKFISH_SKILL = 10  # Roughly ~2000 Elo (a much fairer test for a ~2000 Elo engine)


async def play_game(white_path, black_path, time_limit, game_idx):
    """Play one game between two UCI engines. Returns (result_str, pgn_moves)."""
    transport_w, eng_w = await chess.engine.popen_uci(white_path)
    transport_b, eng_b = await chess.engine.popen_uci(black_path)

    # Configure Stockfish skill level if requested
    for path, eng in [(white_path, eng_w), (black_path, eng_b)]:
        if path == STOCKFISH and STOCKFISH_SKILL is not None:
            await eng.configure({"Skill Level": STOCKFISH_SKILL})

    board = chess.Board()
    limit = chess.engine.Limit(time=time_limit)

    moves_log = []
    moves_played = 0
    while not board.is_game_over(claim_draw=True):
        if moves_played > 300:
            print("  [ABORT] Game too long, adjudicating as draw.")
            break
        try:
            if board.turn == chess.WHITE:
                result = await asyncio.wait_for(eng_w.play(board, limit), timeout=time_limit * 5 + 3)
            else:
                result = await asyncio.wait_for(eng_b.play(board, limit), timeout=time_limit * 5 + 3)
        except asyncio.TimeoutError:
            print(f"  [TIMEOUT] Engine timed out at move {moves_played}")
            break
        except Exception as e:
            print(f"  [ERROR] Engine error at move {moves_played}: {e}")
            break

        if result.move is None:
            break

        san = board.san(result.move)
        score_str = ""
        score_info = result.info.get("score")
        if score_info is not None:
            score_str = f" eval={score_info}"
        depth_info = result.info.get("depth")
        depth_str = f" d={depth_info}" if depth_info is not None else ""
        nodes_info = result.info.get("nodes")
        nodes_str = f" n={nodes_info}" if nodes_info is not None else ""
        moves_log.append(result.move.uci())
        print(f"  Move {moves_played:3d}: {san:<10}{score_str}{depth_str}{nodes_str}")
        board.push(result.move)
        moves_played += 1

    await eng_w.quit()
    await eng_b.quit()

    outcome = board.outcome(claim_draw=True)
    result_str = outcome.result() if outcome else "1/2-1/2"
    return result_str, moves_log


async def run_tournament():
    print("=" * 60)
    print(f"  Aether Chess Engine vs Stockfish")
    print(f"  {N_GAMES} games  |  {TIME_LIMIT}s/move")
    if STOCKFISH_SKILL is not None:
        print(f"  Stockfish Skill Level: {STOCKFISH_SKILL}")
    print("=" * 60)

    score = 0.0
    results = []

    for i in range(N_GAMES):
        game_num = i + 1
        # Alternate colors
        if i % 2 == 0:
            print(f"\n[Game {game_num}/{N_GAMES}] Aether=White vs Stockfish=Black")
            result, moves = await play_game(OUR_ENGINE, STOCKFISH, TIME_LIMIT, game_num)
            our_color = "White"
            gained = 1.0 if result == "1-0" else (0.5 if result == "1/2-1/2" else 0.0)
        else:
            print(f"\n[Game {game_num}/{N_GAMES}] Stockfish=White vs Aether=Black")
            result, moves = await play_game(STOCKFISH, OUR_ENGINE, TIME_LIMIT, game_num)
            our_color = "Black"
            gained = 1.0 if result == "0-1" else (0.5 if result == "1/2-1/2" else 0.0)

        score += gained
        results.append((our_color, result, gained, moves))
        outcome_label = "WIN" if gained == 1.0 else ("DRAW" if gained == 0.5 else "LOSS")
        print(f"  --> Game {game_num}: {result}  [{outcome_label} for Aether as {our_color}]")
        print(f"  --> Running score: {score}/{game_num}")

    print("\n" + "=" * 60)
    print(f"  FINAL SCORE: {score}/{N_GAMES}")
    pct = score / N_GAMES * 100
    print(f"  Win rate: {pct:.1f}%")
    if pct >= 50:
        print("  [+] Aether holds its own!")
    else:
        print("  [-] Engine needs more work.")
    print("=" * 60)

    print("\nGame log:")
    for idx, (color, result, gained, moves) in enumerate(results):
        print(f"  Game {idx+1} (Aether={color}): {result}  [{len(moves)} moves]")
        if len(moves) <= 60:
            print(f"    Moves: {' '.join(moves)}")


if __name__ == "__main__":
    asyncio.run(run_tournament())

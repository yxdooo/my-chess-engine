"""Clocked match harness: Aether (native UCI build) vs Stockfish (UCI_Elo limited).

Plays real-clock games (base time + increment), alternates colors, detects flag
losses, and reports the score, flag count, and an Elo difference estimate.

Usage (from the `engine-wasm` directory):
    python tourney.py --tc 1+0 --games 10
    python tourney.py --tc 3+0 --games 10 --sf-elo 2500
    python tourney.py --tc all --games 6          # runs 1+0, 3+0 and 5+0
"""

import argparse
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field

import chess
import chess.engine

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(ENGINE_DIR)

DEFAULT_AETHER_PATH = os.path.join(
    ENGINE_DIR, "target", "x86_64-pc-windows-msvc", "release", "uci.exe"
)
DEFAULT_STOCKFISH_PATH = os.path.join(
    REPO_ROOT, "stockfish", "stockfish-windows-x86-64-avx2.exe"
)

STANDARD_TIME_CONTROLS = ("1+0", "3+0", "5+0")
DEFAULT_STOCKFISH_ELO = 2500
OPENING_PLIES = 4
MAX_GAME_PLIES = 400
SEED = 20260101


@dataclass
class GameResult:
    """Outcome of a single game from Aether's point of view."""

    score: float
    reason: str
    aether_flagged: bool = False
    plies: int = 0
    moves_uci: list = field(default_factory=list)


def parse_time_control(text):
    """Parses `base+inc` (seconds) into a (base, increment) tuple."""
    base_text, _, inc_text = text.partition("+")
    return float(base_text) * 60.0, float(inc_text or 0)


def random_opening(rng):
    """Returns a short random legal opening so games are not identical."""
    board = chess.Board()
    for _ in range(OPENING_PLIES):
        moves = list(board.legal_moves)
        if not moves:
            break
        board.push(rng.choice(moves))
    return board


def estimate_elo_difference(score, games):
    """Returns the Elo difference implied by a score fraction (clamped to avoid infinities)."""
    if games == 0:
        return 0.0
    fraction = min(max(score / games, 0.01), 0.99)
    return -400.0 * math.log10(1.0 / fraction - 1.0)


def result_for_aether(board, aether_color):
    """Converts the final board result into Aether's score."""
    result = board.result(claim_draw=True)
    if result == "1/2-1/2":
        return 0.5
    aether_won = (result == "1-0") == (aether_color == chess.WHITE)
    return 1.0 if aether_won else 0.0


def play_game(aether, stockfish, aether_color, base, increment, start_board):
    """Plays one clocked game and returns a GameResult."""
    board = start_board.copy()
    clocks = {chess.WHITE: base, chess.BLACK: base}
    moves = []
    plies = 0
    game_token = object()  # a fresh token makes python-chess send `ucinewgame`

    while not board.is_game_over(claim_draw=True) and plies < MAX_GAME_PLIES:
        side = board.turn
        engine = aether if side == aether_color else stockfish
        limit = chess.engine.Limit(
            white_clock=clocks[chess.WHITE],
            black_clock=clocks[chess.BLACK],
            white_inc=increment,
            black_inc=increment,
        )

        started = time.perf_counter()
        try:
            result = engine.play(board, limit, game=game_token, info=chess.engine.INFO_NONE)
        except (chess.engine.EngineError, chess.engine.EngineTerminatedError) as error:
            print(f"  [ERROR] engine failure: {error}")
            return GameResult(0.0 if side == aether_color else 1.0, "engine-error", plies=plies, moves_uci=moves)
        elapsed = time.perf_counter() - started

        clocks[side] -= elapsed
        if clocks[side] <= 0:
            flagged_is_aether = side == aether_color
            return GameResult(
                0.0 if flagged_is_aether else 1.0,
                "flag",
                aether_flagged=flagged_is_aether,
                plies=plies,
                moves_uci=moves,
            )
        clocks[side] += increment

        if result.move is None:
            break
        moves.append(result.move.uci())
        board.push(result.move)
        plies += 1

    if board.is_game_over(claim_draw=True):
        return GameResult(result_for_aether(board, aether_color), "board", plies=plies, moves_uci=moves)
    return GameResult(0.5, "adjudicated-draw", plies=plies, moves_uci=moves)


def run_time_control(args, time_control):
    """Runs a full match at one time control and prints a summary."""
    base, increment = parse_time_control(time_control)
    rng = random.Random(SEED)

    aether = chess.engine.SimpleEngine.popen_uci(args.aether, cwd=ENGINE_DIR)
    stockfish = chess.engine.SimpleEngine.popen_uci(args.stockfish)
    stockfish.configure({"UCI_LimitStrength": True, "UCI_Elo": args.sf_elo})
    # Warm up both engines so one-time startup cost is not charged to the game clock.
    aether.ping()
    stockfish.ping()

    total_score = 0.0
    flags = 0
    wins = draws = losses = 0
    print(f"\n=== {time_control} | Aether vs Stockfish UCI_Elo={args.sf_elo} | {args.games} games ===")
    try:
        # Each opening is played twice with colors swapped for fairness.
        for game_index in range(args.games):
            if game_index % 2 == 0:
                opening = random_opening(rng)
            aether_color = chess.WHITE if game_index % 2 == 0 else chess.BLACK
            result = play_game(aether, stockfish, aether_color, base, increment, opening)
            total_score += result.score
            flags += 1 if result.aether_flagged else 0
            if result.score == 1.0:
                wins += 1
            elif result.score == 0.5:
                draws += 1
            else:
                losses += 1
            color_name = "white" if aether_color == chess.WHITE else "black"
            print(
                f"  game {game_index + 1:3d} aether={color_name:5s} score={result.score} "
                f"reason={result.reason} plies={result.plies}",
                flush=True,
            )
    finally:
        aether.quit()
        stockfish.quit()

    elo_diff = estimate_elo_difference(total_score, args.games)
    print(
        f"  RESULT {time_control}: +{wins} ={draws} -{losses} "
        f"score={total_score}/{args.games} ({100 * total_score / max(args.games, 1):.1f}%) "
        f"aether_flags={flags} elo_diff~{elo_diff:+.0f}"
    )
    return total_score, flags


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tc", default="1+0", help="Time control as base+inc seconds, or 'all'")
    parser.add_argument("--games", type=int, default=10, help="Games per time control")
    parser.add_argument("--sf-elo", type=int, default=DEFAULT_STOCKFISH_ELO, help="Stockfish UCI_Elo")
    parser.add_argument("--aether", default=DEFAULT_AETHER_PATH, help="Path to the Aether UCI binary")
    parser.add_argument("--stockfish", default=DEFAULT_STOCKFISH_PATH, help="Path to the Stockfish binary")
    return parser


def main():
    args = build_parser().parse_args()
    controls = STANDARD_TIME_CONTROLS if args.tc == "all" else (args.tc,)
    for control in controls:
        run_time_control(args, control)


if __name__ == "__main__":
    main()

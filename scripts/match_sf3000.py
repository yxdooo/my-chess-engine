import os
import sys
import time
import chess
import chess.engine
import chess.pgn

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AETHER_PATH = os.path.join(ROOT_DIR, "engine-wasm", "target", "release", "uci.exe")
SF_PATH = os.path.join(ROOT_DIR, "stockfish", "stockfish-windows-x86-64-avx2.exe")

# 10 balanced, diverse opening FENs (played as both White and Black = 20 games)
OPENINGS = [
    ("Italian Game", "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"),
    ("Ruy Lopez", "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"),
    ("Sicilian Najdorf", "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6"),
    ("Queen's Gambit Declined", "rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4"),
    ("French Defense", "rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3"),
    ("Caro-Kann", "rn1qkbnr/pp2pppp/2p5/5b2/3PN3/8/PPP2PPP/R1BQKBNR w KQkq - 1 5"),
    ("Nimzo-Indian", "rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4"),
    ("King's Indian", "rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R b KQ - 3 5"),
    ("English Opening", "r1bqkbnr/pppp1ppp/2n5/4p3/2P5/2N5/PP1PPPPP/R1BQKBNR w KQkq - 2 3"),
    ("Slav Defense", "rnbqkb1r/pp2pppp/2p2n2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R b KQkq - 3 4"),
]


def play_match(num_games=10, base_time=10.0, inc_time=0.2, sf_elo=3000, aether_threads=4):
    print(f"=== Aether vs Stockfish {sf_elo} Elo ({num_games} games, TC {base_time}+{inc_time}s) ===")
    print(f"Aether binary : {AETHER_PATH}")
    print(f"Stockfish bin : {SF_PATH}")

    aether = chess.engine.SimpleEngine.popen_uci(AETHER_PATH, cwd=ROOT_DIR)
    sf = chess.engine.SimpleEngine.popen_uci(SF_PATH, cwd=ROOT_DIR)

    aether.configure({"Threads": aether_threads, "Hash": 128, "Move Overhead": 10})
    sf.configure({"Threads": 1, "Hash": 64, "UCI_LimitStrength": True, "UCI_Elo": sf_elo})

    wins = 0
    draws = 0
    losses = 0

    for g in range(num_games):
        opening_name, fen = OPENINGS[(g // 2) % len(OPENINGS)]
        aether_white = (g % 2 == 0)

        board = chess.Board(fen)
        w_time = base_time
        b_time = base_time

        moves_played = []
        adjudicated_result = None
        low_score_streak = 0
        win_score_streak = 0

        while not board.is_game_over(claim_draw=True) and len(moves_played) < 400:
            stm_white = (board.turn == chess.WHITE)
            is_aether_turn = (stm_white == aether_white)
            eng = aether if is_aether_turn else sf

            limit = chess.engine.Limit(
                white_clock=max(0.05, w_time),
                black_clock=max(0.05, b_time),
                white_inc=inc_time,
                black_inc=inc_time,
            )

            t0 = time.perf_counter()
            res = eng.play(board, limit, info=chess.engine.INFO_ALL, game=g)
            dt = time.perf_counter() - t0

            if stm_white:
                w_time = max(0.01, w_time - dt + inc_time)
            else:
                b_time = max(0.01, b_time - dt + inc_time)

            if res.move is None or res.move not in board.legal_moves:
                adjudicated_result = "0-1" if stm_white else "1-0"
                break

            board.push(res.move)
            moves_played.append(res.move.uci())

            if is_aether_turn and "score" in res.info and len(moves_played) > 60:
                sc = res.info["score"].relative.score(mate_score=10000)
                if sc is not None and abs(sc) <= 15 and board.halfmove_clock >= 40:
                    low_score_streak += 1
                    if low_score_streak >= 8:
                        adjudicated_result = "1/2-1/2"
                        break
                else:
                    low_score_streak = 0

        result_str = adjudicated_result if adjudicated_result else board.result(claim_draw=True)
        if result_str == "1-0":
            aether_pts = 1.0 if aether_white else 0.0
        elif result_str == "0-1":
            aether_pts = 0.0 if aether_white else 1.0
        else:
            aether_pts = 0.5

        if aether_pts == 1.0:
            wins += 1
            tag = "WIN "
        elif aether_pts == 0.5:
            draws += 1
            tag = "DRAW"
        else:
            losses += 1
            tag = "LOSS"

        side_str = "White" if aether_white else "Black"
        total_score = wins + 0.5 * draws
        pct = (total_score / (g + 1)) * 100.0
        print(
            f"Game {g+1:2d}/{num_games} [{tag}] Aether ({side_str:5s}) vs SF{sf_elo} | "
            f"{opening_name:22s} | {len(moves_played):3d} plies | Score: {total_score:.1f}/{g+1} ({pct:.1f}%)"
        )
        if aether_pts == 0.0:
            print(f"  Loss FEN: {fen}")
            print(f"  Moves   : {' '.join(moves_played[:60])} ...")
        sys.stdout.flush()

    aether.quit()
    sf.quit()

    total = wins + 0.5 * draws
    winrate = (total / num_games) * 100.0
    print("\n============================================================")
    print(f"FINAL SCORE vs Stockfish {sf_elo}: +{wins} ={draws} -{losses} ({total:.1f}/{num_games} = {winrate:.1f}%)")
    print("============================================================")
    return winrate


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    tc = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
    inc = float(sys.argv[3]) if len(sys.argv) > 3 else 0.2
    play_match(num_games=n, base_time=tc, inc_time=inc)

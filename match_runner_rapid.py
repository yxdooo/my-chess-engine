import chess
import chess.engine
import chess.pgn
import time
import os
import sys

AETHER_PATH = os.path.join(os.path.dirname(__file__), 'engine-wasm', 'target', 'x86_64-pc-windows-msvc', 'release', 'uci.exe')
STOCKFISH_PATH = os.path.join(os.path.dirname(__file__), 'stockfish', 'stockfish-windows-x86-64-avx2.exe')

def run_rapid_match(num_games=3, base_time=600.0, inc=2.0):
    print(f"=== Starting {num_games}-Game Rapid Match: Aether (Full Power) vs Stockfish 18 (Full Power) ===")
    print(f"Time Control: {base_time}s (10 min) + {inc}s increment\n")

    aether = chess.engine.SimpleEngine.popen_uci(AETHER_PATH)
    sf = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)

    aether.configure({"Threads": 4, "Hash": 256})
    sf.configure({"Threads": 4, "Hash": 256, "Skill Level": 20, "UCI_LimitStrength": False})

    games_data = []

    for game_idx in range(1, num_games + 1):
        board = chess.Board()
        game = chess.pgn.Game()
        
        aether_is_white = (game_idx % 2 == 1)
        white_name = "Aether v2.2.0 (4T/256M)" if aether_is_white else "Stockfish 18 (4T/256M)"
        black_name = "Stockfish 18 (4T/256M)" if aether_is_white else "Aether v2.2.0 (4T/256M)"
        
        game.headers["Event"] = f"Aether Benchmark Rapid ({base_time/60:.0f}+{inc:.0f})"
        game.headers["Site"] = "Local Benchmark"
        game.headers["Date"] = time.strftime("%Y.%m.%d")
        game.headers["Round"] = str(game_idx)
        game.headers["White"] = white_name
        game.headers["Black"] = black_name

        aether_clock = base_time
        sf_clock = base_time
        node = game

        print(f"--- Rapid Game {game_idx}/{num_games}: {white_name} vs {black_name} ---")
        
        move_num = 1
        termination = None
        winner = None

        while not board.is_game_over(claim_draw=True):
            is_aether_turn = (board.turn == chess.WHITE and aether_is_white) or (board.turn == chess.BLACK and not aether_is_white)
            active_engine = aether if is_aether_turn else sf
            
            w_clock = aether_clock if aether_is_white else sf_clock
            b_clock = sf_clock if aether_is_white else aether_clock

            t0 = time.time()
            limit = chess.engine.Limit(
                white_clock=w_clock,
                black_clock=b_clock,
                white_inc=inc,
                black_inc=inc
            )

            try:
                res = active_engine.play(board, limit)
            except Exception as e:
                print(f"Engine play error: {e}")
                termination = f"Engine crash: {e}"
                break

            elapsed = time.time() - t0

            if is_aether_turn:
                aether_clock = aether_clock - elapsed + inc
                if aether_clock < 0:
                    termination = "Aether flagged (loss on time)"
                    winner = "Stockfish"
                    break
            else:
                sf_clock = sf_clock - elapsed + inc
                if sf_clock < 0:
                    termination = "Stockfish flagged (loss on time)"
                    winner = "Aether"
                    break

            if res.move is None or not board.is_legal(res.move):
                termination = f"Illegal move: {res.move}"
                winner = "Stockfish" if is_aether_turn else "Aether"
                break

            node = node.add_variation(res.move)
            node.comment = f"clk: {aether_clock if is_aether_turn else sf_clock:.1f}s"
            
            san_move = board.san(res.move)
            if board.turn == chess.WHITE:
                sys.stdout.write(f"{move_num}. {san_move} ")
            else:
                sys.stdout.write(f"{san_move} | ")
                move_num += 1
            sys.stdout.flush()

            board.push(res.move)

        print("")
        if not termination:
            outcome = board.outcome(claim_draw=True)
            if outcome:
                termination = str(outcome.termination)
                if outcome.winner is not None:
                    winner = "Aether" if (outcome.winner == chess.WHITE and aether_is_white) or (outcome.winner == chess.BLACK and not aether_is_white) else "Stockfish"
                    game.headers["Result"] = "1-0" if outcome.winner == chess.WHITE else "0-1"
                else:
                    winner = "Draw"
                    game.headers["Result"] = "1/2-1/2"
            else:
                termination = "Unknown"
                game.headers["Result"] = "*"
        else:
            if winner == "Aether":
                game.headers["Result"] = "1-0" if aether_is_white else "0-1"
            elif winner == "Stockfish":
                game.headers["Result"] = "0-1" if aether_is_white else "1-0"
            else:
                game.headers["Result"] = "1/2-1/2"

        game.headers["Termination"] = termination
        print(f"Result: {game.headers['Result']} ({winner}) | Reason: {termination}")
        print(f"Clocks at end -> Aether: {aether_clock:.2f}s, Stockfish: {sf_clock:.2f}s\n")

        pgn_str = str(game)
        games_data.append({
            "round": game_idx,
            "white": white_name,
            "black": black_name,
            "result": game.headers["Result"],
            "winner": winner,
            "termination": termination,
            "moves_count": len(board.move_stack),
            "aether_clock": aether_clock,
            "sf_clock": sf_clock,
            "pgn": pgn_str
        })

        # Append to PGN file immediately after each game
        with open("rapid_match_results.pgn", "a", encoding="utf-8") as f:
            f.write(pgn_str + "\n\n")

    aether.quit()
    sf.quit()

    print("=== All Rapid Games Complete. Saved to rapid_match_results.pgn ===")
    return games_data

if __name__ == "__main__":
    run_rapid_match(num_games=3, base_time=600.0, inc=2.0)

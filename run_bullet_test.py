import chess
import chess.engine
import time

def run_match():
    # Load engines
    our_engine = chess.engine.SimpleEngine.popen_uci('engine-wasm/target/x86_64-pc-windows-msvc/release/uci.exe')
    sf_engine = chess.engine.SimpleEngine.popen_uci('stockfish/stockfish-windows-x86-64-avx2.exe')
    
    # Configure SF to 2000 ELO
    sf_engine.configure({"UCI_LimitStrength": True, "UCI_Elo": 2600})
    our_engine.configure({"Hash": 128})

    results = {"win": 0, "draw": 0, "loss": 0}
    num_games = 5

    for i in range(num_games):
        board = chess.Board()
        our_color = chess.WHITE if i % 2 == 0 else chess.BLACK
        
        # 60s without increment
        our_time = 60.0
        sf_time = 60.0
        
        print(f"Game {i+1} starting. Our engine is {'White' if our_color == chess.WHITE else 'Black'}")
        
        while not board.is_game_over():
            if board.turn == our_color:
                # Our turn
                start = time.time()
                result = our_engine.play(board, chess.engine.Limit(white_clock=our_time if our_color == chess.WHITE else sf_time, black_clock=sf_time if our_color == chess.WHITE else our_time))
                elapsed = time.time() - start
                our_time -= elapsed
                if our_time < 0:
                    print("We flagged!")
                    break
                board.push(result.move)
            else:
                # SF turn
                start = time.time()
                result = sf_engine.play(board, chess.engine.Limit(white_clock=our_time if our_color == chess.WHITE else sf_time, black_clock=sf_time if our_color == chess.WHITE else our_time))
                elapsed = time.time() - start
                sf_time -= elapsed
                if sf_time < 0:
                    print("SF flagged!")
                    break
                board.push(result.move)

        if our_time < 0:
            results["loss"] += 1
            print("Result: Loss by time")
        elif sf_time < 0:
            results["win"] += 1
            print("Result: Win by time")
        else:
            res = board.result()
            if (res == "1-0" and our_color == chess.WHITE) or (res == "0-1" and our_color == chess.BLACK):
                results["win"] += 1
                print("Result: Win by board")
            elif res == "1/2-1/2":
                results["draw"] += 1
                print("Result: Draw")
            else:
                results["loss"] += 1
                print("Result: Loss by board")

    our_engine.quit()
    sf_engine.quit()

    win_rate = (results["win"] + 0.5 * results["draw"]) / num_games * 100
    print(f"\nFinal Results: {results['win']} Wins, {results['draw']} Draws, {results['loss']} Losses.")
    print(f"Win Rate: {win_rate}%")

if __name__ == '__main__':
    run_match()





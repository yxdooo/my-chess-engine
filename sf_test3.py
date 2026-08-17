import chess.engine
engine = chess.engine.SimpleEngine.popen_uci('stockfish/stockfish-windows-x86-64-avx2.exe')
board = chess.Board('8/3P1r2/8/8/3k4/1PK5/8/2N5 w - - 0 71')
res = engine.analyse(board, chess.engine.Limit(depth=20))
print(f"Move 70 d7 SF Evaluation: {res['score'].white()}")
engine.quit()

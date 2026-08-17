import chess.engine
engine = chess.engine.SimpleEngine.popen_uci('stockfish/stockfish-windows-x86-64-avx2.exe')
board = chess.Board('8/8/1r2k3/5p2/3PP3/1PK5/8/2N5 w - - 0 61')
res = engine.analyse(board, chess.engine.Limit(depth=20))
print(f"Move 60 FEN SF Evaluation: {res['score'].white()}")
print(f"Move 60 FEN SF Best Move: {res['pv'][0]}")
engine.quit()

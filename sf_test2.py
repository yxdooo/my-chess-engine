import chess.engine
engine = chess.engine.SimpleEngine.popen_uci('stockfish/stockfish-windows-x86-64-avx2.exe')
board = chess.Board('8/8/1r6/3k1P2/1P1P4/2K5/8/2N5 b - - 0 62')
res = engine.analyse(board, chess.engine.Limit(depth=20))
print(f"Move 62 b4 SF Evaluation: {res['score'].white()}")
print(f"Move 62 b4 SF Best Move: {res['pv'][0]}")

board = chess.Board('8/8/5r2/1P1k1P2/3P4/1K6/8/2N5 b - - 0 64')
res = engine.analyse(board, chess.engine.Limit(depth=20))
print(f"Move 64 b5 SF Evaluation: {res['score'].white()}")
print(f"Move 64 b5 SF Best Move: {res['pv'][0]}")

engine.quit()

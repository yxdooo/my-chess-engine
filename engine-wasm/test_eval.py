import chess
import chess.engine
import asyncio

async def main():
    _, engine = await chess.engine.popen_uci("target/release/test_fen.exe")
    # Position before giving away pawns
    board1 = chess.Board("8/8/8/8/3k4/1PK5/8/2N1r3 w - - 0 1")
    info1 = await engine.analyse(board1, chess.engine.Limit(depth=15))
    print("Before:", info1["score"].white())
    
    # Position after giving away pawns
    board2 = chess.Board("8/8/8/8/3k4/8/K7/2N1r3 w - - 0 1")
    info2 = await engine.analyse(board2, chess.engine.Limit(depth=15))
    print("After:", info2["score"].white())
    
    await engine.quit()

asyncio.run(main())

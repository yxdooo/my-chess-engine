import chess.pgn
import io

pgn = """[Event "Play vs Bot"]
[Site "Chess.com"]
[Date "2026.08.01"]
[Round "?"]
[White "stl0420402042"]
[Black "Advanced"]
[Result "0-1"]
[BlackElo "1900"]
[WhiteElo "400"]
[Termination "by checkmate"]
[ECO "A00"]
[EndDate "2026.08.01"]
[Link "https://www.chess.com/game/computer/1859764312"]

1. b4 d5 2. c4 dxc4 3. e3 Be6 4. Bb2 Qd6 5. Nf3 Nf6 6. Na3 Qxb4 7. Qc2 b5 8. Nd4
Bd7 9. Ndxb5 Bxb5 10. Nxb5 Qxb5 11. Bxc4 Qc6 12. Bxf7+ Kxf7 13. Qb3+ Qd5 14. Rc1
Qxb3 15. axb3 Na6 16. Rc6 Nb4 17. Rxf6+ exf6 18. Bxf6 Kxf6 19. h4 Rd8 20. Kf1
Rxd2 21. Rh3 Bc5 22. Rg3 Nd3 23. b4 Rxf2+ 24. Kg1 Bxb4 25. Rg4 c5 26. e4 c4 27.
g3 Re2 28. e5+ Nxe5 29. Rf4+ Ke6 30. Kf1 Rb2 31. Rf6+ Kxf6 32. h5 Rf8 33. Kg1
Rd8 34. Kh1 Rd1# 0-1"""

game = chess.pgn.read_game(io.StringIO(pgn))
board = game.board()
for move in game.mainline_moves():
    board.push(move)
    if board.fullmove_number == 14 and board.turn == chess.BLACK:
        print("FEN at 14...:", board.fen())

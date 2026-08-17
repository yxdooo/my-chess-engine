import chess.pgn
import io
pgn = """[Event "Play vs Bot"]
1. b4 d5 2. c4 dxc4 3. e3 Be6 4. Bb2 Qd6 5. Nf3 Nf6 6. Na3 Qxb4 7. Qc2 b5 8. Nd4 Bd7 9. Ndxb5 Bxb5 10. Nxb5 Qxb5 11. Bxc4 Qc6 12. Bxf7+ Kxf7 13. Qb3+ Qd5 14. Rc1"""
game = chess.pgn.read_game(io.StringIO(pgn))
b = game.board()
for m in list(game.mainline_moves())[:-1]:
    b.push(m)
print(b.fen())

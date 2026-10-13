import chess

board = chess.Board()
moves = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "O-O", "c3", "d6", "h3", "Na5", "Bc2", "c5", "d4", "Nd7", "b4", "Nc4", "bxc5", "dxc5", "a4", "Bb7", "axb5", "axb5", "Rxa8", "Qxa8", "Nbd2", "cxd4", "Nxc4", "bxc4", "cxd4", "Bb4", "Re3", "Qa1", "dxe5", "Bc5", "Re2", "Nxe5", "Re1", "Ra8", "Nxe5", "Qxe5", "Qd7", "Rb8", "Be3", "Bxe3"]

for m in moves:
    board.push_san(m)

print(board.fen())

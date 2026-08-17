import chess

pgn = "1. Nc3 c5 2. d4 cxd4 3. Qxd4 Nc6 4. Qd3 e6 5. e4 Qb6 6. Qg3 Nb4 7. Bd3 Nxd3+ 8. cxd3 Nf6 9. Nf3 d5 10. O-O d4 11. Ne2 Nd7 12. Nexd4 Qd6 13. Bf4 Qb6 14. Be3 Qd6 15. Bf4 e5 16. Bxe5 Nxe5 17. Qxe5+ Qxe5 18. Nxe5 Bd6 19. Nef3 Bd7 20. Rac1 f6 21. h3 Kf7 22. Rfd1 Rad8 23. Kf1 a6 24. Rc2 Rhg8 25. b3 Rge8 26. Rc4 h5 27. a4 g5 28. Rdc1 Bf4 29. R1c3 b5 30. axb5 axb5 31. Rc5 g4 32. hxg4 b4 33. R3c4 hxg4 34. Ne1 Rh8 35. Ke2 g3 36. Nef3 Bg4 37. fxg3 Bd6 38. Rd5 Bxg3 39. Rxd8 Rxd8 40. Rxb4 Rd7 41. Nc6 Rd6 42. Rb7+ Ke8 43. Rg7 Rxc6 44. Rxg4 Rc2+ 45. Kd1 Rxg2 46. Nd4 Rg1+ 47. Kc2 Rg2+ 48. Kd1 Rg1+ 49. Ke2 Bf2 50. Kxf2 Rxg4 51. Ne2 Rg5 52. Ke3 Rb5 53. Nc1 Ke7 54. d4 Rb4 55. Kd3 Rb8 56. Ke2 Rb7 57. Kd3 Ke6 58. Ke3 Rb4 59. Kd3 Rb6 60. Kc3 f5"

board = chess.Board()
moves = pgn.split()
for m in moves:
    if "." in m:
        continue
    board.push_san(m)

print(f"Move 60 FEN: {board.fen()}")

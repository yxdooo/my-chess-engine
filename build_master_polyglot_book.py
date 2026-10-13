import struct
import chess
import chess.polyglot

# A rich collection of master opening lines covering ECO A00-E99
MASTER_LINES = [
    # 1. e4 e5 - Ruy Lopez
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7 Nbd2 Bb7 Bc2 Re8 Nf1 Bf8 Ng3 g6 b3 Bg7 d5 Nb6 Be3 c6 c4 cxd5 cxd5 Rc8 Qd2 Nbd7 Rac1 Nc5", # Breyer
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7 Rc1 Qb8 Bb1 Rc8", # Chigorin
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 h6 d4 Re8 Nbd2 Bf8 Nf1 Bd7 Ng3 Na5 Bc2 c5 d5 Nc4 b3 Nb6 Be3 a5", # Karpov
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5 exd5 Nxd5 Nxe5 Nxe5 Rxe5 c6 d4 Bd6 Re1 Qh4 g3 Qh3 Be3 Bg4 Qd3 Rae8 Nd2 Re6 a4 Qh5 axb5 axb5", # Marshall Attack
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O d4 Bg4 Be3 exd4 cxd4 Na5 Bc2 c5 d5 Nc4 Bc1 Nd7",
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4 d4 b5 Bb3 d5 dxe5 Be6 c3 Be7 Nbd2 Nc5 Bc2 d4 cxd4 Nxd4 Nxd4 Qxd4 Nf3 Qxd1 Rxd1 O-O Be3 Rfd8 Nd4 Bd5 Nf5 Bf8", # Open Spanish
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 d3 b5 Bb3 d6 a4 Bd7 c3 O-O Nbd2 Na5 Bc2 c5 Re1 Re8 Nf1 h6 Ng3", # Anti-Marshall 8.d3
    "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8 Nc3 Ke8 h3 h5 Bf4 Be7 Rad1 Be6 b3 Rd8 Ne4 b6 Neg5 Bc8 Rxd8+ Bxd8 Rd1 Be7", # Berlin Defense Endgame
    "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5 c3 O-O O-O d6 Nbd2 a6 Ba4 Ba7 h3 Ne7 Re1 Ng6 Nf1 d5 exd5 Nxd5 Ng3 f6 d4 exd4 Nxd4", # Berlin 4.d3
    "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5 Ne2 Qxd1 Rxd1 Bd7 Nbc3 O-O-O Be3 Re8 f3 f5 Bf2 fxe4 Nxe4 b6 N2c3 Bc6", # Exchange Spanish
    "e4 e5 Nf3 Nc6 Bb5 Bc5 c3 Nf6 d4 exd4 e5 Nd5 O-O O-O cxd4 Bb6 Nc3 Nxc3 bxc3 d5 Bg5 Ne7 Bd3 h6 Bh4 Bg4 h3", # Classical Spanish
    "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O b5 Bb3 Bb7 d3 Be7 Re1 O-O a4 b4 Nbd2 d6 a5 Nd7 Nc4 Nc5 Ba2 Ne6 c3", # Archangel

    # Italian Game
    "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O a6 a4 Ba7 Re1 O-O Nbd2 h6 Nf1 Be6 Bxe6 fxe6 Be3 Bxe3 Nxe3 Qd7 b4 Ne7", # Giuoco Pianissimo
    "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Nc3 Nxe4 O-O Bxc3 d5 Bf6 Re1 Ne7 Rxe4 d6 Bg5 Bxg5 Nxg5 h6 Qe2 hxg5 Re1 Be6 dxe6 f6 Re3 c6 Rh3 Rxh3 gxh3 g6", # Main Giuoco Piano
    "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O Nge7 cxd4 d5 exd5 Nxd5 Ba3 Be6 Bb5 Bb4 Bxb4 Nxb4 Nc3 O-O a3 Nd5 Ne4", # Evans Gambit
    "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 O-O d6 c3 a6 Bb3 Ba7 Nbd2 O-O h3 h6 Re1 Re8 Nf1 Be6 Bc2 d5 exd5 Bxd5 Ng3 Qd7", # Two Knights 4.d3
    "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Bd3 Nd5 Nf3 Bd6 O-O O-O Re1 Qc7 c4 Nf4 Bf1 c5 Nc3 Bb7 d3", # Two Knights 4.Ng5

    # Scotch & Petrov & Vienna & Others
    "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6 b3 g6 f4 Bg7 Ba3 d6 Nd2 O-O O-O-O Rfe8 Qf2 Nb6 Ne4", # Scotch Mieses
    "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7 Bc4 Ne5 Be2 Qg6 O-O d6 f4 Qxe4 Bf2 Qxf4 Nb5 Bxe3+ Kh1 Qh4 Nxc7+ Kd8 Nxa8 Nf5", # Scotch Classical
    "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Bd6 O-O O-O c4 c6 Nc3 Nxc3 bxc3 dxc4 Bxc4 Bg4 h3 Bh5 Re1 Nd7 Bd3 Re8 Rxe8+ Qxe8 Be3", # Petrov 5.d4
    "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 Nc3 Nxc3 dxc3 Be7 Be3 O-O Qd2 Nd7 O-O-O Nf6 Bd3 c5 Rhe1 Be6 Kb1 Qa5 c4 Qxd2", # Petrov 4.Nc3
    "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Bc5 d4 Bb4 Bd2 c5 dxc5 Bxc3 Bxc3 Nxc3 bxc3 O-O Bd3 Nd7 O-O Nxc5 Qe1 Be6 Nd4", # Vienna Game
    "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6 d4 d6 Nd3 Nxe4 Bxf4 Bg7 c3 O-O Nd2 Re8 Nxe4 Rxe4+ Be2 Qe7 Qd2 Bf5 Nf2 Re6", # King's Gambit Accepted
    "e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6 Nc3 Be7 Be2 O-O O-O Re8 Re1 Nbd7 Bf1 c6 a4 Bf8 Bg5 h6 Bh4 Ne5 f3 Ng6 Bf2", # Philidor Defense
    "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6 Bg5 Bxc3 bxc3 Qe7 Re1 Nd8 d4 Ne6 Bc1 c5 Bf1 Qc7 d5 Nf4 Bxf4 exf4", # Four Knights

    # 2. Sicilian Defense (1. e4 c5)
    # Najdorf
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Be7 Qf3 Qc7 O-O-O Nbd7 g4 b5 Bxf6 Nxf6 g5 Nd7 f5 Nc5 f6 gxf6 gxf6 Bf8 Rg1 h5 Kb1 Bd7 a3 O-O-O", # Najdorf 6.Bg5
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5 g5 b4 Ne2 Ne8 f4 a5 f5 a4 Nbd4 exd4 Nxd4 b3 Kb1 bxc2+ Nxc2 Bb3 axb3 axb3 Na3 Ne5", # Najdorf English Attack
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O Be3 Be6 Qd2 Nbd7 a4 Rc8 a5 Qc7 Rfd1 Rfd8 Qe1 Qc6 Bf3", # Najdorf 6.Be2
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 h3 e5 Nde2 h5 g3 Be7 Bg2 Be6 O-O Nbd7 a4 Rc8 Nd5 Nxd5 exd5 Bf5 c3 a5", # Najdorf Adams Attack 6.h3
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 g3 e5 Nde2 Be7 Bg2 O-O O-O b5 a4 b4 Nd5 Nxd5 Qxd5 Ra7 Be3 Be6 Qd2 Rb7 a5 Nd7", # Najdorf 6.g3

    # Dragon & Classical & Scheveningen
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 Bc4 Bd7 O-O-O Rc8 Bb3 Ne5 h4 h5 Bg5 Rc5 Kb1 b5 g4 a5 Bxf6 Bxf6 gxh5 a4 Bd5 e6 hxg6 exd5 Qh6 fxg6 Nxd5 Rxd5 exd5 Bg7", # Dragon Yugoslav 9.Bc4
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6 O-O-O d5 exd5 Nxd5 Nxc6 bxc6 Bd4 e5 Bc5 Be6 Ne4 Re8 h4 h6 g4 Qc7 g5 h5 Bc4 Red8 Qf2 Nf4 Bxe6 Nxe6", # Dragon Yugoslav 9.O-O-O d5
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 a6 O-O-O Bd7 f4 b5 Bxf6 gxf6 Kb1 Qb6 Nxc6 Bxc6 Bd3 O-O-O Rhe1 h5 f5 b4 Ne2 e5 Bc4 Bh6 Qd3", # Classical Richter-Rauzer
    "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6 Be2 Be7 O-O O-O Be3 Nc6 f4 a6 a4 Qc7 Kh1 Re8 Bf3 Bd7 Qd2 Na5 b3 Rac8 Nde2 Red8 Rad1 Be8", # Scheveningen Classical

    # Sveshnikov & Kalashnikov & Taimanov & Kan
    "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5 Nd5 Be7 Bxf6 Bxf6 c3 O-O Nc2 Bg5 a4 bxa4 Rxa4 a5 Bc4 Rb8 b3 Kh8 O-O f5 exf5 Bxf5 Nce3 Bg6 Bd3 Bxe3 Nxe3 Bxd3 Qxd3 Rxb3", # Sveshnikov 9.Bxf6
    "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5 Nd5 Be7 Bxf6 Bxf6 c4 b4 Nc2 O-O g3 a5 Bg2 Bg5 O-O Be6 Qd3 Ne7 Nxe7+ Qxe7 b3",
    "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5 Nb5 d6 c4 Be7 N1c3 a6 Na3 Be6 Be2 Bg5 Nc2 Bxc1 Rxc1 Nf6 O-O O-O Qd2 Qb8 Rfd1 Rd8 b3 Qa7 Bf3 Rac8 Qe3 Qxe3 Nxe3 Nd4", # Kalashnikov
    "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Qd2 Nf6 O-O-O Bb4 f3 Ne5 Nb3 b5 Qe1 Be7 f4 Nc4 Bxc4 bxc4 Nd4 Bb7 e5 Nd5 Nxd5 Bxd5 Qg3 O-O f5", # Taimanov
    "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Bc5 Nb3 Ba7 Qe2 d6 Be3 Bxe3 Qxe3 Nf6 Nc3 O-O O-O-O Nc6 f4 Qc7 g4 b5 g5 Nd7 Kb1 b4 Ne2 a5 Nbd4 Nxd4 Nxd4 Ba6", # Kan 5.Bd3

    # Anti-Sicilians
    "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 cxd4 d6 Nf3 Nc6 Bc4 e6 O-O Be7 Qe2 O-O Nc3 Nxc3 bxc3 dxe5 dxe5 Qa5 Bd2 Rd8 Bd3 Bd7 Rfe1 Be8 Qe4 g6 h4 Rd7 h5 Rad8 Re3", # Alapin 2.c3 Nf6
    "e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 Bg4 Be2 e6 O-O Nc6 h3 Bh5 Be3 cxd4 cxd4 Be7 Nc3 Qd6 Qb3 O-O Rfd1 Rfd8 Rac1 Qb4 Qxb4 Bxb4 a3 Be7 g4 Bg6 Ne5", # Alapin 2.c3 d5
    "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 Be3 e5 Qd2 Nge7 Bh6 O-O h4 f6 Bxg7 Kxg7 f4 Be6 Nf3 Nd4 O-O Qd7 Rf2 Rac8 Raf1 b5 a3 a5", # Closed Sicilian
    "e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4 e6 O-O Nf6 Qe2 Be7 Rd1 e5 h3 O-O Be3 Be6 Bxe6 fxe6 b4 a6 a4 Qe8 b5 axb5 axb5 Rxa1 Rxa1 Nd8", # Smith-Morra Gambit

    # 3. French Defense (1. e4 e6)
    "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7 Qxg7 Rg8 Qxh7 cxd4 Ne2 Nbc6 f4 Bd7 Qd3 dxc3 h4 O-O-O h5 Nf5 h6 Rg6 h7 Rh8 Rb1 d4 Rg1 Rxh7 g4", # Winawer Mainline
    "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Nf3 Bd7 a4 Qa5 Bd2 Nbc6 Be2 c4 O-O f6 Re1 O-O-O Bf1 Ng6 g3 fxe5 dxe5 Rdf8 Bg2 Qc7 Qe2 Rf5", # Winawer Positional
    "e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7 f4 O-O Nf3 c5 Qd2 Nc6 O-O-O a6 dxc5 Qxc5 Bd3 b5 Kb1 Nb6 Qe1 f5 exf6 Rxf6 g3 Bd7 Ng5 h6 Nf3 b4 Ne2 a5", # Classical 4.Bg5
    "e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3 cxd4 Nxd4 Bc5 Qd2 O-O O-O-O a6 Qf2 Bxd4 Bxd4 b5 Bd3 b4 Ne2 a5 Kb1 Ba6 Bxa6 Rxa6 Rd3", # Steinitz 4.e5
    "e4 e6 d4 d5 Nd2 c5 exd5 Qxd5 Ngf3 cxd4 Bc4 Qd6 O-O Nf6 Nb3 Nc6 Nbxd4 Nxd4 Nxd4 a6 Re1 Qc7 Bb3 Bd6 h3 O-O Bg5 Bh2+ Kh1 Be5 c3 h6 Be3 Bd7 Qe2", # Tarrasch Open
    "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2 cxd4 cxd4 f6 exf6 Nxf6 O-O Bd6 Nf3 Qc7 Bg5 O-O Bh4 Nh5 Bg3 Nxg3 hxg3 g6 Rc1 Qg7 Bb5 Bd7 Re1", # Tarrasch Closed
    "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 Nh6 b4 cxd4 cxd4 Nf5 Bb2 Bd7 g4 Nfe7 Nc3 Na5 Na4 Qc6 Nc5 Nc4 Bc1 b6 Nxd7 Qxd7 Bd3 Rc8 O-O Ng6 h4", # Advance French 5...Qb6

    # 4. Caro-Kann Defense (1. e4 c6)
    "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Qb6 Nc3 Nc6 O-O Qxb2 Qe1 cxd4 Bxd4 Nxd4 Nxd4 Bb4 Ndb5 Ba5 Rb1 Qxc2 Rb3 Ne7 Nd6+ Kf8 Nxb7 Bb6 Nd6 Bg6 Na4 Bd4", # Advance Short System 4.Nf3
    "e4 c6 d4 d5 e5 Bf5 h4 h5 c4 e6 Nc3 Ne7 Nge2 Nd7 Ng3 Bg6 Bg5 Qb6 Qd2 dxc4 Bxc4 Nf5 Nxf5 Bxf5 O-O f6 exf6 gxf6 Be3 O-O-O d5 Bc5", # Advance 4.h4
    "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6 Bd2 Ngf6 O-O-O Be7 Kb1 O-O Ne4 Nxe4 Qxe4 Nf6 Qe2 Qd5 Ne5 Qe4 Qxe4 Nxe4 Be3 Rfd8", # Classical Mainline
    "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Ng5 Ngf6 Bd3 e6 N1f3 Bd6 Qe2 h6 Ne4 Nxe4 Qxe4 Qc7 Qg4 Kf8 O-O b6 b3 Bb7 Bb2 Nf6 Qh3 c5 dxc5 Qxc5 Rfe1 Qh5 Qxh5 Nxh5", # Classical Karpov 4...Nd7
    "e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4 Bg4 Qb3 Qc8 Nd2 e6 Ngf3 Be7 O-O O-O Rfe1 Bh5 Ne5 Nxe5 Bxe5 Nd7 Bg3 Bg6 Bxg6 hxg6 Nf3 Qc6 a4 Rfc8", # Exchange / Panov
    "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nf6 Nxf6+ exf6 c3 Bd6 Bd3 O-O Qc2 Re8+ Ne2 h5 O-O Nd7 Be3 Nf8 c4 h4 h3 Bc7 Rad1 Qd6 Bf4 Rxe2 Bxd6 Rxc2 Bxc7 Rxb2", # Tartakower 4...Nf6

    # 5. Queen's Gambit & Slav (1. d4 d5 2. c4)
    "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7 Nxd5 exd5 Rc1 Be6 Qa4 c5 Qa3 Rc8 Bb5 a6 dxc5 bxc5 O-O Qa7 Be2 Nd7 Rfd1 a5", # Tartakower QGD
    "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 Ne4 Bxe7 Qxe7 cxd5 Nxc3 bxc3 exd5 Qb3 Rd8 c4 dxc4 Bxc4 Nc6 O-O Na5 Qc3 Nxc4 Qxc4 Be6 Qc3 Rac8", # Lasker Defense
    "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 c6 e3 Be7 Bd3 Nbd7 Qc2 O-O Nge2 Re8 O-O Nf8 f3 g6 Rad1 Ne6 Bh4 b6 Kh1 Bb7 Bf2 c5 dxc5 bxc5", # QGD Exchange
    "d4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bf4 O-O e3 c5 dxc5 Bxc5 Qc2 Nc6 a3 Qa5 O-O-O Be7 g4 dxc4 Bxc4 e5 Bg5 Bxg4 Bxf6 Bxf6 Bd5 Rac8 Rhg1 Bxf3 Bxf3 Nd4 exd4 exd4", # Harrwitz Attack
    "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 Bg5 h6 Bh4 dxc4 e4 g5 Bg3 b5 Be2 Bb7 O-O Nbd7 Ne5 Bg7 Nxd7 Nxd7 Bd6 a6 a4 e5 d5 cxd5 Nxd5 Bxd5 Qxd5 Nb6 Qc6+ Nd7", # Semi-Slav Anti-Moscow
    "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5 Bd3 Bb7 O-O a6 e4 c5 d5 Qc7 dxe6 fxe6 Bc2 c4 Ng5 Nc5 Qe2 h6 Nf3 O-O-O e5 Nd5 Nxd5 Bxd5", # Semi-Slav Meran
    "d4 d5 c4 c6 Nf3 Nf6 Nc3 a6 c5 Bf5 Bf4 Nbd7 e3 e6 h3 Be7 Be2 O-O O-O b6 b4 a5 a3 Qc8 Qb3 Qb7 Rfc1 Rfc8 Qb2 h6 Ne5 Nxe5 Bxe5", # Chebanenko Slav 4...a6
    "d4 d5 c4 c6 cxd5 cxd5 Nc3 Nf6 Bf4 Nc6 e3 Bf5 Qb3 Na5 Qa4+ Bd7 Qc2 e6 Bd3 Rc8 Nf3 Be7 O-O O-O Ne5 b5 a3 Nc4 Qe2 a6 Rfc1 Be8 a4 Qb6 axb5 axb5", # Slav Exchange
    "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6 Bb3 cxd4 exd4 Nc6 Nc3 Be7 Bg5 O-O Re1 b5 d5 Nxd5 Bxd5 exd5 Bxe7 Nxe7 Qd4 Be6 Ng5 Qd7 Rad1 Rad8", # QGA 4.e3

    # 6. King's Indian & Grunfeld (1. d4 Nf6 2. c4 g6)
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7 Ne1 Nd7 Be3 f5 f3 f4 Bf2 g5 a4 Ng6 a5 Rf7 c5 Nxc5 b4 Na6 Nd3 Bf8 b5 Nb8 b6 axb6 axb6 Rxa1 Qxa1", # KID Mar del Plata 9.Ne1
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7 b4 a5 Ba3 axb4 Bxb4 b6 a4 Nh5 Re1 Nf4 Bf1 f5 a5 bxa5 Rxa5 Rb8 Ba3 fxe4 Nxe4 Bg4 Neg5 h6", # KID Bayonet Attack 9.b4
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 c6 Qd2 cxd5 cxd5 a6 O-O-O b5 Kb1 Nbd7 Rc1 Nb6 Bd3 Bd7 Nge2 Nc4 Bxc4 bxc4 g4 Rb8 Ng3 Qa5 h4 Rb7", # KID Samisch 5.f3
    "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O h3 e5 d5 a5 Bg5 Na6 g4 Qe8 Be2 Kh8 Rg1 Ng8 Qd2 f6 Be3 f5 gxf5 gxf5 exf5 Bxf5 Ng5 Nb4 Nce4 Nf6 a3", # KID Makogonov 6.h3
    "d4 Nf6 c4 g6 g3 Bg7 Bg2 O-O Nc3 d6 Nf3 Nc6 O-O a6 d5 Na5 Nd2 c5 Qc2 Rb8 b3 b5 Bb2 bxc4 bxc4 Bh6 f4 e5 dxe6 Bxe6 Nd5 Nxd5 cxd5 Rxb2 Qxb2 Bg7", # KID Fianchetto
    "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5 Be3 Qa5 Qd2 O-O Rc1 Rd8 d5 e6 c4 Qxd2+ Nxd2 b6 Be2 Na6 O-O Re8 Rfd1 Bd7 f3 Ba4 Nb3 Nb4", # Grunfeld Exchange 7.Nf3
    "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Bc4 c5 Ne2 O-O O-O Nc6 Be3 Bg4 f3 Na5 Bd3 cxd4 cxd4 Be6 Rc1 Bxa2 Qa4 b6 d5 Bb3 Qb4 e6 d6 e5 Ba6", # Grunfeld Classical 7.Bc4
    "d4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7 Qb3 dxc4 Qxc4 O-O e4 a6 Be2 b5 Qb3 c5 dxc5 Bb7 e5 Nfd7 Be3 e6 O-O Qc7 a4 bxa4 Nxa4 Nxe5 Nxe5 Bxe5 h3 Nd7 Rac1 Bd5", # Grunfeld Russian 4.Qb3
    "d4 Nf6 c4 g6 Nc3 d5 Bf4 Bg7 e3 O-O Rc1 c5 dxc5 Be6 Nf3 Qa5 Nd4 dxc4 Nxe6 fxe6 Bxc4 Nd5 O-O Qxc5 Nxd5 exd5 Qxd5+ Qxd5 Bxd5+", # Grunfeld 4.Bf4

    # 7. Nimzo-Indian & Queen's Indian & Bogo-Indian (1. d4 Nf6 2. c4 e6)
    "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O dxc4 Bxc4 Nbd7 Qe2 b6 Rd1 cxd4 exd4 Bxc3 bxc3 Bb7 Bd3 Qc7 c4 Rfe8 Bb2 Qf4 Qe3 Nh5 Be2 Qxe3 fxe3 Nhf6", # Nimzo-Indian Rubinstein 4.e3
    "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6 Bg5 Bb7 f3 h6 Bh4 d5 e3 Nbd7 cxd5 Nxd5 Bxd8 Nxc3 Bh4 Nd5 Bf2 c5 e4 Ne7 Bb5 Rfd8 Ne2 cxd4 Bxd4 Nc5", # Nimzo-Indian Classical 4.Qc2
    "d4 Nf6 c4 e6 Nc3 Bb4 f3 d5 a3 Bxc3+ bxc3 c5 cxd5 Nxd5 dxc5 f5 e4 fxe4 Qc2 Qa5 fxe4 Nf6 Nf3 Qxc5 Bd3 Nc6 Bf4 e5 Bg5 Be6 Bh4 O-O Bf2 Qa5 O-O", # Nimzo-Indian 4.f3
    "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7 Bg2 c6 Bc3 d5 Ne5 Nfd7 Nxd7 Nxd7 Nd2 O-O O-O Rc8 e4 c5 exd5 exd5 dxc5 dxc4 c6 cxb3 Re1 b2 Bxb2 Nc5", # Queen's Indian 4...Ba6
    "d4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O d5 exd5 Nh4 c6 cxd5 Nxd5 Nf5 Nc7 e4 d5 Nc3 dxe4 Nxe4 Nd5 Qg4 g6 Nxe7+ Qxe7 Bh6 Re8 Rfe1 Nd7", # Queen's Indian 4...Bb7
    "d4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Qe7 g3 Nc6 Nc3 Bxc3 Bxc3 Ne4 Rc1 O-O Bg2 d6 d5 Nxc3 Rxc3 Nb8 dxe6 fxe6 O-O a5 c5 d5 e4 c6 Re1 Qf6 Qd2 Na6", # Bogo-Indian Defense

    # 8. Catalan & Modern Benoni & Benko Gambit
    "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6 a4 Bd7 Qxc4 Bc6 Bg5 Bd5 Qd3 Be4 Qd1 c5 dxc5 Bxc5 Nc3 Bc6 Qxd8 Rxd8 Ne5 Bxg2 Kxg2 Nbd7 Nxd7 Rxd7", # Catalan Open 6...dxc4
    "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O c6 Qc2 Nbd7 Nbd2 b6 e4 Bb7 e5 Ne8 cxd5 cxd5 Re1 Rc8 Qd1 Nc7 Nf1 b5 h4 b4 Bg5 Nb6 Ne3 Nc4", # Catalan Closed 6...c6
    "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7 h3 O-O Bd3 b5 Nxb5 Re8 O-O Nxe4 Re1 a6 Na3 Nf6 Rxe8+ Nxe8 Bg5 Bf6 Qd2 Nd7 Re1 Bb7 Bc4 Nb6 b3", # Modern Benoni Classical
    "d4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 g6 Nc3 Bxa6 e4 Bxf1 Kxf1 d6 Nf3 Bg7 g3 O-O Kg2 Nbd7 h3 Qa5 Re1 Rfb8 Re2 Ne8 Rc2 Nc7 Bg5 Kf8 Qd2 Nb5 Nxb5 Qxb5", # Benko Gambit Accepted

    # 9. English Opening (1. c4)
    "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 a3 O-O b4 Be6 Rb1 f6 d3 Nd4 Nd2 c6 e3 Nf5 Qc2 Qd7 Nde4 Rfd8 Rd1 Bf7 Bb2 Qe8 Ba1 Rac8", # English Four Knights
    "c4 c5 Nf3 Nf6 d4 cxd4 Nxd4 e6 Nc3 Nc6 g3 Qb6 Ndb5 Ne5 Bf4 a6 Bxe5 axb5 e3 bxc4 Bxc4 Qc6 Bb5 Qxh1+ Ke2 Qxd1+ Rxd1 Be7 Bd6 Bxd6 Rxd6 Ke7", # English Symmetrical
    "c4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 Nf3 e6 O-O Nge7 d3 O-O Bg5 h6 Bd2 d5 Qc1 Kh7 Rb1 b6 a3 Bb7 b4 cxb4 axb4 dxc4 dxc4 Rc8 Rd1 Qe8 Nb5", # English Double Fianchetto
    "c4 e5 Nc3 d6 g3 f5 Bg2 Nf6 d3 Be7 e3 O-O Nge2 c6 O-O Na6 Rb1 Nc7 b4 d5 cxd5 cxd5 d4 e4 b5 Be6 Qb3 Bf7 Ba3 Bxa3 Qxa3", # English vs Dutch setup

    # 10. Reti Opening & Others (1. Nf3, 1. d4 sidelines, etc.)
    "Nf3 d5 g3 Nf6 Bg2 c6 O-O Bf5 c4 e6 cxd5 exd5 d3 Be7 Nc3 O-O Qb3 Qb6 Be3 Qxb3 axb3 Na6 Nd4 Bd7 Nc2 Nb4 Nxb4 Bxb4 Rxa7 Rxa7 Bxa7 Ra8 Bd4 Ne8", # Reti Slav
    "Nf3 d5 c4 d4 b4 g6 Bb2 Bg7 e3 e5 c5 Ne7 Bc4 O-O O-O Nbc6 Qb3 Bg4 Ng5 Qe8 f4 h6 Ne4 exf4 Rxf4 Bf5 Ng3 dxe3 Bxg7 Kxg7 dxe3", # Reti Gambit 2...d4
    "d4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 Qb6 Qb3 c4 Qc2 g6 e4 dxe4 Bxc4 Bf5 Be3 Qc7 Ne2 Bg7 Ng3 O-O O-O Rac8 Rac1 Qd7 Nxf5 gxf5 f3", # London System vs Qb6
    "d4 Nf6 Bf4 g6 e3 Bg7 Nf3 O-O h3 d6 Be2 c5 c3 b6 O-O Bb7 Nbd2 Nbd7 a4 a6 Bh2 Rc8 Re1 Re8 Bc4 cxd4 exd4 Qc7 Qb3 e6", # London vs King's Indian
    "d4 Nf6 Bg5 Ne4 Bf4 c5 f3 Qa5+ c3 Nf6 d5 Qb6 Bc1 e6 e4 exd5 exd5 d6 c4 Be7 Bd3 O-O Ne2 Nbd7 f4 Re8 O-O Nf8 Nbc3 Ng6 Ng3 Bd7", # Trompowsky Attack
    "d4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6 Nc3 Qe8 d5 a5 Nd4 Na6 b3 Bd7 Bb2 c6 Qd2 Nc5 Rad1 Rc8 e3 Nfe4 Nxe4 fxe4 Ne2 Bxb2", # Dutch Leningrad
    "d4 f5 c4 Nf6 Nc3 e6 g3 d5 Bg2 c6 Nf3 Bd6 O-O O-O b3 Nbd7 Bb2 Ne4 e3 Qf6 Ne2 g5 Qc2 Rf7 Ne1 Qh6 Nd3 Ndf6 Ne5 Rg7 f3", # Dutch Stonewall
    "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6 Nd5 Qd8 Nxf6+ gxf6 c3 Nd7 Qe2 Qc7 Nh4 Bg6 O-O-O O-O-O Nxg6 hxg6 g3 Bd6 Kb1", # Scandinavian 3...Qa5
    "e4 d5 exd5 Qxd5 Nc3 Qd6 d4 Nf6 Nf3 a6 g3 Bg4 Bg2 Nc6 O-O O-O-O h3 Bxf3 Qxf3 Qxd4 Be3 Qb4 Rfd1 Rxd1+ Rxd1 e6 a3 Qxb2 Rb1 Qxc3", # Scandinavian 3...Qd6
    "e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Na6 O-O c5 d5 Bg4 h3 Bxf3 Qxf3 Nb4 Rd1 Nd7 a3 Nxd3 Qxd3 a6 a4 Qc7 Be3 c4 Qe2 Rac8", # Pirc Austrian Attack
    "e4 Nf6 e5 Nd5 d4 d6 Nf3 g6 Bc4 Nb6 Bb3 Bg7 a4 dxe5 a5 Nd5 dxe5 c6 h3 O-O O-O Na6 Re1 Nc5 Bc4 Bf5 Nd4 Bd7 Nd2 Qc7 N2f3", # Alekhine Modern
]

print("Processing master opening lines...")

# Map of (polyglot_hash, raw_move) -> weight
entries_dict = {}

for line in MASTER_LINES:
    moves = line.strip().split()
    board = chess.Board()
    for move_idx, san in enumerate(moves):
        # Calculate weight: earlier moves get higher weight
        # Plies 0-10: weight 100, 11-20: weight 80, 21+: weight 60
        weight = max(20, 100 - (move_idx * 2))
        h = chess.polyglot.zobrist_hash(board)
        move = board.parse_san(san)

        # Polyglot move format
        to_sq = move.to_square
        from_sq = move.from_square

        # Castling: Polyglot encodes castling as king takes own rook!
        if board.is_castling(move):
            if from_sq == chess.E1 and to_sq == chess.G1:
                to_sq = chess.H1
            elif from_sq == chess.E1 and to_sq == chess.C1:
                to_sq = chess.A1
            elif from_sq == chess.E8 and to_sq == chess.G8:
                to_sq = chess.H8
            elif from_sq == chess.E8 and to_sq == chess.C8:
                to_sq = chess.A8

        prom = 0
        if move.promotion:
            prom = move.promotion - 1 # 1=Knight, 2=Bishop, 3=Rook, 4=Queen

        raw_move = (to_sq & 0x3F) | ((from_sq & 0x3F) << 6) | ((prom & 0x07) << 12)

        key_pair = (h, raw_move)
        if key_pair in entries_dict:
            entries_dict[key_pair] = max(entries_dict[key_pair], weight)
        else:
            entries_dict[key_pair] = weight

        board.push(move)

print(f"Total unique book entries generated: {len(entries_dict)}")

# Sort entries strictly by Polyglot key (required for binary search!)
sorted_entries = sorted(entries_dict.items(), key=lambda item: (item[0][0], -item[1]))

# Write out master_book.bin (standard Polyglot format: >QHHI)
output_path = "engine-wasm/master_book.bin"
with open(output_path, "wb") as f:
    for (h, raw_move), weight in sorted_entries:
        f.write(struct.pack(">QHHI", h, raw_move, weight, 0))

print(f"Saved {output_path} ({len(sorted_entries) * 16} bytes)")

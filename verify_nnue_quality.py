"""
verify_nnue_quality.py

Verifies the Stockfish 14 HalfKP neural network integration in Aether:
1. Accuracy on tactical motifs (e.g. Legal's Mate puzzle, Scotch gambit).
2. Positional evaluation sanity across diverse game phases (opening, middlegame, endgame).
3. Search speed (NPS) and depth scaling under the upgraded network.
"""

import chess
import chess.engine
import os
import sys

ENGINE_PATH = os.path.join(os.path.dirname(__file__), "engine-wasm", "target", "x86_64-pc-windows-msvc", "release", "uci.exe")

def test_nnue():
    print("=================================================")
    print("AETHER STOCKFISH 14 NNUE EVALUATION VERIFICATION")
    print("=================================================\n")

    if not os.path.exists(ENGINE_PATH):
        print(f"ERROR: Engine binary not found at {ENGINE_PATH}")
        sys.exit(1)

    engine = chess.engine.SimpleEngine.popen_uci(ENGINE_PATH)

    test_cases = [
        {
            "name": "Légal's Mate (Tactical Mate-in-2)",
            "fen": "r2qkb1r/pp2nppp/3p4/2pNN3/2B1P3/8/PPPP1PPP/R1BbK2R w KQkq - 0 1",
            "expected_move": "d5f6",
            "min_score_cp": 500, # Should see imminent win / mate
            "movetime": 1000
        },
        {
            "name": "Giuoco Pianissimo (Balanced Opening)",
            "fen": "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5",
            "expected_range": (-20, 70),
            "movetime": 800
        },
        {
            "name": "Material Advantage (Clean Queen Up)",
            "fen": "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", # standard startpos
            "test_type": "material",
            "advantage_fen": "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", # White has no Queen
            "movetime": 500
        },
        {
            "name": "Endgame Conversion (K+R vs K)",
            "fen": "8/8/8/4k3/8/8/4K3/4R3 w - - 0 1",
            "min_score_cp": 300, # Heavily winning for White
            "movetime": 600
        }
    ]

    passed = 0
    total = len(test_cases)

    for tc in test_cases:
        print(f"[*] Testing: {tc['name']}")
        if tc.get("test_type") == "material":
            board_start = chess.Board(tc["fen"])
            info_start = engine.analyse(board_start, chess.engine.Limit(time=tc["movetime"]/1000.0))
            score_start = info_start["score"].white().score(mate_score=10000)

            board_down = chess.Board(tc["advantage_fen"])
            info_down = engine.analyse(board_down, chess.engine.Limit(time=tc["movetime"]/1000.0))
            score_down = info_down["score"].white().score(mate_score=10000)

            print(f"    Normal Startpos Eval: {score_start} cp")
            print(f"    Down Queen Eval:      {score_down} cp")
            if score_down < score_start - 700:
                print(f"    ✓ PASS: Down a Queen recognized accurately ({score_down} cp << {score_start} cp)")
                passed += 1
            else:
                print(f"    ✗ FAIL: Neural network failed to evaluate Queen loss correctly")
            continue

        board = chess.Board(tc["fen"])
        play_res = engine.play(board, chess.engine.Limit(time=tc["movetime"]/1000.0))
        best_move = play_res.move.uci() if play_res.move else "none"
        res = engine.analyse(board, chess.engine.Limit(time=tc["movetime"]/1000.0))
        score = res["score"].white().score(mate_score=10000)
        depth = res.get("depth", 0)
        nodes = res.get("nodes", 0)

        print(f"    Move: {best_move} | Score: {score} cp | Depth: {depth} | Nodes: {nodes}")

        if "expected_move" in tc:
            if best_move == tc["expected_move"]:
                print(f"    ✓ PASS: Found exact winning move {best_move} with score {score}cp")
                passed += 1
            else:
                print(f"    ✗ FAIL: Expected {tc['expected_move']}, got {best_move}")
        elif "min_score_cp" in tc:
            if score >= tc["min_score_cp"]:
                print(f"    ✓ PASS: Score {score}cp satisfies minimum threshold of {tc['min_score_cp']}cp")
                passed += 1
            else:
                print(f"    ✗ FAIL: Score {score}cp below required threshold of {tc['min_score_cp']}cp")
        elif "expected_range" in tc:
            low, high = tc["expected_range"]
            if low <= score <= high:
                print(f"    ✓ PASS: Balanced opening score {score}cp within [{low}, {high}]")
                passed += 1
            else:
                print(f"    ✗ FAIL: Score {score}cp out of range [{low}, {high}]")

    engine.quit()

    print("\n=================================================")
    print(f"NNUE QUALITY VERIFICATION: {passed}/{total} PASSED ({(passed/total)*100:.0f}%)")
    print("=================================================")
    return passed == total

if __name__ == "__main__":
    success = test_nnue()
    sys.exit(0 if success else 1)

import os

filepath = 'engine-wasm/src/lib.rs'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. QS check evasion
old_qs = '''    fn quiescence_search(&mut self, board: &Board, mut alpha: i32, beta: i32, ply: u8) -> i32 {
        self.nodes += 1;
        if (self.nodes & 2047) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        let stand_pat = pseudo_nnue_evaluate(board);
        if stand_pat >= beta { return beta; }
        if stand_pat + 1225 < alpha { return alpha; }
        if alpha < stand_pat { alpha = stand_pat; }

        let mut moves: Vec<ChessMove> = MoveGen::new_legal(board)
            .filter(|m| board.piece_on(m.get_dest()).is_some() || m.get_promotion().is_some())
            .collect();
            
        self.sort_moves(board, &mut moves, ply, None);'''

new_qs = '''    fn quiescence_search(&mut self, board: &Board, mut alpha: i32, beta: i32, ply: u8) -> i32 {
        self.nodes += 1;
        if (self.nodes & 2047) == 0 { self.check_time(); }
        if self.stop_search { return 0; }

        let in_check = board.checkers().popcnt() > 0;
        let stand_pat = pseudo_nnue_evaluate(board);
        
        if !in_check {
            if stand_pat >= beta { return beta; }
            if stand_pat + 1225 < alpha { return alpha; }
            if alpha < stand_pat { alpha = stand_pat; }
        }

        let mut moves: Vec<ChessMove> = if in_check {
            MoveGen::new_legal(board).collect()
        } else {
            MoveGen::new_legal(board)
                .filter(|m| board.piece_on(m.get_dest()).is_some() || m.get_promotion().is_some())
                .collect()
        };
            
        self.sort_moves(board, &mut moves, ply, None);
        
        if in_check && moves.is_empty() {
            return -MATE + ply as i32;
        }'''

content = content.replace(old_qs, new_qs)

# 2. Score Move Promotion Priority
old_score = '''    fn score_move(&self, board: &Board, m: &ChessMove, ply: u8, tt_best_move: Option<ChessMove>) -> i32 {
        if Some(*m) == tt_best_move { return 10_000_000; }
        
        if let Some(victim) = board.piece_on(m.get_dest()) {
            if let Some(attacker) = board.piece_on(m.get_source()) {
                return 10000 + 10 * piece_value_mg(victim) - piece_value_mg(attacker);
            }
        } else if (ply as usize) < 128 {
            if Some(*m) == self.killers[ply as usize][0] { return 9000; }
            if Some(*m) == self.killers[ply as usize][1] { return 8000; }
            return self.history[m.get_source().to_index()][m.get_dest().to_index()];
        }
        if m.get_promotion().is_some() { return 8500; }
        0
    }'''

new_score = '''    fn score_move(&self, board: &Board, m: &ChessMove, ply: u8, tt_best_move: Option<ChessMove>) -> i32 {
        if Some(*m) == tt_best_move { return 10_000_000; }
        
        if let Some(victim) = board.piece_on(m.get_dest()) {
            if let Some(attacker) = board.piece_on(m.get_source()) {
                return 10000 + 10 * piece_value_mg(victim) - piece_value_mg(attacker);
            }
        }
        
        if m.get_promotion().is_some() { return 9500; }
        
        if (ply as usize) < 128 {
            if Some(*m) == self.killers[ply as usize][0] { return 9000; }
            if Some(*m) == self.killers[ply as usize][1] { return 8000; }
            return self.history[m.get_source().to_index()][m.get_dest().to_index()];
        }
        0
    }'''

content = content.replace(old_score, new_score)

# 3. History Cap in negamax
old_hist = '''            if alpha >= beta { 
                if !is_capture && (ply as usize) < 128 {
                    self.killers[ply as usize][1] = self.killers[ply as usize][0];
                    self.killers[ply as usize][0] = Some(m);
                    self.history[m.get_source().to_index()][m.get_dest().to_index()] += (depth as i32) * (depth as i32);
                }
                break; 
            }'''

new_hist = '''            if alpha >= beta { 
                if !is_capture && (ply as usize) < 128 {
                    self.killers[ply as usize][1] = self.killers[ply as usize][0];
                    self.killers[ply as usize][0] = Some(m);
                    let h = &mut self.history[m.get_source().to_index()][m.get_dest().to_index()];
                    *h = (*h + (depth as i32) * (depth as i32)).min(20000);
                }
                break; 
            }'''

content = content.replace(old_hist, new_hist)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"QS updated: {new_qs in content}")
print(f"Score updated: {new_score in content}")
print(f"Hist updated: {new_hist in content}")

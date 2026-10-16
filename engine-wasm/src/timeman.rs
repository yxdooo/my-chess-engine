pub struct ClockInfo {
    pub remaining_ms: f64,
    pub increment_ms: f64,
    pub opponent_remaining_ms: f64,
    pub moves_to_go: Option<u32>,
    pub move_overhead_ms: f64,
    pub piece_count: u32,
}

pub struct TimeBudget {
    pub optimum_ms: f64,
    pub maximum_ms: f64,
}

const MIN_MOVES_TO_GO: f64 = 25.0;
const MAX_MOVES_TO_GO: f64 = 30.0;
const INCREMENT_SHARE: f64 = 0.85;
const HARD_LIMIT_CLOCK_FRACTION: f64 = 0.30;

pub fn allocate(clock: &ClockInfo) -> TimeBudget {
    let usable_time = (clock.remaining_ms - clock.move_overhead_ms).max(0.0);
    
    // Emergency mode: triggered when remaining time is low (<= 600ms or <= 15% of clock)
    let emergency_threshold = (clock.remaining_ms * 0.15).max(600.0);
    if usable_time < emergency_threshold {
        let inc_bonus = clock.increment_ms * INCREMENT_SHARE;
        let optimum = (usable_time / MIN_MOVES_TO_GO + inc_bonus).max(10.0);
        let maximum = (usable_time / 8.0 + inc_bonus * 1.5).min(usable_time * 0.5).max(optimum);
        return TimeBudget {
            optimum_ms: optimum,
            maximum_ms: maximum,
        };
    }
    
    let moves_left = match clock.moves_to_go {
        Some(m) => (m as f64).clamp(12.0, MAX_MOVES_TO_GO),
        None => {
            let p = clock.piece_count.clamp(2, 32) as f64;
            let expected = 12.0 + (18.0 * (p - 2.0) / 30.0);
            expected.clamp(12.0, MAX_MOVES_TO_GO)
        }
    };
    
    let mut optimum = usable_time / moves_left + clock.increment_ms * INCREMENT_SHARE;
    let mut maximum = optimum * 3.0;
    
    // Hard clamp: never use more than a fraction of the remaining clock
    let clock_fraction_limit = usable_time * HARD_LIMIT_CLOCK_FRACTION;
    maximum = maximum.min(clock_fraction_limit);
    
    // Absolute max clamp: never exceed half the clock
    maximum = maximum.min(usable_time * 0.5);
    optimum = optimum.min(maximum);
    
    TimeBudget {
        optimum_ms: optimum.max(10.0),
        maximum_ms: maximum.max(optimum.max(10.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_never_exceeds_remaining_clock() {
        let clock = ClockInfo {
            remaining_ms: 1000.0,
            increment_ms: 0.0,
            opponent_remaining_ms: 1000.0,
            moves_to_go: None,
            move_overhead_ms: 50.0,
            piece_count: 32,
        };
        let budget = allocate(&clock);
        assert!(budget.maximum_ms <= (1000.0 - 50.0) * 0.5);
    }

    #[test]
    fn emergency_mode_below_two_seconds() {
        let clock = ClockInfo {
            remaining_ms: 500.0,
            increment_ms: 0.0,
            opponent_remaining_ms: 5000.0,
            moves_to_go: None,
            move_overhead_ms: 50.0,
            piece_count: 32,
        };
        let budget = allocate(&clock);
        let usable = 500.0 - 50.0;
        assert!((budget.optimum_ms - (usable / 25.0)).abs() < 1.0);
        assert!((budget.maximum_ms - (usable / 8.0)).abs() < 1.0);
    }
}

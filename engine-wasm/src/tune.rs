// SPSA Parameter Tuning Infrastructure for Aether Chess Engine
// Exposes search heuristics and time management constants as UCI spin options
// when compiled with `--features tune`, and compiles as zero-cost const expressions in release.

pub struct TunableParam {
    pub name: &'static str,
    pub default: i32,
    pub min: i32,
    pub max: i32,
    pub step: i32,
}

pub const TUNABLE_PARAMS: &[TunableParam] = &[
    TunableParam { name: "LmrBase", default: 75, min: 20, max: 200, step: 5 },
    TunableParam { name: "LmrDivisor", default: 195, min: 100, max: 350, step: 5 },
    TunableParam { name: "RfpDepth", default: 8, min: 4, max: 12, step: 1 },
    TunableParam { name: "RfpMargin", default: 75, min: 40, max: 150, step: 5 },
    TunableParam { name: "RfpImprovingMargin", default: 55, min: 30, max: 120, step: 5 },
    TunableParam { name: "NmpBaseReduction", default: 3, min: 2, max: 6, step: 1 },
    TunableParam { name: "NmpDivisor", default: 3, min: 2, max: 6, step: 1 },
    TunableParam { name: "ProbcutMargin", default: 170, min: 100, max: 300, step: 10 },
    TunableParam { name: "SingularMargin", default: 35, min: 15, max: 80, step: 5 },
    TunableParam { name: "DoubleSingularMargin", default: 60, min: 30, max: 120, step: 5 },
    TunableParam { name: "TripleSingularMargin", default: 75, min: 45, max: 150, step: 5 },
    TunableParam { name: "HistoryPruningSlope", default: 3500, min: 1500, max: 6000, step: 250 },
    TunableParam { name: "FutilityBase", default: 90, min: 40, max: 200, step: 10 },
    TunableParam { name: "FutilitySlope", default: 40, min: 20, max: 100, step: 5 },
];

// Production compile-time constants (zero-overhead)
pub const LMR_BASE: f64 = 0.75;
pub const LMR_DIVISOR: f64 = 1.95;
pub const RFP_DEPTH: u8 = 8;
pub const RFP_MARGIN: i32 = 75;
pub const RFP_IMPROVING_MARGIN: i32 = 55;
pub const NMP_BASE_REDUCTION: u8 = 3;
pub const NMP_DIVISOR: u8 = 3;
pub const PROBCUT_MARGIN: i32 = 170;
pub const SINGULAR_MARGIN: i32 = 35;
pub const DOUBLE_SINGULAR_MARGIN: i32 = 60;
pub const TRIPLE_SINGULAR_MARGIN: i32 = 75;
pub const HISTORY_PRUNING_SLOPE: i32 = 3500;
pub const FUTILITY_BASE: i32 = 90;
pub const FUTILITY_SLOPE: i32 = 40;

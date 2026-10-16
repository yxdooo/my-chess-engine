// Aether Chess Engine Hyperparameters
// Auto-generated via Distributed SPSA (scripts/spsa_cluster.py)
// Tuned values generated automatically from SPSA checkpoints.

// Late Move Reductions (LMR)
pub const LMR_BASE: f64 = 0.75;
pub const LMR_DIVISOR: f64 = 1.95;

// Null Move Pruning (NMP)
pub const NMP_BASE_REDUCTION: u8 = 3;
pub const NMP_DIVISOR: u8 = 3;
pub const NMP_MIN_DEPTH: u8 = 3;
pub const NMP_VERIFY_DEPTH: u8 = 12;

// Reverse Futility Pruning (RFP)
pub const RFP_MAX_DEPTH: u8 = 6;
pub const RFP_MARGIN: i32 = 75;
pub const RFP_IMPROVING_BONUS: i32 = 30;
pub const RFP_EVAL_DIFF_BONUS: i32 = 20;

// Futility Pruning (FP)
pub const FP_MAX_DEPTH: u8 = 4;
pub const FP_BASE_MARGIN: i32 = 80;
pub const FP_MARGIN_PER_DEPTH: i32 = 100;

// Quiet History Pruning
pub const HIST_PRUNING_MAX_DEPTH: u8 = 4;
pub const HIST_PRUNING_MARGIN: i32 = 3500;

// ProbCut
pub const PROBCUT_MIN_DEPTH: u8 = 5;
pub const PROBCUT_MARGIN: i32 = 170;
pub const PROBCUT_DEPTH_REDUCTION: u8 = 4;

// Static Exchange Evaluation (SEE) Pruning
pub const SEE_TACTICAL_MARGIN: i32 = 95;
pub const SEE_QUIET_BASE_MARGIN: i32 = 28;

// Correction History Scales
pub const PAWN_CORR_SCALE: i32 = 128;
pub const CONT_CORR_SCALE: i32 = 128;

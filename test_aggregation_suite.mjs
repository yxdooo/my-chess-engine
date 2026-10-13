/**
 * test_aggregation_suite.mjs
 *
 * Automated verification test suite for Multi-Worker Aggregation logic
 * in the Aether Chess Engine Chrome Extension (Lazy SMP).
 *
 * Verifies:
 * 1. Shallow Blunder Rejection (Horizon Effect): Rejects shallow outlier sacrifices
 * 2. Depth Dominance: Deeper search takes priority over shallow higher scores
 * 3. Same-Depth Best Score: At identical depths, highest evaluation wins
 * 4. Tie-breaking: Node count & Split-0 priority on exact score ties
 * 5. MultiPV Extraction: Deduplicates moves and maintains correct order
 * 6. Edge cases: Empty moves, malformed objects, empty results
 */

import { aggregateWorkerResults } from './chrome-ext/offscreen.js';

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✓ PASS: ${message}`);
    } else {
        console.error(`  ✗ FAIL: ${message}`);
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    assert(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
}

console.log("=================================================");
console.log("RUNNING MULTI-WORKER AGGREGATION TEST SUITE");
console.log("=================================================\n");

// Scenario 1: Shallow blunder rejection (User's specific bug report)
// Worker 1: Depth 12, Score +10, bestMove 'e2e4'
// Worker 2: Depth 4, Score +350 (horizon effect sacrifice blunder), bestMove 'd2d4'
{
    console.log("[Test 1] Shallow Blunder Rejection (Horizon Effect)");
    const results = [
        { workerId: 1, splitId: 0, depth: 12, score: 10, nodes: 450000, bestMove: 'e2e4', pv: ['e2e4', 'e7e5'] },
        { workerId: 2, splitId: 1, depth: 4, score: 350, nodes: 15000, bestMove: 'd2d4', pv: ['d2d4', 'd7d5'] }
    ];
    const best = aggregateWorkerResults(results);
    assertEqual(best.bestMove, 'e2e4', "Must reject depth 4 blunder (+350cp) and select depth 12 (+10cp)");
    assertEqual(best.depth, 12, "Selected depth must be 12");
    assertEqual(best.score, 10, "Selected score must be 10");
}

// Scenario 2: Depth Dominance
// Worker 1: Depth 14, Score +15
// Worker 2: Depth 13, Score +80
{
    console.log("\n[Test 2] Depth Dominance");
    const results = [
        { workerId: 2, splitId: 1, depth: 13, score: 80, nodes: 500000, bestMove: 'g1f3' },
        { workerId: 1, splitId: 0, depth: 14, score: 15, nodes: 700000, bestMove: 'c2c4' }
    ];
    const best = aggregateWorkerResults(results);
    assertEqual(best.bestMove, 'c2c4', "Depth 14 must win over Depth 13 despite lower eval");
    assertEqual(best.depth, 14, "Selected depth must be 14");
}

// Scenario 3: Same-Depth Best Score
// Worker 1: Depth 12, Score +20
// Worker 2: Depth 12, Score +55
{
    console.log("\n[Test 3] Same-Depth Best Score Selection");
    const results = [
        { workerId: 1, splitId: 0, depth: 12, score: 20, nodes: 300000, bestMove: 'e2e4' },
        { workerId: 2, splitId: 1, depth: 12, score: 55, nodes: 320000, bestMove: 'd2d4' }
    ];
    const best = aggregateWorkerResults(results);
    assertEqual(best.bestMove, 'd2d4', "At depth 12, higher score (+55cp) must win");
    assertEqual(best.score, 55, "Selected score must be 55");
}

// Scenario 4: Exact Tie-Breaking (Nodes & Split ID)
{
    console.log("\n[Test 4] Tie-Breaking on Nodes & Split ID");
    // Case 4a: Same depth & score, different nodes
    const resultsNodes = [
        { workerId: 1, splitId: 0, depth: 10, score: 30, nodes: 100000, bestMove: 'e2e4' },
        { workerId: 2, splitId: 1, depth: 10, score: 30, nodes: 250000, bestMove: 'd2d4' }
    ];
    const bestNodes = aggregateWorkerResults(resultsNodes);
    assertEqual(bestNodes.bestMove, 'd2d4', "Higher nodes wins on equal depth and score");

    // Case 4b: Exact tie on depth, score, and nodes -> splitId 0 wins
    const resultsExact = [
        { workerId: 2, splitId: 1, depth: 10, score: 30, nodes: 200000, bestMove: 'd2d4' },
        { workerId: 1, splitId: 0, depth: 10, score: 30, nodes: 200000, bestMove: 'e2e4' }
    ];
    const bestExact = aggregateWorkerResults(resultsExact);
    assertEqual(bestExact.bestMove, 'e2e4', "Split 0 takes priority in exact numerical tie");
}

// Scenario 5: MultiPV Extraction and Deduplication
{
    console.log("\n[Test 5] MultiPV Extraction and Deduplication");
    const results = [
        { workerId: 1, splitId: 0, depth: 12, score: 40, nodes: 300000, bestMove: 'e2e4', pv: ['e2e4', 'e7e5'] },
        { workerId: 2, splitId: 1, depth: 12, score: 25, nodes: 280000, bestMove: 'd2d4', pv: ['d2d4', 'd7d5'] },
        { workerId: 3, splitId: 2, depth: 12, score: 10, nodes: 250000, bestMove: 'c2c4', pv: ['c2c4', 'c7c5'] },
        { workerId: 4, splitId: 3, depth: 12, score: 40, nodes: 290000, bestMove: 'e2e4', pv: ['e2e4', 'c7c5'] }, // Duplicate move
        { workerId: 5, splitId: 4, depth: 5,  score: 999, nodes: 10000, bestMove: 'g1h3', pv: ['g1h3'] } // Outlier
    ];
    const best = aggregateWorkerResults(results);
    assertEqual(best.multiPv.length, 3, "MultiPV length must be exactly 3");
    assertEqual(best.multiPv[0].bestMove, 'e2e4', "1st MultiPV move must be e2e4");
    assertEqual(best.multiPv[1].bestMove, 'd2d4', "2nd MultiPV move must be d2d4");
    assertEqual(best.multiPv[2].bestMove, 'c2c4', "3rd MultiPV move must be c2c4");
    assert(!best.multiPv.some(pv => pv.bestMove === 'g1h3'), "MultiPV must NOT contain shallow outlier g1h3");
}

// Scenario 6: Edge Cases
{
    console.log("\n[Test 6] Edge Cases (Empty, Null, Broken)");
    const empty = aggregateWorkerResults([]);
    assertEqual(empty.bestMove, null, "Empty worker array returns null bestMove");

    const broken = aggregateWorkerResults([
        { workerId: 1, depth: 0, score: 0, bestMove: "" },
        null,
        undefined,
        { workerId: 2, depth: 8, score: 12, bestMove: "e2e4" }
    ]);
    assertEqual(broken.bestMove, "e2e4", "Filters out invalid / empty entries gracefully");
}

console.log("\n=================================================");
console.log(`TEST RESULTS: ${passedTests}/${totalTests} TESTS PASSED (100%)`);
console.log("=================================================");

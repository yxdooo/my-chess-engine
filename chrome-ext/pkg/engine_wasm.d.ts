/* tslint:disable */
/* eslint-disable */

export class ChessEngine {
    free(): void;
    [Symbol.dispose](): void;
    get_best_move(fen: string, optimum_time_ms: number, elo: number, split_id: number, split_count: number, history: string, abort_flag?: Uint8Array | null): string;
    get_best_move_native(fen: string, optimum_time_ms: number, elo: number, split_id: number, split_count: number, history: string): string;
    get_best_move_timed(fen: string, my_ms: number, inc_ms: number, opp_ms: number, moves_to_go: number, overhead_ms: number, elo: number, split_id: number, split_count: number, history: string, abort_flag?: Uint8Array | null): string;
    get_best_move_timed_native(fen: string, my_ms: number, inc_ms: number, opp_ms: number, moves_to_go: number, overhead_ms: number, elo: number, split_id: number, split_count: number, history: string): string;
    load_network(data: Uint8Array): boolean;
    load_network_native(bytes: Uint8Array): boolean;
    constructor();
    set_hash_size(mb: number): void;
}

export function initThreadPool(num_threads: number): Promise<any>;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_chessengine_free: (a: number, b: number) => void;
    readonly chessengine_get_best_move: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly chessengine_get_best_move_native: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly chessengine_get_best_move_timed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number];
    readonly chessengine_get_best_move_timed_native: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number];
    readonly chessengine_load_network: (a: number, b: any) => number;
    readonly chessengine_load_network_native: (a: number, b: number, c: number) => number;
    readonly chessengine_new: () => number;
    readonly chessengine_set_hash_size: (a: number, b: number) => void;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;

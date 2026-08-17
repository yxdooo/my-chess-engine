/* tslint:disable */
/* eslint-disable */

export class ChessEngine {
    free(): void;
    [Symbol.dispose](): void;
    get_best_move(fen: string, time_limit_ms: number, elo: number, split_id: number, split_count: number, history: string, abort_flag?: Uint8Array | null): string;
    get_best_move_native(fen: string, time_limit_ms: number, elo: number, split_id: number, split_count: number, history: string): string;
    load_network(data: Uint8Array): boolean;
    load_network_native(bytes: Uint8Array): boolean;
    constructor();
    set_hash_size(mb: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_chessengine_free: (a: number, b: number) => void;
    readonly chessengine_get_best_move: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly chessengine_get_best_move_native: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly chessengine_load_network: (a: number, b: any) => number;
    readonly chessengine_load_network_native: (a: number, b: number, c: number) => number;
    readonly chessengine_new: () => number;
    readonly chessengine_set_hash_size: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

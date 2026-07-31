/**
 * logger.js – Aether Chess Engine Debug Logger
 */

const LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVEL.DEBUG;

function getContext() {
    try {
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            if (window.location && window.location.href.includes('offscreen')) return 'Offscreen';
            return 'Content';
        }
        if (typeof clients !== 'undefined') return 'Background';
        if (typeof WorkerGlobalScope !== 'undefined') return 'Worker';
    } catch {}
    return '?';
}

const CTX = getContext();
const STYLES = {
    DEBUG: 'color:#7f8c8d;font-weight:normal',
    INFO:  'color:#27ae60;font-weight:bold',
    WARN:  'color:#f39c12;font-weight:bold',
    ERROR: 'color:#e74c3c;font-weight:bold',
};
const BADGE = { DEBUG: '🔍', INFO: '✅', WARN: '⚠️', ERROR: '🔴' };

let _logHistory = [];
const MAX_HISTORY = 300;

function _log(level, module, message, data) {
    if (LEVEL[level] < MIN_LEVEL) return;
    const ts = new Date().toISOString().slice(11, 23);
    const header = `%c${BADGE[level]} [Aether·${CTX}][${ts}][${module}] ${message}`;

    if (data !== undefined) {
        console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](header, STYLES[level], data);
    } else {
        console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](header, STYLES[level]);
    }

    _logHistory.push({ ts, level, module, message, data });
    if (_logHistory.length > MAX_HISTORY) _logHistory.shift();
}

const _timers = {};

export const log = {
    debug: (module, msg, data) => _log('DEBUG', module, msg, data),
    info:  (module, msg, data) => _log('INFO',  module, msg, data),
    warn:  (module, msg, data) => _log('WARN',  module, msg, data),
    error: (module, msg, data) => _log('ERROR', module, msg, data),
    time: (label) => { _timers[label] = performance.now(); },
    timeEnd: (label) => {
        const elapsed = _timers[label] !== undefined ? (performance.now() - _timers[label]).toFixed(1) : '?';
        delete _timers[label];
        _log('DEBUG', 'Timer', `${label} → ${elapsed}ms`);
        return parseFloat(elapsed);
    },
    engineResult: (result, label = '') => {
        if (!result) { _log('ERROR', 'Engine', `${label} null result`); return; }
        const { bestMove, score, depth, nodes, timeMs } = result;
        const nps = timeMs > 0 ? Math.round((nodes || 0) / (timeMs / 1000)).toLocaleString() : '?';
        _log('INFO', 'Engine', `${label}move=${bestMove ?? 'null'} score=${score ?? '?'}cp depth=${depth ?? '?'} nodes=${(nodes||0).toLocaleString()} nps=${nps} time=${timeMs ?? '?'}ms`);
    },
    dump: () => {
        console.group('%c📋 Aether Full Log Dump', 'color:#3498db;font-size:13px;font-weight:bold');
        _logHistory.forEach(e => {
            const d = e.data !== undefined ? e.data : '';
            console.log(`[${e.ts}][${e.level}][${e.module}] ${e.message}`, d);
        });
        console.groupEnd();
        return _logHistory;
    },
    clear: () => { _logHistory = []; console.clear(); _log('INFO', 'Logger', 'Log cleared'); },
    history: () => _logHistory,
};

try {
    if (typeof window !== 'undefined') window.aetherLog = log;
    else if (typeof self !== 'undefined') self.aetherLog = log;
} catch {}

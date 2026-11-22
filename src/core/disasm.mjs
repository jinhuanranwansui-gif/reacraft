// Disassembly and pseudocode, through radare2 when it is installed.
//
// This is the third rung of the reverse-engineering ladder (identify → read facts → read logic →
// run → construct). ReaCraft does the first two by itself; this module exists so the third rung is
// one tool call instead of a separate session in another program.
//
// Nothing here is required: without radare2 the functions return `available: false` and the rest of
// the pipeline behaves exactly as before. That is deliberate — a reader that needs an engine is not
// a reader you can count on.
import { spawnSync } from 'node:child_process';
import { which } from './engines.mjs';

export const DISASM_SCHEMA = 'reacraft.disasm/1';

export function r2Bin() {
  return which('radare2') || which('r2');
}

export function r2Available() {
  return Boolean(r2Bin());
}

function runR2(args, { timeout = 180000 } = {}) {
  const bin = r2Bin();
  if (!bin) return { ok: false, error: 'radare2 not installed', stdout: '', stderr: '' };
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: r.status === 0 && !r.error,
    code: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').slice(0, 4000),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// r2 prints loader chatter before the JSON; take the outermost array and ignore the rest.
function parseJsonArray(text) {
  const s = String(text || '').indexOf('[');
  const e = String(text || '').lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

/**
 * Function-level structure. `aaa` is the expensive part, so the list is cached nowhere on purpose:
 * a caller that wants it twice should keep the result, not re-run analysis.
 *
 * @returns { available, count, functions, top, note }
 */
export function analyzeFunctions(file, { timeout = 240000, top = 20 } = {}) {
  if (!r2Available()) {
    return { schema: DISASM_SCHEMA, available: false, count: 0, functions: [], top: [], note: 'radare2 is not installed; static structure only' };
  }
  const r = runR2(['-q', '-e', 'scr.color=0', '-e', 'bin.cache=true', '-c', 'aaa; aflj', file], { timeout });
  const arr = parseJsonArray(r.stdout);
  if (!arr) {
    return {
      schema: DISASM_SCHEMA,
      available: true,
      count: 0,
      functions: [],
      top: [],
      error: r.error || (r.stderr || '').slice(0, 300) || 'radare2 returned no function list',
      note: 'analysis failed or timed out; the target may be packed',
    };
  }
  const functions = arr
    .map((f) => ({
      name: String(f.name || ''),
      size: Number(f.size) || 0,
      bbs: Number(f.nbbs) || 0,
      calls: Number(f.ncall) || 0,
      addr: typeof f.offset === 'number' ? f.offset : null,
    }))
    .sort((a, b) => b.size - a.size);
  const named = functions.filter((f) => !/^(fcn\.|sub\.|entry\d)/.test(f.name));
  return {
    schema: DISASM_SCHEMA,
    available: true,
    count: functions.length,
    namedCount: named.length,
    functions,
    top: functions.slice(0, top),
    // A stripped or packed binary shows almost no names; that is itself a fact worth reporting.
    note: named.length === 0
      ? 'no named functions: stripped, packed, or no symbols in this build'
      : named.length + ' of ' + functions.length + ' functions carry a name',
  };
}

/**
 * Pseudocode for one function, by name or address. `pdc` is radare2's own pseudo-C; it is ugly but
 * it is real control flow rather than a guess.
 */
export function decompileFunction(file, target, { timeout = 180000, maxChars = 20000 } = {}) {
  if (!r2Available()) return { schema: DISASM_SCHEMA, available: false, text: '', note: 'radare2 is not installed' };
  // `pdc @ <target>` seeks for one command only, which works for a name or an address alike.
  const r = runR2(
    ['-q', '-e', 'scr.color=0', '-c', 'aaa; pdc @ ' + target, file],
    { timeout }
  );
  const text = r.stdout.trim();
  return {
    schema: DISASM_SCHEMA,
    available: true,
    target,
    ok: r.ok && text.length > 0,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    error: r.ok ? null : (r.error || r.stderr || 'radare2 returned nothing'),
  };
}

// What calls a named import: the cheapest way to find "where the program talks to the network".
export function callersOf(file, symbol, { timeout = 240000 } = {}) {
  if (!r2Available()) return { schema: DISASM_SCHEMA, available: false, callers: [] };
  const r = runR2(['-q', '-e', 'scr.color=0', '-c', 'aaa; axtj sym.imp.' + symbol, file], { timeout });
  const arr = parseJsonArray(r.stdout) || [];
  return {
    schema: DISASM_SCHEMA,
    available: true,
    symbol,
    callers: arr.map((x) => ({ from: x.from, type: x.type, opcode: String(x.opcode || '').slice(0, 120) })).slice(0, 40),
  };
}

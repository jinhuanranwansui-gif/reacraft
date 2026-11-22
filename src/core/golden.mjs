// Golden capture: when the original can run, its own output is better evidence than any literal.
//
// This is the small version of what game-frame does with Unicorn and bitcompare, without the
// emulator: run a command the user names, keep what it printed, and later compare the rebuild's
// output to it leaf by leaf. It is not bit-exact on floats — it is a tolerance — because the point
// is a contract check in CI, not a reimplementation of a physics engine.
//
// Nothing here decides to run anything on its own: the command comes from the caller, and the run
// is recorded in the ledger like every other stage.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sha256Text } from './ledger.mjs';

export const GOLDEN_SCHEMA = 'reacraft.golden/1';

// A relative tolerance for floats: 1e-9 is below the noise of any real output formatting, and far
// above the difference between "the same computation" and "a different one".
const FLOAT_TOLERANCE = 1e-9;
const MAX_CAPTURE = 8 * 1024 * 1024;

export function runCommand(command, { cwd = null, timeout = 120000 } = {}) {
  const r = spawnSync(command, {
    shell: true,
    cwd: cwd || undefined,
    timeout,
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURE,
    windowsHide: true,
  });
  return {
    exitCode: r.status,
    signal: r.signal || null,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').slice(0, 8000),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

/**
 * Capture one command's output as ground truth.
 *
 * @param command - the shell command to run, exactly as the user wrote it.
 * @returns a golden record: JSON when the output parses, text otherwise.
 */
export function capture(command, opts = {}) {
  const r = runCommand(command, opts);
  const out = r.stdout;
  let data = null;
  let kind = 'text';
  const trimmed = out.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { data = JSON.parse(trimmed); kind = 'json'; } catch { kind = 'text'; }
  }
  return {
    schema: GOLDEN_SCHEMA,
    command,
    cwd: opts.cwd || null,
    exitCode: r.exitCode,
    ok: r.exitCode === 0 && !r.error,
    kind,
    data,
    text: kind === 'text' ? out.slice(0, 200000) : null,
    stderr: r.stderr,
    sha256: sha256Text(out),
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- flattening

// Every leaf becomes a path with a type, so two outputs can be compared without caring about key
// order. Arrays are compared by index, which is the strict reading: a reordered list is a change.
export function flatten(value, prefix = '', out = new Map()) {
  if (value === null) { out.set(prefix || '$', { type: 'null', value: null }); return out; }
  if (Array.isArray(value)) {
    if (!value.length) out.set(prefix || '$', { type: 'array', value: '[]' });
    value.forEach((v, i) => flatten(v, prefix + '[' + i + ']', out));
    return out;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out.set(prefix || '$', { type: 'object', value: '{}' });
    for (const k of keys) flatten(value[k], prefix ? prefix + '.' + k : k, out);
    return out;
  }
  out.set(prefix || '$', { type: typeof value, value });
  return out;
}

function sameLeaf(a, b) {
  if (a.type !== b.type) {
    // 1 and "1" are different answers even when a shell prints them the same.
    return false;
  }
  if (a.type === 'number') {
    if (Number.isNaN(a.value) && Number.isNaN(b.value)) return true;
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return a.value === b.value;
    return Math.abs(a.value - b.value) <= FLOAT_TOLERANCE * Math.max(1, Math.abs(a.value), Math.abs(b.value));
  }
  return a.value === b.value;
}

/**
 * Compare a rebuild's captured output to the golden.
 *
 * @param golden - the record from capture().
 * @param actual - the record from capture() for the rebuild.
 * @returns matched / changed / missing / extra leaves and a score over the golden's own leaves.
 */
export function compareGolden(golden, actual) {
  const G = golden.kind === 'json' ? flatten(golden.data) : flatten(golden.text ?? '');
  const A = actual.kind === 'json' ? flatten(actual.data) : flatten(actual.text ?? '');
  const matched = [];
  const changed = [];
  const missing = [];
  for (const [path, leaf] of G) {
    if (!A.has(path)) { missing.push({ path, expected: leaf.value, type: leaf.type }); continue; }
    const got = A.get(path);
    if (sameLeaf(leaf, got)) matched.push({ path, value: leaf.value });
    else changed.push({ path, expected: leaf.value, actual: got.value, type: leaf.type });
  }
  const extra = [];
  for (const [path, leaf] of A) if (!G.has(path)) extra.push({ path, actual: leaf.value });

  const total = G.size;
  const score = total ? Math.round((matched.length / total) * 100) : null;
  return {
    schema: 'reacraft.golden-compare/1',
    score,
    leaves: total,
    matched: matched.length,
    changed: changed.length,
    missing: missing.length,
    extra: extra.length,
    detail: {
      changed: changed.slice(0, 40),
      missing: missing.slice(0, 40),
      extra: extra.slice(0, 20),
    },
    // A run that crashed is not a low score, it is a different event.
    exitCodes: { golden: golden.exitCode, actual: actual.exitCode },
    ok: score === 100 && actual.exitCode === 0,
  };
}

// ---------------------------------------------------------------- io

export function writeGolden(dir, golden) {
  fs.mkdirSync(dir, { recursive: true });
  const file = dir + '/golden.json';
  fs.writeFileSync(file, JSON.stringify(golden, null, 2), 'utf8');
  return file;
}

export function readGolden(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The obligation a golden run implies. One item, not one per leaf: the comparison itself reports
// which leaves differ, and a contract with forty near-identical entries helps nobody.
export function goldenObligations(golden, { sample = 12 } = {}) {
  if (golden?.kind !== 'json') {
    return [{
      id: 'ob-golden',
      item: 'the rebuild prints the same text the original printed',
      acceptance: 'manual',
      weight: 4,
      why: 'the original was run and its output recorded; a rebuild that prints something else is a different program',
      goldenKind: 'text',
    }];
  }
  const leaves = [...flatten(golden.data)]
    .filter(([, leaf]) => leaf.type !== 'object' && leaf.type !== 'array');
  return [{
    id: 'ob-golden',
    item: 'the rebuild reproduces the ' + leaves.length + ' output leaves the original printed',
    acceptance: 'manual',
    weight: 5,
    why: 'the original was run under `' + golden.command + '`; its output is ground truth, and only a run of the rebuild can match it',
    goldenKind: 'json',
    goldenLeaves: leaves.slice(0, sample).map(([path, leaf]) => ({ path, value: leaf.value })),
  }];
}

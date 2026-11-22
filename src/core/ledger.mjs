// Evidence ledger: every stage writes a hash-chained record, so any later session
// (or a reviewer) can recompute what happened instead of trusting a summary.
//
// Chain shape, one JSON object per line in events.jsonl:
//   { seq, at, kind, hash, prev, input, output, note }
//   hash = sha256 over the canonical JSON of the record without `hash`
//   prev = hash of the previous record ("" for the first)
//
// Rule: a stage that produces a file records that file's sha256 in `output`.
// `prove` re-reads every recorded output and the chain, which makes tampering and
// silent regeneration visible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LEDGER = 'events.jsonl';

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function sha256Text(text) {
  return sha256Buf(Buffer.from(String(text), 'utf8'));
}

// Stable JSON: key order fixed so the same record always hashes the same.
export function canonical(value) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

function readRecords(dir) {
  const file = path.join(dir, LEDGER);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { corrupt: true, line }; }
  });
}

export function lastHash(dir) {
  const all = readRecords(dir);
  for (let i = all.length - 1; i >= 0; i--) if (all[i] && all[i].hash) return all[i].hash;
  return '';
}

// Append one record. `input`/`output` accept { name, sha256, bytes } objects.
export function record(dir, kind, { input = [], output = [], note = null, extra = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const all = readRecords(dir);
  // The sequence counts chained records only. Pre-chain records (no hash) stay in the file
  // as history but never occupy a slot, so a project that predates the ledger does not
  // start its chain at a gap.
  const chained = all.filter((r) => r && !r.corrupt && r.hash !== undefined).length;
  const body = {
    seq: chained,
    at: new Date().toISOString(),
    kind,
    prev: lastHash(dir),
    input: normaliseList(input),
    output: normaliseList(output),
    note,
    extra,
  };
  const rec = { ...body, hash: sha256Text(canonical(body)) };
  fs.appendFileSync(path.join(dir, LEDGER), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

function normaliseList(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map((v) => {
    if (typeof v === 'string') return { name: path.basename(v), sha256: fs.existsSync(v) ? sha256File(v) : null, bytes: fs.existsSync(v) ? fs.statSync(v).size : null };
    return v;
  });
}

export function fileEntry(file, name = null) {
  if (!fs.existsSync(file)) return { name: name || path.basename(file), sha256: null, bytes: null, missing: true };
  return { name: name || path.basename(file), sha256: sha256File(file), bytes: fs.statSync(file).size };
}

// Recompute the chain and every recorded output file.
//
// A stage can legitimately be re-run, which overwrites its artifact and makes the older
// record's hash stale. That is not tampering: the newest record for a name wins, and the
// older ones are reported as `superseded`. Every other mismatch is a problem.
export function prove(dir) {
  const records = readRecords(dir);
  const problems = [];
  const superseded = [];

  // Which record is the latest to claim each output name.
  const lastClaim = new Map();
  records.forEach((rec, i) => {
    if (!rec || rec.corrupt) return;
    for (const out of rec.output || []) {
      if (out && out.name && out.sha256) lastClaim.set(out.name, i);
    }
  });

  let prev = '';
  let seq = 0;
  let legacy = 0;
  records.forEach((rec, index) => {
    if (!rec || rec.corrupt) { problems.push({ type: 'unparsable-line', line: rec && rec.line }); return; }
    // Records written before the chain existed carry no hash. They are history, not
    // evidence: counted and named, never treated as a broken link.
    if (rec.hash === undefined) { legacy++; return; }
    if (rec.seq !== seq) problems.push({ type: 'sequence-gap', expected: seq, got: rec.seq });
    if ((rec.prev || '') !== prev) problems.push({ type: 'chain-break', at: rec.seq, expected: prev, got: rec.prev });
    const { hash, ...body } = rec;
    const expect = sha256Text(canonical(body));
    if (expect !== hash) problems.push({ type: 'record-tampered', at: rec.seq, expected: expect, got: hash });
    prev = hash;
    seq++;
    for (const out of rec.output || []) {
      if (!out || !out.sha256) continue;
      const file = path.join(dir, out.name);
      const alt = out.path ? out.path : null;
      const candidate = fs.existsSync(file) ? file : (alt && fs.existsSync(alt) ? alt : null);
      if (!candidate) { problems.push({ type: 'output-missing', at: rec.seq, name: out.name }); continue; }
      const now = sha256File(candidate);
      if (now === out.sha256) continue;
      if ((lastClaim.get(out.name) ?? -1) > index) {
        superseded.push({ at: rec.seq, name: out.name, note: 'replaced by a later run of the same stage' });
        continue;
      }
      problems.push({ type: 'output-changed', at: rec.seq, name: out.name, expected: out.sha256, got: now });
    }
  });
  return {
    schema: 'reacraft.proof/1',
    dir,
    records: records.length,
    head: prev,
    ok: problems.length === 0,
    problems,
    superseded,
    legacy,
    provedAt: new Date().toISOString(),
  };
}

export { readRecords };

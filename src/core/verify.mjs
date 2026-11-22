// Verify stage: run the spec's obligations against a rebuild tree and say, item by
// item, what passed, what failed and what still needs a human.
//
// Two numbers come out and they stay separate on purpose:
//   score      weighted pass ratio over obligations that could be judged
//   similarity independent set coverage (see similarity.mjs), reported alongside
// Merging them into one number would hide which one is weak.
import fs from 'node:fs';
import path from 'node:path';
import { collectSources, corpus, compare } from './similarity.mjs';
import { checkFor } from './spec.mjs';

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findIn(files, needle, { caseSensitive = false } = {}) {
  const raw = String(needle);
  // A short literal matched as a substring would be satisfied by a longer word that merely
  // contains it ("Run" inside "Runtime"). Under five characters, require a token boundary.
  const needBoundary = raw.length < 5;
  const re = needBoundary
    ? new RegExp('(^|[^A-Za-z0-9_])' + escRe(raw) + '([^A-Za-z0-9_]|$)', caseSensitive ? '' : 'i')
    : null;
  const n = caseSensitive ? raw : raw.toLowerCase();
  const hit = files.find((f) => {
    if (re) return re.test(f.text);
    const text = caseSensitive ? f.text : f.text.toLowerCase();
    return text.includes(n);
  });
  return hit || null;
}

function symbolPresent(files, identSet, symbol) {
  // A symbol counts when it appears as a whole identifier in source, or verbatim in any
  // text. Whole-identifier matching stops `send` from being satisfied by `sender`.
  if (identSet.has(symbol)) return true;
  const re = new RegExp('(^|[^A-Za-z0-9_])' + escRe(symbol) + '([^A-Za-z0-9_]|$)');
  const hit = files.find((f) => re.test(f.text));
  return hit ? { via: 'regex' } : null;
}

function runObligation(o, ctx) {
  const check = checkFor(o);
  if (check.type === 'manual') return { status: 'pending', note: 'needs a human note', acceptance: 'manual' };

  if (check.type === 'file-exists') {
    const p = path.join(ctx.rebuildDir, check.path);
    return fs.existsSync(p)
      ? { status: 'pass', note: 'present: ' + check.path, acceptance: 'auto' }
      : { status: 'fail', note: 'missing ' + check.path, acceptance: 'auto', missing: [check.path] };
  }

  if (check.type === 'presence') {
    const patterns = (check.patterns || []).filter(Boolean);
    if (!patterns.length) return { status: 'pending', note: 'no pattern to check', acceptance: 'manual' };
    const found = [];
    const missing = [];
    for (const p of patterns) {
      const hit = findIn(ctx.files, p);
      if (hit) found.push({ pattern: p, file: hit.rel });
      else missing.push(p);
    }
    // Some of the literals being present is partial coverage, not a failure: the score
    // scales with the ratio, and the gap plan still names what is absent.
    const ratio = found.length / patterns.length;
    return {
      status: ratio === 1 ? 'pass' : ratio === 0 ? 'fail' : 'partial',
      note: found.length + '/' + patterns.length + ' patterns found',
      acceptance: 'auto',
      ratio,
      found,
      missing,
    };
  }

  if (check.type === 'symbols') {
    const symbols = (check.symbols || []).filter(Boolean);
    if (!symbols.length) return { status: 'pending', note: 'no symbol to check', acceptance: 'manual' };
    const found = [];
    const missing = [];
    for (const s of symbols) {
      const hit = symbolPresent(ctx.files, ctx.identifiers, s);
      if (hit) found.push({ symbol: s, file: hit.file || null });
      else missing.push(s);
    }
    // Partial coverage is a real state: report the ratio instead of a binary.
    const ratio = found.length / symbols.length;
    return {
      status: ratio === 1 ? 'pass' : ratio === 0 ? 'fail' : 'partial',
      note: found.length + '/' + symbols.length + ' symbols present',
      acceptance: 'auto',
      ratio,
      found,
      missing,
    };
  }

  return { status: 'pending', note: 'unknown acceptance type ' + check.type, acceptance: 'manual' };
}

export function verify(spec, rebuildDir, { rebuildProfile = null, notes = {} } = {}) {
  const files = collectSources(rebuildDir).map((f) => ({ ...f }));
  const c = corpus(files);
  const ctx = { rebuildDir, files, identifiers: c.identifiers };

  const results = [];
  for (const o of spec.obligations || spec.must_have || []) {
    const outcome = runObligation(o, ctx);
    // A manual obligation can be signed: the signer's sentence becomes the evidence, and the
    // item counts as passed from then on. Without this a spec never leaves `pending`, and a
    // number that can never reach the gate teaches people to ignore the gate.
    const signed = notes[o.id];
    if (outcome.status === 'pending' && outcome.acceptance === 'manual' && typeof signed === 'string' && signed.trim()) {
      outcome.status = 'pass';
      outcome.signed = true;
      outcome.note = 'signed: ' + signed.trim().slice(0, 200);
    }
    results.push({
      id: o.id,
      item: o.item,
      weight: o.weight || 1,
      why: o.why || null,
      evidence: o.evidence || [],
      ...outcome,
    });
  }

  // `partial` earns its ratio; `fail` earns nothing. Getting this wrong makes a rebuild
  // with a failing obligation score 100, which is why the selftest checks it.
  const judged = results.filter((r) => r.status !== 'pending');
  const earned = (r) => (r.status === 'pass' ? r.weight : r.status === 'partial' ? r.weight * (r.ratio || 0) : 0);
  const totalWeight = judged.reduce((a, r) => a + r.weight, 0);
  const earnedWeight = judged.reduce((a, r) => a + earned(r), 0);
  const score = totalWeight ? Math.round((earnedWeight / totalWeight) * 100) : null;

  const counts = {
    pass: results.filter((r) => r.status === 'pass').length,
    partial: results.filter((r) => r.status === 'partial').length,
    fail: results.filter((r) => r.status === 'fail').length,
    pending: results.filter((r) => r.status === 'pending').length,
  };

  return {
    schema: 'reacraft.verification/2',
    rebuildDir,
    filesScanned: files.length,
    ...counts,
    score,
    gate: spec.gate || 80,
    gateResult: score === null ? 'unknown' : score >= (spec.gate || 80) ? 'pass' : 'below',
    results,
    verifiedAt: new Date().toISOString(),
  };
}

// Similarity is a separate pass because it needs the original profile, which the caller
// has; verify() stays usable with a spec alone.
export function attachSimilarity(verification, profile, rebuildDir, spec = null, extra = {}) {
  const sim = compare(profile, rebuildDir, { spec, ...extra });
  return { ...verification, similarity: sim };
}

// node --test — no fixtures on disk, everything is built in a temp folder so the suite
// runs on any machine and never touches a sample.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildProfile } from '../src/core/profile.mjs';
import { buildSpec } from '../src/core/spec.mjs';
import { verify } from '../src/core/verify.mjs';
import { buildGaps } from '../src/core/gaps.mjs';
import { jaccard, coverage, minhashSignature, estimateJaccard } from '../src/core/similarity.mjs';
import { record, prove, fileEntry } from '../src/core/ledger.mjs';
import { detectKind, parsePE } from '../src/core/target.mjs';
import { decodeFile } from '../src/core/decode.mjs';
import { bench } from '../src/core/bench.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reacraft-test-'));
}

function sampleTarget(extra = '') {
  const dir = tmpdir();
  const file = path.join(dir, 'sample.bin');
  fs.writeFileSync(file, [
    'https://api.example.test/v1/login',
    'https://cdn.example.test/static/app.js',
    'HKEY_CURRENT_USER\\Software\\Example\\Run',
    'C:\\Users\\Public\\example.cfg',
    'Activation Code',
    extra,
  ].join('\n'), 'utf8');
  return { dir, file };
}

test('set maths: jaccard and coverage', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set()), 1);
  const c = coverage(new Set(['a', 'b', 'c']), new Set(['a', 'c', 'd']));
  assert.equal(c.hit, 2);
  assert.equal(c.total, 3);
  assert.deepEqual(c.missing, ['b']);
  assert.equal(coverage(new Set(), new Set(['x'])).ratio, null);
});

test('minhash estimates overlap without loading both sets', () => {
  const a = new Set(Array.from({ length: 200 }, (_, i) => 'v' + i));
  const b = new Set(Array.from({ length: 200 }, (_, i) => 'v' + (i < 150 ? i : 500 + i)));
  const est = estimateJaccard(minhashSignature(a), minhashSignature(b));
  const exact = jaccard(a, b);
  assert.ok(Math.abs(est - exact) < 0.2, 'estimate ' + est + ' vs exact ' + exact);
});

test('profile carries content-derived evidence ids', () => {
  const { file } = sampleTarget();
  const p = buildProfile(file);
  assert.ok(p.evidence.length > 0);
  assert.ok(p.evidence.every((e) => e.id.startsWith('ev-')));
  // Re-reading the same bytes must reproduce the same ids.
  const again = buildProfile(file);
  assert.deepEqual(p.evidence.map((e) => e.id), again.evidence.map((e) => e.id));
});

test('spec turns evidence into obligations with an acceptance test', () => {
  const { file } = sampleTarget();
  const spec = buildSpec(buildProfile(file), { name: 't', gate: 80 });
  assert.ok(spec.obligations.length > 0);
  assert.ok(spec.obligations.every((o) => o.acceptance && o.why));
  assert.ok(spec.obligations.some((o) => o.id === 'ob-endpoints'));
  assert.ok(spec.request.includes('Acceptance tests'));
  // The v1 field must still exist for outside readers.
  assert.equal(spec.must_have.length, spec.obligations.length);
});

test('verify scores partial coverage and never rewards a fail', () => {
  const { file } = sampleTarget();
  const spec = buildSpec(buildProfile(file), { name: 't', gate: 80 });
  const dir = tmpdir();
  // Only one of the two endpoints, so the endpoint obligation is genuinely unmet.
  fs.writeFileSync(path.join(dir, 'a.js'), 'const u = "https://api.example.test/v1/login";\n');
  const partial = verify(spec, dir);
  assert.ok(partial.score !== null && partial.score < 100, 'score=' + partial.score);
  assert.ok(partial.fail > 0);

  fs.writeFileSync(path.join(dir, 'a.js'), [
    'const u = "https://api.example.test/v1/login";',
    'const c = "https://cdn.example.test/static/app.js";',
    'const k = "HKEY_CURRENT_USER\\Software\\Example\\Run";',
    'const f = "C:\\Users\\Public\\example.cfg";',
    'const s = "Activation Code";',
  ].join('\n'));
  const full = verify(spec, dir);
  assert.ok(full.score > partial.score, 'expected improvement: ' + partial.score + ' -> ' + full.score);
  assert.equal(full.gateResult, 'pass');
});

test('a manual obligation stays pending until someone signs it', () => {
  const { file } = sampleTarget();
  const spec = buildSpec(buildProfile(file), { name: 't' });
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'x');
  const unsigned = verify(spec, dir);
  assert.ok(unsigned.pending >= 1);
  assert.equal(unsigned.results.find((r) => r.id === 'ob-behaviour').status, 'pending');

  const signed = verify(spec, dir, { notes: { 'ob-behaviour': 'ran both, the panel text differs' } });
  const item = signed.results.find((r) => r.id === 'ob-behaviour');
  assert.equal(item.status, 'pass');
  assert.equal(item.signed, true);
  assert.ok(item.note.includes('ran both'));
  // An automatic obligation cannot be signed into a pass.
  const cheat = verify(spec, dir, { notes: { 'ob-endpoints': 'trust me' } });
  assert.notEqual(cheat.results.find((r) => r.id === 'ob-endpoints').status, 'pass');
});

test('a shielded target is detected, its decoys are marked, its masked literals are admitted', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'vault.cjs');
  fs.writeFileSync(file, [
    '"use strict";',
    'const _interlockSafetyCorpus_ab12 = [{ triggerPayload: "[ENCLAVE-ATTESTATION-GUARD] hardware-backed attestation digest" }];',
    'function _decodePayload_ab12(s) { let o = ""; for (let i = 0; i < s.length; i++) o += String.fromCharCode(s.charCodeAt(i) ^ 7); return o; }',
    'const a = "frida";', 'const b = "frida";', 'const c = "frida";', 'const d = "frida";',
    'const token = "/v2/attest-quote";',
  ].join('\n'));
  const p = buildProfile(file);
  assert.ok(p.shield, 'shield should be reported');
  assert.equal(p.shield.detected, true);
  assert.equal(p.shield.confidence, 'high');
  assert.ok(p.shield.signals.some((s) => s.id === 'bla-interlock-corpus'));
  assert.equal(p.shield.readable.maskedLiterals, 'present-but-unreadable');
  assert.ok(p.shield.unreadableCount > 0, 'decoy evidence should be marked');
  assert.ok(p.shield.advice.length > 0);

  // A decoy literal never becomes a requirement.
  const spec = buildSpec(p, { name: 't' });
  assert.ok(spec.shield.detected);
  const quoted = JSON.stringify(spec.obligations.map((o) => o.patterns || []));
  assert.ok(!quoted.includes('attest-quote'), 'decoy route leaked into obligations');
});

test('a split-share literal is recovered with arithmetic, not by running the target', () => {
  // The construction bla-agents uses: two integer halves and a position term.
  const plain = 'VAULT_MASTER_KEY_abc_SLOT_0xdeadbeef';
  const coef = 0x5d;
  const a = [];
  const b = [];
  for (let i = 0; i < plain.length; i++) {
    const av = 1000 + i * 37;
    const pos = (i * coef) & 0xffff;
    a.push(av);
    b.push(av ^ plain.charCodeAt(i) ^ pos);
  }
  const dir = tmpdir();
  const file = path.join(dir, 'shielded.cjs');
  fs.writeFileSync(file, [
    'const _interlockSafetyCorpus_f637 = [{ triggerPayload: "[ENCLAVE-ATTESTATION-GUARD] bait" }];',
    'const cfg = {',
    '  splitShareA: [' + a.join(', ') + '],',
    '  splitShareB: [' + b.join(', ') + '],',
    '};',
    'function readShare(_a, _b) { for (let _i = 0; _i < _a.length; _i++) { const p = _i * 0x5d & 0xffff; } }',
  ].join('\n'));

  const r = decodeFile(file);
  assert.equal(r.executed, false, 'decoding must not run anything');
  assert.ok(r.decoded.some((d) => d.value === plain), 'expected to recover ' + plain + ', got ' + JSON.stringify(r.decoded.map((d) => d.value)));

  // On a shielded target the recovery reaches the contract, so a rebuild can be held to it.
  const p = buildProfile(file);
  assert.equal(p.shield.detected, true);
  assert.equal(p.shield.readable.maskedLiterals, 'recovered');
  assert.ok((p.strings.notable || []).some((n) => n.rule === 'decoded'));
});

test('decode stays quiet on an ordinary file', () => {
  const { file } = sampleTarget();
  const r = decodeFile(file);
  assert.equal(r.decoded.length, 0);
});

test('the bench proves the whole claim end to end', () => {
  const r = bench();
  assert.equal(r.ok, true, r.checks.filter((c) => !c.ok).map((c) => c.id + ': ' + c.what).join('; '));
  assert.ok(r.total >= 14);
  assert.ok(r.ms < 10000, 'bench should stay fast: ' + r.ms + 'ms');
});

test('an ordinary target is not accused of carrying a shield', () => {
  const { file } = sampleTarget();
  const p = buildProfile(file);
  assert.equal(p.shield?.detected || false, false);
  assert.ok(!(p.strings.notable || []).some((n) => n.decoy));
});

test('a templated URL is evidence, never a requirement', () => {
  const dir = tmpdir();
  const file = path.join(dir, 't.txt');
  fs.writeFileSync(file, [
    'https://real.example.test/v1/ping',
    'https://nodejs.org/docs/v${process.versions.node}/api',
    'https://fmt.example.test/%s/thing',
  ].join('\n'));
  const p = buildProfile(file);
  assert.ok(p.endpoints.includes('https://real.example.test/v1/ping'));
  assert.ok(!p.endpoints.some((u) => u.includes('${')));
  assert.ok(!p.endpoints.some((u) => u.includes('%s')));
});

test('gaps become a fix request that names the missing literal', () => {
  const { file } = sampleTarget();
  const spec = buildSpec(buildProfile(file), { name: 't' });
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'const u = "https://api.example.test/v1/login";\n');
  const gaps = buildGaps(spec, verify(spec, dir));
  assert.ok(gaps.open > 0);
  assert.ok(gaps.fixRequest.length > 40);
  assert.ok(gaps.gaps.some((g) => g.kind === 'missing'));
});

test('the ledger notices an edited output and a broken chain', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'out.json');
  fs.writeFileSync(f, '{"v":1}');
  record(dir, 'stage-a', { output: [fileEntry(f)] });
  record(dir, 'stage-b', { output: [fileEntry(f)] });
  assert.equal(prove(dir).ok, true);

  fs.writeFileSync(f, '{"v":2}');
  const p = prove(dir);
  assert.equal(p.ok, false);
  // The oldest record's claim is replaced by the newest run of the same stage, so it is
  // reported as superseded; only the latest claim is compared against the file.
  assert.ok(p.problems.some((x) => x.type === 'output-changed'));
  assert.ok(p.superseded.length >= 1);
});

test('a truncated PE header is refused, not guessed', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'not-a.pe');
  fs.writeFileSync(f, Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]));
  assert.equal(parsePE(fs.readFileSync(f)), null);
  const kind = detectKind(fs.readFileSync(f), f);
  assert.equal(kind.kind, 'pe-unknown');
});

test('an asar container is read from its own index', () => {
  const header = JSON.stringify({ files: { 'package.json': { size: 5, offset: '0' } } });
  const json = Buffer.from(header, 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(4 + json.length + 4, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  const body = Buffer.from('{}   ', 'utf8');
  const dir = tmpdir();
  const f = path.join(dir, 'x.asar');
  fs.writeFileSync(f, Buffer.concat([head, json, body]));
  const kind = detectKind(fs.readFileSync(f), f);
  assert.equal(kind.kind, 'asar');
});

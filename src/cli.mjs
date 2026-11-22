#!/usr/bin/env node
// reacraft 鈥?read a target, write the contract, rebuild it, score the rebuild, close the gap.
//
// Exit codes: 0 ok 路 1 usage or io error 路 2 gate not met (CI can rely on this)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProfile, PROFILE_SCHEMA } from './core/profile.mjs';
import { buildSpec, writeSpec, readSpec, normaliseSpec, SPEC_SCHEMA } from './core/spec.mjs';
import { verify, attachSimilarity } from './core/verify.mjs';
import { buildGaps, summarise } from './core/gaps.mjs';
import { writeReport } from './core/report.mjs';
import { record, prove, fileEntry, sha256File } from './core/ledger.mjs';
import { probeEngines, probePartners } from './core/engines.mjs';
import { resolveCraft, resolveRea, craftCommand, run as runCli, reaAnalyze } from './core/partners.mjs';
import { decodeFile } from './core/decode.mjs';
import { bench } from './core/bench.mjs';
import { toSarif } from './core/sarif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = process.env.REACRAFT_HOME ? path.resolve(process.env.REACRAFT_HOME) : path.join(ROOT, 'projects');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = (next === undefined || next.startsWith('--')) ? true : (i++, next);
      // --sign may repeat: one manual obligation per flag.
      if (key === 'sign') (out.sign = out.sign || []).push(value);
      else out[key] = value;
    } else out._.push(a);
  }
  return out;
}

// --sign id=text ... 鈫?{ id: text }
function signNotes(args) {
  const notes = {};
  for (const s of Array.isArray(args.sign) ? args.sign : []) {
    if (typeof s !== 'string') continue;
    const at = s.indexOf('=');
    if (at <= 0) continue;
    notes[s.slice(0, at).trim()] = s.slice(at + 1).trim();
  }
  return notes;
}

function slugFor(target, explicit) {
  if (explicit && typeof explicit === 'string') return explicit;
  const base = path.basename(target).replace(/[^\w.-]+/g, '_').replace(/\.[^.]+$/, '');
  return base || 'target';
}

const projDir = (slug) => path.join(HOME, slug);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); return f; };
const say = (s = '') => process.stdout.write(s + '\n');
const isJson = (args) => !!(args.json || args.format === 'json');
const emit = (args, obj, text) => {
  if (isJson(args)) say(JSON.stringify(obj, null, 2));
  else if (text) say(text);
};

function fail(msg, code = 1) {
  process.stderr.write('reacraft: ' + msg + '\n');
  process.exit(code);
}

function need(slug) {
  if (!slug) fail('this command needs a project slug');
  const dir = projDir(slug);
  if (!fs.existsSync(dir)) fail('no project ' + slug + ' in ' + HOME);
  return { slug, dir };
}

// ---------------------------------------------------------------- commands

function cmdProbe(args) {
  const engines = probeEngines();
  const partners = args.partners || args.all ? probePartners() : null;
  const craft = partners ? partners.craft : null;
  const out = {
    schema: 'reacraft.probe/1',
    node: process.version,
    platform: process.platform,
    home: HOME,
    engines,
    craftCli: resolveCraft(),
    reaCli: resolveRea(),
    craft,
    craftCommand: craftCommand(),
    rea: partners ? partners.rea : null,
  };
  const lines = [];
  for (const e of engines) {
    lines.push((e.found ? 'OK   ' : 'MISS ') + e.id.padEnd(15) + (e.found ? String(e.version || '').slice(0, 60) : '(' + e.role + ')'));
  }
  if (craft) lines.push('', 'craft-anything: ' + (craft.ok ? 'answers' : 'does not answer') + (craft.tools ? ', ' + craft.tools + ' tools' : '') + (craft.mode ? ', mode=' + craft.mode : ''));
  if (partners && partners.rea) lines.push('REA: ' + (partners.rea.ok ? 'answers, ' + partners.rea.lines + ' capability lines' : 'does not answer'));
  lines.push('', 'projects: ' + HOME);
  emit(args, out, lines.join('\n'));
  return 0;
}

function cmdRea(args) {
  const target = args._[1];
  if (!target) fail('rea needs a target path');
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) fail('no such file: ' + abs);
  const slug = slugFor(abs, args.name);
  const dir = projDir(slug);

  const profile = buildProfile(abs, { name: slug });
  let deep = null;
  if (args.deep) {
    const r = reaAnalyze(abs, { timeout: Number(args.timeout) || 600000 });
    deep = { status: r.status, ok: r.status === 0, body: r.body || null, stderr: (r.stderr || '').slice(0, 800) };
    profile.deep = deep.ok ? { engine: 'rea', summary: summariseDeep(deep.body) } : { engine: 'rea', failed: true, stderr: deep.stderr };
  }
  const profileFile = writeJson(path.join(dir, 'profile.json'), profile);
  record(dir, 'rea', {
    input: [fileEntry(abs)],
    output: [fileEntry(profileFile)],
    note: 'kind=' + profile.kind + ' strings=' + profile.strings.total + ' rules=' + Object.keys(profile.ruleScores).length,
  });

  const caps = Object.entries(profile.ruleScores).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const lines = [
    'target   ' + abs,
    'kind     ' + profile.kind + '  arch=' + (profile.pe?.arch || profile.elf?.arch || profile.macho?.arch || '-') + '  size=' + profile.size,
    'sha256   ' + profile.sha256,
    'strings  ' + profile.strings.total + '   endpoints=' + profile.endpoints.length,
    'symbols  imports=' + (profile.importHits.length) + ' elf=' + (profile.symbolHits.length) + ' class=' + (profile.classHits.length),
    'stack    ' + profile.stack.primary + (profile.stack.labels.length ? ' (' + profile.stack.labels.join(', ') + ')' : ''),
    'evidence ' + profile.evidence.length + ' ids',
    'signals  ' + (caps.map(([k, v]) => k + '=' + v).join(' ') || 'none'),
  ];
  if (profile.deep) lines.push('deep     ' + (profile.deep.failed ? 'REA failed: ' + String(profile.deep.stderr).slice(0, 120) : 'REA body stored'));
  lines.push('wrote    ' + profileFile);
  emit(args, { schema: PROFILE_SCHEMA, slug, dir, profile }, lines.join('\n'));
  return 0;
}

function summariseDeep(body) {
  if (!body || typeof body !== 'object') return null;
  const keys = Object.keys(body);
  return { keys: keys.slice(0, 20), size: JSON.stringify(body).length };
}

function cmdSpec(args) {
  const { slug, dir } = need(args._[1]);
  const profile = readJson(path.join(dir, 'profile.json'));
  if (!profile) fail('run rea first: no profile.json in ' + dir);
  const gate = args.gate ? Number(args.gate) : 80;
  const spec = buildSpec(profile, { name: slug, request: typeof args.request === 'string' ? args.request : null, gate });
  const file = writeSpec(dir, spec);
  record(dir, 'spec', {
    input: [fileEntry(path.join(dir, 'profile.json'))],
    output: [fileEntry(file)],
    note: 'caps=' + spec.capabilities.length + ' obligations=' + spec.obligations.length + ' gate=' + gate,
  });
  const auto = spec.obligations.filter((o) => o.acceptance !== 'manual').length;
  const lines = [
    'spec     ' + file,
    'stack    ' + spec.stack.primary + (spec.stack.labels.length ? ' (' + spec.stack.labels.join(', ') + ')' : ''),
    'caps     ' + spec.capabilities.length + '   obligations=' + spec.obligations.length + ' (' + auto + ' auto, ' + (spec.obligations.length - auto) + ' manual)   unknowns=' + spec.unknowns.length,
    'gate     ' + gate + '%',
    '',
    '--- rebuild request ---',
    spec.request,
  ];
  emit(args, { slug, dir, spec }, lines.join('\n'));
  return 0;
}

function cmdCraft(args) {
  const { slug, dir } = need(args._[1]);
  const spec = normaliseSpec(readSpec(dir));
  const cmd = craftCommand();
  const argv = ['rebuild', spec.target, spec.request, '--project-folder', dir, '--deep', '--allow-run'];
  const shown = [cmd.cli, ...argv].join(' ');
  if (!args.run) {
    emit(args, { slug, dryRun: true, command: shown }, 'command  ' + shown + '\n\ndry run  (pass --run to execute; a rebuild drives a coding agent and can take a while)');
    return 0;
  }
  const r = runCli(cmd.cli, argv, { timeout: Number(args.timeout) || 1800000 });
  const outFile = writeJson(path.join(dir, 'craft-rebuild.json'), { status: r.status, stdout: r.stdout.slice(0, 40000), stderr: r.stderr.slice(0, 8000) });
  record(dir, 'craft-rebuild', { input: [fileEntry(path.join(dir, 'spec.json'))], output: [fileEntry(outFile)], note: 'exit=' + r.status });
  emit(args, { slug, status: r.status, stdout: r.stdout.slice(0, 4000) }, 'exit     ' + r.status + '\n' + r.stdout.slice(0, 4000));
  return r.status === 0 ? 0 : 1;
}

function cmdVerify(args) {
  const { slug, dir } = need(args._[1]);
  const spec = normaliseSpec(readSpec(dir));
  const rebuild = path.resolve(typeof args.rebuild === 'string' ? args.rebuild : path.join(dir, 'rebuild'));
  if (!fs.existsSync(rebuild)) fail('rebuild folder not found: ' + rebuild);
  const profile = readJson(path.join(dir, 'profile.json'));
  const gate = args.gate ? Number(args.gate) : spec.gate;

  let v = verify({ ...spec, gate }, rebuild, { notes: signNotes(args) });
  if (profile) {
    let rebuildProfile = null;
    if (args['rebuild-target']) {
      try { rebuildProfile = buildProfile(path.resolve(args['rebuild-target'])); } catch { rebuildProfile = null; }
    }
    v = attachSimilarity(v, profile, rebuild, { ...spec, gate }, { rebuildProfile });
  }
  const vFile = writeJson(path.join(dir, 'verification.json'), v);
  const gaps = buildGaps({ ...spec, gate }, v);
  const gFile = writeJson(path.join(dir, 'gaps.json'), gaps);
  let sarifFile = null;
  if (typeof args.sarif === 'string') {
    sarifFile = path.resolve(args.sarif);
    fs.mkdirSync(path.dirname(sarifFile), { recursive: true });
    fs.writeFileSync(sarifFile, JSON.stringify(toSarif({ ...spec, gate }, v, { rebuildDir: rebuild, version: '0.3.0' }), null, 2), 'utf8');
  }
  record(dir, 'verify', {
    input: [fileEntry(path.join(dir, 'spec.json')), { name: 'rebuild-tree', sha256: null, bytes: null, path: rebuild }],
    output: [fileEntry(vFile), fileEntry(gFile), ...(sarifFile ? [fileEntry(sarifFile)] : [])],
    note: 'score=' + v.score + ' gate=' + gate + ' ' + v.gateResult,
  });

  const lines = [];
  lines.push('score    ' + (v.score === null ? 'n/a' : v.score + '%') + '   gate=' + gate + '% 鈫?' + v.gateResult);
  lines.push('items    pass=' + v.pass + ' partial=' + v.partial + ' fail=' + v.fail + ' pending=' + v.pending + '   files=' + v.filesScanned);
  if (v.similarity) {
    const s = v.similarity;
    lines.push('similar  ' + (s.score === null ? 'n/a' : s.score + '%') + ' (' + s.confidence + ' confidence, minhash=' + s.minhashJaccard + ')');
  }
  lines.push('');
  for (const r of v.results) lines.push('  ' + r.status.padEnd(8) + r.id.padEnd(24) + r.note);
  if (gaps.open) {
    lines.push('');
    lines.push('open gaps (' + gaps.open + '), highest weight first:');
    lines.push(summarise(gaps));
  }
  if (sarifFile) lines.push('', 'sarif    ' + sarifFile);
  emit(args, { slug, verification: v, gaps, sarif: sarifFile }, lines.join('\n'));
  return v.gateResult === 'below' ? 2 : 0;
}

function cmdGaps(args) {
  const { slug, dir } = need(args._[1]);
  const gaps = readJson(path.join(dir, 'gaps.json'));
  if (!gaps) fail('run verify first: no gaps.json in ' + dir);
  if (args.apply) {
    const spec = normaliseSpec(readSpec(dir));
    spec.request = gaps.fixRequest;
    spec.round = (spec.round || 1) + 1;
    writeSpec(dir, spec);
    record(dir, 'replan', { input: [fileEntry(path.join(dir, 'gaps.json'))], output: [fileEntry(path.join(dir, 'spec.json'))], note: 'round=' + spec.round });
    if (!isJson(args)) say('spec.request replaced with the fix plan (round ' + spec.round + '). Next: reacraft craft ' + slug + ' --run');
    return 0;
  }
  emit(args, gaps, gaps.gaps.map((g) => String(g.weight).padStart(2) + '  ' + g.kind.padEnd(8) + g.id.padEnd(24) + g.action).join('\n') + '\n\n--- fix request ---\n' + gaps.fixRequest);
  return 0;
}

function cmdDecode(args) {
  const arg = args._[1];
  if (!arg) fail('decode needs a target path or a project slug');
  let file = arg;
  if (!fs.existsSync(file)) {
    const dir = projDir(String(arg));
    const spec = readJson(path.join(dir, 'spec.json'));
    const prof = readJson(path.join(dir, 'profile.json'));
    file = (spec && spec.target) || (prof && prof.target) || null;
    if (!file || !fs.existsSync(file)) fail('no target for ' + arg + ' (not a file, not a project)');
  }
  const r = decodeFile(path.resolve(file));
  const lines = [
    'method   ' + r.method,
    'executed ' + r.executed + '   (arithmetic over constants the file carries; no target code ran)',
    'arrays   ' + r.arrays + '   coefficients ' + r.coefficients.length + '   combinations tried ' + r.tried,
    'decoded  ' + r.decoded.length,
  ];
  for (const d of r.decoded.slice(0, 20)) {
    lines.push('  ' + String(d.score).padEnd(5) + ' 0x' + d.coefficient.toString(16).padEnd(4) + ' ' + JSON.stringify(d.value.slice(0, 100)));
  }
  if (!r.decoded.length) lines.push('  ' + r.note);
  emit(args, r, lines.join('\n'));
  return r.decoded.length ? 0 : 2;
}

function cmdReport(args) {
  const { slug, dir } = need(args._[1]);
  const profile = readJson(path.join(dir, 'profile.json'));
  const specFile = path.join(dir, 'spec.json');
  if (!profile || !fs.existsSync(specFile)) fail('run rea and spec first');
  const spec = normaliseSpec(readJson(specFile));
  const verification = readJson(path.join(dir, 'verification.json'));
  const gaps = readJson(path.join(dir, 'gaps.json'));
  const proof = fs.existsSync(path.join(dir, 'events.jsonl')) ? prove(dir) : null;
  const files = writeReport(dir, { profile, spec, verification, gaps, proof }, { html: !!args.html });
  record(dir, 'report', { input: [fileEntry(specFile)], output: files.map((f) => fileEntry(f)), note: 'proof=' + (proof ? proof.ok : 'none') });
  emit(args, { slug, files, proof }, files.map((f) => 'report   ' + f).join('\n') + (proof ? '\nchain    ' + (proof.ok ? 'intact (' + proof.records + ' records)' : proof.problems.length + ' problem(s)') : ''));
  return 0;
}

function cmdProve(args) {
  const { slug, dir } = need(args._[1]);
  const p = prove(dir);
  emit(args, { slug, proof: p }, [
    'chain    ' + (p.ok ? 'intact' : p.problems.length + ' problem(s)') + '   records=' + p.records,
    'head     ' + p.head,
    ...(p.superseded.length ? ['superseded ' + p.superseded.length + ' (older runs replaced by a later one)'] : []),
    ...p.problems.map((x) => '  ' + x.type + (x.at !== undefined ? ' @' + x.at : '') + (x.name ? ' ' + x.name : '')),
  ].join('\n'));
  return p.ok ? 0 : 2;
}

function cmdStatus(args) {
  if (!fs.existsSync(HOME)) { emit(args, { projects: [] }, 'no projects yet (' + HOME + ')'); return 0; }
  const rows = [];
  for (const name of fs.readdirSync(HOME)) {
    const dir = path.join(HOME, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const profile = readJson(path.join(dir, 'profile.json'));
    const spec = readJson(path.join(dir, 'spec.json'));
    const v = readJson(path.join(dir, 'verification.json'));
    const g = readJson(path.join(dir, 'gaps.json'));
    const p = fs.existsSync(path.join(dir, 'events.jsonl')) ? prove(dir) : null;
    rows.push({
      project: name,
      kind: profile ? profile.kind : '-',
      caps: spec ? spec.capabilities.length : '-',
      obligations: spec ? (spec.obligations || spec.must_have || []).length : '-',
      score: v ? (v.score === null || v.score === undefined ? 'n/a' : v.score + '%') : '-',
      gate: v ? (v.gateResult || 'unknown') : '-',
      openGaps: g ? g.open : '-',
      chain: p ? (p.ok ? (p.records > (p.legacy || 0) ? 'ok' : 'legacy') : 'broken') : '-',
    });
  }
  if (!rows.length) { emit(args, { projects: [] }, 'no projects yet'); return 0; }
  const head = ['project', 'kind', 'caps', 'oblig', 'score', 'gate', 'gaps', 'chain'];
  const keys = ['project', 'kind', 'caps', 'obligations', 'score', 'gate', 'openGaps', 'chain'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[keys[i]]).length)));
  if (isJson(args)) { emit(args, { projects: rows }); return 0; }
  const fmt = (vals) => vals.map((c, i) => String(c).padEnd(width[i])).join('  ');
  say(fmt(head));
  say(width.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) say(fmt(keys.map((k) => r[k])));
  return 0;
}

async function cmdAll(args) {
  const target = args._[1];
  if (!target) fail('all needs a target path');
  const rc1 = cmdRea(args);
  const slug = slugFor(path.resolve(target), args.name);
  const rc2 = cmdSpec({ _: [null, slug], gate: args.gate, request: args.request, json: args.json });
  if (typeof args.rebuild === 'string') {
    say('');
    const rc3 = cmdVerify({ _: [null, slug], rebuild: args.rebuild, gate: args.gate, json: args.json });
    say('');
    cmdReport({ _: [null, slug], html: true, json: args.json });
    return rc3;
  }
  say('');
  cmdReport({ _: [null, slug], html: true, json: args.json });
  return Math.max(rc1, rc2);
}

function cmdBench(args) {
  const r = bench();
  emit(args, r, r.lines.join('\n'));
  return r.ok ? 0 : 2;
}

function cmdSelftest(args) {
  // A rebuild of a known shape, scored end to end, with no engine and no network.
  const result = selftestImpl();
  emit(args, result, result.lines.join('\n'));
  return result.ok ? 0 : 2;
}

function selftestImpl() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reacraft-selftest-'));
  const lines = [];
  const checks = [];
  const ok = (id, pass, note) => { checks.push({ id, pass, note }); lines.push((pass ? 'PASS ' : 'FAIL ') + id.padEnd(28) + note); };

  // 1. a small synthetic target with a URL, a registry-like path and an API name
  const targetText = 'https://api.example.test/v1/login\nHKEY_CURRENT_USER\\Software\\Test\\Run\nCreateRemoteThread\n';
  const target = path.join(tmp, 'sample.bin');
  fs.writeFileSync(target, targetText, 'utf8');
  const profile = buildProfile(target);
  ok('profile-kind', profile.kind !== undefined, 'kind=' + profile.kind);
  ok('profile-evidence', profile.evidence.length > 0, profile.evidence.length + ' evidence ids');
  const spec = buildSpec(profile, { name: 'selftest', gate: 80 });
  ok('spec-obligations', spec.obligations.length > 0, spec.obligations.length + ' obligations');
  ok('spec-endpoint-obligation', spec.obligations.some((o) => o.id === 'ob-endpoints'), 'endpoint obligation present');

  // 2. a rebuild that satisfies half of it
  const rebuild = path.join(tmp, 'rebuild');
  fs.mkdirSync(rebuild, { recursive: true });
  fs.writeFileSync(path.join(rebuild, 'app.js'), 'const url = "https://api.example.test/v1/login";\n', 'utf8');
  const v1 = verify(spec, rebuild);
  ok('verify-partial', v1.fail + v1.pass > 0, 'score=' + v1.score + ' pass=' + v1.pass + ' fail=' + v1.fail);

  // 3. close the gap: a complete rebuild must score higher than the partial one
  fs.writeFileSync(path.join(rebuild, 'app.js'), [
    'const url = "https://api.example.test/v1/login";',
    'const runKey = "HKEY_CURRENT_USER\\\\Software\\\\Test\\\\Run";',
    'module.exports = { url, runKey };',
  ].join('\n'), 'utf8');
  const v2 = verify(spec, rebuild);
  ok('verify-improves', v2.score >= v1.score, 'before=' + v1.score + ' after=' + v2.score);

  // 4. the ledger notices a changed output
  const ledgerDir = path.join(tmp, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const f = path.join(ledgerDir, 'a.json');
  fs.writeFileSync(f, '{"x":1}', 'utf8');
  record(ledgerDir, 'test', { output: [fileEntry(f)] });
  const p1 = prove(ledgerDir);
  ok('ledger-intact', p1.ok, p1.records + ' record(s)');
  fs.writeFileSync(f, '{"x":2}', 'utf8');
  const p2 = prove(ledgerDir);
  ok('ledger-detects-change', !p2.ok, p2.problems.map((p) => p.type).join(','));

  // 5. gaps name what is missing
  const gaps = buildGaps(spec, v1);
  ok('gaps-produced', gaps.open > 0, gaps.open + ' open, fix request ' + gaps.fixRequest.length + ' chars');

  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: checks.every((c) => c.pass), checks, lines };
}

// ---------------------------------------------------------------- help

function cmdHelp() {
  say('reacraft 鈥?read a target, write the contract, rebuild it, score the rebuild, close the gap.');
  say('');
  say('  probe                                  engines, partners, project home');
  say('  rea <target> [--name slug] [--deep]    static read: format, symbols, strings, evidence ids');
  say('  spec <slug> [--request text] [--gate N]  capabilities + obligations + rebuild request');
  say('  craft <slug> [--run]                   hand the request to craft-anything (dry run by default)');
  say('  verify <slug> --rebuild <dir> [--gate N] [--sign id=text]  score the rebuild, write gaps');
  say('      --sign ob-behaviour="ran both, X differs"   sign one manual obligation (repeatable)');
  say('  gaps <slug> [--apply]                  show the fix plan, optionally write it into the spec');
  say('  decode <slug|path>                     recover masked string literals without running the target');
  say('  report <slug> [--html]                 report.md + report.json (+ report.html)');
  say('  prove <slug>                           recompute the evidence chain');
  say('  status [--json]                        every project and its stage');
  say('  all <target> [--rebuild dir]           rea + spec + optional verify + report');
  say('  selftest                               run the built-in end-to-end check');
  say('  bench                                  the full claim, run end to end on generated fixtures');
  say('');
  say('Exit codes: 0 ok 路 1 usage/io 路 2 gate not met or chain broken.');
  say('Project home: ' + HOME + ' (override with REACRAFT_HOME)');
}

// ---------------------------------------------------------------- dispatch

const table = {
  probe: cmdProbe, rea: cmdRea, spec: cmdSpec, craft: cmdCraft, verify: cmdVerify,
  gaps: cmdGaps, decode: cmdDecode, report: cmdReport, prove: cmdProve, status: cmdStatus, all: cmdAll,
  selftest: cmdSelftest, bench: cmdBench, help: cmdHelp,
};

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
if (!table[cmd]) { cmdHelp(); process.exit(1); }
const code = await Promise.resolve(table[cmd](args));
process.exit(typeof code === 'number' ? code : 0);

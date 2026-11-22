/**
 * ReaCraft for DeepSeek Harness.
 *
 * Seven tools on ctx.tools, no MCP server and no external process: the pipeline in
 * ../src is imported directly, so a tool call is a function call, not a JSON-RPC round
 * trip through a bridge. That is the whole point of shipping a plugin instead of only a
 * CLI: the model can read a target, write the contract, score a rebuild and see the gap
 * plan without leaving the session.
 *
 * Zero dependencies on purpose: node: builtins and this repository's own modules only.
 * A DSH plugin that cannot resolve @deepseek-ai/* at import time fails to load, and the
 * pipeline has nothing to gain from those packages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProfile, PROFILE_SCHEMA } from '../../src/core/profile.mjs';
import { buildSpec, writeSpec, readSpec, normaliseSpec, SPEC_SCHEMA } from '../../src/core/spec.mjs';
import { verify, attachSimilarity } from '../../src/core/verify.mjs';
import { buildGaps } from '../../src/core/gaps.mjs';
import { writeReport } from '../../src/core/report.mjs';
import { record, prove, fileEntry } from '../../src/core/ledger.mjs';
import { probeEngines, probePartners } from '../../src/core/engines.mjs';
import { craftCommand } from '../../src/core/partners.mjs';

export const name = 'reacraft';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DEFAULT_HOME = process.env.REACRAFT_HOME
  ? path.resolve(process.env.REACRAFT_HOME)
  : path.join(REPO, 'projects');

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); return f; };
const text = (s) => [{ type: 'text', text: s }];

function projectDir(slug, config) {
  const home = (config && typeof config.projectHome === 'string' && config.projectHome) || DEFAULT_HOME;
  return { home, dir: path.join(home, slug) };
}

function slugFor(target) {
  return path.basename(target).replace(/[^\w.-]+/g, '_').replace(/\.[^.]+$/, '') || 'target';
}

function gateOf(args, config) {
  const g = Number(args?.gate ?? (config && config.gate) ?? 80);
  return Number.isFinite(g) ? g : 80;
}

/** Register one tool through ctx.effect so a plugin reload removes it cleanly. */
function tool(ctx, def) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(def);
    return () => { dispose() };
  });
}

export async function apply(ctx, rawConfig) {
  // Cordis passes null when the patch row has no config; a default parameter only covers
  // undefined, so normalise here and every tool can read config.* safely.
  const config = rawConfig || {};
  tool(ctx, {
    name: 'reacraft_probe',
    description: 'Check the ReaCraft engines: this pipeline needs nothing, but radare2, ilspycmd, REA and craft-anything add depth. Reports what is installed, the project home, and the exact craft-anything rebuild command.',
    parameters: {
      partners: { type: 'boolean', description: 'Also ask the REA and craft-anything CLIs whether they answer (slower).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const engines = probeEngines();
      const partners = args?.partners ? probePartners() : null;
      const lines = engines.map((e) => (e.found ? 'OK   ' : 'MISS ') + e.id.padEnd(15) + (e.found ? String(e.version || '').slice(0, 60) : '(' + e.role + ')'));
      if (partners?.craft) lines.push('craft-anything: ' + (partners.craft.ok ? 'answers' : 'does not answer'));
      if (partners?.rea) lines.push('REA: ' + (partners.rea.ok ? 'answers' : 'does not answer'));
      lines.push('projects: ' + ((config.projectHome && path.resolve(config.projectHome)) || DEFAULT_HOME));
      const text_ = lines.join('\n');
      return { ok: true, engines, partners, text: text_ };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Probe ReaCraft engines', kind: 'other', rawInput: args || {} }),
  });

  tool(ctx, {
    name: 'reacraft_read',
    description: 'Read a local file as a reverse-engineering target: format, sections, imports or ELF/Mach-O symbols, archive contents, strings, endpoints and capability signals, each carrying a content-derived evidence id. Static only; nothing from the target is executed.',
    parameters: {
      target: { type: 'string', required: true, description: 'Absolute path to the file or app bundle to read.' },
      slug: { type: 'string', description: 'Project name for later stages; defaults to the file name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const abs = path.resolve(String(args.target));
      if (!fs.existsSync(abs)) throw new Error('no such file: ' + abs);
      const slug = typeof args.slug === 'string' && args.slug ? args.slug : slugFor(abs);
      const { dir } = projectDir(slug, config);
      const profile = buildProfile(abs, { name: slug });
      const file = writeJson(path.join(dir, 'profile.json'), profile);
      record(dir, 'rea', { input: [fileEntry(abs)], output: [fileEntry(file)], note: 'kind=' + profile.kind });
      const caps = Object.entries(profile.ruleScores).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const lines = [
        'slug     ' + slug,
        'kind     ' + profile.kind + '  stack=' + profile.stack.primary + (profile.stack.labels.length > 1 ? ' (' + profile.stack.labels.join(', ') + ')' : ''),
        'sha256   ' + profile.sha256,
        'strings  ' + profile.strings.total + '  endpoints=' + profile.endpoints.length + '  evidence=' + profile.evidence.length,
        'symbols  imports=' + profile.importHits.length + ' elf=' + profile.symbolHits.length + ' class=' + profile.classHits.length,
        'signals  ' + (caps.map(([k, v]) => k + '=' + v).join(' ') || 'none'),
        'unknowns ' + profile.unknowns.length + (profile.unknowns.length ? ': ' + profile.unknowns.map((u) => u.id).join(', ') : ''),
        'wrote    ' + file,
        '',
        'next     reacraft_spec with slug="' + slug + '"',
      ];
      return { ok: true, slug, dir, profile: { schema: PROFILE_SCHEMA, kind: profile.kind, sha256: profile.sha256, ruleScores: profile.ruleScores }, text: lines.join('\n') };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read target', kind: 'other', rawInput: { target: args?.target } }),
  });

  tool(ctx, {
    name: 'reacraft_spec',
    description: 'Turn a read into a contract: capabilities with evidence ids, obligations with the acceptance test the verifier will run, and one structured rebuild request a coding agent can execute.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Project name from reacraft_read.' },
      request: { type: 'string', description: 'Override the generated rebuild request with your own one-paragraph instruction.' },
      gate: { type: 'integer', description: 'Pass mark in percent for the verifier (default 80).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { dir } = projectDir(String(args.slug), config);
      const profile = readJson(path.join(dir, 'profile.json'));
      if (!profile) throw new Error('run reacraft_read first: no profile.json in ' + dir);
      const spec = buildSpec(profile, { name: String(args.slug), request: typeof args.request === 'string' ? args.request : null, gate: gateOf(args, config) });
      const file = writeSpec(dir, spec);
      record(dir, 'spec', { input: [fileEntry(path.join(dir, 'profile.json'))], output: [fileEntry(file)], note: 'obligations=' + spec.obligations.length });
      const auto = spec.obligations.filter((o) => o.acceptance !== 'manual').length;
      const lines = [
        'spec     ' + file,
        'caps     ' + spec.capabilities.length + '  obligations=' + spec.obligations.length + ' (' + auto + ' machine, ' + (spec.obligations.length - auto) + ' manual)  gate=' + spec.gate + '%',
        'unknowns ' + spec.unknowns.length,
        '',
        '--- rebuild request ---',
        spec.request,
      ];
      return { ok: true, slug: args.slug, spec: { schema: SPEC_SCHEMA, gate: spec.gate, obligations: spec.obligations.map((o) => ({ id: o.id, acceptance: o.acceptance, weight: o.weight, item: o.item })) }, text: lines.join('\n') };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Write spec', kind: 'other', rawInput: { slug: args?.slug } }),
  });

  tool(ctx, {
    name: 'reacraft_verify',
    description: 'Score a rebuild against the contract, then say what to do next. Two numbers are reported and kept separate: weighted obligation score and independent set coverage (endpoints, literals, symbols, structure). Writes verification.json and gaps.json with a ready-to-send fix request.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Project name.' },
      rebuildDir: { type: 'string', required: true, description: 'Folder holding the rebuild source tree.' },
      rebuildTarget: { type: 'string', description: 'Optional built binary of the rebuild; its imports and exports join the symbol comparison.' },
      gate: { type: 'integer', description: 'Pass mark in percent (default: the gate stored in the spec).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { dir } = projectDir(String(args.slug), config);
      const spec = normaliseSpec(readSpec(dir));
      const rebuild = path.resolve(String(args.rebuildDir));
      if (!fs.existsSync(rebuild)) throw new Error('rebuild folder not found: ' + rebuild);
      const gate = args?.gate !== undefined ? gateOf(args, config) : spec.gate;
      const profile = readJson(path.join(dir, 'profile.json'));

      let v = verify({ ...spec, gate }, rebuild);
      if (profile) {
        let rebuildProfile = null;
        if (typeof args.rebuildTarget === 'string') {
          try { rebuildProfile = buildProfile(path.resolve(args.rebuildTarget)); } catch { rebuildProfile = null; }
        }
        v = attachSimilarity(v, profile, rebuild, { ...spec, gate }, { rebuildProfile });
      }
      const vFile = writeJson(path.join(dir, 'verification.json'), v);
      const gaps = buildGaps({ ...spec, gate }, v);
      const gFile = writeJson(path.join(dir, 'gaps.json'), gaps);
      record(dir, 'verify', { input: [fileEntry(path.join(dir, 'spec.json'))], output: [fileEntry(vFile), fileEntry(gFile)], note: 'score=' + v.score + ' ' + v.gateResult });

      const lines = [
        'score    ' + (v.score === null ? 'n/a' : v.score + '%') + '   gate=' + gate + '% → ' + v.gateResult,
        'items    pass=' + v.pass + ' partial=' + v.partial + ' fail=' + v.fail + ' pending=' + v.pending,
      ];
      if (v.similarity) lines.push('similar  ' + (v.similarity.score === null ? 'n/a' : v.similarity.score + '%') + ' (' + v.similarity.confidence + ' confidence)');
      lines.push('', 'obligations:');
      for (const r of v.results) lines.push('  ' + r.status.padEnd(8) + r.id.padEnd(24) + r.note);
      if (gaps.open) {
        lines.push('', 'open gaps (' + gaps.open + '):');
        for (const g of gaps.gaps.slice(0, 10)) lines.push('  w' + String(g.weight).padStart(2) + ' ' + g.id.padEnd(24) + g.action);
        lines.push('', '--- next instruction for the builder ---', gaps.fixRequest);
      }
      return { ok: true, score: v.score, gate: v.gateResult, similarity: v.similarity?.score ?? null, openGaps: gaps.open, verification: v, gaps, text: lines.join('\n') };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Verify rebuild', kind: 'other', rawInput: { slug: args?.slug } }),
  });

  tool(ctx, {
    name: 'reacraft_report',
    description: 'Write the project report: report.md, report.json and optionally report.html, with the verdict, the obligation table, set coverage, the gap plan, unknowns and the evidence index. Also re-proves the evidence chain.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Project name.' },
      html: { type: 'boolean', description: 'Also write a self-contained report.html.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { dir } = projectDir(String(args.slug), config);
      const profile = readJson(path.join(dir, 'profile.json'));
      const specFile = path.join(dir, 'spec.json');
      if (!profile || !fs.existsSync(specFile)) throw new Error('run reacraft_read and reacraft_spec first');
      const spec = normaliseSpec(readJson(specFile));
      const verification = readJson(path.join(dir, 'verification.json'));
      const gaps = readJson(path.join(dir, 'gaps.json'));
      const proof = fs.existsSync(path.join(dir, 'events.jsonl')) ? prove(dir) : null;
      const files = writeReport(dir, { profile, spec, verification, gaps, proof }, { html: args?.html === true });
      record(dir, 'report', { input: [fileEntry(specFile)], output: files.map((f) => fileEntry(f)), note: 'proof=' + (proof ? proof.ok : 'none') });
      const lines = files.map((f) => 'wrote    ' + f);
      lines.push('chain    ' + (proof ? (proof.ok ? 'intact (' + proof.records + ' records)' : proof.problems.length + ' problem(s)') : 'no ledger yet'));
      return { ok: true, files, proof, text: lines.join('\n') };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Write report', kind: 'other', rawInput: { slug: args?.slug } }),
  });

  tool(ctx, {
    name: 'reacraft_prove',
    description: 'Recompute the hash chain and every file recorded in it. Reports any changed output, broken link or edited record. Use it before trusting a report that was produced in an earlier session.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Project name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { dir } = projectDir(String(args.slug), config);
      if (!fs.existsSync(path.join(dir, 'events.jsonl'))) throw new Error('no evidence ledger in ' + dir);
      const p = prove(dir);
      const lines = ['chain    ' + (p.ok ? 'intact' : p.problems.length + ' problem(s)'), 'records  ' + p.records, 'head     ' + p.head];
      if (p.superseded.length) lines.push('superseded ' + p.superseded.length + ' (older runs replaced by a later one)');
      for (const x of p.problems.slice(0, 20)) lines.push('  ' + x.type + (x.at !== undefined ? ' @' + x.at : '') + (x.name ? ' ' + x.name : ''));
      return { ok: p.ok, proof: p, text: lines.join('\n') };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Prove chain', kind: 'other', rawInput: { slug: args?.slug } }),
  });

  tool(ctx, {
    name: 'reacraft_status',
    description: 'Every project in the ReaCraft home with its stage, obligation score, gate result, open gaps and evidence-chain state.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => text(v.text),
    },
    async execute() {
      const home = (config.projectHome && path.resolve(config.projectHome)) || DEFAULT_HOME;
      if (!fs.existsSync(home)) return { ok: true, projects: [], text: 'no projects yet (' + home + ')' };
      const rows = [];
      for (const entry of fs.readdirSync(home)) {
        const dir = path.join(home, entry);
        try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
        const profile = readJson(path.join(dir, 'profile.json'));
        const spec = readJson(path.join(dir, 'spec.json'));
        const v = readJson(path.join(dir, 'verification.json'));
        const g = readJson(path.join(dir, 'gaps.json'));
        const p = fs.existsSync(path.join(dir, 'events.jsonl')) ? prove(dir) : null;
        rows.push({
          project: entry,
          kind: profile ? profile.kind : '-',
          obligations: spec ? (spec.obligations || spec.must_have || []).length : '-',
          score: v && v.score !== null && v.score !== undefined ? v.score + '%' : '-',
          gate: v ? (v.gateResult || 'unknown') : '-',
          gaps: g ? g.open : '-',
          chain: p ? (p.ok ? (p.records > (p.legacy || 0) ? 'ok' : 'legacy') : 'broken') : '-',
        });
      }
      if (!rows.length) return { ok: true, projects: [], text: 'no projects yet (' + home + ')' };
      const cols = ['project', 'kind', 'obligations', 'score', 'gate', 'gaps', 'chain'];
      const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
      const fmt = (vals) => vals.map((c, i) => String(c).padEnd(w[i])).join('  ');
      const lines = [fmt(cols), w.map((x) => '-'.repeat(x)).join('  '), ...rows.map((r) => fmt(cols.map((c) => r[c])))];
      return { ok: true, home, projects: rows, text: lines.join('\n') };
    },
    presentCall: () => ({ card: 'generic', title: 'ReaCraft projects', kind: 'other', rawInput: {} }),
  });
}

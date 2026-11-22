// Spec stage: turn a profile into a contract.
//
// A spec is three things:
//   capabilities  what the original does, each with evidence ids
//   obligations   what a rebuild must satisfy, each with a check the verifier can run
//   request       one structured instruction a rebuild engine can execute
//
// The obligations are the part neither REA nor craft-anything hands you across tools:
// they are written from static evidence, they name their own acceptance test, and the
// verifier fills in their outcome instead of a human remembering to.
import { CAPABILITIES } from './rules.mjs';
import { evidenceId, pickEvidence } from './profile.mjs';

export const SPEC_SCHEMA = 'reacraft.spec/2';

const usable = (s) => typeof s === 'string' && s.length >= 4 && s.length <= 200 && !/[\u0000-\u001f]/.test(s);

// Weights: 1 is a nicety, 5 is "the rebuild is wrong without it". The verifier scales
// these into a score; a pending obligation is never counted as either pass or fail.
const W = { endpoints: 5, literals: 4, symbols: 3, types: 3, components: 4, libs: 3, stack: 2 };

export function buildSpec(profile, { name = null, request = null, gate = 80 } = {}) {
  const caps = [];
  const obligations = [];
  const unknowns = [...(profile.unknowns || [])];
  const byId = new Map();

  const addCap = (id, { weight = 1, evidence = [], samples = [], statement = null } = {}) => {
    const meta = CAPABILITIES[id];
    if (!meta) return;
    // One statement per capability: a second rule that points at the same behaviour merges
    // its evidence instead of printing a duplicate row.
    const existing = caps.find((c) => c.id === id);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      existing.evidence = [...new Set([...existing.evidence, ...evidence.filter(Boolean)])].slice(0, 8);
      existing.samples = [...new Set([...existing.samples, ...samples.filter(usable)])].slice(0, 6);
      return;
    }
    caps.push({
      id,
      statement: statement || meta.statement,
      weight,
      evidence: evidence.filter(Boolean).slice(0, 8),
      samples: samples.filter(usable).slice(0, 6),
    });
  };

  const addObligation = (o) => {
    if (byId.has(o.id)) return;
    const item = { evidence: [], acceptance: 'manual', weight: 1, ...o };
    byId.set(item.id, item);
    obligations.push(item);
  };

  // ---- capabilities from scored rules, strongest first
  for (const [rule, score] of Object.entries(profile.ruleScores || {}).sort((a, b) => b[1] - a[1])) {
    if (score < 2) continue;
    const stringsHit = pickEvidence(profile, rule, 4);
    const symbols = [...(profile.importHits || []), ...(profile.symbolHits || []), ...(profile.classHits || [])]
      .filter((h) => h.rule === rule).slice(0, 6);
    const evidence = [...stringsHit.map((h) => h.id), ...symbols.map((h) => h.id)];
    addCap(rule, {
      weight: Math.min(5, Math.max(1, Math.round(score / 2))),
      evidence,
      samples: stringsHit.map((h) => h.value),
    });
  }

  // ---- endpoints: the single most checkable obligation for a networked target
  const urls = (profile.endpoints || profile.strings?.urls || []).slice(0, 20);
  if (urls.length) {
    addObligation({
      id: 'ob-endpoints',
      item: 'every hardcoded endpoint is present in the rebuild',
      acceptance: 'presence',
      patterns: urls.slice(0, 12),
      scope: 'rebuild',
      weight: W.endpoints,
      why: 'an endpoint that is missing means the rebuild talks to a different service',
      evidence: [evidenceId('endpoint', urls[0])],
    });
    addCap('network', { weight: 3, evidence: urls.slice(0, 4).map((u) => evidenceId('endpoint', u)), samples: urls.slice(0, 6) });
  }

  // ---- platform-specific obligations
  if (profile.kind === 'pe-dotnet') {
    if (profile.dotnet?.ok) {
      const types = (profile.dotnet.interesting || []).slice(0, 20);
      addObligation({
        id: 'ob-managed-types',
        item: 'the rebuild reproduces the interesting managed types',
        acceptance: types.length ? 'symbols' : 'manual',
        symbols: types,
        weight: W.types,
        why: 'the managed type list is the closest thing to a module map this read can get',
      });
      addCap('managed-types', {
        weight: 2,
        statement: 'is a managed .NET assembly with ' + profile.dotnet.count + ' types',
        evidence: [],
        samples: [],
      });
    } else {
      unknowns.push({ id: 'u-dotnet', question: 'the .NET type list could not be read', how_to_settle: 'install ilspycmd (dotnet runtime), or pass --no-dotnet to accept the gap', severity: 'high' });
    }
  }

  if (profile.kind === 'asar' || profile.stack?.labels?.includes('electron')) {
    const m = profile.asar?.manifest;
    addObligation({
      id: 'ob-electron-shape',
      item: 'the rebuild keeps the same main/renderer split and the same package manifest fields',
      acceptance: 'manual',
      weight: W.stack,
      why: 'an Electron rebuild that collapses main and renderer is a different application, not a port',
      evidence: m?.name ? [evidenceId('app', m.name)] : [],
      notes: m ? { name: m.name, version: m.version, main: m.main, dependencies: (m.dependencies || []).slice(0, 12) } : null,
    });
  }

  if (profile.kind === 'apk' || profile.kind === 'dex-archive') {
    const classes = (profile.dexClasses || []).slice(0, 24);
    if (classes.length) {
      addObligation({
        id: 'ob-android-classes',
        item: 'the rebuild declares the same application classes that drive behaviour',
        acceptance: 'symbols',
        symbols: classes,
        weight: W.components,
        why: 'the class list is what a mobile rebuild is compared against when no manifest reader is available',
      });
    }
    addObligation({
      id: 'ob-android-components',
      item: 'the rebuild declares the same components and permissions',
      acceptance: 'manual',
      weight: W.components,
      why: 'component and permission declarations are the externally visible contract of an Android package',
    });
  }

  if (profile.kind === 'elf') {
    const needed = (profile.elf?.needed || []).slice(0, 20);
    if (needed.length) {
      addObligation({
        id: 'ob-elf-libs',
        item: 'the rebuild links or loads the same libraries',
        acceptance: 'symbols',
        symbols: needed.map((n) => n.replace(/\.so(\.\d+)*$/, '')),
        weight: W.libs,
        why: 'a missing library means a missing code path, not just a build difference',
      });
    }
  }

  if (profile.pe?.exports?.length) {
    addObligation({
      id: 'ob-exports',
      item: 'the rebuild exports the same public symbols',
      acceptance: 'manual',
      weight: W.symbols,
      why: 'an export list is the ABI contract; a consumer of the original will call these names',
      symbols: profile.pe.exports.slice(0, 20),
    });
  }

  if (profile.kind === 'jar' || profile.kind === 'apk') {
    const interesting = (profile.classHits || []).slice(0, 16).map((h) => h.api);
    if (interesting.length) {
      addObligation({
        id: 'ob-java-surface',
        item: 'the rebuild keeps the same networking, storage and account classes',
        acceptance: 'symbols',
        symbols: interesting,
        weight: W.symbols,
        why: 'these classes carry the behaviour a Java rebuild has to reproduce',
      });
    }
  }

  // ---- literals that a rebuild can be checked against verbatim
  const literals = (profile.strings?.notable || [])
    .filter((n) => !n.decoy && ['registry', 'paths', 'task-scheduler', 'persistence', 'sql', 'embedded-url-api'].includes(n.rule))
    .slice(0, 16);
  if (literals.length) {
    addObligation({
      id: 'ob-literals',
      item: 'the rebuild references the same paths, keys and statements',
      acceptance: 'presence',
      patterns: [...new Set(literals.map((l) => l.value))].slice(0, 12),
      weight: W.literals,
      why: 'a registry key or SQL statement written differently usually means a different target system',
      evidence: literals.slice(0, 6).map((l) => l.id),
    });
  }

  // Any capability that carries verbatim samples gets a presence obligation, unless a
  // stronger obligation already covers it. Without this, a thin target (a p-code program
  // with three strings) produces a spec with nothing checkable, which defeats the point.
  for (const c of caps) {
    if (!c.samples.length) continue;
    const id = 'ob-cap-' + c.id;
    if (byId.has(id)) continue;
    addObligation({
      id,
      item: 'the rebuild keeps the user-visible strings of the ' + c.id + ' behaviour',
      acceptance: 'presence',
      patterns: c.samples.slice(0, 6),
      weight: 2,
      why: 'a literal the original shows or uses is the cheapest thing a rebuild can be held to',
      evidence: c.evidence,
    });
  }

  // ---- a manual gate that a reviewer must sign, never auto-passed
  addObligation({
    id: 'ob-behaviour',
    item: 'a human has run the original and the rebuild side by side and written what differs',
    acceptance: 'manual',
    weight: 2,
    why: 'static reads cannot prove behaviour; this is the one obligation no tool here can close',
  });

  if (!obligations.length) {
    unknowns.push({ id: 'u-empty-spec', question: 'no obligation could be derived from this target', how_to_settle: 'the file may be a data blob; check the kind and try a deeper engine', severity: 'high' });
  }

  const stack = profile.stack || { primary: 'unknown', labels: [] };
  const spec = {
    schema: SPEC_SCHEMA,
    name: name || profile.name,
    target: profile.target,
    sha256: profile.sha256,
    kind: profile.kind,
    size: profile.size,
    stack,
    gate,
    shield: profile.shield ? {
      detected: true,
      confidence: profile.shield.confidence,
      signals: profile.shield.signals.map((s) => s.id),
      maskedLiterals: profile.shield.readable.maskedLiterals,
      untrusted: profile.shield.unreadableCount,
      advice: profile.shield.advice,
    } : { detected: false },
    capabilities: caps,
    obligations,
    // Kept under the v1 name as well: existing reports and outside scripts read `must_have`.
    must_have: obligations.map((o) => ({
      id: o.id,
      item: o.item,
      weight: o.weight,
      check: checkFor(o),
      evidence: o.evidence || [],
    })),
    unknowns,
    endpoints: urls,
    request: request || buildRequest(profile, stack, caps, obligations),
    createdAt: new Date().toISOString(),
  };
  return spec;
}

export function checkFor(o) {
  if (o.acceptance === 'presence') return { type: 'presence', patterns: o.patterns || [], scope: o.scope || 'rebuild' };
  if (o.acceptance === 'symbols') return { type: 'symbols', symbols: o.symbols || [] };
  if (o.acceptance === 'file-exists') return { type: 'file-exists', path: o.path };
  if (o.acceptance === 'manual') return { type: 'manual' };
  return { type: 'manual' };
}

// The request is what a rebuild engine reads. It is structured so that the acceptance
// tests travel with it instead of being described in prose.
export function buildRequest(profile, stack, caps, obligations) {
  const lines = [];
  lines.push('Rebuild the externally visible behaviour of this target as an independent implementation.');
  lines.push('');
  lines.push('Target: ' + profile.name + ' (' + profile.kind + ', ' + stack.primary + ', ' + profile.size + ' bytes)');
  if (stack.labels.length > 1) lines.push('Detected stack markers: ' + stack.labels.join(', '));
  lines.push('');
  lines.push('Behaviours that matter, strongest evidence first:');
  for (const c of caps.slice(0, 8)) lines.push('- ' + c.statement + (c.samples.length ? '  (evidence: ' + c.samples[0].slice(0, 80) + ')' : ''));
  lines.push('');
  lines.push('Acceptance tests your rebuild will be scored against:');
  for (const o of obligations) {
    if (o.acceptance === 'manual') lines.push('- [manual] ' + o.item);
    else if (o.acceptance === 'presence') lines.push('- [checked] ' + o.item + ': ' + (o.patterns || []).slice(0, 4).join(' | '));
    else if (o.acceptance === 'symbols') lines.push('- [checked] ' + o.item + ': ' + (o.symbols || []).slice(0, 6).join(', '));
  }
  lines.push('');
  lines.push('Internal structure may differ. Every [checked] line above must appear verbatim somewhere in the tree.');
  lines.push('Do not implement behaviour the evidence does not support.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- io

import fs from 'node:fs';
import path from 'node:path';

export function writeSpec(dir, spec) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8');
  return file;
}

export function readSpec(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
}

// A spec written by v0.1 has no obligations; adapt it rather than refusing to run.
export function normaliseSpec(spec) {
  if (spec.schema === SPEC_SCHEMA) return spec;
  const obligations = (spec.must_have || []).map((m) => ({
    id: m.id,
    item: m.item,
    weight: m.weight || 1,
    acceptance: m.check?.type === 'regex-any' ? 'presence' : m.check?.type === 'file-exists' ? 'file-exists' : 'manual',
    patterns: m.check?.patterns || [],
    path: m.check?.path,
    why: 'carried over from a v1 spec',
    evidence: m.evidence || [],
  }));
  return { ...spec, schema: SPEC_SCHEMA, obligations, gate: spec.gate || 80 };
}

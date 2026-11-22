// The coverage table: what this tool actually does in each reverse-engineering domain, said plainly.
//
// The point is the third column. A tool that lists twenty supported formats without saying how deep
// it goes is lying by omission; this one marks each domain full / partial / none and puts the reason
// in the row.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAnalyzers } from '../../analyzers/index.mjs';

export const MAP_SCHEMA = 'reacraft.map/1';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECIPES = path.join(here, '..', '..', 'knowledge', 'recipes.json');

// How far the reader actually goes, per domain. Kept beside the recipes so the two cannot drift:
// adding a recipe for a domain that is listed as `none` is a signal to write the analyzer, not to
// quietly upgrade the label.
const DEPTH = {
  'pe-native': { depth: 'full', by: 'parsePE + profile + drm + decode; disasm.mjs adds structure and pseudocode via radare2' },
  'pe-managed': { depth: 'partial', by: 'CLR header detected; IL is not decompiled — pair with ilspycmd' },
  elf: { depth: 'full', by: 'parseELF, symbols, NEEDED; disasm.mjs adds structure and pseudocode' },
  macho: { depth: 'partial', by: 'slices and load commands; entitlements not read' },
  android: { depth: 'partial', by: 'classes from DEX names; manifest is not parsed — pair with apktool' },
  java: { depth: 'partial', by: 'class names and package layout; bytecode is not read' },
  electron: { depth: 'full', by: 'src/core/target.mjs (parseAsar), main/preload/renderer shape' },
  script: { depth: 'full', by: 'text mode plus the string rules and the instruction-like guard' },
  protection: { depth: 'full', by: 'src/core/shield.mjs, drm.mjs (per-section entropy, products)' },
  crypto: { depth: 'partial', by: 'literals and API names; algorithms are not identified' },
  network: { depth: 'partial', by: 'endpoints and hosts; protocol shape is not inferred' },
  firmware: { depth: 'none', by: 'no container parser: binwalk first, then rea each part' },
};

export function loadRecipes(file = RECIPES) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Which domains a profile lands in, using the same facts the spec uses.
export function domainsFor(profile) {
  const hit = new Set();
  const kind = profile?.kind || '';
  if (kind === 'pe-native') hit.add('pe-native');
  if (kind === 'pe-managed') { hit.add('pe-native'); hit.add('pe-managed'); }
  if (kind === 'elf') hit.add('elf');
  if (kind === 'macho') hit.add('macho');
  if (kind === 'apk' || kind === 'dex') hit.add('android');
  if (kind === 'jar' || kind === 'class') hit.add('java');
  if (kind === 'asar' || kind === 'electron') hit.add('electron');
  if (['javascript', 'python', 'lua', 'text', 'json'].includes(kind)) hit.add('script');
  if (profile?.drm?.detected || profile?.shield?.detected) hit.add('protection');
  const caps = new Set((profile?.capabilities || []).map((c) => c.id));
  if (caps.has('crypto')) hit.add('crypto');
  if (caps.has('network')) hit.add('network');
  if (kind === 'raw-binary') hit.add('firmware');
  return hit;
}

/**
 * @param profile - optional; when given, the table marks which domains this target landed in.
 */
export function buildMap(profile = null) {
  const { domains } = loadRecipes();
  const hit = profile ? domainsFor(profile) : new Set();
  const rows = domains.map((d) => {
    const depth = DEPTH[d.id] || { depth: 'none', by: 'no analyzer' };
    return {
      id: d.id,
      title: d.title,
      detect: d.detect,
      depth: depth.depth,
      analyzer: depth.by,
      recipes: d.steps.length,
      pitfalls: d.pitfalls.length,
      hit: hit.has(d.id),
    };
  });
  const counts = { full: 0, partial: 0, none: 0 };
  for (const r of rows) counts[r.depth] += 1;
  return {
    schema: MAP_SCHEMA,
    domains: rows,
    counts,
    // The container formats that can be opened at all, read from the registry rather than typed here.
    analyzers: listAnalyzers(),
    // The honest line, and the one that matters for "support every domain".
    note:
      counts.none + ' domain(s) have no reader at all: a recipe tells you what to run, not what this tool can see',
  };
}

export function renderMap(map) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  lines.push('domain            depth    recipes  analyzer');
  lines.push('----------------  -------  -------  --------');
  for (const d of map.domains) {
    lines.push(pad(d.id, 18) + '  ' + pad(d.depth, 7) + '  ' + pad(String(d.recipes), 7) + '  ' + pad(d.analyzer, 66));
  }
  lines.push('');
  lines.push('full ' + map.counts.full + '   partial ' + map.counts.partial + '   none ' + map.counts.none);
  lines.push('analyzers: ' + (map.analyzers || []).map((a) => a.id).join(', '));
  if (map.domains.some((d) => d.hit)) {
    lines.push('');
    lines.push('this target: ' + map.domains.filter((d) => d.hit).map((d) => d.id).join(', '));
  }
  lines.push('');
  lines.push(map.note);
  return lines.join('\n');
}

// The steps a person would actually run for one domain, in order.
export function recipeFor(id) {
  const { domains } = loadRecipes();
  const d = domains.find((x) => x.id === id);
  if (!d) return null;
  return {
    ...d,
    steps: d.steps.map((s) => ({ when: s.when, run: s.run, expect: s.expect })),
  };
}

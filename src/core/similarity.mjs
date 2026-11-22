// Similarity: how much of what the original says is present in the rebuild.
//
// This is deliberately NOT a behavioural claim. It answers one narrow question with
// numbers you can recompute: which literals, endpoints and symbols the original carries
// are missing from the rebuild tree. The score is weighted coverage over the categories
// that have something to require, so an empty category never inflates it.
//
// Categories:
//   endpoints  hosts and URL prefixes     weight 4
//   literals   registry paths, file paths, distinctive strings  weight 3
//   symbols    imported/exported API names, or source identifiers  weight 3
//   structure  manifest fields, section names, extension mix     weight 2
import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.m', '.mm', '.lua', '.rb', '.php', '.json', '.yml', '.yaml', '.toml', '.ini', '.xml', '.html', '.htm', '.css', '.scss', '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.md', '.txt', '.cfg', '.conf', '.env', '.gradle', '.properties']);

const WEIGHTS = { endpoints: 4, literals: 3, symbols: 3, structure: 2 };

// ---------------------------------------------------------------- corpus

export function collectSources(dir, { maxFiles = 6000, maxBytes = 8 * 1024 * 1024, maxFile = 2 * 1024 * 1024 } = {}) {
  const files = [];
  let budget = maxBytes;
  const walk = (d, depth) => {
    if (depth > 12 || files.length >= maxFiles || budget <= 0) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size > maxFile || st.size > budget) continue;
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      budget -= st.size;
      files.push({ path: p, rel: path.relative(dir, p), text, bytes: st.size });
    }
  };
  walk(dir, 0);
  return files;
}

// Distinctive tokens without a language parser: string literals carry most of the
// signal for reconstruction, so they lead; identifiers catch re-implemented APIs.
export function corpus(files) {
  const literals = new Set();
  const urls = new Set();
  const identifiers = new Set();
  const manifestKeys = new Set();
  const exts = new Map();
  const litRe = /"((?:[^"\\\n]|\\.){3,120})"|'((?:[^'\\\n]|\\.){3,120})'|`((?:[^`\\]|\\.){3,120})`/g;
  const urlRe = /\bhttps?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?(?:\/[^\s"'`<>)]*)?/gi;
  const idRe = /\b[A-Za-z_][A-Za-z0-9_]{2,60}\b/g;

  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase().replace('.', '') || 'none';
    exts.set(ext, (exts.get(ext) || 0) + 1);
    let m;
    while ((m = litRe.exec(f.text))) {
      const v = (m[1] || m[2] || m[3] || '').trim();
      if (v.length >= 3) literals.add(v);
    }
    while ((m = urlRe.exec(f.text))) urls.add(m[0].replace(/[.,;:]+$/, ''));
    if (/\.(m?js|cjs|ts|tsx|jsx|json|ya?ml|py|cs|go|rs|java|kt|c|cpp|h)$/i.test(f.rel)) {
      // identifiers only for code-like files, capped per file
      const seen = new Set();
      let im;
      while ((im = idRe.exec(f.text)) && seen.size < 4000) seen.add(im[0]);
      for (const s of seen) identifiers.add(s);
    }
    if (f.rel.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(f.text);
        for (const k of ['name', 'main', 'version']) if (pkg[k]) manifestKeys.add(k + ':' + pkg[k]);
        for (const k of Object.keys(pkg.scripts || {})) manifestKeys.add('script:' + k);
        for (const k of Object.keys(pkg.dependencies || {})) manifestKeys.add('dep:' + k);
      } catch { /* a broken manifest is itself a finding, not a crash */ }
    }
  }
  return { literals, urls, identifiers, manifestKeys, exts, files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) };
}

// ---------------------------------------------------------------- set maths

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

export function coverage(required, actual) {
  if (!required.size) return { ratio: null, hit: 0, total: 0, missing: [] };
  const missing = [];
  let hit = 0;
  for (const v of required) {
    if (actual.has(v)) hit++;
    else missing.push(v);
  }
  return { ratio: hit / required.size, hit, total: required.size, missing };
}

// 64-bit FNV-1a over a seed prefix: good enough for a MinHash estimate, no dependency.
export function fnv(str, seed = 0) {
  let h = 0xcbf29ce484222325n ^ BigInt(seed);
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

export function minhashSignature(set, size = 64) {
  const sig = new Array(size).fill(0xffffffffffffffffn);
  for (const v of set) {
    for (let i = 0; i < size; i++) {
      const h = fnv(v, i * 2654435761 + 1);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

export function estimateJaccard(sigA, sigB) {
  if (!sigA.length || sigA.length !== sigB.length) return null;
  let same = 0;
  for (let i = 0; i < sigA.length; i++) if (sigA[i] === sigB[i]) same++;
  return same / sigA.length;
}

// ---------------------------------------------------------------- comparison

// The original side is the profile written by the rea stage; only what it actually
// carries becomes a requirement.
export function requiredFromProfile(profile, spec = null) {
  const endpoints = new Set((profile.endpoints || profile.strings?.urls || []).map(shortUrl).filter(Boolean));
  const literals = new Set();
  for (const item of profile.strings?.notable || []) {
    const v = String(item.value || '').trim();
    if (v.length < 4 || v.length > 160) continue;
    if (item.rule === 'network' || item.rule === 'ipv4' || item.rule === 'domain') continue;
    if (/^(file|http|https):/i.test(v)) continue;
    if (/^[a-z]:\\/i.test(v) || v.startsWith('%')) literals.add(v);
    else if (item.rule === 'registry' || item.rule === 'persistence' || item.rule === 'task-scheduler') literals.add(v);
    else if (item.rule === 'embedded-url-api') literals.add(v);
    else if (v.length >= 8 && /[\\/.:]/.test(v)) literals.add(v);
  }
  const symbols = new Set();
  for (const hit of profile.importHits || []) symbols.add(shortApi(hit.api));
  for (const exp of profile.pe?.exports || []) symbols.add(String(exp));
  const structure = new Set();
  for (const s of profile.pe?.sections || []) structure.add('section:' + s.name);
  if (profile.asar?.manifest?.name) structure.add('app:' + profile.asar.manifest.name);
  if (profile.kind) structure.add('kind:' + profile.kind);
  if (spec?.stack?.primary) structure.add('stack:' + spec.stack.primary);
  return { endpoints, literals, symbols, structure };
}

function shortUrl(u) {
  const m = String(u).match(/^(?:https?|wss?):\/\/([^\s/]+)(\/[^\s]*)?/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const prefix = (m[2] || '').split(/[?#]/)[0].slice(0, 60);
  return prefix && prefix !== '/' ? host + prefix : host;
}

function shortApi(api) {
  const s = String(api || '');
  const bang = s.indexOf('!');
  return bang >= 0 ? s.slice(bang + 1) : s;
}

// A rebuild may be source or a binary. Source gets the corpus; a binary gets its
// imported and exported names via the rea stage, which the caller can pass in.
export function compare(profile, rebuildDir, { rebuildProfile = null, spec = null } = {}) {
  const files = collectSources(rebuildDir);
  const c = corpus(files);
  const req = requiredFromProfile(profile, spec);

  const actualUrls = new Set([...c.urls].map(shortUrl).filter(Boolean));
  const actualLiterals = new Set([...c.literals]);
  const actualSymbols = new Set([...c.identifiers]);
  if (rebuildProfile) {
    for (const h of rebuildProfile.importHits || []) actualSymbols.add(shortApi(h.api));
    for (const e of rebuildProfile.pe?.exports || []) actualSymbols.add(String(e));
    for (const u of rebuildProfile.endpoints || []) { const s = shortUrl(u); if (s) actualUrls.add(s); }
  }
  const actualStructure = new Set([...c.manifestKeys]);
  for (const ext of c.exts.keys()) actualStructure.add('ext:' + ext);

  // Endpoints and literals match case-insensitively: the same key path written with
  // different capitalisation is the same key as far as this check goes.
  const endpoints = coverage(lower(req.endpoints), lower(actualUrls));
  const literals = coverage(lower(req.literals), lower(actualLiterals));
  const symbols = coverage(req.symbols, actualSymbols);
  const structure = coverage(req.structure, actualStructure);

  const parts = [
    ['endpoints', endpoints],
    ['literals', literals],
    ['symbols', symbols],
    ['structure', structure],
  ];
  let wsum = 0;
  let acc = 0;
  const detail = {};
  for (const [name, cov] of parts) {
    detail[name] = {
      weight: WEIGHTS[name],
      required: cov.total,
      hit: cov.hit,
      ratio: cov.ratio,
      missing: cov.missing.slice(0, 40),
    };
    if (cov.ratio === null) continue;
    wsum += WEIGHTS[name];
    acc += WEIGHTS[name] * cov.ratio;
  }

  const sigA = minhashSignature(req.literals);
  const sigB = minhashSignature(new Set([...c.literals]));
  const minhash = estimateJaccard(sigA, sigB);

  const score = wsum ? Math.round((acc / wsum) * 100) : null;
  const requirements = parts.reduce((a, [, cov]) => a + cov.total, 0);
  const confidence = requirements >= 25 && c.files >= 3 ? 'high' : requirements >= 8 ? 'medium' : 'low';

  return {
    schema: 'reacraft.similarity/1',
    rebuildDir,
    score,
    minhashJaccard: minhash === null ? null : Number(minhash.toFixed(3)),
    coverage: detail,
    corpus: { files: c.files, bytes: c.bytes, literals: c.literals.size, urls: c.urls.size, identifiers: c.identifiers.size },
    requirements,
    confidence,
    caveats: [
      'coverage counts presence, not behaviour: a literal can appear without being used',
      'minhashJaccard is an estimate over literals only, not over code',
      'low confidence means few requirements or a tiny rebuild tree, not a bad rebuild',
    ],
  };
}

function lower(set) {
  const out = new Set();
  for (const v of set) out.add(String(v).toLowerCase());
  return out;
}

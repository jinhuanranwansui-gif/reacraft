// Profile stage: everything the pipeline knows about a target, with an evidence id on
// every claim. The ids are content-derived, so re-reading the same file reproduces the
// same ids and a spec written last week still points at something you can check.
import path from 'node:path';
import crypto from 'node:crypto';
import { readTarget, extractEndpoints } from './target.mjs';
import { STRING_RULES, API_RULES, API_SETS, JAVA_RULES, apiHit } from './rules.mjs';
import { assessShield, filterEndpoints } from './shield.mjs';
import { decodeShares } from './decode.mjs';
import { detectDrm } from './drm.mjs';
import { scanForInstructions, redact } from './prompt-guard.mjs';

export const PROFILE_SCHEMA = 'reacraft.profile/2';

export function evidenceId(kind, value) {
  const h = crypto.createHash('sha256').update(kind + '\u0000' + String(value)).digest('hex').slice(0, 10);
  return 'ev-' + kind + '-' + h;
}

// One rule per string, first match wins. Scoring the whole line instead makes a passing
// mention of "license" look like a licence check.
export function scoreStrings(strings) {
  const notable = [];
  const hits = [];
  let budget = 4000;
  for (const s of strings) {
    if (budget <= 0) break;
    for (const rule of STRING_RULES) {
      const m = s.match(rule.re);
      if (!m) continue;
      budget--;
      const value = m[0].slice(0, 200);
      const id = evidenceId(rule.id, value);
      if (notable.length < 600) {
        notable.push({ rule: rule.id, value, id, context: s.length > 200 ? s.slice(0, 200) + '...' : s });
      }
      hits.push({ rule: rule.id, weight: rule.weight, id, sample: value.slice(0, 160) });
      break;
    }
  }
  return { hits, notable };
}

// ELF symbols carry a version suffix (socket@GLIBC_2.2.5) and Mach-O ones a leading
// underscore; both are noise for capability matching.
export function cleanSymbol(name) {
  return String(name).replace(/@.*$/, '').replace(/^_+/, '');
}

export function scoreSymbols(names) {
  const hits = [];
  for (const raw of names || []) {
    const name = cleanSymbol(raw);
    for (const rule of API_RULES) {
      if (apiHit(name, API_SETS[rule.id])) {
        hits.push({ rule: rule.id, weight: rule.weight, api: name, id: evidenceId(rule.id, name) });
        break;
      }
    }
  }
  return hits;
}

export function scoreImports(imports) {
  const hits = [];
  for (const imp of imports || []) {
    for (const fn of imp.functions || []) {
      const name = fn.name || ('#' + fn.ordinal);
      for (const rule of API_RULES) {
        if (apiHit(name, API_SETS[rule.id])) {
          hits.push({ rule: rule.id, weight: rule.weight, api: imp.dll + '!' + name, id: evidenceId(rule.id, imp.dll + '!' + name) });
          break;
        }
      }
    }
  }
  return hits;
}

export function scoreJavaClasses(classes) {
  const hits = [];
  for (const c of classes || []) {
    for (const rule of JAVA_RULES) {
      if (rule.re.test(c)) {
        hits.push({ rule: rule.id, weight: rule.weight, api: c, id: evidenceId('java-' + rule.id, c) });
        break;
      }
    }
  }
  return hits;
}

export function guessStack(profile) {
  const dlls = (profile.pe?.imports || []).map((i) => i.dll).join(' ');
  const flat = [
    ...(profile.strings?.notable || []).map((x) => x.value),
    ...(profile.elf?.needed || []),
    ...(profile.elf?.symbols || []).slice(0, 400),
    dlls,
  ].join(' ').toLowerCase();
  // Electron is decided structurally, not by a string: craft-anything itself mentions
  // Electron everywhere because it analyses Electron apps, and that is not evidence.
  const strong = [];
  const dllsLower = dlls.toLowerCase();
  if (profile.kind === 'asar' || /chrome_\d+\.dll|libcef\.dll|node\.dll|electron\.exe/.test(dllsLower)) strong.push('electron');
  if (profile.kind === 'apk' || profile.kind === 'dex-archive') strong.push('android');
  const marks = [
    ['flutter', /flutter|libapp\.so/],
    ['qt', /qt5|qt6|qwindows\.dll|libqt/],
    ['wpf', /presentationframework|wpfgfx/],
    ['winforms', /system\.windows\.forms/],
    ['dotnet', /mscorlib|system\.private\.corelib/],
    ['vb6', /msvbvm\d+\.dll|vb6\.dll|visual basic runtime/i],
    ['delphi', /borlndmm|rtl\d+\.bpl|embarcadero|delphi/i],
    ['rust', /rust\b|core::panicking|rustc|\.rs:[0-9]/],
    ['go', /go1\.\d+|golang|runtime\.goexit/],
    ['java', /\.jar|openjdk|jvm|dalvik/],
    ['python', /python3\d|pyinstaller|site-packages|__pycache__/],
    ['node', /node_modules|require\.js|v8::/],
  ];
  const labels = [...new Set([...strong, ...marks.filter(([, re]) => re.test(flat)).map(([k]) => k)])];
  return {
    labels,
    primary: labels[0] || (profile.kind.startsWith('pe') ? 'native-c' : profile.kind === 'elf' ? 'native-c' : 'unknown'),
  };
}

// A short, honest statement of what this read could not cover.
export function limits(profile) {
  const out = [];
  if (profile.kind === 'pe-native' && !(profile.pe?.imports || []).length) {
    out.push({ id: 'u-imports', question: 'no import table was parsed (packed, stripped or non-PE)', how_to_settle: 'run with --deep or unpack the sample first', severity: 'medium' });
  }
  if (profile.kind === 'elf' && !(profile.elf?.symbols || []).length) {
    out.push({ id: 'u-symbols', question: 'the ELF has no dynamic symbol table (stripped, static or packed)', how_to_settle: 'disassemble with a native engine, or treat symbol coverage as unavailable', severity: 'medium' });
  }
  if (profile.kind === 'apk' && !(profile.dexClasses || []).length) {
    out.push({ id: 'u-dex', question: 'no class descriptors were recovered from the APK', how_to_settle: 'decode the dex with a dedicated tool, then re-run the spec stage on its class list', severity: 'medium' });
  }
  if (profile.kind === 'macho' && profile.macho?.fat) {
    out.push({ id: 'u-fat', question: 'universal binary: only the container was identified', how_to_settle: 'split the slices and read each architecture', severity: 'low' });
  }
  if (profile.kind === 'large-file') {
    out.push({ id: 'u-large', question: 'the file is too large to read in one pass', how_to_settle: 'read the first and last megabytes, or point the tool at an extracted part', severity: 'high' });
  }
  // A p-code VM keeps its own logic in bytecode: there is no import table to reason from,
  // so a thin spec here is a property of the target, not of the reader.
  if ((profile.stack?.labels || []).some((l) => l === 'vb6' || l === 'delphi')) {
    out.push({
      id: 'u-pcode',
      question: 'the program logic lives in a p-code or VM runtime (' + (profile.stack.labels.join(', ')) + ')',
      how_to_settle: 'read the bytecode with a dedicated decompiler, or record its behaviour and attach the trace as evidence',
      severity: 'high',
    });
  }
  out.push({ id: 'u-dynamic', question: 'run-time behaviour (what it does when started) is not observed here', how_to_settle: 'record a bounded session with an engine, then attach the trace as extra evidence', severity: 'low' });
  return out;
}

export function buildProfile(file, { name = null } = {}) {
  const t = readTarget(file, { name });
  const strings = t.strings;
  const sScore = scoreStrings(strings);
  const peImports = scoreImports(t.pe?.imports || []);
  const elfSymbols = scoreSymbols(t.elf?.symbols || []);
  const javaClasses = scoreJavaClasses(t.classes || t.dexClasses || []);
  const endpoints = extractEndpoints(strings);

  const ruleScores = {};
  const sum = (list) => { for (const h of list) ruleScores[h.rule] = (ruleScores[h.rule] || 0) + h.weight; };
  sum(sScore.hits);
  sum(peImports);
  sum(elfSymbols);
  sum(javaClasses);

  const profile = {
    schema: PROFILE_SCHEMA,
    target: t.target,
    name: t.name,
    size: t.size,
    sha256: t.sha256,
    kind: t.kind,
    ext: t.ext,
    pe: t.pe,
    elf: t.elf,
    macho: t.macho,
    asar: t.asar,
    zipEntries: t.zipEntries,
    classes: t.classes ? t.classes.slice(0, 400) : null,
    dexClasses: t.dexClasses ? t.dexClasses.slice(0, 400) : null,
    strings: {
      total: strings.length,
      urls: endpoints,
      notable: sScore.notable,
      minLength: 6,
    },
    endpoints,
    ruleScores,
    importHits: peImports.slice(0, 500),
    symbolHits: elfSymbols.slice(0, 500),
    classHits: javaClasses.slice(0, 300),
    analyzedAt: new Date().toISOString(),
  };
  profile.stack = guessStack(profile);
  profile.unknowns = limits(profile);

  // Commercial wrapper (Steam DRM, UPX, VMProtect…): the headers survive, the code may not.
  if (profile.pe) {
    const drm = detectDrm(profile);
    // Always present on a PE, so a caller can ask "was a wrapper found?" without a null check.
    profile.drm = drm;
    if (drm.detected) {
      profile.drm = drm;
      profile.unknowns.unshift({
        id: 'u-drm',
        question: 'this image carries a commercial wrapper (' + drm.products.map((p) => p.id).join(', ') + ')'
          + (drm.codeEncrypted ? ' and its code section is encrypted' : ''),
        how_to_settle: drm.codeEncrypted
          ? 'a static read cannot see the protected code: dump the image after the stub decrypts it, then read that'
          : 'the code section is readable in this build; treat the wrapper section as packaging, not behaviour',
        severity: drm.codeEncrypted ? 'high' : 'medium',
      });
    }
  }

  // Does this target fight back? A shield adds bytes, decoys and masked literals; it does not
  // change the container, so structure stays trustworthy while individual values may not.
  const shield = assessShield(profile, t.text);
  if (shield.detected) {
    profile.shield = shield;
    profile.endpoints = filterEndpoints(profile.endpoints, true);
    if (profile.strings) profile.strings.urls = profile.endpoints;

    // A masked literal is stored as two integer arrays plus a position term, and both arrays
    // ship in the file — so the value is arithmetic, not a secret. Recover it and put it back
    // where the rest of the evidence lives.
    if (t.text) {
      const dec = decodeShares(t.text);
      if (dec.decoded.length) {
        profile.decoded = dec;
        for (const d of dec.decoded.slice(0, 24)) {
          profile.strings.notable.push({
            rule: 'decoded',
            value: d.value,
            id: evidenceId('decoded', d.value),
            context: 'recovered from a masked literal (coefficient 0x' + d.coefficient.toString(16) + ')',
          });
        }
        shield.readable.maskedLiterals = 'recovered';
        shield.recovered = dec.decoded.length;
        shield.advice = shield.advice.map((a) => (a.startsWith('masked string literals')
          ? 'masked string literals: ' + dec.decoded.length + ' recovered offline — the two share arrays are the key and they ship in the file (no target code was run)'
          : a));
      }
    }

    profile.unknowns = profile.unknowns.filter((u) => u.id !== 'u-shield');
    profile.unknowns.unshift({
      id: 'u-shield',
      question: 'this target carries a shield (' + shield.signals.map((s) => s.id).join(', ') + ')',
      how_to_settle: shield.readable.maskedLiterals === 'recovered'
        ? 'masked literals recovered; re-check any decoy-marked value before relying on it'
        : shield.readable.maskedLiterals === 'none-detected'
          ? 'decoys are marked and excluded; re-read any value you plan to rely on'
          : 'masked literals cannot be recovered statically: run the program and hook the decoder, or evaluate the decoder offline',
      severity: shield.readable.maskedLiterals === 'recovered' ? 'medium' : 'high',
    });
  }

  // Strings that would read as an order if a model saw them (arXiv 2605.30667). This scans every
  // string, not only the notable ones: the bait usually matches no parser rule at all.
  const guard = scanForInstructions(strings, (v) => evidenceId('instruction', v));
  if (guard.detected) {
    const byValue = new Map((profile.strings?.notable || []).map((n) => [n.value, n]));
    for (const h of guard.hits) {
      const existing = byValue.get(h.value);
      if (existing) {
        existing.suspect = 'instruction-like';
        existing.suspectRules = h.matched;
        h.rule = existing.rule;
        h.digest = existing.id;
      } else {
        // Not notable by any rule, which is exactly why it is worth indexing here.
        h.rule = 'instruction';
        profile.strings?.notable.push({
          rule: 'instruction',
          value: h.value,
          id: h.id,
          suspect: 'instruction-like',
          suspectRules: h.matched,
          context: 'not classified by any rule; flagged as instruction-like text',
        });
        h.digest = h.id;
      }
    }
    profile.guard = guard;
    profile.unknowns.unshift({
      id: 'u-instruction-strings',
      question: guard.count + ' string(s) in this target read as instructions rather than data',
      how_to_settle: 'treat any model that reads this file as a target: quote the evidence ids, never the text',
      severity: 'high',
    });
  } else {
    profile.guard = guard;
  }

  profile.evidence = buildEvidenceIndex(profile);
  return profile;
}

// A flat index of every evidence id the profile carries, so a report can cite one and a
// reader can find it. Kept small: ids plus a one-line value.
export function buildEvidenceIndex(profile) {
  const items = [];
  const push = (kind, id, value, extra = '') => items.push({ id, kind, value: String(value).slice(0, 160), detail: extra });
  for (const n of profile.strings?.notable || []) {
    // A suspect string is indexed but never carried into a report as text.
    push(n.rule, n.id, n.suspect ? redact(n.value) : n.value, n.suspect ? 'instruction-like' : '');
  }
  for (const h of profile.importHits || []) push(h.rule, h.id, h.api, 'import');
  for (const h of profile.symbolHits || []) push(h.rule, h.id, h.api, 'symbol');
  for (const h of profile.classHits || []) push(h.rule, h.id, h.api, 'class');
  for (const e of profile.endpoints || []) push('endpoint', evidenceId('endpoint', e), e);
  return items.slice(0, 1200);
}

export function pickEvidence(profile, rule, n = 6) {
  // Decoys and instruction-like text never become evidence a spec can quote.
  return (profile.strings?.notable || []).filter((x) => x.rule === rule && !x.decoy && !x.suspect).slice(0, n);
}

export { path };

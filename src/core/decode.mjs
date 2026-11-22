// Recovering masked string literals — the one thing a shield claims a static reader cannot do.
//
// bla-agents stores a literal at maximum/bankrupt intensity as two integer arrays plus a
// position term, and rebuilds it at run time:
//
//     function readSplitShare_xxxx(a, b) {
//       for (i …) { const pos = i * 0x5d & 0xffff;
//                   const ch  = a[i] ^ b[i] ^ pos;
//                   out[i] = String.fromCharCode(ch); }
//       return out.join("");
//     }
//
// Its documentation says recovery "takes running the decoder: executing the program and printing
// the variable, or copying the function and its arguments out of the file". The second half is
// the important one: **the key is the two arrays, and they are in the file**. No extra secret is
// involved, so the value is recoverable with arithmetic alone — no evaluation, no execution, no
// sandbox. That is what this module does.
//
// A shield that only ever used one construction would be easy; four are handled here, and the
// cost of a wrong guess is one failed printable-ratio check:
//
//   split-share        two equal-length integer arrays, XOR with a position term
//   single-array-xor   one array, XOR with a position term
//   fromcharcode-list  String.fromCharCode(104, 101, …) — visible, but easy to miss in 150 KB
//   mapped-offset      [104, 101, …].map(c => String.fromCharCode(c - 5))
//
// It never runs target code. It reads arrays and literals, tries the constants the file declares,
// and keeps whatever scores as text.
import fs from 'node:fs';

export const DECODE_SCHEMA = 'reacraft.decode/1';

const MIN_SHARE = 8;
const MAX_SHARE = 8192;

const HEX_CONST = /\*\s*0x([0-9a-f]{1,4})\b/gi;

export function findIntArrays(text) {
  const out = [];
  const re = /\[\s*(\d{1,6}(?:\s*,\s*\d{1,6}){7,})\s*\]/g;
  let m;
  while ((m = re.exec(text))) {
    const values = m[1].split(',').map((v) => Number(v.trim()));
    if (values.length < MIN_SHARE || values.length > MAX_SHARE) continue;
    if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 0xffff)) continue;
    out.push({ values, index: m.index });
    if (out.length >= 400) break;
  }
  return out;
}

export function findCoefficients(text) {
  const seen = new Map();
  let m;
  const re = new RegExp(HEX_CONST.source, 'gi');
  while ((m = re.exec(text))) {
    const v = parseInt(m[1], 16);
    if (!Number.isFinite(v) || v === 0 || v > 0xffff) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0]);
}

function printable(s) {
  if (!s) return 0;
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c !== 0x7f) ok++;
  }
  return ok / s.length;
}

function looksLikeText(s) {
  if (s.length < 6) return false;
  if (printable(s) < 0.92) return false;
  return /[A-Za-z]{3,}|https?:\/\/|\/|\\|\./.test(s);
}

// One place that decides whether a candidate earns a slot, so every strategy is held to the same
// standard.
function offer(found, value, detail) {
  const clean = String(value).replace(/\u0000+$/, '');
  if (!looksLikeText(clean)) return false;
  const score = printable(clean);
  const existing = found.get(clean);
  if (existing && existing.score >= score) return false;
  found.set(clean, {
    value: clean.slice(0, 4096),
    score: Number(score.toFixed(3)),
    ...detail,
  });
  return true;
}

// ---------------------------------------------------------------- strategies

// Two equal-length integer arrays plus a position term: the bla-agents construction.
function splitShare(text, coefficients) {
  const arrays = findIntArrays(text);
  const found = new Map();
  let tried = 0;
  const byLength = new Map();
  for (const arr of arrays) {
    if (!byLength.has(arr.values.length)) byLength.set(arr.values.length, []);
    byLength.get(arr.values.length).push(arr);
  }
  for (const [, group] of byLength) {
    for (let i = 0; i + 1 < group.length; i += 1) {
      const a = group[i].values;
      const b = group[i + 1].values;
      for (const coef of coefficients.slice(0, 24)) {
        tried++;
        let s = '';
        for (let k = 0; k < a.length; k++) {
          const ch = (a[k] ^ b[k] ^ ((k * coef) & 0xffff)) & 0xffff;
          s += ch >= 0x20 && ch !== 0x7f ? String.fromCharCode(ch) : '\u0000';
        }
        offer(found, s, { strategy: 'split-share', coefficient: coef, length: a.length, at: group[i].index });
      }
    }
  }
  return { id: 'split-share', found, tried, arrays: arrays.length };
}

// One array, XOR with a position term: the cheap version of the same idea.
function singleArrayXor(text, coefficients) {
  const found = new Map();
  let tried = 0;
  for (const arr of findIntArrays(text)) {
    for (const coef of coefficients.slice(0, 16)) {
      tried++;
      let s = '';
      for (let k = 0; k < arr.values.length; k++) {
        const ch = (arr.values[k] ^ ((k * coef) & 0xffff)) & 0xffff;
        s += ch >= 0x20 && ch !== 0x7f ? String.fromCharCode(ch) : '\u0000';
      }
      offer(found, s, { strategy: 'single-array-xor', coefficient: coef, length: arr.values.length, at: arr.index });
    }
  }
  return { id: 'single-array-xor', found, tried };
}

// String.fromCharCode(104, 101, 108, …) — no key at all, just obfuscation by inconvenience.
function fromCharCodeList(text) {
  const found = new Map();
  let tried = 0;
  const re = /String\.fromCharCode\(\s*(\d{1,5}(?:\s*,\s*\d{1,5}){5,})\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    tried++;
    const values = m[1].split(',').map((v) => Number(v.trim()));
    if (values.some((v) => v > 0xffff)) continue;
    offer(found, String.fromCharCode(...values), { strategy: 'fromcharcode-list', length: values.length, at: m.index });
  }
  return { id: 'fromcharcode-list', found, tried };
}

// [104, 101, …].map(c => String.fromCharCode(c - 5)) — a list with one arithmetic step on it.
function mappedOffset(text) {
  const found = new Map();
  let tried = 0;
  const re = /\[\s*(\d{1,5}(?:\s*,\s*\d{1,5}){5,})\s*\]\s*\.map\(\s*[A-Za-z_$][\w$]*\s*=>\s*String\.fromCharCode\(\s*[A-Za-z_$][\w$]*\s*([-+^])\s*(0x[0-9a-f]+|\d{1,5})\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const values = m[1].split(',').map((v) => Number(v.trim()));
    if (values.some((v) => v > 0xffff)) continue;
    const op = m[2];
    const k = m[3].startsWith('0x') ? parseInt(m[3], 16) : Number(m[3]);
    tried++;
    const codes = values.map((v) => (op === '-' ? v - k : op === '+' ? v + k : v ^ k));
    if (codes.some((c) => c < 0 || c > 0xffff)) continue;
    offer(found, String.fromCharCode(...codes), { strategy: 'mapped-offset', offset: op + k, length: values.length, at: m.index });
  }
  return { id: 'mapped-offset', found, tried };
}

// Decimal strings rather than numeric arrays (`"229,134,72…"`), with a position term.
function decimalStrings(text, coefficients) {
  const found = new Map();
  let tried = 0;
  const re = /["'](\d{1,5}(?:,\d{1,5}){9,})["']/g;
  let m;
  while ((m = re.exec(text))) {
    const values = m[1].split(',').map(Number);
    if (values.some((v) => v > 0xffff)) continue;
    for (const coef of [0x5d, 0x3b, 0x1f, 0x37, ...coefficients.slice(0, 4)]) {
      tried++;
      let s = '';
      for (let k = 0; k < values.length; k++) {
        const ch = (values[k] ^ ((k * coef) & 0xffff)) & 0xffff;
        s += ch >= 0x20 && ch !== 0x7f ? String.fromCharCode(ch) : '\u0000';
      }
      offer(found, s, { strategy: 'decimal-strings', coefficient: coef, length: values.length, at: m.index });
    }
  }
  return { id: 'decimal-strings', found, tried };
}

// ---------------------------------------------------------------- entry point

/**
 * Try every construction against the text, and keep the reconstructions that read as text.
 *
 * @param text - the target's source as text.
 * @returns reconstructions, each tagged with the strategy that produced it.
 */
export function decodeShares(text) {
  const coefficients = findCoefficients(text);
  const runs = [
    splitShare(text, coefficients),
    singleArrayXor(text, coefficients),
    fromCharCodeList(text),
    mappedOffset(text),
    decimalStrings(text, coefficients),
  ];

  const merged = new Map();
  for (const run of runs) {
    for (const [value, detail] of run.found) {
      const existing = merged.get(value);
      if (!existing || existing.score < detail.score) merged.set(value, detail);
    }
  }

  const tried = runs.reduce((a, r) => a + r.tried, 0);
  const decoded = [...merged.values()].sort((a, b) => b.score - a.score || b.value.length - a.value.length).slice(0, 64);
  const strategies = runs.filter((r) => r.found.size).map((r) => r.id);

  return {
    schema: DECODE_SCHEMA,
    // Nothing was executed: this is arithmetic over constants the file itself carries.
    executed: false,
    method: 'string reconstruction from constants the file carries',
    strategies,
    arrays: runs[0].arrays,
    coefficients: coefficients.slice(0, 16),
    tried,
    decoded,
    note: decoded.length
      ? 'recovered without running the target, by ' + strategies.join(', ')
      : 'no reconstruction scored as text; the value may use a construction this does not try',
  };
}

export function decodeFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return decodeShares(text);
}

// The values a spec can use as requirements, with their provenance kept.
export function decodedLiterals(result, { minLength = 6 } = {}) {
  return (result?.decoded || []).filter((d) => d.value.length >= minLength && d.score >= 0.95);
}

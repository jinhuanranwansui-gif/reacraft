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
// It never runs target code. It reads arrays, tries the multiplication constants the file itself
// declares, and keeps the reconstruction that scores as text.
import fs from 'node:fs';

export const DECODE_SCHEMA = 'reacraft.decode/1';

// A share array is a long run of integers; short numeric arrays are ordinary data.
const MIN_SHARE = 8;
const MAX_SHARE = 8192;

// Extracted from the file rather than hard-coded, so a different seed or version still works.
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
    // The position term multiplies the index, so it is small; anything past 0xffff cannot be it.
    if (!Number.isFinite(v) || v === 0 || v > 0xffff) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  // Most-used first: the decoder's own constant appears once per decoder, decoys repeat.
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

// Does it read like something a compiler kept? Tokens, paths, URLs, prose.
function looksLikeText(s) {
  if (s.length < 6) return false;
  if (printable(s) < 0.92) return false;
  return /[A-Za-z]{3,}|https?:\/\/|\/|\\|\./.test(s);
}

/**
 * Try every pairing of equal-length integer arrays against every multiplication constant the
 * file declares, and keep the reconstructions that read as text.
 *
 * @param text - the target's source as text.
 * @returns reconstructions with the evidence of how each was produced.
 */
export function decodeShares(text) {
  const arrays = findIntArrays(text);
  const coefficients = findCoefficients(text);
  const attempts = [];
  const found = new Map();

  // Pair arrays of the same length, in file order. A shield emits its shares adjacent.
  const byLength = new Map();
  for (const arr of arrays) {
    if (!byLength.has(arr.values.length)) byLength.set(arr.values.length, []);
    byLength.get(arr.values.length).push(arr);
  }

  let tried = 0;
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
        const clean = s.replace(/\u0000+$/, '');
        if (!looksLikeText(clean)) continue;
        const score = printable(clean);
        if (!found.has(clean) || found.get(clean).score < score) {
          found.set(clean, {
            value: clean.slice(0, 4096),
            score: Number(score.toFixed(3)),
            coefficient: coef,
            length: a.length,
            at: group[i].index,
          });
        }
      }
    }
  }

  attempts.push({ arrays: arrays.length, coefficients: coefficients.length, tried });
  restOfInput(text, found);

  return {
    schema: DECODE_SCHEMA,
    // Nothing was executed: this is arithmetic over constants the file itself carries.
    executed: false,
    method: 'split-share xor with the file\'s own position coefficient',
    arrays: arrays.length,
    coefficients: coefficients.slice(0, 16),
    tried,
    decoded: [...found.values()].sort((a, b) => b.score - a.score || b.value.length - a.value.length).slice(0, 64),
    note: found.size
      ? 'recovered without running the target: the two arrays are the key, and they ship in the file'
      : 'no split-share reconstruction scored as text; the value may use a different construction',
  };
}

// Second pass: some shields store the same trick as decimal strings rather than numeric arrays
// (`"229,134,72…"`), or as two arrays inside one object with the halves named. Cheap to try.
function restOfInput(text, found) {
  const re = /["'](\d{1,5}(?:,\d{1,5}){9,})["']/g;
  let m;
  while ((m = re.exec(text))) {
    const values = m[1].split(',').map(Number);
    if (values.some((v) => v > 0xffff)) continue;
    for (const coef of [0x5d, 0x3b, 0x1f, 0x37]) {
      let s = '';
      for (let k = 0; k < values.length; k++) {
        const ch = values[k] ^ ((k * coef) & 0xffff);
        s += ch >= 0x20 && ch !== 0x7f ? String.fromCharCode(ch) : '\u0000';
      }
      const clean = s.replace(/\u0000+$/, '');
      if (looksLikeText(clean) && !found.has(clean)) {
        found.set(clean, { value: clean.slice(0, 4096), score: Number(printable(clean).toFixed(3)), coefficient: coef, length: values.length, at: m.index });
      }
    }
  }
}

export function decodeFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return decodeShares(text);
}

// The values a spec can use as requirements, with their provenance kept.
export function decodedLiterals(result, { minLength = 6 } = {}) {
  return (result?.decoded || []).filter((d) => d.value.length >= minLength && d.score >= 0.95);
}

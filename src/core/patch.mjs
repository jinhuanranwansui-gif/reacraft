// The fifth rung: changing the target, and proving the change did what it claims.
//
// Everything before this reads. This writes — and writing to a binary is where a tool can do real
// damage, so the rules are narrow on purpose:
//
//   * the original is never touched; a patch produces `<name>.patched`
//   * a patch is described before it is applied: address, old bytes, new bytes, and why
//   * verification is a separate step that runs the result, because "the bytes changed" is not
//     "the behaviour changed"
//
// The findings come from the same radare2 the disassembler uses. Without it, this module can still
// describe and apply a byte change at an address you already know — it just cannot find the address
// for you.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { which } from './engines.mjs';
import { parsePE } from './target.mjs';

export const PATCH_SCHEMA = 'reacraft.patch/1';

// Conditional jumps and their opposites. Flipping one is the smallest change that turns "reject" into
// "accept". Short and near encodings have different opcode bytes, so they are two tables: 0x84 is
// only ever the second byte of a near jump, never a jump on its own.
const SHORT = {
  0x74: 0x75, 0x75: 0x74, // je / jne
  0x7c: 0x7d, 0x7d: 0x7c, // jl / jge
  0x7e: 0x7f, 0x7f: 0x7e, // jle / jg
  0x72: 0x73, 0x73: 0x72, // jb / jae
  0x76: 0x77, 0x77: 0x76, // jbe / ja
  0x7a: 0x7b, 0x7b: 0x7a, // jp / jnp
  0x78: 0x79, 0x79: 0x78, // js / jns
  0x70: 0x71, 0x71: 0x70, // jo / jno
};

const NEAR = {
  0x84: 0x85, 0x85: 0x84,
  0x8c: 0x8d, 0x8d: 0x8c,
  0x8e: 0x8f, 0x8f: 0x8e,
  0x82: 0x83, 0x83: 0x82,
  0x86: 0x87, 0x87: 0x86,
};

const NOP = 0x90;

export function r2Bin() {
  return which('radare2') || which('r2');
}

function runR2(args, { timeout = 240000 } = {}) {
  const bin = r2Bin();
  if (!bin) return { ok: false, stdout: '', stderr: 'radare2 not installed' };
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: (r.stderr || '').slice(0, 2000) };
}

function parseJson(text, open) {
  const s = String(text || '').indexOf(open);
  const close = open === '[' ? ']' : '}';
  const e = String(text || '').lastIndexOf(close);
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

/**
 * What a byte change at `at` could be. Pure arithmetic over the bytes, so it works with or without
 * radare2 and is testable without a binary.
 */
export function patchOptions(buf, at) {
  if (at < 0 || at >= buf.length) return [];
  const b = buf[at];
  const out = [];
  const bytes = (n) => Array.from(buf.subarray(at, at + n));
  const nops = (n) => new Array(n).fill(NOP);

  if (SHORT[b]) {
    out.push({ kind: 'flip', at, from: [b], to: [SHORT[b]], why: 'invert the condition: the branch that was taken is not taken' });
    out.push({ kind: 'nop', at, from: bytes(2), to: nops(2), why: 'remove the branch: neither path is skipped' });
  } else if (b === 0x0f && NEAR[buf[at + 1]]) {
    out.push({ kind: 'flip', at, from: [0x0f, buf[at + 1]], to: [0x0f, NEAR[buf[at + 1]]], why: 'invert the near condition' });
    out.push({ kind: 'nop', at, from: bytes(6), to: nops(6), why: 'remove the near branch: six bytes of nop' });
  } else if (b === 0xeb) {
    out.push({ kind: 'nop', at, from: bytes(2), to: nops(2), why: 'remove the unconditional short jump' });
  } else if (b === 0xe9) {
    out.push({ kind: 'nop', at, from: bytes(5), to: nops(5), why: 'remove the unconditional near jump' });
  }
  return out;
}

// A virtual address is not a file offset, and radare2's own mapping depends on whether it has loaded
// the image yet — the same `px @ va` gives different answers before and after analysis. Doing the
// arithmetic here, from the section table, makes the behaviour the same every time.
// parsePE keeps imageBase as a hex string in the profile-shaped output, so it has to be read as
// hex here — `Number('0x400000')` is NaN, and NaN silently makes every comparison below false.
function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    return s.startsWith('0x') || s.startsWith('0X') ? parseInt(s, 16) : Number(s);
  }
  return NaN;
}

export function vaToOffset(pe, va) {
  if (!pe || !Array.isArray(pe.sections)) return null;
  const imageBase = toNum(pe.imageBase);
  const target = toNum(va);
  if (!Number.isFinite(imageBase) || !Number.isFinite(target)) return null;
  const rva = target - imageBase;
  for (const s of pe.sections) {
    const vaddr = toNum(s.virtualAddress);
    const size = Math.max(toNum(s.virtualSize) || 0, toNum(s.rawSize) || 0);
    if (rva >= vaddr && rva < vaddr + size) {
      const delta = rva - vaddr;
      const rawSize = toNum(s.rawSize) || 0;
      if (delta >= rawSize) return null; // in the zero-filled tail, nothing on disk
      return (toNum(s.rawPtr) || 0) + delta;
    }
  }
  return null;
}

/** Apply a described patch to a copy. The original file is only ever read. */
export function applyPatch(file, patch, { out = null } = {}) {
  const target = out || file + '.patched';
  const buf = Buffer.from(fs.readFileSync(file));

  // A patch found by radare2 carries a virtual address; convert it through the section table.
  let at = patch.at;
  if (patch.va) {
    const pe = parsePE(buf);
    at = vaToOffset(pe, patch.at);
    if (at === null) {
      return { schema: PATCH_SCHEMA, applied: false, error: 'virtual address is not backed by file bytes' };
    }
  }
  if (at < 0 || at + patch.to.length > buf.length) {
    return { schema: PATCH_SCHEMA, applied: false, error: 'offset outside the file' };
  }

  const before = Array.from(buf.subarray(at, at + patch.to.length));
  for (let i = 0; i < patch.to.length; i++) buf[at + i] = patch.to[i];
  fs.writeFileSync(target, buf);

  return {
    schema: PATCH_SCHEMA,
    applied: true,
    source: file,
    target,
    at: patch.va ? patch.at : at,
    fileOffset: at,
    before,
    after: patch.to,
    note: 'the original is untouched; ' + target + ' differs at file offset 0x' + at.toString(16),
  };
}

/**
 * Candidate verification sites: strings that look like a decision, and the code that references them.
 *
 * @param hint - words to look for in the strings, e.g. "licen" or "trial".
 */
export function findSites(file, { hint = 'licen,trial,expire,valid,activ,serial,regist', timeout = 300000 } = {}) {
  const bin = r2Bin();
  if (!bin) return { schema: PATCH_SCHEMA, available: false, sites: [], note: 'radare2 is not installed: pass --at with an address you already know' };
  const words = hint.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const r = runR2(['-q', '-e', 'scr.color=0', '-c', 'aaa; izzj', file], { timeout });
  const strings = parseJson(r.stdout, '[') || [];
  const hits = strings
    .filter((s) => {
      const v = String(s.string || '').toLowerCase();
      return v.length >= 4 && words.some((w) => v.includes(w));
    })
    .slice(0, 12);

  const sites = [];
  for (const s of hits) {
    const refs = runR2(['-q', '-e', 'scr.color=0', '-c', 'axtj @ ' + s.vaddr, file], { timeout: 120000 });
    for (const ref of parseJson(refs.stdout, '[') || []) {
      sites.push({
        string: String(s.string).slice(0, 80),
        stringAddr: s.vaddr,
        from: ref.from,
        function: ref.fcn_name || null,
        opcode: String(ref.opcode || '').slice(0, 80),
      });
    }
  }
  return {
    schema: PATCH_SCHEMA,
    available: true,
    searched: words,
    strings: hits.length,
    sites: sites.slice(0, 40),
    note: sites.length
      ? sites.length + ' reference(s) to ' + hits.length + ' decision-like string(s)'
      : 'no decision-like strings referenced: the check may compare numbers rather than text, or the binary is packed',
  };
}

/**
 * Disassemble around an address and describe the first conditional jump found there.
 * That jump is the smallest thing worth changing.
 */
export function suggestAt(file, addr, { count = 24, timeout = 240000 } = {}) {
  const bin = r2Bin();
  if (!bin) return { schema: PATCH_SCHEMA, available: false, options: [] };
  const base = Number(addr);
  // pdj reports `addr` (a virtual address), and pxj reads bytes at that address through the same
  // mapping — so the comparison happens on the right bytes without any offset arithmetic here.
  const r = runR2(['-q', '-e', 'scr.color=0', '-e', 'bin.relocs.apply=true', '-c', 'aaa; pdj ' + count + ' @ ' + addr, file], { timeout });
  const ops = parseJson(r.stdout, '[') || [];
  const dump = runR2(['-q', '-e', 'scr.color=0', '-c', 'pxj 160 @ ' + addr, file], { timeout: 120000 });
  const raw = Buffer.from(parseJson(dump.stdout, '[') || []);

  const options = [];
  for (const op of ops) {
    const va = typeof op.addr === 'number' ? op.addr : null;
    const size = typeof op.size === 'number' ? op.size : 0;
    if (va === null || size < 1) continue;
    const rel = va - base;
    if (rel < 0 || rel + size > raw.length) continue;
    const at = rel;
    for (const o of patchOptions(raw, at)) {
      options.push({ ...o, at: va, va: true, opcode: String(op.opcode || ''), why: o.why });
    }
    if (options.length >= 6) break;
  }

  return {
    schema: PATCH_SCHEMA,
    available: true,
    at: addr,
    disassembly: ops.slice(0, 12).map((o) => ({ addr: o.addr, opcode: o.opcode, type: o.type })),
    options: options.slice(0, 6),
    note: options.length
      ? 'each option flips or removes one branch; apply one and verify, do not stack them'
      : 'no conditional jump in the first ' + count + ' instructions',
  };
}

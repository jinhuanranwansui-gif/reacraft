// Target reader: identify a file and pull the structure that a rebuild has to honour.
//
// Static only. Nothing from the target is executed, and no network call is made.
// Containers (zip family, asar) are read from their own indexes; an encrypted or
// truncated container reports what it could not read instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './ledger.mjs';

const MAX_FULL_READ = 640 * 1024 * 1024;

export function readAll(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FULL_READ) return null;
  return fs.readFileSync(file);
}

function hex(n, width) {
  return '0x' + Number(n).toString(16).padStart(width, '0');
}

// Shannon entropy over a sample of the section: 8.0 is random, ~6.5 is compiled code, under 4
// is text or padding. A packed or encrypted section sits near 7.9+.
export function sectionEntropy(buf, { sample = 1 << 20 } = {}) {
  const n = Math.min(buf.length, sample);
  if (!n) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < n; i++) freq[buf[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return Number(h.toFixed(3));
}

function cstr(buf, off, max) {
  if (off < 0 || off >= buf.length) return '';
  let end = off;
  const limit = Math.min(buf.length, off + max);
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('latin1', off, end);
}

// ---------------------------------------------------------------- PE

function overlaySize(buf, sections) {
  let end = 0;
  for (const s of sections) end = Math.max(end, s.rawPtr + s.rawSize);
  return end > 0 && buf.length > end ? buf.length - end : 0;
}

export function parsePE(buf) {
  try {
    if (buf.readUInt16LE(0) !== 0x5a4d) return null;
    const eLfanew = buf.readUInt32LE(0x3c);
    if (buf.readUInt32BE(eLfanew) !== 0x50450000) return null;
    const coff = eLfanew + 4;
    const machine = buf.readUInt16LE(coff);
    const numSections = buf.readUInt16LE(coff + 2);
    const timeStamp = buf.readUInt32LE(coff + 4);
    const sizeOpt = buf.readUInt16LE(coff + 16);
    const opt = coff + 20;
    const magic = buf.readUInt16LE(opt);
    const pe32plus = magic === 0x20b;
    const entryPoint = buf.readUInt32LE(opt + 16);
    const imageBase = pe32plus ? Number(buf.readBigUInt64LE(opt + 24)) : buf.readUInt32LE(opt + 28);
    const subsystem = buf.readUInt16LE(opt + 68);
    const numDirsOff = pe32plus ? opt + 108 : opt + 92;
    const dirsOff = numDirsOff + 4;
    const numDirs = buf.readUInt32LE(numDirsOff);

    const dir = (i) => (i >= numDirs || dirsOff + i * 8 + 8 > buf.length)
      ? { rva: 0, size: 0 }
      : { rva: buf.readUInt32LE(dirsOff + i * 8), size: buf.readUInt32LE(dirsOff + i * 8 + 4) };

    const sections = [];
    const secOff = opt + sizeOpt;
    for (let i = 0; i < numSections; i++) {
      const o = secOff + i * 40;
      if (o + 40 > buf.length) break;
      const rawSize = buf.readUInt32LE(o + 16);
      const rawPtr = buf.readUInt32LE(o + 20);
      const characteristics = buf.readUInt32LE(o + 36);
      const body = buf.subarray(rawPtr, Math.min(rawPtr + rawSize, buf.length));
      sections.push({
        name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''),
        virtualSize: buf.readUInt32LE(o + 8),
        virtualAddress: buf.readUInt32LE(o + 12),
        rawSize,
        rawPtr,
        characteristics,
        // Enough to tell compiled code from a packed or encrypted body.
        entropy: sectionEntropy(body),
        executable: Boolean(characteristics & 0x20000000),
        writable: Boolean(characteristics & 0x80000000),
      });
    }

    const rvaToOff = (rva) => {
      for (const s of sections) {
        if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
          const d = rva - s.virtualAddress;
          if (s.rawPtr + d < buf.length) return s.rawPtr + d;
        }
      }
      return rva > 0 && rva < buf.length ? rva : -1;
    };

    const imports = [];
    const impDir = dir(1);
    if (impDir.rva) {
      let off = rvaToOff(impDir.rva);
      for (let i = 0; off > 0 && i < 512 && off + 20 <= buf.length; i++) {
        const nameRva = buf.readUInt32LE(off + 12);
        const firstThunk = buf.readUInt32LE(off + 16);
        const origThunk = buf.readUInt32LE(off);
        if (!nameRva && !firstThunk) break;
        const nOff = rvaToOff(nameRva);
        const dll = nOff > 0 ? cstr(buf, nOff, 128) : '';
        const funcs = [];
        const stride = pe32plus ? 8 : 4;
        let tOff = rvaToOff(origThunk || firstThunk);
        for (let k = 0; tOff > 0 && k < 4096 && tOff + stride <= buf.length; k++) {
          const val = pe32plus ? buf.readBigUInt64LE(tOff) : BigInt(buf.readUInt32LE(tOff));
          if (val === 0n) break;
          const ordinalBit = pe32plus ? (1n << 63n) : (1n << 31n);
          if ((val & ordinalBit) !== 0n) funcs.push({ ordinal: Number(val & 0xffffn) });
          else {
            const fOff = rvaToOff(Number(val & 0x7fffffffn));
            if (fOff > 0) funcs.push({ name: cstr(buf, fOff + 2, 128) });
          }
          tOff += stride;
        }
        imports.push({ dll, functions: funcs });
        off += 20;
      }
    }

    const exports = [];
    const expDir = dir(0);
    if (expDir.rva) {
      const eOff = rvaToOff(expDir.rva);
      if (eOff > 0 && eOff + 40 <= buf.length) {
        const numNames = buf.readUInt32LE(eOff + 24);
        const namesRva = buf.readUInt32LE(eOff + 32);
        const nBase = rvaToOff(namesRva);
        for (let i = 0; nBase > 0 && i < numNames && i < 2048; i++) {
          const s = rvaToOff(buf.readUInt32LE(nBase + i * 4));
          if (s > 0) exports.push(cstr(buf, s, 256));
        }
      }
    }

    // Delay-load imports are separate from the import directory and are easy to miss.
    const delay = [];
    const dlDir = dir(13);
    if (dlDir.rva) {
      let off = rvaToOff(dlDir.rva);
      for (let i = 0; off > 0 && i < 64 && off + 32 <= buf.length; i++) {
        const nameRva = buf.readUInt32LE(off + 4);
        const nOff = rvaToOff(nameRva);
        if (!nOff) break;
        delay.push(cstr(buf, nOff, 128));
        off += 32;
      }
    }

    const comDir = dir(14);
    return {
      machine: hex(machine, 4),
      arch: machine === 0x8664 ? 'x86_64' : machine === 0x14c ? 'x86' : machine === 0xaa64 ? 'arm64' : hex(machine, 4),
      isDotNet: (comDir.rva | comDir.size) !== 0,
      pe32plus,
      entryPoint: hex(entryPoint, 8),
      imageBase: '0x' + imageBase.toString(16),
      subsystem,
      builtAt: timeStamp ? new Date(timeStamp * 1000).toISOString() : null,
      sections,
      imports,
      exports,
      delayImports: delay,
      hasSignature: dir(4).size > 0,
      overlayBytes: overlaySize(buf, sections),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- ELF

const ELF_MACHINES = { 3: 'x86', 62: 'x86_64', 40: 'arm', 183: 'arm64', 8: 'mips', 243: 'riscv', 247: 'bpf' };
const ELF_TYPES = { 1: 'rel', 2: 'exec', 3: 'dyn', 4: 'core' };

export function parseELF(buf) {
  try {
    if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46) return null;
    const is64 = buf[4] === 2;
    const le = buf[5] === 1;
    const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const r64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
    const type = r16(16);
    const machine = r16(18);
    const shoff = is64 ? r64(0x28) : r32(0x20);
    const shentsize = r16(is64 ? 0x3a : 0x2e);
    const shnum = r16(is64 ? 0x3c : 0x30);
    const shstrndx = r16(is64 ? 0x3e : 0x32);

    const sections = [];
    if (shoff > 0 && shoff < buf.length && shentsize >= 40) {
      for (let i = 0; i < Math.min(shnum, 96); i++) {
        const o = shoff + i * shentsize;
        if (o + shentsize > buf.length) break;
        sections.push({
          nameOff: r32(o),
          type: r32(o + 4),
          offset: is64 ? r64(o + 24) : r32(o + 16),
          size: is64 ? r64(o + 32) : r32(o + 20),
          link: r32(o + (is64 ? 40 : 24)),
          entsize: is64 ? r64(o + 56) : r32(o + 36),
        });
      }
      // Resolve section names through the string table.
      const strSec = sections[shstrndx];
      if (strSec && strSec.offset < buf.length) {
        for (const s of sections) {
          s.name = cstr(buf, strSec.offset + s.nameOff, 64);
        }
      }
    }

    const byName = (n) => sections.find((s) => s.name === n);
    const dynsym = byName('.dynsym');
    const dynstr = byName('.dynstr');
    const symbols = [];
    const needed = [];
    if (dynsym && dynstr && dynsym.entsize) {
      const count = Math.min(Math.floor(dynsym.size / dynsym.entsize), 20000);
      for (let i = 0; i < count; i++) {
        const o = dynsym.offset + i * dynsym.entsize;
        const nameOff = r32(o);
        if (!nameOff) continue;
        const nm = cstr(buf, dynstr.offset + nameOff, 128);
        if (nm) symbols.push(nm);
      }
    }
    const dynamic = byName('.dynamic');
    if (dynamic && dynstr && dynamic.entsize) {
      const st = dynamic.entsize;
      const count = Math.min(Math.floor(dynamic.size / st), 2000);
      for (let i = 0; i < count; i++) {
        const o = dynamic.offset + i * st;
        const tag = is64 ? r64(o) : r32(o);
        const val = is64 ? r64(o + 8) : r32(o + 4);
        if (tag === 1) { const nm = cstr(buf, dynstr.offset + val, 128); if (nm) needed.push(nm); }
        if (tag === 0) break;
      }
    }
    const interp = byName('.interp');
    return {
      arch: ELF_MACHINES[machine] || hex(machine, 4),
      bits: is64 ? 64 : 32,
      endian: le ? 'little' : 'big',
      type: ELF_TYPES[type] || hex(type, 2),
      interpreter: interp ? cstr(buf, interp.offset, 128) : null,
      sections: sections.filter((s) => s.name).map((s) => ({ name: s.name, size: s.size })).slice(0, 48),
      symbols: [...new Set(symbols)].slice(0, 3000),
      needed: [...new Set(needed)],
      isPacked: sections.some((s) => /^UPX|packed|pydata/i.test(s.name || '')),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Mach-O

export function parseMachO(buf) {
  try {
    if (buf.length < 32) return null;
    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);
    let le = true;
    let is64 = true;
    let arch = null;
    if (magicLE === 0xfeedface) { le = true; is64 = false; }
    else if (magicLE === 0xfeedfacf) { le = true; is64 = true; }
    else if (magicBE === 0xfeedface) { le = false; is64 = false; }
    else if (magicBE === 0xfeedfacf) { le = false; is64 = true; }
    else if (magicLE === 0xcafebabe || magicBE === 0xcafebabe) {
      return { fat: true, arch: 'universal', slices: [] };
    } else return null;
    const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const cputype = r32(4);
    arch = cputype === 0x01000007 ? 'x86_64' : cputype === 0x0100000c ? 'arm64' : cputype === 7 ? 'x86' : cputype === 12 ? 'arm' : hex(cputype, 8);
    const ncmds = r32(16);
    const sizeofcmds = r32(20);
    const headerSize = is64 ? 32 : 28;
    const libs = [];
    const segments = [];
    let u = headerSize;
    for (let i = 0; i < Math.min(ncmds, 512) && u + 8 <= buf.length && u < headerSize + sizeofcmds; i++) {
      const cmd = r32(u);
      const size = r32(u + 4);
      if (size < 8 || u + size > buf.length) break;
      if (cmd === 0xc || cmd === 0x8000001f || cmd === 0x18) { // LOAD_DYLIB / LOAD_WEAK_DYLIB / LOAD_STR
        const off = r32(u + 8);
        const nm = cstr(buf, u + off, 128);
        if (nm) libs.push(nm);
      }
      if (cmd === 0x19 || cmd === 0x1) { // SEGMENT_64 / SEGMENT
        const name = cstr(buf, u + 8, 16).replace(/\0+$/, '');
        if (name) segments.push(name);
      }
      u += size;
    }
    return { arch, bits: is64 ? 64 : 32, endian: le ? 'little' : 'big', filetype: r32(12), libraries: libs, segments, fat: false };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- zip family

export function zipNames(buf) {
  const names = [];
  for (let i = 0; i + 46 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    if (i + 46 + nameLen > buf.length) break;
    names.push(buf.toString('utf8', i + 46, i + 46 + nameLen));
    i += 45 + nameLen + extraLen + commentLen;
    if (names.length > 20000) break;
  }
  return names;
}

// A dex keeps every class descriptor in its string table; a coarse scan recovers the
// names a rebuild has to provide without parsing the whole file format.
export function dexClassNames(buf, limit = 400) {
  const out = [];
  const re = /L[a-z][A-Za-z0-9_\/$]{2,120};/g;
  const text = buf.toString('latin1');
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const v = m[0];
    if (!/[A-Z]/.test(v)) continue;
    out.push(v);
  }
  return [...new Set(out)].slice(0, limit);
}

export function parseAsar(buf) {
  try {
    if (buf.length < 16 || buf.readUInt32LE(0) !== 4) return null;
    const headerSize = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    if (!jsonLen || jsonLen > 64 * 1024 * 1024 || 16 + jsonLen > buf.length) return null;
    const json = buf.toString('utf8', 16, 16 + jsonLen);
    if (!json.startsWith('{"files"')) return null;
    const tree = JSON.parse(json);
    const files = [];
    const walk = (node, prefix, depth) => {
      if (!node || depth > 12) return;
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? prefix + '/' + name : name;
        if (child && child.files) walk(child, p, depth + 1);
        else files.push({ path: p, size: typeof child.size === 'number' ? child.size : 0, offset: child.offset === undefined ? null : Number(child.offset) });
      }
    };
    walk(tree, '', 0);
    const byExt = {};
    for (const f of files) {
      const m = f.path.match(/\.([a-z0-9]+)$/i);
      const ext = m ? m[1].toLowerCase() : 'none';
      byExt[ext] = (byExt[ext] || 0) + 1;
    }
    const filesStart = 8 + headerSize;
    let manifest = null;
    const top = files.find((f) => f.path === 'package.json');
    if (top && top.offset !== null && filesStart + top.offset + top.size <= buf.length) {
      try {
        const pkg = JSON.parse(buf.toString('utf8', filesStart + top.offset, filesStart + top.offset + top.size));
        manifest = {
          name: pkg.name || null, version: pkg.version || null, main: pkg.main || null,
          productName: pkg.productName || null,
          dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
          scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
        };
      } catch { manifest = null; }
    }
    // An asar integrity block is the strongest single signal of an Electron app.
    let integrity = null;
    try {
      const root = JSON.parse(json);
      integrity = root.integrity ? Object.keys(root.integrity).length : null;
    } catch { integrity = null; }
    return {
      format: 'asar',
      manifest,
      integrityEntries: integrity,
      headerBytes: filesStart,
      fileCount: files.length,
      byExt,
      keyFiles: files.filter((f) => /(^|\/)(package\.json|main\.[cm]?js|preload\.[cm]?js|index\.[cm]?js|.*\.node|.*\.dll)$/i.test(f.path)).slice(0, 80),
      largest: files.slice().sort((a, b) => b.size - a.size).slice(0, 15),
      treeSample: files.slice(0, 100).map((f) => f.path),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- kind

export function detectKind(buf, file) {
  const ext = path.extname(file).toLowerCase();
  if (!buf) return { kind: 'large-file', ext };
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = parsePE(buf);
    if (pe && pe.isDotNet) return { kind: 'pe-dotnet', ext, pe };
    if (pe) return { kind: 'pe-native', ext, pe };
    return { kind: 'pe-unknown', ext };
  }
  const elf = parseELF(buf);
  if (elf) return { kind: 'elf', ext, elf };
  const macho = parseMachO(buf);
  if (macho) return { kind: 'macho', ext, macho };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x504b0304) {
    const names = zipNames(buf);
    if (names.includes('AndroidManifest.xml')) {
      const dex = buf.indexOf(Buffer.from('dex\n'));
      return { kind: 'apk', ext, zipEntries: names, dexClasses: dex >= 0 ? dexClassNames(buf.subarray(dex)) : [] };
    }
    if (names.some((n) => /^classes\d*\.dex$/.test(n))) return { kind: 'dex-archive', ext, zipEntries: names };
    if (names.some((n) => n.endsWith('.class'))) {
      return {
        kind: 'jar', ext, zipEntries: names,
        classes: names.filter((n) => n.endsWith('.class')).map((n) => n.replace(/\.class$/, '').replace(/\//g, '.')).slice(0, 400),
      };
    }
    return { kind: 'zip', ext, zipEntries: names };
  }
  const asar = parseAsar(buf);
  if (asar) return { kind: 'asar', ext, asar };
  if (ext === '.wasm' || (buf.length > 4 && buf.readUInt32LE(0) === 0x6d736100)) return { kind: 'wasm', ext };
  if (ext === '.pyc' || (buf.length > 4 && buf.readUInt16LE(0) === 0x0a0d)) return { kind: 'pyc', ext };
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8');
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { kind: 'javascript', ext, looksBundled: /webpack|__webpack_require__|browserify|rollup/i.test(head) };
  if (ext === '.json') return { kind: 'json-data', ext };
  if (ext === '.html' || ext === '.htm') return { kind: 'html', ext };
  if (/^#!.*\b(node|python|bash|sh|pwsh)\b/.test(head)) return { kind: 'script', ext };
  if (ext === '.dll' || ext === '.exe' || ext === '.sys') return { kind: 'unknown-binary', ext };
  return { kind: 'data', ext };
}

// ---------------------------------------------------------------- strings

export function extractStrings(buf, { min = 6, limit = 60000 } = {}) {
  const ascii = [];
  let cur = [];
  const push = () => { if (cur.length >= min) ascii.push(cur.join('')); cur = []; };
  for (let i = 0; i < buf.length && ascii.length < limit; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) cur.push(String.fromCharCode(b));
    else push();
  }
  push();

  // UTF-16LE runs may start on either byte phase. A run read across an ASCII neighbour
  // glues one stray character on the end (keychainH), so drop any wide string that is an
  // ASCII hit plus one or two trailing characters.
  const asciiSet = new Set(ascii);
  const wide = [];
  for (const phase of [0, 1]) {
    let run = [];
    const flush = () => {
      if (run.length >= min) {
        const s = run.join('');
        if (!asciiSet.has(s) && !asciiSet.has(s.slice(0, -1)) && !asciiSet.has(s.slice(0, -2))) wide.push(s);
      }
      run = [];
    };
    for (let i = phase; i + 1 < buf.length && wide.length < limit; i += 2) {
      const lo = buf[i];
      const hi = buf[i + 1];
      if (hi === 0 && (lo >= 0x20 && lo < 0x7f || lo >= 0xc0)) run.push(String.fromCharCode(lo));
      else flush();
    }
    flush();
  }
  return [...new Set(ascii.concat(wide))];
}

export function extractEndpoints(strings) {
  const seen = new Map();
  const urlRe = /\b(?:https?|wss?):\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?[^\s"'<>]*/gi;
  for (const s of strings) {
    const m = s.match(urlRe);
    if (!m) continue;
    for (const u of m) {
      // Wide-string runs glue neighbouring literals together: stop at a second scheme and
      // at the punctuation that usually closes a URL in prose.
      let clean = u;
      const second = clean.toLowerCase().indexOf('http', 4);
      if (second > 0) clean = clean.slice(0, second);
      const cut = clean.search(/[)"'<>\s，。）】]/);
      if (cut > 0) clean = clean.slice(0, cut);
      clean = clean.replace(/[.,;:]+$/, '');
      // A URL built by a template is not an endpoint: `https://nodejs.org/docs/v${version}/api`
      // would be required verbatim from a rebuild that can never contain it. The literal stays
      // in the strings profile as evidence; it just does not become a requirement.
      if (/\$\{|\{\{|%[sdv](?![a-z])|#\{|`/.test(clean)) continue;
      const host = (clean.match(/^[a-z]+:\/\/([^/:]+)/i) || [])[1] || '';
      if (host.length < 4 || host.length > 120) continue;
      if (!/^[a-z0-9.-]+$/i.test(host)) continue;
      if (!seen.has(clean)) seen.set(clean, clean);
    }
  }
  return [...seen.keys()].slice(0, 80);
}

// ---------------------------------------------------------------- top level

const TEXT_KINDS = new Set(['javascript', 'html', 'json-data', 'script', 'data']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.json', '.txt', '.md', '.py', '.rb', '.php', '.java', '.kt', '.cs', '.go', '.rs', '.c', '.h', '.cpp', '.sh', '.ps1']);

export function readTarget(file, { name = null } = {}) {
  const st = fs.statSync(file);
  const buf = readAll(file);
  const det = detectKind(buf, file);
  // A text copy is only kept for the shield assessment, and only when the file really is
  // text: a 100 MiB binary is never turned into a string.
  const asText = buf && st.size <= 4 * 1024 * 1024
    && (TEXT_KINDS.has(det.kind) || TEXT_EXT.has(path.extname(file).toLowerCase()))
    ? buf.toString('utf8')
    : null;
  return {
    target: path.resolve(file),
    name: name || path.basename(file).replace(/[^\w.-]+/g, '_'),
    size: st.size,
    sha256: sha256File(file),
    kind: det.kind,
    ext: det.ext,
    pe: det.pe || null,
    elf: det.elf || null,
    macho: det.macho || null,
    asar: det.asar || null,
    zipEntries: det.zipEntries ? det.zipEntries.slice(0, 200) : null,
    classes: det.classes || null,
    dexClasses: det.dexClasses || null,
    looksBundled: det.looksBundled || false,
    text: asText,
    strings: buf ? extractStrings(buf) : [],
  };
}

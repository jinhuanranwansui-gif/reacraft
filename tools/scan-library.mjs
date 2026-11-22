// Scan a Steam library and report, per executable, whether a commercial wrapper is present and
// whether the code section is readable. Static, sampled, nothing executed.
//
// This is the question the tool exists to answer for a real machine: of the games installed here,
// which ones ship their program readable and which are walled.
import fs from 'node:fs';
import path from 'node:path';

const LIB = process.argv[2] || 'D:\\dd\\steamapps\\common';
const MAX_READ = 1 << 20; // 1 MiB per section is plenty for an entropy estimate

function entropyAt(fd, offset, length) {
  const n = Math.min(length, MAX_READ);
  if (n <= 0) return 0;
  const buf = Buffer.allocUnsafe(n);
  fs.readSync(fd, buf, 0, n, offset);
  const freq = new Uint32Array(256);
  for (let i = 0; i < n; i++) freq[buf[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return Number(h.toFixed(2));
}

function inspect(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 64 * 1024) return null;
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, Math.min(4096, size), 0);
    if (head.readUInt16LE(0) !== 0x5a4d) return null;
    const peOff = head.readUInt32LE(0x3c);
    if (peOff + 24 > head.length || head.readUInt32BE(peOff) !== 0x50450000) return null;
    const machine = head.readUInt16LE(peOff + 4);
    const numSections = head.readUInt16LE(peOff + 6);
    const sizeOpt = head.readUInt16LE(peOff + 20);
    const opt = peOff + 24;
    const magic = head.readUInt16LE(opt);
    const pe32plus = magic === 0x20b;
    const entry = head.readUInt32LE(opt + 16);
    const secTable = opt + sizeOpt;
    const sections = [];
    for (let i = 0; i < numSections && secTable + i * 40 + 40 <= head.length; i++) {
      const o = secTable + i * 40;
      const name = head.toString('latin1', o, o + 8).replace(/\0+$/, '');
      const vsize = head.readUInt32LE(o + 8);
      const vaddr = head.readUInt32LE(o + 12);
      const rawSize = head.readUInt32LE(o + 16);
      const rawPtr = head.readUInt32LE(o + 20);
      sections.push({ name, vsize, vaddr, rawSize, rawPtr, entropy: entropyAt(fd, rawPtr, rawSize) });
    }
    const text = sections.find((s) => /^\.text$/i.test(s.name));
    const entrySec = sections.find((s) => entry >= s.vaddr && entry < s.vaddr + Math.max(s.vsize, s.rawSize));
    const wrapper = sections.find((s) => /^\.(bind|steam|vmp\d?|themida|enigma\d?|winlice)$/i.test(s.name) || /^UPX\d?$/i.test(s.name));
    return {
      size,
      arch: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : '?' + machine.toString(16),
      bits: pe32plus ? 64 : 32,
      entry: '0x' + entry.toString(16),
      textH: text ? text.entropy : null,
      wrapper: wrapper ? wrapper.name : null,
      wrapperH: wrapper ? wrapper.entropy : null,
      entryIn: entrySec ? entrySec.name : '?',
      // A walled build: wrapper present AND the code section is not compiled code.
      walled: Boolean(wrapper && text && text.entropy >= 7.2),
      readable: Boolean(text && text.entropy < 7.2),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > 600) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.exe$/i.test(e.name)) out.push(p);
  }
  return out;
}

const games = fs.readdirSync(LIB, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const rows = [];
for (const game of games) {
  const root = path.join(LIB, game);
  const exes = walk(root).filter((f) => {
    // Skip installers and crash reporters: they are not the program under protection.
    const n = path.basename(f).toLowerCase();
    return !/unins|setup|vcredist|dxsetup|crashhandler|crashreport|report|helper/.test(n);
  });
  for (const f of exes) {
    const r = inspect(f);
    if (!r || r.size < 512 * 1024) continue;
    // Keep the biggest few per game: those are the programs.
    rows.push({ game, exe: path.relative(root, f), ...r });
  }
}

// Up to three executables per game, so the program under protection is not hidden behind a
// bigger utility (Isaac ships a 9.9 MB ModUploader beside its 9.1 MB game).
const perGame = new Map();
for (const r of rows) {
  if (!perGame.has(r.game)) perGame.set(r.game, []);
  perGame.get(r.game).push(r);
}
const list = [];
for (const [, rs] of perGame) {
  rs.sort((a, b) => b.size - a.size);
  list.push(...rs.slice(0, 3));
}
list.sort((a, b) => Number(b.walled) - Number(a.walled) || Number(Boolean(b.wrapper)) - Number(Boolean(a.wrapper)) || b.size - a.size);

const walled = list.filter((r) => r.walled).length;
const wrappers = list.filter((r) => r.wrapper).length;

console.log('game | exe | arch | MB | .text H | wrapper | entry in | verdict');
console.log('---|---|---|---|---|---|---|---');
for (const r of list) {
  const verdict = r.walled ? 'CODE WALLED' : r.wrapper ? 'wrapper, code readable' : 'plain';
  console.log([
    r.game,
    '`' + r.exe + '`',
    r.arch,
    (r.size / 1048576).toFixed(1),
    r.textH ?? '-',
    r.wrapper ? '`' + r.wrapper + '` H=' + r.wrapperH : '—',
    r.entryIn,
    verdict,
  ].join(' | '));
}
console.log('');
console.log(list.length + ' executables inspected · ' + wrappers + ' carry a wrapper · ' + walled + ' have the code section encrypted');

// Dump the first bytes of each PE section, plus a byte histogram summary, to see whether a
// high-entropy section is ciphertext, a compressed stream, or something structural.
import fs from 'node:fs';

const file = process.argv[2];
const fd = fs.openSync(file, 'r');
const st = fs.fstatSync(fd);
const head = Buffer.alloc(4096);
fs.readSync(fd, head, 0, Math.min(4096, st.size), 0);

const peOff = head.readUInt32LE(0x3c);
const numSections = head.readUInt16LE(peOff + 6);
const sizeOpt = head.readUInt16LE(peOff + 20);
const opt = peOff + 24;
const entry = head.readUInt32LE(opt + 16);
const secTable = opt + sizeOpt;

console.log('file   ' + file);
console.log('size   ' + st.size + ' bytes');
console.log('entry  0x' + entry.toString(16));
console.log('');

for (let i = 0; i < numSections; i++) {
  const o = secTable + i * 40;
  const name = head.toString('latin1', o, o + 8).replace(/\0+$/, '');
  const vsize = head.readUInt32LE(o + 8);
  const rawSize = head.readUInt32LE(o + 16);
  const rawPtr = head.readUInt32LE(o + 20);
  if (!rawSize || rawPtr >= st.size) {
    console.log(name.padEnd(9) + ' (no raw data)');
    continue;
  }
  const n = Math.min(64, rawSize, st.size - rawPtr);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, rawPtr);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...buf].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  console.log(name.padEnd(9) + ' @0x' + rawPtr.toString(16).padStart(8, '0') + ' size=' + String(vsize).padStart(9));
  console.log('  ' + hex.slice(0, 140));
  console.log('  ' + ascii);
}

// Tail of the file: an overlay or a trailing structure can explain a wrapper.
const tailLen = Math.min(256, st.size);
const tail = Buffer.alloc(tailLen);
fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
console.log('');
console.log('tail @0x' + (st.size - tailLen).toString(16));
console.log('  ' + [...tail.slice(tailLen - 64)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('  ' + [...tail.slice(tailLen - 64)].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join(''));

fs.closeSync(fd);

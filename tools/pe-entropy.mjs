// Measure per-section entropy on a PE, to see whether a section is stored encrypted.
// Pure statistics: reads bytes, counts frequencies, nothing is executed.
import fs from 'node:fs';
import crypto from 'node:crypto';

function entropy(buf) {
  if (!buf.length) return 0;
  const freq = new Array(256).fill(0);
  for (const b of buf) freq[b]++;
  let h = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function sections(file) {
  const buf = fs.readFileSync(file);
  const eLfanew = buf.readUInt32LE(0x3c);
  const coff = eLfanew + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const sizeOpt = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const entryPoint = buf.readUInt32LE(opt + 16);
  const secOff = opt + sizeOpt;
  const out = [];
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    const name = buf.toString('latin1', o, o + 8).replace(/\0+$/, '');
    const vsize = buf.readUInt32LE(o + 8);
    const rawSize = buf.readUInt32LE(o + 16);
    const rawPtr = buf.readUInt32LE(o + 20);
    const chars = buf.readUInt32LE(o + 36);
    const bytes = buf.subarray(rawPtr, Math.min(rawPtr + rawSize, buf.length));
    out.push({
      name,
      rawSize,
      voidSize: rawSize - vsize > 0 ? 0 : 0,
      entropy: Number(entropy(bytes).toFixed(3)),
      zeroShare: Number((bytes.filter((b) => b === 0).length / Math.max(1, bytes.length)).toFixed(3)),
      writable: Boolean(chars & 0x80000000),
      executable: Boolean(chars & 0x20000000),
      sha8: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8),
    });
  }
  return { file, pe32plus, entryPoint: '0x' + entryPoint.toString(16).padStart(8, '0'), sections: out };
}

for (const f of process.argv.slice(2)) {
  const r = sections(f);
  console.log('\n' + r.file);
  console.log('  entry ' + r.entryPoint + (r.pe32plus ? '  (PE32+)' : '  (PE32)'));
  for (const s of r.sections) {
    console.log(
      '  ' + s.name.padEnd(9) +
      String(s.rawSize).padStart(9) +
      '  H=' + String(s.entropy).padStart(5) +
      '  zero=' + String(s.zeroShare).padStart(4) +
      (s.executable ? '  X' : '   ') +
      (s.writable ? ' W' : '  ') +
      '  ' + s.sha8
    );
  }
}

// Binary formats that are recognised but not parsed: the kind is still useful, because it changes
// which recipe applies. Returning a kind here is not a claim that the contents were read.
export default {
  id: 'binary-headers',
  title: 'WASM / PYC / unknown binary',
  probe(buf, { ext }) {
    if (ext === '.wasm' || (buf.length > 4 && buf.readUInt32LE(0) === 0x6d736100)) return { kind: 'wasm', ext };
    if (ext === '.pyc' || (buf.length > 4 && buf.readUInt16LE(0) === 0x0a0d)) return { kind: 'pyc', ext };
    if (ext === '.dll' || ext === '.exe' || ext === '.sys') return { kind: 'unknown-binary', ext };
    return null;
  },
};

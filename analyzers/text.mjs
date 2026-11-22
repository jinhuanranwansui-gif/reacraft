// The text floor: everything that is not a container. It is last in the registry because it matches
// almost anything with printable bytes.
export default {
  id: 'text',
  title: 'Text and scripts',
  probe(buf, { ext }) {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8');
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      return { kind: 'javascript', ext, looksBundled: /webpack|__webpack_require__|browserify|rollup/i.test(head) };
    }
    if (ext === '.json') return { kind: 'json-data', ext };
    if (ext === '.html' || ext === '.htm') return { kind: 'html', ext };
    if (/^#!.*\b(node|python|bash|sh|pwsh)\b/.test(head)) return { kind: 'script', ext };
    // A file with a high share of printable bytes is text even without a telling extension.
    const sample = buf.subarray(0, Math.min(buf.length, 2048));
    let printable = 0;
    for (const b of sample) {
      if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
    }
    if (sample.length && printable / sample.length > 0.9) return { kind: 'text', ext };
    return { kind: 'data', ext };
  },
};

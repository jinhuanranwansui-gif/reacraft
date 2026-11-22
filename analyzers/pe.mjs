// One analyzer per container format. Each returns a probe result or null; the registry tries them in
// order and the first non-null wins. Adding a format is adding a file here — nothing else changes.
//
// A probe may import the parsers from ../src/core/target.mjs. That import looks circular (target.mjs
// imports this registry), and it is: the parsers are function declarations, so they are hoisted and
// available by the time a probe actually runs. Nothing here executes at module load.
import { parsePE } from '../src/core/target.mjs';

export default {
  id: 'pe',
  title: 'Windows PE',
  probe(buf, { ext }) {
    if (buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
    const pe = parsePE(buf);
    if (pe && pe.isDotNet) return { kind: 'pe-dotnet', ext, pe };
    if (pe) return { kind: 'pe-native', ext, pe };
    return { kind: 'pe-unknown', ext };
  },
};

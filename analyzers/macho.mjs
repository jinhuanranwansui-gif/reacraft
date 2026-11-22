import { parseMachO } from '../src/core/target.mjs';

export default {
  id: 'macho',
  title: 'Mach-O',
  probe(buf, { ext }) {
    const macho = parseMachO(buf);
    return macho ? { kind: 'macho', ext, macho } : null;
  },
};

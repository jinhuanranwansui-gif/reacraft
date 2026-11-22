import { parseELF } from '../src/core/target.mjs';

export default {
  id: 'elf',
  title: 'ELF',
  probe(buf, { ext }) {
    const elf = parseELF(buf);
    return elf ? { kind: 'elf', ext, elf } : null;
  },
};

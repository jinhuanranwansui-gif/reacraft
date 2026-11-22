import { parseAsar } from '../src/core/target.mjs';

export default {
  id: 'asar',
  title: 'Electron asar',
  probe(buf, { ext }) {
    const asar = parseAsar(buf);
    return asar ? { kind: 'asar', ext, asar } : null;
  },
};

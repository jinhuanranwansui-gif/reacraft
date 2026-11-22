// ZIP-based containers, split by what is inside rather than by extension: an .apk, a .jar and a
// plain .zip all start with the same four bytes.
import { zipNames, dexClassNames } from '../src/core/target.mjs';

export default {
  id: 'zip',
  title: 'ZIP / APK / JAR',
  probe(buf, { ext }) {
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x504b0304) return null;
    const names = zipNames(buf);

    if (names.includes('AndroidManifest.xml')) {
      const dex = buf.indexOf(Buffer.from('dex\n'));
      return {
        kind: 'apk',
        ext,
        zipEntries: names,
        dexClasses: dex >= 0 ? dexClassNames(buf.subarray(dex)) : [],
      };
    }
    if (names.some((n) => /^classes\d*\.dex$/.test(n))) return { kind: 'dex-archive', ext, zipEntries: names };
    if (names.some((n) => n.endsWith('.class'))) {
      return {
        kind: 'jar',
        ext,
        zipEntries: names,
        classes: names
          .filter((n) => n.endsWith('.class'))
          .map((n) => n.replace(/\.class$/, '').replace(/\//g, '.'))
          .slice(0, 400),
      };
    }
    return { kind: 'zip', ext, zipEntries: names };
  },
};

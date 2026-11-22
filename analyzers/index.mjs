// The analyzer registry. Order matters: the first probe that returns a value wins, so specific
// containers come before the text floor.
//
// Adding a format = adding a file to this list. `reacraft map` reads this list, so a new analyzer
// shows up in the coverage table without anything else being edited.
import pe from './pe.mjs';
import elf from './elf.mjs';
import macho from './macho.mjs';
import zip from './zip.mjs';
import asar from './asar.mjs';
import binaryHeaders from './binary-headers.mjs';
import text from './text.mjs';

export const ANALYZERS = [pe, elf, macho, zip, asar, binaryHeaders, text];

/**
 * @param buf - the first bytes of the target (null when the file was too large to read whole).
 * @param file - the path, used for the extension.
 * @returns { kind, ext, analyzer, ... } — the shape every downstream stage already expects.
 */
export function detect(buf, file, { ext: forcedExt } = {}) {
  const ext = forcedExt !== undefined ? forcedExt : (file || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  if (!buf) return { kind: 'large-file', ext, analyzer: 'none' };
  for (const a of ANALYZERS) {
    const r = a.probe(buf, { ext, file });
    if (r) return { ...r, analyzer: a.id };
  }
  return { kind: 'data', ext, analyzer: 'none' };
}

export function listAnalyzers() {
  return ANALYZERS.map((a) => ({ id: a.id, title: a.title }));
}

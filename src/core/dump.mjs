// Dumping a running image — the first half of unpacking.
//
// A packer decrypts its code in memory and never writes it back to disk, which is why a static reader
// sees entropy 8.0. The way out is not to break the cipher: it is to wait until the program has
// already done it, then take a copy of the process's own memory.
//
// This does exactly that, and stops there. What it produces is a **dump**, not a runnable image:
// the import table inside a live process points at resolved addresses, not at the names on disk, so a
// dump needs its IAT rebuilt before a disassembler can follow calls into imported functions.
// Saying that here matters — a dump that looks like a PE and is not one is the classic wasted
// afternoon.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from './engines.mjs';

export const DUMP_SCHEMA = 'reacraft.dump/1';
export const MAX_DUMP = 512 * 1024 * 1024;

export function fridaBin() {
  return process.env.REACRAFT_FRIDA_BIN || which('frida') || which('frida.cmd') || null;
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Dump the first module (the executable itself) after `afterMs`, from inside the process.
const SCRIPT = (outFile, afterMs, maxBytes) => `
const OUT = ${JSON.stringify(outFile)};
const AFTER = ${afterMs};
const MAX = ${maxBytes};
function emit(o) { try { const f = new File(OUT + '.json', 'a'); f.write(JSON.stringify(o) + '\\n'); f.flush(); f.close(); } catch (e) {} }
emit({ phase: 'loaded', runtime: Frida.version });
setTimeout(function () {
  try {
    const mods = Process.enumerateModules();
    const main = mods[0];
    if (!main) { emit({ phase: 'error', error: 'no modules' }); return; }
    const size = Math.min(main.size, MAX);
    // frida 17 dropped Memory.readByteArray; the pointer method is the one that survived.
    const data = main.base.readByteArray(size);
    const f = new File(OUT, 'wb');
    f.write(data);
    f.close();
    emit({ phase: 'dumped', name: main.name, base: String(main.base), size: size, declared: main.size, path: main.path });
  } catch (e) {
    emit({ phase: 'error', error: String(e) });
  }
}, AFTER);
`;

/**
 * Run the target for a moment, then copy its main module out of memory.
 *
 * @param target - executable to run.
 * @param afterMs - how long to let it unpack before taking the copy.
 * @param outFile - where the raw image goes.
 */
export function dumpImage(target, { afterMs = 4000, outFile = null, args = [], startupMs = 1500 } = {}) {
  const bin = fridaBin();
  if (!bin) return { schema: DUMP_SCHEMA, available: false, error: 'frida is not installed' };
  if (!fs.existsSync(target)) return { schema: DUMP_SCHEMA, available: true, error: 'no such file: ' + target };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reacraft-dump-'));
  const raw = outFile || path.join(tmp, 'image.bin');
  const log = raw + '.json';
  const script = path.join(tmp, 'dump.js');
  // The log is appended to from inside the target; a leftover from an earlier run would report an
  // error that this run never had.
  try { fs.rmSync(log, { force: true }); } catch { /* first run */ }
  fs.writeFileSync(script, SCRIPT(raw.replace(/\\/g, '/'), afterMs, MAX_DUMP), 'utf8');

  let child = null;
  let attach = null;
  try {
    child = spawn(target, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    sleepSync(startupMs);
    if (!child.pid) throw new Error('target did not start');
    if (!isAlive(child.pid)) throw new Error('target exited before frida could attach; the dump would be empty');

    attach = spawnSync(bin, ['-p', String(child.pid), '-l', script, '-q', '--runtime=v8', '--eternalize'], {
      timeout: 30000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    // Give the injected script time to reach its own timer, plus a margin for a large write.
    sleepSync(afterMs + 4000);
  } catch (e) {
    return { schema: DUMP_SCHEMA, available: true, error: String(e && e.message ? e.message : e) };
  } finally {
    if (child && child.pid) { try { process.kill(child.pid); } catch { /* gone */ } }
  }

  let events = [];
  if (fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* torn line */ }
    }
  }
  const dumped = events.find((e) => e.phase === 'dumped');
  const errorEvent = events.find((e) => e.phase === 'error');
  const exists = fs.existsSync(raw);

  return {
    schema: DUMP_SCHEMA,
    available: true,
    target,
    ok: Boolean(dumped && exists),
    file: exists ? raw : null,
    bytes: exists ? fs.statSync(raw).size : 0,
    base: dumped ? dumped.base : null,
    declaredSize: dumped ? dumped.declared : null,
    error: errorEvent ? errorEvent.error : null,
    // The single most important sentence this module can print.
    note: dumped && exists
      ? 'this is a memory image, not a runnable binary: the IAT points at resolved addresses, so rebuild it before disassembly'
      : 'no dump produced',
    stderr: (attach && attach.stderr ? String(attach.stderr) : '').slice(0, 800),
  };
}

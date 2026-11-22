// Dynamic observation, through frida when it is installed.
//
// This is the fourth rung (identify → read facts → read logic → RUN → construct). Static reading says
// what a program *can* do; only a run says what it *does*.
//
// Three decisions worth naming, all of them learned by things not working:
//
// 1. **Attach, do not spawn.** `frida -f` resumed the target and then stopped executing the agent's
//    timers — the script's synchronous prologue ran, its heartbeat never did. `-p <pid>` plus
//    `--eternalize` keeps the agent alive after the CLI exits, which is exactly what is wanted: the
//    CLI comes back, the target keeps running, the findings keep landing in a file.
// 2. **Write JSONL from inside the target**, not send(). Parsing frida's console output means parsing
//    Python repr with single quotes and escapes; a file has no such problem and survives the kill.
// 3. **frida 17 removed Module.findExportByName**, so the injected script tries the new API first and
//    falls back to the old one, then to the module handle. A hook script that works on exactly one
//    frida version is a hook script that breaks silently.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from './engines.mjs';

export const DYNAMIC_SCHEMA = 'reacraft.dynamic/1';

export function fridaBin() {
  return process.env.REACRAFT_FRIDA_BIN || which('frida') || which('frida.cmd') || null;
}

export function fridaAvailable() {
  return Boolean(fridaBin());
}

// Node has no synchronous sleep, and this function is synchronous by contract (the CLI is).
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// detached + unref means Node stops tracking the child's exit, so liveness is asked of the OS.
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const SCRIPT = (apis, outFile) => `
const OUT = ${JSON.stringify(outFile)};
function emit(o) {
  try { const f = new File(OUT, 'a'); f.write(JSON.stringify(o) + '\\n'); f.flush(); f.close(); } catch (e) {}
}
function findExport(modName, name) {
  try { if (typeof Module.getGlobalExportByName === 'function') { const p = Module.getGlobalExportByName(name); if (p) return p; } } catch (e) {}
  try { if (typeof Module.findExportByName === 'function') { const p = Module.findExportByName(modName, name); if (p) return p; } } catch (e) {}
  try { return Process.getModuleByName(modName).getExportByName(name); } catch (e) { return null; }
}
function readArg(a) {
  let t = '';
  try { t = a.readUtf16String() || ''; } catch (e) {}
  if (!t) { try { t = a.readCString() || ''; } catch (e) {} }
  return String(t).slice(0, 300);
}
emit({ phase: 'loaded', runtime: Frida.version });
${JSON.stringify(apis)}.forEach(function (name) {
  let p = null;
  try { p = findExport('kernel32.dll', name) || findExport('advapi32.dll', name) || findExport('ws2_32.dll', name); } catch (e) {}
  if (!p) { emit({ phase: 'missing', name: name }); return; }
  try {
    Interceptor.attach(p, {
      onEnter(args) {
        try { emit({ api: name, arg0: readArg(args[0]) }); } catch (e) { emit({ api: name, error: String(e) }); }
      },
    });
    emit({ phase: 'hooked', name: name });
  } catch (e) {
    emit({ phase: 'hookError', name: name, error: String(e) });
  }
});
`;

/**
 * Start the target, hook the named imports for a few seconds, then stop it.
 *
 * @param target - absolute path to an executable.
 * @param apis - import names to hook.
 * @param seconds - observation window after the hooks are installed.
 * @param args - arguments for the target (this is how a CLI gets a program to do something).
 */
export function runHook(target, { apis = ['CreateFileW', 'RegOpenKeyExW'], seconds = 8, args = [], startupMs = 1800 } = {}) {
  const bin = fridaBin();
  if (!bin) {
    return { schema: DYNAMIC_SCHEMA, available: false, events: [], hooked: [], missing: [], note: 'frida is not installed; static reading only' };
  }
  if (!fs.existsSync(target)) {
    return { schema: DYNAMIC_SCHEMA, available: true, events: [], hooked: [], missing: [], error: 'no such file: ' + target };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reacraft-hook-'));
  const out = path.join(tmp, 'events.jsonl');
  const script = path.join(tmp, 'hook.js');
  fs.writeFileSync(script, SCRIPT(apis, out.replace(/\\/g, '/')), 'utf8');

  let child = null;
  let attach = null;
  try {
    child = spawn(target, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    sleepSync(startupMs);
    if (!child.pid) throw new Error('target did not start');
    // A program that finished within the startup window cannot be attached to. Saying so beats
    // returning "0 calls", which reads like "it did nothing".
    if (!isAlive(child.pid)) {
      throw new Error('target exited before frida could attach; run something that stays alive (a GUI app, a server, or a loop)');
    }

    attach = spawnSync(
      bin,
      ['-p', String(child.pid), '-l', script, '-q', '--runtime=v8', '--eternalize'],
      { timeout: 30000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    sleepSync(Math.max(0, seconds) * 1000);
  } catch (e) {
    return {
      schema: DYNAMIC_SCHEMA, available: true, events: [], hooked: [], missing: [],
      error: String(e && e.message ? e.message : e),
    };
  } finally {
    if (child && child.pid) {
      try { process.kill(child.pid); } catch { /* already gone */ }
    }
  }

  const events = [];
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch { /* a torn last line after the kill */ }
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

  const hooked = events.filter((e) => e.phase === 'hooked').map((e) => e.name);
  const missing = events.filter((e) => e.phase === 'missing').map((e) => e.name);
  const calls = events.filter((e) => e.api);
  const runtimeSeen = (events.find((e) => e.phase === 'loaded') || {}).runtime || null;

  return {
    schema: DYNAMIC_SCHEMA,
    available: true,
    target,
    args,
    seconds,
    fridaRuntime: runtimeSeen,
    hooked,
    missing,
    events: calls.slice(0, 500),
    count: calls.length,
    // A run with no calls is a fact too, and saying which of the two reasons it might be is more
    // useful than an empty list.
    note: calls.length
      ? calls.length + ' call(s) across ' + hooked.length + ' hook(s) in ' + seconds + 's'
      : 'no calls captured: the program may not use these imports in the first ' + seconds + 's, or it noticed the instrumentation',
    stderr: (attach && attach.stderr ? String(attach.stderr) : '').slice(0, 1200),
  };
}

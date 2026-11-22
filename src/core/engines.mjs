// Engine discovery. Nothing here is assumed present: each probe answers found/version or
// says why not. The pipeline runs without any of these; engines add depth, not existence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

// Engines are usually installed on a data drive, so the candidate list covers the usual
// roots instead of assuming the system drive. A missing directory costs one failed stat.
const ROOTS = process.platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\', 'F:\\'] : ['/opt', '/usr/local', '/usr'];
const REA_DIRS = ROOTS.map((r) => path.join(r, 'tools', 'rea'));
const R2_DIRS = [path.join(HOME, 'tools', 'radare2', 'radare2-6.2.6-w64', 'bin'), ...ROOTS.map((r) => path.join(r, 'tools', 'radare2', 'bin'))];
const ILSPY_DIRS = [path.join(HOME, '.dsh', 'tools', 'ilspycmd', 'win-x64', 'tools', 'any', 'win-x64')];

// Per-engine search list. First hit wins; later entries are the layouts this machine and
// the portable installers actually use.
export const ENGINE_SPECS = [
  { id: 'node', role: 'runs this tool', names: ['node'], args: ['--version'] },
  { id: 'radare2', role: 'optional disassembly metadata', names: ['radare2', 'r2'], args: ['-v'], extra: R2_DIRS },
  { id: 'rizin', role: 'optional read-only disassembly with a command allow-list', names: ['rizin'], args: ['-v'] },
  { id: 'ilspycmd', role: '.NET type and IL listing', names: ['ilspycmd'], args: ['--version'], extra: ILSPY_DIRS },
  { id: 'frida', role: 'optional run-time instrumentation', names: ['frida'], args: ['--version'] },
  { id: 'python', role: 'optional scripting for adapters', names: ['python', 'python3'], args: ['--version'] },
  { id: 'git', role: 'versioning the analysis project', names: ['git'], args: ['--version'] },
  { id: 'rea', role: 'REA agent CLI: deep native/managed read', names: ['rea'], args: ['--version'], extra: REA_DIRS },
  { id: 'craft-anything', role: 'craft-anything CLI: rebuild and self-check', names: ['craft-anything-cli'], args: ['--version'], extra: [path.join(HOME, 'Desktop', 'craft-anything', 'craft-anything-0.6.1-windows-x64-portable')] },
];

const EXT = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

export function which(name, extraDirs = []) {
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...extraDirs.map((d) => path.resolve(d)),
  ];
  for (const dir of dirs) {
    for (const ext of EXT) {
      const p = path.join(dir, name + ext);
      try {
        if (!fs.existsSync(p)) continue;
        if (!fs.statSync(p).isFile()) continue;
        return p;
      } catch { /* an unreadable PATH entry is not a failure */ }
    }
  }
  return null;
}

// One probe per engine. A version string is enough: the pipeline only needs to know
// whether a deeper stage can run.
export function probeOne(spec) {
  let exe = null;
  for (const n of spec.names) {
    exe = which(n, spec.extra || []);
    if (exe) break;
  }
  if (!exe) return { id: spec.id, found: false, role: spec.role, hint: (spec.extra && spec.extra[0]) || spec.names[0] };
  let version = '';
  try {
    const r = spawnSync(exe, spec.args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    version = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0].slice(0, 120);
    // Some CLIs answer --help but not --version; the first line still names the version.
    if (!version) {
      const h = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      version = ((h.stdout || '') + (h.stderr || '')).trim().split(/\r?\n/)[0].slice(0, 120);
    }
  } catch (e) {
    version = 'found, version probe failed: ' + (e && e.message ? e.message : e);
  }
  return { id: spec.id, found: true, path: exe, version, role: spec.role };
}

export function probeEngines() {
  return ENGINE_SPECS.map(probeOne);
}

// The two engines this tool is named after get a deeper report: whether the CLI answers
// on the subcommands the pipeline actually calls.
export function probePartners({ reaPath = null, craftPath = null } = {}) {
  const out = { rea: null, craft: null };
  const rea = reaPath || (probeOne(ENGINE_SPECS.find((s) => s.id === 'rea')) || {}).path;
  if (rea) {
    const r = spawnSync(rea, ['capabilities'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const text = (r.stdout || '') + (r.stderr || '');
    out.rea = { ok: r.status === 0, path: rea, lines: text.trim().split(/\r?\n/).length, head: text.trim().split(/\r?\n/).slice(0, 6) };
  }
  const craft = craftPath || (probeOne(ENGINE_SPECS.find((s) => s.id === 'craft-anything')) || {}).path;
  if (craft) {
    const r = spawnSync(craft, ['capabilities', '--format', 'json'], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    let tools = null;
    let mode = null;
    try {
      const j = JSON.parse(r.stdout);
      const body = j.result || j;
      tools = body.tools ? (Array.isArray(body.tools) ? body.tools.length : body.tools) : null;
      mode = body.analysis_mode || null;
    } catch { /* a non-JSON answer is reported as such below */ }
    out.craft = { ok: r.status === 0, path: craft, tools, mode, stderr: (r.stderr || '').slice(0, 400) };
  }
  return out;
}

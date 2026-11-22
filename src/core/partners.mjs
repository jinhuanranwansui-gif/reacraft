// Partner engines: thin wrappers around the REA and craft-anything CLIs.
//
// Both are optional. ReaCraft reads a target by itself; these wrappers exist so a deep
// read (REA) and a real rebuild (craft-anything) can be driven from the same project
// folder without the user remembering two different command grammars.
//
// Measured on Windows: piping a child process's stdout can be refused by the sandbox,
// while plain file descriptors always work. Every call here redirects to temp files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, ENGINE_SPECS } from './engines.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function specPath(id) {
  const spec = ENGINE_SPECS.find((s) => s.id === id);
  return spec ? which(spec.names[0], spec.extra || []) : null;
}

export function resolveCraft() {
  return process.env.REACRAFT_CRAFT_CLI || specPath('craft-anything') || 'craft-anything-cli';
}

export function resolveRea() {
  return process.env.REACRAFT_REA_CLI || specPath('rea') || 'rea';
}

export function parseJsonLoose(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* fall through to the slice below */ }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const close = t[start] === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// Run one CLI with output redirected to files, then read those files back.
export function run(cli, args, { cwd = null, timeout = 300000, env = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reacraft-'));
  const outFile = path.join(tmp, 'out');
  const errFile = path.join(tmp, 'err');
  const ofd = fs.openSync(outFile, 'w');
  const efd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(cli, args, {
      cwd: cwd || undefined,
      stdio: ['ignore', ofd, efd],
      timeout,
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } finally {
    fs.closeSync(ofd);
    fs.closeSync(efd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: res.status, signal: res.signal, error: res.error || null, stdout, stderr, json: parseJsonLoose(stdout) };
}

// ---------------------------------------------------------------- craft-anything

export function craftCapabilities() {
  const r = run(resolveCraft(), ['capabilities', '--format', 'json'], { timeout: 120000 });
  const body = r.json && typeof r.json === 'object' && 'result' in r.json ? r.json.result : r.json;
  return {
    ...r,
    tools: body && body.tools ? body.tools : null,
    toolsets: body && body.toolsets ? body.toolsets : null,
    mode: body && body.analysis_mode ? body.analysis_mode : null,
  };
}

export function craftCommand() {
  return {
    cli: resolveCraft(),
    args: ['rebuild', '<target>', '<request>', '--project-folder', '<project>', '--deep', '--allow-run'],
    note: 'craft-anything drives a coding agent; nothing runs unless --run is passed to reacraft craft',
  };
}

// ---------------------------------------------------------------- REA

// REA answers in several formats; json is the one that survives a schema change best.
export function reaAnalyze(file, { timeout = 600000, format = 'json' } = {}) {
  const r = run(resolveRea(), ['analyze', file, '--format', format], { timeout });
  return { ...r, body: r.json };
}

export function reaCapabilities() {
  const r = run(resolveRea(), ['capabilities', '--format', 'json'], { timeout: 120000 });
  return { ...r, body: r.json };
}

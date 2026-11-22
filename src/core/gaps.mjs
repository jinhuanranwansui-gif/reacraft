// Gap stage: turn a failed verification into the next instruction.
//
// This is the step that closes the loop. A score on its own tells you a rebuild is
// 62% similar; a gap plan tells the builder which literal is missing, why it matters,
// and what to write. The output is both machine-readable (for a rebuild CLI) and a
// short block of text a person can paste into a follow-up request.
import path from 'node:path';

export const GAP_SCHEMA = 'reacraft.gaps/1';

const SKIP = new Set(['ob-behaviour']);

// One gap per obligation that is not satisfied. `action` says what to change; `ask` is
// the sentence a rebuild engine will actually receive.
export function buildGaps(spec, verification) {
  const gaps = [];
  for (const r of verification.results || []) {
    if (r.status === 'pass') continue;
    if (SKIP.has(r.id) && r.status === 'pending') {
      gaps.push({
        id: r.id,
        kind: 'human',
        weight: r.weight,
        statement: r.item,
        why: r.why,
        action: 'run both builds side by side and write down what differs',
        ask: 'Record the observed difference between the original and the rebuild: ' + r.item,
        blockers: [],
      });
      continue;
    }
    const missing = r.missing || [];
    const kind = r.status === 'partial' ? 'partial' : r.status === 'pending' ? 'pending' : 'missing';
    const what = missing.length
      ? 'add the missing ' + (missing.length === 1 ? 'item' : 'items') + ': ' + missing.slice(0, 8).map(short).join(', ')
      : r.status === 'pending'
        ? 'no automatic check applies; a person has to judge this one'
        : 'the obligation is not met';
    gaps.push({
      id: r.id,
      kind,
      weight: r.weight,
      statement: r.item,
      why: r.why,
      action: what,
      ask: askFor(r, missing),
      blockers: missing.slice(0, 12),
    });
  }
  gaps.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const score = verification.score;
  return {
    schema: GAP_SCHEMA,
    target: spec.target,
    rebuildDir: verification.rebuildDir,
    score,
    gate: verification.gate,
    open: gaps.length,
    gaps,
    // A single block a rebuild engine can take as its next instruction.
    fixRequest: renderFixRequest(spec, verification, gaps),
    createdAt: new Date().toISOString(),
  };
}

function short(v) {
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function askFor(r, missing) {
  if (r.status === 'pending') return 'Decide and record: ' + r.item;
  if (r.id === 'ob-endpoints') return 'Add these endpoints to the rebuild config exactly as written: ' + missing.join(', ');
  if (r.id === 'ob-literals') return 'Reference these exact paths, keys or statements in the rebuild: ' + missing.join(', ');
  if (r.id === 'ob-managed-types' || r.id === 'ob-java-surface') return 'Implement or keep these types/classes: ' + missing.join(', ');
  if (r.id === 'ob-elf-libs') return 'Link or load these libraries: ' + missing.join(', ');
  if (r.id === 'ob-android-classes') return 'Declare these classes in the rebuild: ' + missing.join(', ');
  return 'Satisfy: ' + r.item + (missing.length ? ' — missing: ' + missing.join(', ') : '');
}

function renderFixRequest(spec, verification, gaps) {
  if (!gaps.length) {
    return 'Nothing is open. score=' + verification.score + ' gate=' + verification.gate + ' — verify the manual item once more and ship.';
  }
  const lines = [];
  lines.push('Continue the rebuild of ' + path.basename(spec.target) + '.');
  lines.push('Current score: ' + (verification.score === null ? 'unscored' : verification.score + '%') + ' (gate ' + verification.gate + '%).');
  lines.push('Close these, highest weight first:');
  for (const g of gaps.slice(0, 12)) {
    lines.push('- [' + g.kind + '][w' + g.weight + '] ' + g.ask);
  }
  lines.push('');
  lines.push('Do not change behaviour that already passes. Re-run the verifier afterwards.');
  return lines.join('\n');
}

// A compact view for a terminal: one line per gap.
export function summarise(gaps) {
  return gaps.gaps.map((g) => '  ' + String(g.weight).padStart(2) + '  ' + g.kind.padEnd(8) + g.id.padEnd(22) + g.action).join('\n');
}

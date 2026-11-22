// Report stage: one page a person can read, and one JSON block a machine can diff.
// Every claim in the page carries either an evidence id or a file path.
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_SCHEMA = 'reacraft.report/1';

export function renderMarkdown({ profile, spec, verification, gaps, proof = null }) {
  const L = [];
  const v = verification || {};
  const sim = v.similarity || null;
  const g = gaps || null;

  L.push('# ReaCraft report — ' + spec.name);
  L.push('');
  L.push('> Read the target, write the contract, rebuild it, score the rebuild, close the gap.');
  L.push('');

  L.push('## Target');
  L.push('');
  L.push('| field | value |');
  L.push('|---|---|');
  L.push('| file | `' + esc(spec.target) + '` |');
  L.push('| kind | ' + (profile?.kind || spec.kind) + ' |');
  L.push('| arch | ' + (profile?.pe?.arch || profile?.elf?.arch || profile?.macho?.arch || '-') + ' |');
  L.push('| size | ' + spec.size + ' bytes |');
  L.push('| sha256 | `' + spec.sha256 + '` |');
  L.push('| stack | ' + spec.stack.primary + (spec.stack.labels.length ? ' (' + spec.stack.labels.join(', ') + ')' : '') + ' |');
  L.push('');

  if (spec.shield?.detected) {
    const s = spec.shield;
    L.push('## Shield');
    L.push('');
    L.push('This target carries a shield (' + (s.confidence || 'unknown') + ' confidence). The container is');
    L.push('still readable; some of its *values* are not, and they are marked instead of trusted.');
    L.push('');
    L.push('| what | state |');
    L.push('|---|---|');
    L.push('| signals | ' + (s.signals || []).join(', ') + ' |');
    L.push('| masked literals | ' + (s.maskedLiterals || 'unknown') + ' |');
    L.push('| decoy evidence marked | ' + (s.untrusted ?? '-') + ' |');
    L.push('');
    for (const a of s.advice || []) L.push('- ' + a);
    L.push('');
  }

  if (profile?.guard?.detected) {
    const g = profile.guard;
    L.push('## Instruction-like strings');
    L.push('');
    L.push('This target contains text that reads as an order rather than as data. A model given the');
    L.push('strings of this file would read them as instructions (arXiv 2605.30667). They stay in');
    L.push('`profile.json` as evidence; what follows is redacted, and the ids let you check the bytes.');
    L.push('');
    L.push('| evidence id | matched | weight | preview |');
    L.push('|---|---|---|---|');
    for (const h of g.hits.slice(0, 12)) {
      L.push('| `' + h.id + '` | ' + h.matched.join(', ') + ' | ' + h.weight + ' | `' + oneLine(h.preview) + '` |');
    }
    L.push('');
    for (const a of g.advice) L.push('- ' + a);
    L.push('');
  }

  L.push('## Verdict');
  L.push('');
  L.push('| metric | value |');
  L.push('|---|---|');
  L.push('| obligation score | ' + (v.score === null || v.score === undefined ? 'not scored' : v.score + '%') + ' |');
  L.push('| gate | ' + (v.gate || spec.gate) + '% → ' + (v.gateResult || 'unknown') + ' |');
  L.push('| pass / partial / fail / pending | ' + [v.pass ?? '-', v.partial ?? '-', v.fail ?? '-', v.pending ?? '-'].join(' / ') + ' |');
  if (sim) {
    L.push('| similarity | ' + (sim.score === null ? 'n/a' : sim.score + '%') + ' (' + sim.confidence + ' confidence) |');
    L.push('| minhash jaccard (literals) | ' + (sim.minhashJaccard === null ? 'n/a' : sim.minhashJaccard) + ' |');
  }
  if (proof) L.push('| evidence chain | ' + (proof.ok ? 'intact' : proof.problems.length + ' problem(s)') + ' |');
  L.push('');
  L.push('The score counts obligations that could be judged, weighting partial coverage by ratio.');
  L.push('Pending items are excluded — read the pending count before trusting the percentage.');
  L.push('');

  L.push('## What it does (REA)');
  L.push('');
  L.push('| capability | weight | evidence | sample |');
  L.push('|---|---|---|---|');
  for (const c of spec.capabilities) {
    const ev = c.evidence.length ? c.evidence.slice(0, 3).map((e) => '`' + e + '`').join(' ') : '-';
    L.push('| ' + c.statement + ' | ' + c.weight + ' | ' + ev + ' | ' + (c.samples[0] ? '`' + oneLine(c.samples[0]) + '`' : '-') + ' |');
  }
  L.push('');

  L.push('## Obligations and their outcome');
  L.push('');
  L.push('| id | obligation | weight | acceptance | status | note |');
  L.push('|---|---|---|---|---|---|');
  for (const r of v.results || []) {
    L.push('| ' + r.id + ' | ' + r.item + ' | ' + r.weight + ' | ' + (r.acceptance || '-') + ' | ' + badge(r.status) + ' | ' + (r.note || '') + ' |');
  }
  if (!(v.results || []).length) {
    L.push('| - | no verification has been run yet | - | - | - | run `verify` |');
  }
  L.push('');

  if (sim) {
    L.push('## Set coverage');
    L.push('');
    L.push('| category | required | present | ratio | missing (first few) |');
    L.push('|---|---|---|---|---|');
    for (const [name, d] of Object.entries(sim.coverage)) {
      L.push('| ' + name + ' | ' + d.required + ' | ' + d.hit + ' | ' + (d.ratio === null ? '-' : Math.round(d.ratio * 100) + '%') + ' | ' + (d.missing.slice(0, 4).map((m) => '`' + oneLine(m) + '`').join(' ') || '-') + ' |');
    }
    L.push('');
    for (const c of sim.caveats) L.push('- ' + c);
    L.push('');
  }

  if (g && g.gaps.length) {
    L.push('## Gap plan');
    L.push('');
    L.push('Highest weight first. Each line is what the next rebuild round should do.');
    L.push('');
    for (const gap of g.gaps) {
      L.push('- **' + gap.id + '** (w' + gap.weight + ', ' + gap.kind + '): ' + gap.action);
      if (gap.why) L.push('  - why: ' + gap.why);
    }
    L.push('');
    L.push('```text');
    L.push(g.fixRequest);
    L.push('```');
    L.push('');
  }

  if (spec.unknowns?.length) {
    L.push('## What this read did not settle');
    L.push('');
    for (const u of spec.unknowns) L.push('- **' + u.severity + '** — ' + u.question + ' → ' + u.how_to_settle);
    L.push('');
  }

  if (profile?.evidence?.length) {
    L.push('## Evidence index');
    L.push('');
    L.push('Ids are content-derived: re-reading the same bytes reproduces them.');
    L.push('');
    L.push('| id | kind | value |');
    L.push('|---|---|---|');
    for (const e of profile.evidence.slice(0, 40)) L.push('| `' + e.id + '` | ' + e.kind + ' | `' + oneLine(e.value) + '` |');
    if (profile.evidence.length > 40) L.push('| … | ' + (profile.evidence.length - 40) + ' more | in profile.json |');
    L.push('');
  }

  L.push('## Reproduce');
  L.push('');
  L.push('```powershell');
  L.push('reacraft prove ' + spec.name + '      # recompute the chain and every recorded hash');
  L.push('reacraft verify ' + spec.name + ' --rebuild <dir>');
  L.push('```');
  L.push('');
  L.push('_Generated ' + new Date().toISOString() + '_');
  return L.join('\n');
}

function badge(status) {
  if (status === 'pass') return '✅ pass';
  if (status === 'partial') return '🟡 partial';
  if (status === 'fail') return '❌ fail';
  return '⚪ pending';
}

function oneLine(s) {
  return String(s).replace(/[|\n\r]/g, ' ').slice(0, 90);
}

function esc(s) {
  return String(s).replace(/`/g, "'");
}

// ---------------------------------------------------------------- html

export function renderHtml(markdown, title) {
  const body = markdownToHtml(markdown);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{margin:0 auto;max-width:960px;padding:32px 24px 80px;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0e1116;color:#d7dde5}
h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid #232a33;padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin:8px 0 20px;font-size:13.5px}
th,td{border:1px solid #232a33;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#151a21;font-weight:600}
code{background:#161b22;padding:1px 5px;border-radius:4px;font-size:12.5px}
pre{background:#10151b;border:1px solid #232a33;border-radius:8px;padding:12px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:0 0 16px;padding:8px 14px;border-left:3px solid #3b7dd8;color:#9fb0c3;background:#12171e}
ul{padding-left:22px}li{margin:4px 0}
a{color:#6ea8fe}
</style></head><body>
${body}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Small, honest converter: headings, tables, lists, code fences, quotes, inline code.
function markdownToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let inTable = false;
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      closeList(); closeTable();
      if (!inCode) { out.push('<pre><code>'); inCode = true; }
      else { out.push('</code></pre>'); inCode = false; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }

    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (!inTable) { out.push('<table><thead><tr>' + cells.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'); inTable = true; }
      else out.push('<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      continue;
    }
    closeTable();

    if (/^#{1,4}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      out.push('<h' + level + '>' + inline(line.replace(/^#+\s*/, '')) + '</h' + level + '>');
      continue;
    }
    if (/^>\s?/.test(line)) { closeList(); out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>');
      continue;
    }
    if (/^\s+[-*]\s+/.test(line)) { out.push('<li style="margin-left:18px;list-style:circle">' + inline(line.trim().replace(/^[-*]\s+/, '')) + '</li>'); continue; }
    closeList();
    if (line.trim() === '') { out.push(''); continue; }
    out.push('<p>' + inline(line) + '</p>');
  }
  closeList(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// ---------------------------------------------------------------- io

export function writeReport(dir, parts, { html = false } = {}) {
  const md = renderMarkdown(parts);
  const mdFile = path.join(dir, 'report.md');
  fs.writeFileSync(mdFile, md, 'utf8');
  const jsonFile = path.join(dir, 'report.json');
  fs.writeFileSync(jsonFile, JSON.stringify({
    schema: REPORT_SCHEMA,
    name: parts.spec.name,
    target: parts.spec.target,
    sha256: parts.spec.sha256,
    score: parts.verification?.score ?? null,
    gate: parts.verification?.gate ?? parts.spec.gate,
    gateResult: parts.verification?.gateResult ?? 'unknown',
    similarity: parts.verification?.similarity ?? null,
    counts: parts.verification ? {
      pass: parts.verification.pass, partial: parts.verification.partial,
      fail: parts.verification.fail, pending: parts.verification.pending,
    } : null,
    openGaps: parts.gaps?.open ?? null,
    unknowns: parts.spec.unknowns?.length ?? 0,
    proof: parts.proof ?? null,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  const files = [mdFile, jsonFile];
  if (html) {
    const htmlFile = path.join(dir, 'report.html');
    fs.writeFileSync(htmlFile, renderHtml(md, 'ReaCraft — ' + parts.spec.name), 'utf8');
    files.push(htmlFile);
  }
  return files;
}

// A standalone dashboard: one HTML file, no assets, no network, opens anywhere.
//
// The DSH sidebar panel would need a Cordis client plugin and a rebuilt web bundle; this is the same
// information in a form that works in any browser, attaches to a CI artifact, and survives being
// emailed to someone. Everything is inline and the file is generated from the project's own JSON.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ring(score, size = 148) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(score) || 0));
  const dash = (v / 100) * c;
  const colour = v >= 80 ? '#3fb950' : v >= 50 ? '#d29922' : '#f85149';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#21262d" stroke-width="12"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${colour}" stroke-width="12"
    stroke-dasharray="${dash} ${c}" stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="#e6edf3"
    font-family="ui-monospace,Consolas,monospace" font-size="34" font-weight="600">${v === null ? '—' : v + '%'}</text>
</svg>`;
}

function bar(value, max = 1) {
  const pct = Math.round((Number(value) / max) * 100);
  return `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
}

function pill(status) {
  const map = { pass: 'ok', partial: 'warn', fail: 'bad', pending: 'mute' };
  return `<span class="pill ${map[status] || 'mute'}">${esc(status || '—')}</span>`;
}

export function renderDashboard({ profile, spec, verification, gaps, ledger }) {
  const score = verification?.score ?? null;
  const cap = spec?.capabilities || [];
  const obs = verification?.results || [];
  const gapList = gaps?.gaps || [];
  const sim = verification?.similarity;
  const stack = typeof profile?.stack === 'object' ? (profile.stack.primary || '') : (profile?.stack || '');
  const counts = {
    pass: verification?.pass ?? 0,
    partial: verification?.partial ?? 0,
    fail: verification?.fail ?? 0,
    pending: verification?.pending ?? 0,
  };

  const rows = obs.map((o) =>
    `<tr><td>${pill(o.status)}</td><td class="mono">${esc(o.id)}</td><td>${esc(o.item)}</td>
     <td class="mono">${esc(o.note || '')}</td><td class="num">${o.weight ?? ''}</td></tr>`).join('');

  const gapRows = gapList.slice(0, 20).map((g) =>
    `<tr><td class="num">${g.weight}</td><td class="mono">${esc(g.id)}</td><td>${esc(g.ask)}</td></tr>`).join('');

  const capRows = cap.map((c) =>
    `<tr><td class="mono">${esc(c.id)}</td><td>${esc(c.statement)}</td><td class="num">${c.weight}</td>
     <td class="mono dim">${(c.evidence || []).slice(0, 3).map(esc).join(', ')}</td></tr>`).join('');

  const simRows = sim
    ? Object.entries(sim.coverage).map(([name, d]) =>
      `<tr><td>${esc(name)}</td><td class="num">${d.required}</td><td class="num">${d.hit}</td>
       <td class="num">${d.ratio === null ? '—' : Math.round(d.ratio * 100) + '%'}</td>
       <td class="num">${d.weightedRatio == null ? '—' : Math.round(d.weightedRatio * 100) + '%'}</td>
       <td>${bar(d.weightedRatio ?? d.ratio ?? 0)}</td></tr>`).join('')
    : '';

  const drm = profile?.drm;
  const guard = profile?.guard;
  const shields = [
    profile?.shield?.detected ? `shield: ${profile.shield.signals.map((s) => s.id).join(', ')}` : null,
    drm?.detected ? `protection: ${drm.products.map((p) => p.id).join(', ') || 'unidentified'}${drm.imageEncrypted ? ' · whole image encrypted' : drm.codeEncrypted ? ' · code encrypted' : ' · code readable'}` : null,
    guard?.detected ? `instruction-like strings: ${guard.count}` : null,
    profile?.strings?.unreliable ? 'strings: unreliable (encrypted bytes)' : null,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>reacraft · ${esc(spec?.name || profile?.name || 'target')}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#c9d1d9;font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 64px}
header{display:flex;gap:26px;align-items:center;flex-wrap:wrap;padding-bottom:22px;border-bottom:1px solid #21262d}
h1{margin:0;font-size:26px;font-weight:650;letter-spacing:-.01em;color:#f0f6fc}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.09em;color:#8b949e;margin:36px 0 12px;font-weight:600}
.meta{color:#8b949e;font-size:13px;margin-top:5px}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;background:#161b22;border:1px solid #30363d;font-size:11.5px;color:#8b949e;margin:0 6px 6px 0}
table{width:100%;border-collapse:collapse;background:#0f141b;border:1px solid #21262d;border-radius:9px;overflow:hidden}
th{text-align:left;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:#8b949e;padding:9px 12px;background:#161b22;border-bottom:1px solid #21262d}
td{padding:9px 12px;border-bottom:1px solid #161b22;vertical-align:top}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dim{color:#6e7681}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.pill.ok{background:#0f2d16;color:#3fb950}.pill.warn{background:#2b2110;color:#d29922}
.pill.bad{background:#321616;color:#f85149}.pill.mute{background:#1a1f26;color:#8b949e}
.bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;min-width:90px}
.bar span{display:block;height:100%;background:#3fb950}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:16px}
.card{background:#0f141b;border:1px solid #21262d;border-radius:10px;padding:16px 18px}
.k{color:#8b949e;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em}
.v{font-size:19px;color:#e6edf3;margin-top:3px;font-family:ui-monospace,Consolas,monospace}
footer{margin-top:44px;padding-top:16px;border-top:1px solid #21262d;color:#6e7681;font-size:12px}
</style></head>
<body><div class="wrap">
<header>
  ${ring(score)}
  <div>
    <h1>${esc(spec?.name || profile?.name || 'target')}</h1>
    <div class="meta">${esc(profile?.kind || '')} · ${esc(stack)} · gate ${esc(spec?.gate ?? '')}% ·
      verification ${esc(verification ? (verification.gateResult || 'scored') : 'not run')}</div>
    <div style="margin-top:10px">${shields.map((s) => `<span class="tag">${esc(s)}</span>`).join('') || '<span class="tag">no protection recognised</span>'}</div>
  </div>
</header>

<div class="grid" style="margin-top:24px">
  <div class="card"><div class="k">obligations</div><div class="v">${counts.pass} pass · ${counts.partial} partial · ${counts.fail} fail · ${counts.pending} pending</div></div>
  <div class="card"><div class="k">open gaps</div><div class="v">${gapList.length}</div></div>
  <div class="card"><div class="k">evidence ids</div><div class="v">${(profile?.evidence || []).length}</div></div>
  <div class="card"><div class="k">similarity</div><div class="v">${sim?.score == null ? '—' : sim.score + '%'} <span class="dim" style="font-size:12px">${esc(sim?.confidence || '')}</span></div></div>
</div>

<h2>Obligations</h2>
<table><thead><tr><th>status</th><th>id</th><th>item</th><th>note</th><th class="num">weight</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="dim">no verification recorded — run verify</td></tr>'}</tbody></table>

${gapRows ? `<h2>Gaps, highest weight first</h2>
<table><thead><tr><th class="num">weight</th><th>id</th><th>what to do next</th></tr></thead><tbody>${gapRows}</tbody></table>` : ''}

${simRows ? `<h2>Set coverage</h2>
<table><thead><tr><th>category</th><th class="num">required</th><th class="num">present</th><th class="num">ratio</th><th class="num">weighted</th><th></th></tr></thead><tbody>${simRows}</tbody></table>` : ''}

${capRows ? `<h2>Capabilities</h2>
<table><thead><tr><th>id</th><th>statement</th><th class="num">weight</th><th>evidence</th></tr></thead><tbody>${capRows}</tbody></table>` : ''}

<footer>
  generated by reacraft ${esc(profile?.toolVersion || '')} · ledger ${ledger?.count ?? 0} records
  ${ledger?.intact === false ? '· <strong style="color:#f85149">chain broken</span>' : '· chain intact'}
  · nothing here was executed: every value came from reading the bytes
</footer>
</div></body></html>`;
}

export function writeDashboard(dir, data) {
  const file = path.join(dir, 'dashboard.html');
  fs.writeFileSync(file, renderDashboard(data), 'utf8');
  return file;
}

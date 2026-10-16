import path from 'node:path';
import { countBySeverity } from './analyze.js';
import { ratings, AREAS } from './ratings.js';
import { CONTACT_EMAIL, SITE_URL } from './config.js';
import { DEADLINE_IDS } from './report-text.js';

// Several apps side by side (an agency's client apps, or every app in a monorepo): versions,
// A–E ratings, and the store and end-of-support deadlines that need a date in the calendar.
// Each app is scanned exactly as `npx nativekeel <app>` would; nothing is uploaded.

const RANK = { E: 0, D: 1, C: 2, B: 3, A: 4 };

export function fleetRow(result, rel) {
  const n = countBySeverity(result.findings);
  const p = result.project;
  return {
    app: p.name || path.basename(rel),
    path: rel,
    reactNative: p.reactNative || null,
    latestReactNative: (result.latest && result.latest.reactNative) || null,
    expo: p.expo ? p.expo.split('.')[0] : null,
    ratings: result.ratings || ratings(result.findings),
    critical: n.critical,
    high: n.high,
    deadlines: result.findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && DEADLINE_IDS.test(f.id)).map((f) => f.title),
  };
}

// Worst first: most critical, then most high, then the lowest single rating.
export function sortFleet(rows) {
  const worst = (r) => (r.error ? 5 : Math.min(...r.ratings.map((x) => RANK[x.rating])));
  return [...rows].sort((a, b) => (b.critical || 0) - (a.critical || 0) || (b.high || 0) - (a.high || 0) || worst(a) - worst(b) || a.path.localeCompare(b.path));
}

const version = (r) => [r.reactNative ? `RN ${r.reactNative}` : null, r.expo ? `Expo ${r.expo}` : null].filter(Boolean).join(', ') || '?';
const TEAMS = `Looking after many apps? Tell us what your team needs: ${CONTACT_EMAIL}`;

export function fleetText(rows, { color = true } = {}) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const c = { red: paint('31'), yellow: paint('33'), green: paint('32'), gray: paint('90'), bold: paint('1') };
  const grade = (g) => (g === 'A' || g === 'B' ? c.green(g) : g === 'C' ? c.yellow(g) : c.red(g));
  const out = [c.bold(`NativeKeel fleet: ${rows.length} app${rows.length === 1 ? '' : 's'}`), c.gray(`Ratings: ${AREAS.map((a) => a.label).join(' · ')}  (A = nothing found, E = a critical finding)`), ''];
  const width = Math.min(40, Math.max(...rows.map((r) => r.path.length), 3));
  for (const r of rows) {
    if (r.error) {
      out.push(`${r.path.padEnd(width)}  ${c.gray(`not scanned: ${r.error}`)}`);
      continue;
    }
    out.push(`${r.path.padEnd(width)}  ${r.ratings.map((x) => grade(x.rating)).join(' ')}  ${c.red(`${r.critical} critical`)} · ${c.yellow(`${r.high} high`)}  ${c.gray(version(r))}`);
    for (const d of r.deadlines.slice(0, 3)) out.push(`${' '.repeat(width)}  ${c.red('deadline')} ${d}`);
  }
  out.push('', c.gray(`Details for one app: npx nativekeel <path>   ·   ${TEAMS}`));
  return out.join('\n');
}

export function fleetMarkdown(rows) {
  const lines = [`### NativeKeel fleet: ${rows.length} app${rows.length === 1 ? '' : 's'}`, '', `| App | Version | ${AREAS.map((a) => a.label).join(' | ')} | Critical | High | Deadlines |`, `|---|---|${AREAS.map(() => '---').join('|')}|---|---|---|`];
  const cell = (s) => String(s).replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;')).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const r of rows) {
    if (r.error) lines.push(`| ${cell(r.path)} | not scanned: ${cell(r.error)} |${AREAS.map(() => ' |').join('')} | | |`);
    else lines.push(`| ${cell(r.path)} | ${cell(version(r))} | ${r.ratings.map((x) => `**${x.rating}**`).join(' | ')} | ${r.critical} | ${r.high} | ${cell(r.deadlines.join('; ') || '–')} |`);
  }
  lines.push('', 'A = nothing found in that area, E = at least one critical finding. Ratings describe what the scan found, not a guarantee.');
  return lines.join('\n') + '\n';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function fleetHtml(rows, { scannedAt = new Date().toISOString(), brand = null } = {}) {
  const total = rows.reduce((a, r) => ({ critical: a.critical + (r.critical || 0), high: a.high + (r.high || 0), deadlines: a.deadlines + (r.deadlines ? r.deadlines.length : 0) }), { critical: 0, high: 0, deadlines: 0 });
  const body = rows.map((r) => r.error
    ? `<tr><th scope="row">${esc(r.path)}</th><td colspan="${AREAS.length + 4}" class="muted">Not scanned: ${esc(r.error)}</td></tr>`
    : `<tr><th scope="row">${esc(r.app)}<span class="muted">${esc(r.path)}</span></th><td class="v">${esc(version(r))}${r.latestReactNative ? `<span class="muted">latest ${esc(r.latestReactNative)}</span>` : ''}</td>${r.ratings.map((x) => `<td class="r"><b class="g g${x.rating}" title="${esc(x.label)}: ${x.findings} finding${x.findings === 1 ? '' : 's'}">${x.rating}</b></td>`).join('')}<td class="n${r.critical ? ' crit' : ''}">${r.critical}</td><td class="n${r.high ? ' high' : ''}">${r.high}</td><td>${r.deadlines.length ? `<ul>${r.deadlines.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '<span class="muted">none</span>'}</td></tr>`).join('\n');
  const title = `${brand ? `${brand}: ` : ''}React Native apps overview`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--text:#16181d;--muted:#5f6673;--line:#e3e6eb;--critical:#c62828;--high:#b26a00;--accent:#0b5d55}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--text:#e8eaee;--muted:#9aa1ad;--line:#2a2f38;--critical:#ff6b6b;--high:#f0a73a;--accent:#3cc4b4}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1360px;margin:0 auto;padding:32px 16px}h1{margin:0 0 4px;font-size:26px}.muted{color:var(--muted);font-size:13px;display:block}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.stats div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}.stats b{display:block;font-size:22px}.stats span{font-size:13px;color:var(--muted)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:900px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tbody th{font-weight:600}td ul{margin:0;padding-left:16px;font-size:13px}td:last-child{min-width:280px}.v{white-space:nowrap}th.r,td.r{padding-left:4px;padding-right:4px;text-align:center}thead th.r{font-size:11px;letter-spacing:0}.n{font-variant-numeric:tabular-nums}.crit{color:var(--critical);font-weight:700}.high{color:var(--high);font-weight:700}
.g{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:6px;color:#fff;font-size:14px}.gA,.gB{background:#2e7d32}.gC{background:#8a6d00}.gD{background:#b26a00}.gE{background:#c62828}
footer{margin-top:24px;color:var(--muted);font-size:13px}a{color:var(--accent)}
</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<p class="muted">Scanned ${esc(scannedAt.slice(0, 16).replace('T', ' '))} UTC with NativeKeel. Worst first.</p>
<div class="stats"><div><b>${rows.length}</b><span>apps</span></div><div><b class="${total.critical ? 'crit' : ''}">${total.critical}</b><span>critical findings</span></div><div><b class="${total.high ? 'high' : ''}">${total.high}</b><span>high findings</span></div><div><b>${total.deadlines}</b><span>store or support deadlines</span></div></div>
<div class="wrap"><table>
<thead><tr><th scope="col">App</th><th scope="col">Version</th>${AREAS.map((a) => `<th scope="col" class="r">${esc(a.label)}</th>`).join('')}<th scope="col">Critical</th><th scope="col">High</th><th scope="col">Deadlines</th></tr></thead>
<tbody>
${body}
</tbody></table></div>
<footer><p>Ratings: A = nothing found in that area, B = only low findings, C = medium, D = high, E = critical. They describe what the scan found, not a guarantee. Details for one app: <code>npx nativekeel &lt;path&gt; --html report.html</code>.</p><p>${esc(TEAMS)} · <a href="${SITE_URL}">${SITE_URL.replace('https://', '')}</a></p></footer>
</main></body></html>
`;
}

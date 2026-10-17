// NativeKeel team panel API (closed beta). Everything else on nativekeel.com is static and never
// reaches this Worker (run_worker_first only covers /api/*).
//
//   POST /api/v1/scans   Authorization: Bearer <upload token>   body: `nativekeel fleet --json` or `nativekeel --json`, as sent by --upload
//   GET  /api/v1/panel   Authorization: Bearer <view token>     the team's apps, latest results and history
//
// Stored per app and scan: name, versions, A–E ratings, severity counts, deadline titles and
// finding ids/severities/areas/titles. No source code and no finding details are accepted.

const MAX_BODY = 1_000_000;
const MAX_APPS = 200;
const MAX_FINDINGS = 500;
const MAX_ROWS_PER_HOUR = 2000;
const HISTORY = 24;
const AREAS = ['security', 'store', 'stability', 'upgrade', 'performance', 'accessibility'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const now = () => new Date().toISOString();

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function teamFor(request, env, kind) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await env.DB.prepare('SELECT t.id, t.name FROM tokens k JOIN teams t ON t.id = k.team_id WHERE k.hash = ? AND k.kind = ?').bind(hash, kind).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?').bind(now(), hash).run();
  return row;
}

// One app from `fleet --json` (apps[]) or a single scan (`nativekeel --json`), reduced to what we keep.
function clean(app, scannedAt, toolVersion) {
  if (!app || typeof app !== 'object' || app.error) return null;
  const key = str(app.path, 200) || str(app.app, 200);
  if (!key) return null;
  const ratings = Array.isArray(app.ratings)
    ? app.ratings.filter((r) => r && AREAS.includes(r.key) && /^[A-E]$/.test(r.rating)).map((r) => ({ key: r.key, rating: r.rating, findings: Number.isInteger(r.findings) ? r.findings : 0 }))
    : [];
  if (ratings.length !== AREAS.length) return null;
  const counts = Object.fromEntries(SEVERITIES.slice(0, 4).map((s) => [s, Number.isInteger(app.counts?.[s]) ? app.counts[s] : Number.isInteger(app[s]) ? app[s] : 0]));
  const findings = (Array.isArray(app.findings) ? app.findings : []).slice(0, MAX_FINDINGS)
    .filter((f) => f && typeof f.id === 'string' && SEVERITIES.includes(f.severity))
    .map((f) => ({ id: f.id.slice(0, 200), severity: f.severity, area: str(f.area, 40), title: str(f.title, 300) }));
  return {
    app: key,
    name: str(app.app, 200),
    scannedAt: typeof scannedAt === 'string' && !Number.isNaN(Date.parse(scannedAt)) ? new Date(scannedAt).toISOString() : now(),
    reactNative: str(app.reactNative, 40),
    expo: str(app.expo, 40),
    ratings,
    counts,
    deadlines: (Array.isArray(app.deadlines) ? app.deadlines : []).slice(0, 20).map((d) => str(d, 300)).filter(Boolean),
    findings,
    toolVersion: str(toolVersion, 40),
  };
}

async function upload(request, env) {
  const team = await teamFor(request, env, 'upload');
  if (!team) return json(401, { error: 'unknown or missing upload token' });
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) return json(413, { error: 'report too large' });
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: 'report too large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not JSON' });
  }
  if (!body || body.tool !== 'nativekeel') return json(400, { error: 'not a NativeKeel report' });
  const list = Array.isArray(body.apps) ? body.apps.slice(0, MAX_APPS) : [body.app || body];
  const rows = list.map((a) => clean(a, a?.scannedAt || body.scannedAt, body.version)).filter(Boolean);
  if (!rows.length) return json(400, { error: 'no apps with ratings in the report' });
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM scans WHERE team_id = ? AND received_at > ?').bind(team.id, hourAgo).first();
  if (recent.n + rows.length > MAX_ROWS_PER_HOUR) return json(429, { error: 'too many uploads in the last hour' });
  const received = now();
  const insert = env.DB.prepare('INSERT INTO scans (team_id, app, name, scanned_at, received_at, react_native, expo, ratings, counts, deadlines, findings, tool_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await env.DB.batch(rows.map((r) => insert.bind(team.id, r.app, r.name, r.scannedAt, received, r.reactNative, r.expo, JSON.stringify(r.ratings), JSON.stringify(r.counts), JSON.stringify(r.deadlines), JSON.stringify(r.findings), r.toolVersion)));
  return json(201, { team: team.name, stored: rows.length });
}

async function panel(request, env) {
  const team = await teamFor(request, env, 'view');
  if (!team) return json(401, { error: 'unknown or missing view key' });
  const { results } = await env.DB.prepare(
    `SELECT app, name, scanned_at, react_native, expo, ratings, counts, deadlines, findings FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY app ORDER BY scanned_at DESC, id DESC) AS n FROM scans WHERE team_id = ?
     ) WHERE n <= ? ORDER BY app, scanned_at DESC`,
  ).bind(team.id, HISTORY).all();
  const apps = new Map();
  for (const r of results) {
    const entry = { scannedAt: r.scanned_at, reactNative: r.react_native, expo: r.expo, ratings: JSON.parse(r.ratings), counts: JSON.parse(r.counts) };
    if (!apps.has(r.app)) apps.set(r.app, { app: r.app, name: r.name, latest: { ...entry, deadlines: JSON.parse(r.deadlines), findings: JSON.parse(r.findings) }, history: [] });
    apps.get(r.app).history.push(entry);
  }
  return json(200, { team: team.name, apps: [...apps.values()] });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/v1/scans' && request.method === 'POST') return await upload(request, env);
      if (url.pathname === '/api/v1/panel' && request.method === 'GET') return await panel(request, env);
      return json(404, { error: 'not found' });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'server error' });
    }
  },
};

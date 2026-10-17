// Opt-in upload to the NativeKeel team panel (closed beta): `--upload` with NATIVEKEEL_TOKEN set.
// Sends the scan summary only: app name, versions, A–E ratings, severity counts, deadline titles
// and each finding's id, severity, area and title. No source code, no finding details, no file
// contents. Never with --offline.
export const panelUrl = () => (process.env.NATIVEKEEL_API || 'https://nativekeel.com').replace(/\/+$/, '');

export const summaryFindings = (findings) =>
  findings.filter((f) => f.severity !== 'info').map((f) => ({ id: f.id, severity: f.severity, area: f.area, title: f.title }));

export async function uploadReport(payload, { token = process.env.NATIVEKEEL_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('set NATIVEKEEL_TOKEN to the upload token of your team panel');
  const res = await fetchImpl(`${panelUrl()}/api/v1/scans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) throw new Error(body.error || `panel answered HTTP ${res.status}`);
  return body;
}

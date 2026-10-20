import fs from './read-boundary.js';
import path from 'node:path';
import { findingLocations } from './locations.js';

// .nativekeel.json in the app folder: a team's decisions, committed with the code.
//   { "failOn": "high", "ignore": [{ "id": "flipper", "reason": "Removed in the next sprint" }],
//     "exclude": [{ "path": "tools/admin-web", "reason": "Separate web project" }] }
// An id ending in "*" matches every finding id that starts with it. Every ignore needs a reason,
// and ignored findings stay listed in the result (and the report), so nothing is hidden silently.
export const SETTINGS_FILE = '.nativekeel.json';
const LEVELS = ['critical', 'high', 'medium', 'low', 'never'];

export function readSettings(root) {
  const file = path.join(root, SETTINGS_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const warnings = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { file: SETTINGS_FILE, ignore: [], exclude: [], warnings: [`${SETTINGS_FILE} is not valid JSON (${e.message}); it was not applied.`] };
  }
  const failOn = LEVELS.includes(data.failOn) ? data.failOn : undefined;
  if (data.failOn !== undefined && !failOn) warnings.push(`${SETTINGS_FILE}: failOn must be one of ${LEVELS.join(', ')}.`);
  const ignore = [];
  for (const entry of Array.isArray(data.ignore) ? data.ignore : []) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    // "until": an accepted finding comes back for review on that date instead of staying hidden.
    const until = entry && typeof entry.until === 'string' ? entry.until.trim() : '';
    if (!id || id === '*') warnings.push(`${SETTINGS_FILE}: an ignore entry has no usable id.`);
    else if (!reason) warnings.push(`${SETTINGS_FILE}: ignore "${id}" has no reason, so it was not applied.`);
    else if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) warnings.push(`${SETTINGS_FILE}: ignore "${id}" has until "${until}"; use YYYY-MM-DD. It was not applied.`);
    else if (until && until < new Date().toISOString().slice(0, 10)) warnings.push(`${SETTINGS_FILE}: the exception for "${id}" ended on ${until} ("${reason}"); the finding is shown again. Review it, then fix it or set a new date.`);
    else ignore.push({ id, reason, ...(until ? { until } : {}) });
  }
  // Folders that are not part of the app (a web dashboard, a backend, an example project): a
  // finding whose files all sit in them is left out. Findings without a file always stay.
  const exclude = [];
  for (const entry of Array.isArray(data.exclude) ? data.exclude : []) {
    const raw = entry && typeof entry.path === 'string' ? entry.path.trim() : '';
    const p = raw.replace(/^\.\//, '').replace(/\/\*\*?$/, '').replace(/\/$/, '');
    const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!p || p === '.' || p.startsWith('..') || path.isAbsolute(p) || /[*?]/.test(p)) warnings.push(`${SETTINGS_FILE}: exclude "${raw}" must be a folder inside the project (no wildcards).`);
    else if (!reason) warnings.push(`${SETTINGS_FILE}: exclude "${raw}" has no reason, so it was not applied.`);
    else exclude.push({ path: p, reason });
  }
  // Checks allowed to fail the build. A team that trusts only some checks lists them; every other
  // finding is still reported, it just does not set the exit code or fail the pull request gate.
  let gate = null;
  if (data.gate !== undefined) {
    if (!Array.isArray(data.gate) || !data.gate.every((g) => typeof g === 'string' && g.trim())) warnings.push(`${SETTINGS_FILE}: gate must be a list of finding ids (a trailing * matches a prefix).`);
    else gate = data.gate.map((g) => g.trim());
  }
  return { file: SETTINGS_FILE, failOn, ignore, exclude, gate, warnings };
}

const matches = (rule, id) => (rule.endsWith('*') ? id.startsWith(rule.slice(0, -1)) : id === rule);
// The file comes with the repository, so a planted one must not be able to hide planted malware.
const NEVER_IGNORED = new Set(['malicious-code', 'vscode-autorun-task']);

// Returns { findings, ignored }: ignored lists each finding left out, with the rule's reason.
const findingFiles = (f) => [...new Set(findingLocations(f).map((l) => l.file))];
const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);

export function applySettings(findings, settings) {
  const exclude = (settings && settings.exclude) || [];
  if (!settings || (!settings.ignore.length && !exclude.length)) return { findings, ignored: [] };
  const kept = [];
  const ignored = [];
  for (const f of findings) {
    const never = NEVER_IGNORED.has(f.id);
    const rule = !never && settings.ignore.find((r) => matches(r.id, String(f.id)));
    const files = never || rule ? [] : findingFiles(f);
    const dirs = files.length ? files.map((file) => exclude.find((e) => inside(file, e.path))) : [];
    const excluded = dirs.length && dirs.every(Boolean) ? dirs[0] : null;
    if (rule) ignored.push({ id: f.id, severity: f.severity, title: f.title, reason: rule.reason, ...(rule.until ? { until: rule.until } : {}) });
    else if (excluded) ignored.push({ id: f.id, severity: f.severity, title: f.title, reason: `${excluded.path}/ excluded: ${excluded.reason}` });
    else kept.push(f);
  }
  return { findings: kept, ignored };
}

// True when the finding may fail the build: no gate list, or its id matches one entry. Planted
// malware always may.
export function gates(settings, id) {
  const list = settings && settings.gate;
  return !list || NEVER_IGNORED.has(id) || list.some((g) => matches(g, String(id)));
}

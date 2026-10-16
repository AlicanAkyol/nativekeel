import fs from './read-boundary.js';
import path from 'node:path';

// .nativekeel.json in the app folder: a team's decisions, committed with the code.
//   { "failOn": "high", "ignore": [{ "id": "flipper", "reason": "Removed in the next sprint" }] }
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
    return { file: SETTINGS_FILE, ignore: [], warnings: [`${SETTINGS_FILE} is not valid JSON (${e.message}); it was not applied.`] };
  }
  const failOn = LEVELS.includes(data.failOn) ? data.failOn : undefined;
  if (data.failOn !== undefined && !failOn) warnings.push(`${SETTINGS_FILE}: failOn must be one of ${LEVELS.join(', ')}.`);
  const ignore = [];
  for (const entry of Array.isArray(data.ignore) ? data.ignore : []) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!id || id === '*') warnings.push(`${SETTINGS_FILE}: an ignore entry has no usable id.`);
    else if (!reason) warnings.push(`${SETTINGS_FILE}: ignore "${id}" has no reason, so it was not applied.`);
    else ignore.push({ id, reason });
  }
  return { file: SETTINGS_FILE, failOn, ignore, warnings };
}

const matches = (rule, id) => (rule.endsWith('*') ? id.startsWith(rule.slice(0, -1)) : id === rule);
// The file comes with the repository, so a planted one must not be able to hide planted malware.
const NEVER_IGNORED = new Set(['malicious-code', 'vscode-autorun-task']);

// Returns { findings, ignored }: ignored lists each finding left out, with the rule's reason.
export function applySettings(findings, settings) {
  if (!settings || !settings.ignore.length) return { findings, ignored: [] };
  const kept = [];
  const ignored = [];
  for (const f of findings) {
    const rule = !NEVER_IGNORED.has(f.id) && settings.ignore.find((r) => matches(r.id, String(f.id)));
    if (rule) ignored.push({ id: f.id, severity: f.severity, title: f.title, reason: rule.reason });
    else kept.push(f);
  }
  return { findings: kept, ignored };
}

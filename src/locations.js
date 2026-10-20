// Where a finding is, in one shape: [{ file, line, role }]. Checks record locations in several
// ways (evidence[].file/line, evidence[].at "file:line", fix.file, or only "file:line" in the
// title or detail); every exporter and post-processing step reads them through here.
const CODE_REF = /(?:^|[\s(`'",;])((?:[\w@.~-]+\/)*[\w@.~[\]()-]+\.(?:[cm]?[jt]sx?|json|kt|java|swift|m|mm|h|xml|plist|gradle|kts|yml|yaml|sql|rules|properties)):(\d+)/g;

function split(ref) {
  const m = String(ref).match(/^(.*?):(\d+)$/);
  return m ? { file: m[1], line: Number(m[2]) } : { file: String(ref), line: 1 };
}

export function findingLocations(finding) {
  const out = [];
  const seen = new Set();
  const push = (file, line, role) => {
    if (!file || typeof file !== 'string') return;
    const f = file.replace(/^\.\//, '').split('\\').join('/');
    const key = `${f}:${line || 1}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: f, line: Number(line) || 1, role: role || null });
  };
  for (const e of Array.isArray(finding.evidence) ? finding.evidence : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.file) {
      const s = /:\d+$/.test(e.file) && !e.line ? split(e.file) : { file: e.file, line: e.line };
      push(s.file, s.line, e.role);
    } else if (e.at) {
      const s = split(e.at);
      push(s.file, s.line, e.role);
    }
  }
  const fix = finding.fix || {};
  if (fix.file) push(fix.file, fix.line, null);
  // Last resort: file:line written in the text ("… (src/screens/Home.tsx:12)").
  if (!out.length) for (const m of `${finding.title || ''} ${finding.detail || ''}`.matchAll(CODE_REF)) push(m[1], m[2], null);
  return out;
}

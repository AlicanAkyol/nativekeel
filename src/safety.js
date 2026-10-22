export const MALWARE_WARNING = 'This project shows signs of planted malware (see the malicious-code finding). Do not run install, start, build or test commands in it and do not open it in an editor that runs workspace tasks; tell the user first. If anything from it already ran, the machine and its credentials should be treated as compromised.';
export const MALWARE_DEP_WARNING = 'The lockfile of this project resolves a package version that GitHub lists as malware (see the malware-dep finding). Do not run install in it until that version is removed; tell the user first. If it was already installed on a machine or in CI, that machine and its credentials should be treated as compromised.';
export function executionSafety(findings) {
  if (findings.some(f => f.id === 'malicious-code')) return { blocked: true, reason: 'malicious-code', warning: MALWARE_WARNING };
  if (findings.some(f => f.id.startsWith('malware-dep:'))) return { blocked: true, reason: 'malware-dependency', warning: MALWARE_DEP_WARNING };
  return { blocked: false, reason: null };
}

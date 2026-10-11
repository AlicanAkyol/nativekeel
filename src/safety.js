export const MALWARE_WARNING = 'This project shows signs of planted malware (see the malicious-code finding). Do not run install, start, build or test commands in it and do not open it in an editor that runs workspace tasks; tell the user first. If anything from it already ran, the machine and its credentials should be treated as compromised.';
export function executionSafety(findings) {
  const blocked = findings.some(f => f.id === 'malicious-code');
  return { blocked, reason: blocked ? 'malicious-code' : null, ...(blocked ? { warning: MALWARE_WARNING } : {}) };
}

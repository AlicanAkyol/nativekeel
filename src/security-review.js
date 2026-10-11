const isSecurity = f => f.area === 'security' || f.area === 'secret' || !!f.masvs;
export function securityOverview(result) {
  const findings = result.findings.filter(isSecurity);
  const risks = {
    'Credentials and private data': findings.filter(f => /^(?:credential-|password-|token-|clipboard-|keychain-|secret:|expo-secret|ai-key-|android-fileprovider|android-allow-backup|native-intent-file|native-archive)/.test(f.id)).map(f => f.id),
    'Account and backend access': findings.filter(f => /^(?:oauth-|firebase-|supabase-|deeplink-)/.test(f.id)).map(f => f.id),
    'Code execution and input handling': findings.filter(f => /^(?:webview-|remote-code-|sqlite-|native-intent-(?:sql|webview|redirection)|malicious-code|vscode-autorun)/.test(f.id)).map(f => f.id),
    'Transport, dependencies and other security': [],
  };
  const assigned = new Set(Object.values(risks).flat());
  risks['Transport, dependencies and other security'] = findings.filter(f => !assigned.has(f.id)).map(f => f.id);
  return {
    verdict: findings.some(f => f.severity !== 'info') ? 'Review the source-backed risks and their prerequisites.' : 'No matching security findings in this scan; this is not proof the app is secure.',
    risks: Object.fromEntries(Object.entries(risks).map(([name, ids]) => [name, { count: ids.length, findings: ids.slice(0, 5) }])),
    limitations: [
      'Static source/configuration checks do not prove exploitability or full MASVS compliance.',
      'Live backend access control, account A versus B, deployed rules, runtime behavior and release binaries are not tested.',
      'A zero count means no matching finding, not that a control passed.',
      ...(result.offline ? ['Online package/advisory checks were unavailable or skipped; see scan warnings.'] : []),
    ],
    flowCoverage: result.mobileSecurityCoverage,
    nativeCoverage: result.nativeSecurityCoverage,
  };
}
export function securityOnly(result) {
  const findings = result.findings.filter(isSecurity);
  const security = Object.fromEntries(Object.keys(result.security || {}).map(k => [k, findings.filter(f => f.masvs === k && f.severity !== 'info').length]));
  const scoped = { ...result, focus: 'security', findings, security };
  return { ...scoped, securityReview: securityOverview(scoped) };
}

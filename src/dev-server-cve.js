// CVE-2025-11953 (GHSA-399j-vxmf-hjvr, CVSS 9.8, in CISA's Known Exploited Vulnerabilities): the
// Metro development server's /open-url endpoint in @react-native-community/cli[-server-api] passes
// attacker input to an OS `open` call, so any page a developer visits while `npx react-native start`
// runs can run commands on their machine. It affects the toolchain, not the shipped app, but it is
// critical and actively exploited, so a project carrying a vulnerable version should know.
//
// Authoritative affected ranges (GitHub advisory), same for both packages:
//   >=18.0.0  <18.0.1          → fixed 18.0.1
//   >=19.0.0-alpha.0  <19.1.2  → fixed 19.1.2
//   >=20.0.0-alpha.0  <20.0.0  → fixed 20.0.0
// The cli is almost always a transitive dependency of react-native, so the version is read from
// node_modules and from every copy the lockfile resolves, never guessed from the range.
import fs from './read-boundary.js';
import path from 'node:path';
import { compareVersions } from './known-issues.js';
import { lockedCopies } from './lockfile.js';

const PACKAGES = ['@react-native-community/cli', '@react-native-community/cli-server-api'];

// A resolved version is vulnerable when it falls in one of the three ranges above. compareVersions
// ignores the prerelease tag, so a 20.0.0 prerelease is caught explicitly (20.0.0 itself is fixed).
function vulnerable(version) {
  const base = String(version).split('-')[0];
  const pre = String(version).includes('-');
  const major = Number(base.split('.')[0]);
  if (major === 18) return compareVersions(base, '18.0.1') < 0;
  if (major === 19) return compareVersions(base, '19.1.2') < 0;
  if (major === 20) return compareVersions(base, '20.0.0') < 0 || (compareVersions(base, '20.0.0') === 0 && pre);
  return false; // below 18 is not in the advisory; 20.0.0 stable and later are fixed
}

const installedVersion = (root, name) => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
    return /^\d/.test(v) ? v : null;
  } catch {
    return null;
  }
};

export function devServerCve(root) {
  const hits = new Map(); // package -> sorted vulnerable versions actually resolved
  for (const name of PACKAGES) {
    const versions = new Set();
    const inst = installedVersion(root, name);
    if (inst) versions.add(inst);
    for (const v of lockedCopies(root, name) || []) versions.add(v);
    const bad = [...versions].filter(vulnerable);
    if (bad.length) hits.set(name, bad.sort(compareVersions));
  }
  if (!hits.size) return [];
  const worst = [...hits.values()].flat().sort(compareVersions)[0];
  const patched = Number(worst.split('.')[0]) === 18 ? '18.0.1' : Number(worst.split('.')[0]) === 19 ? '19.1.2' : '20.0.0';
  const where = [...hits].map(([name, vs]) => `${name} ${vs.join(', ')}`).join('; ');
  return [
    {
      id: 'dev-server-rce-cve-2025-11953',
      severity: 'critical',
      area: 'security',
      title: `Metro development server can be made to run commands on your machine (CVE-2025-11953)`,
      detail: `${where}. The Metro dev server's \`/open-url\` endpoint passes a request's input to an OS \`open\` call (OS command injection, CVSS 9.8, GHSA-399j-vxmf-hjvr). While \`npx react-native start\` / \`expo start\` is running, any web page a developer opens can send that request and run commands on their machine; the flaw is in CISA's Known Exploited Vulnerabilities list, exploited in the wild to drop malware. This affects the development toolchain, not the app you ship, but it exposes every developer who runs the bundler. Update \`@react-native-community/cli\` and \`@react-native-community/cli-server-api\` to ${patched} or later (the fix is on 18.0.1, 19.1.2 and 20.0.0): bump it in your lockfile (an npm/yarn/pnpm override or resolution if it is transitive) or move to a React Native version that ships a fixed cli, and never bind Metro to a public interface (keep \`--host\` on localhost).`,
      fix: { kind: 'security', step: `Update @react-native-community/cli and @react-native-community/cli-server-api to ${patched}+ (patched: 18.0.1, 19.1.2, 20.0.0), re-install, and keep the Metro server bound to localhost.` },
    },
  ];
}

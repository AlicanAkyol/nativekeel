// Version-specific breakages that registries do not know about. Each entry was hit in a real
// upgrade and records where. This list is the part of NativeKeel that grows with every job.
//
// Matching: the installed version of `pkg` is within [from, to] (inclusive, either optional),
// React Native's minor is within [rnFrom, rnTo], and `when` holds:
//   'always'      always
//   'newArch'     the New Architecture is on, or the report says it must be turned on

export const KNOWN_ISSUES = [
  {
    id: 'drawer6-reanimated4',
    pkg: '@react-navigation/drawer',
    from: '6.0.0',
    to: '6.99.99',
    rnFrom: 79,
    when: 'always',
    severity: 'medium',
    title: '@react-navigation/drawer 6 cannot run on Reanimated 4, which React Native 0.82+ needs',
    detail: "Its drawer uses useAnimatedGestureHandler, removed in Reanimated 4 (found in lib/module/views/modern/Drawer.js). Reanimated 3 supports React Native up to 0.81, so the hop past 0.81 also means React Navigation 7 for every navigator. Plan that JS migration before the React Native hop.",
    source: 'real upgrade of an RN 0.77 app, 2026-10-03 (source inspection)',
  },
  {
    id: 'rnfs-fork-codegen-eventemitter',
    pkg: '@dr.pogodin/react-native-fs',
    from: '2.37.0',
    rnTo: 77,
    when: 'always',
    severity: 'high',
    title: '@dr.pogodin/react-native-fs 2.37+ breaks pod install on React Native 0.77',
    detail: "Its TurboModule spec uses EventEmitter properties that this React Native version's codegen rejects (UnsupportedModulePropertyParserError, property 'onDownloadBegin'). Pin 2.36.2 until React Native is upgraded. Its peer range says react-native: *, so npm will not warn you.",
    source: 'real upgrade of an RN 0.77 app, 2026-10-03',
  },
];

// Semver-ish compare on major.minor.patch, ignoring pre-release tags.
export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function matchKnownIssues({ deps, rnVersion, newArchOn, newArchRequired }) {
  const rnMinor = rnVersion ? Number(rnVersion.split('.')[1]) : null;
  const out = [];
  for (const issue of KNOWN_ISSUES) {
    const dep = deps.find((d) => d.name === issue.pkg);
    if (!dep || !dep.version) continue;
    if (issue.from && compareVersions(dep.version, issue.from) < 0) continue;
    if (issue.to && compareVersions(dep.version, issue.to) > 0) continue;
    if (rnMinor === null) continue;
    if (issue.rnFrom !== undefined && rnMinor < issue.rnFrom) continue;
    if (issue.rnTo !== undefined && rnMinor > issue.rnTo) continue;
    if (issue.when === 'newArch' && !newArchOn && !newArchRequired) continue;
    out.push({ issue, dep });
  }
  return out;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Builds a throwaway project from a { 'relative/path': content } map.
export function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativekeel-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

const versions = (list) => Object.fromEntries(list.map((v) => [v, {}]));

// Canned registry answers so tests never touch the network.
export function fakeRegistry({ directory = {}, latest = {}, published = {}, rnPeers = [] } = {}) {
  return async (url) => {
    if (url.startsWith('https://reactnative.directory/api/library?name=')) {
      const names = decodeURIComponent(url.split('name=')[1]).split(',');
      return Object.fromEntries(names.filter((n) => directory[n]).map((n) => [n, directory[n]]));
    }
    if (url === 'https://registry.npmjs.org/react-native') {
      // 1000.0.0 mimics the odd placeholder releases real registries contain.
      return { 'dist-tags': { latest: '0.87.1' }, versions: versions(['0.76.0', '0.77.1', '0.85.0', '0.86.2', '0.87.1', '1000.0.0']) };
    }
    if (url === 'https://registry.npmjs.org/expo') {
      // 55.0.0 is published but not tagged latest yet, like a real SDK preview.
      return { 'dist-tags': { latest: '54.0.3' }, versions: versions(['50.0.1', '52.0.0', '53.0.9', '54.0.3', '55.0.0']) };
    }
    const full = url.match(/^https:\/\/registry\.npmjs\.org\/([^/]+(?:%2F[^/]+)?)$/);
    if (full && published[decodeURIComponent(full[1])]) {
      const name = decodeURIComponent(full[1]);
      const v = latest[name] || '1.0.0';
      return {
        'dist-tags': { latest: v },
        time: { [v]: `${published[name]}T10:00:00.000Z` },
        versions: { [v]: rnPeers.includes(name) ? { peerDependencies: { 'react-native-vector-icons': '*' } } : {} },
      };
    }
    const m = url.match(/^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      return latest[name] ? { version: latest[name] } : null;
    }
    return null;
  };
}

// Realistic-looking fake keys, built from parts so the repository never contains a literal
// that secret scanners flag. (AWS's documented EXAMPLE keys are now treated as placeholders.)
export const FAKE_AWS_ID = ['AKIA', 'Q7Z3M9N2', 'P4R6T8V1'].join('');
export const FAKE_AWS_SECRET = ['k7Pq2Rs9', 'Tv4Wx6Yz', '1Ab3Cd5E', 'f7Gh9Jk2', 'Lm4Np6Qr'].join('');

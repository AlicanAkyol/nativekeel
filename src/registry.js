const UA = { 'User-Agent': 'nativekeel' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET a JSON document. Returns null for "not found" (a package that does not exist is an
// answer, not an error). Rate limits (429) and server errors are retried with backoff; if the
// request still fails, `stats.failed` is incremented so the report can say it is incomplete.
export async function fetchJson(url, headers = {}, stats = null, { retries = 3, wait = sleep, body = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const init = { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30000) };
      if (body) Object.assign(init, { method: 'POST', body });
      const res = await fetch(url, init);
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await wait(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt, 10000));
        continue;
      }
    } catch {
      if (attempt < retries) {
        await wait(1000 * 2 ** attempt);
        continue;
      }
    }
    if (stats) stats.failed++;
    return null;
  }
}

// All network access goes through one `get` function so tests can replace it.
export function createRegistry(get = fetchJson) {
  return {
    // React Native Directory supports looking up many packages in one request.
    async directoryInfo(names) {
      const out = {};
      for (let i = 0; i < names.length; i += 25) {
        const chunk = names.slice(i, i + 25).map(encodeURIComponent).join(',');
        const data = await get(`https://reactnative.directory/api/library?name=${chunk}`);
        if (data) Object.assign(out, data);
      }
      return out;
    },

    async npmLatest(names, concurrency = 12) {
      const out = {};
      const queue = [...names];
      const worker = async () => {
        while (queue.length) {
          const name = queue.shift();
          const data = await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
          out[name] = data ? data.version : null;
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return out;
    },

    // Publish date of each package's latest version. Needs the full packument (the abbreviated
    // one only has a `modified` stamp that also moves on metadata edits), so call it only for
    // the few packages where release recency decides the verdict.
    async publishDates(names, concurrency = 8) {
      const out = {};
      const queue = [...names];
      const worker = async () => {
        while (queue.length) {
          const name = queue.shift();
          const data = await get(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
          const latest = data && data['dist-tags'] && data['dist-tags'].latest;
          const manifest = latest && data.versions ? data.versions[latest] || {} : {};
          out[name] = {
            date: latest && data.time && data.time[latest] ? data.time[latest].slice(0, 10) : null,
            // How tightly it is tied to React Native: through its dependencies ('deps'; some only
            // indirectly, e.g. react-native-elements peers on react-native-vector-icons), only by
            // name ('name'), or not at all (null).
            rnLink: ['peerDependencies', 'dependencies'].some((k) =>
              Object.keys(manifest[k] || {}).some((d) => /^(react-native|expo)(-|$)|^@react-native(-community)?\//.test(d)),
            )
              ? 'deps'
              : /react-native|^expo-/.test(name)
                ? 'name'
                : null,
          };
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return out;
    },

    // Whether the version in use, and the latest, ship a codegen spec (`codegenConfig` in their
    // package.json), i.e. native New Architecture support. React Native Directory's flag lags
    // releases, so this is the tie-breaker before calling a package a blocker.
    async codegenSupport(list, concurrency = 8) {
      const out = {};
      const queue = [...list];
      const manifest = (name, tag) => get(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${tag}`);
      const worker = async () => {
        while (queue.length) {
          const { name, version } = queue.shift();
          const latest = await manifest(name, 'latest');
          if (!latest) continue;
          const used = version && version !== latest.version ? await manifest(name, version) : latest;
          out[name] = { latest: latest.version, latestHas: !!latest.codegenConfig, usedHas: !!(used && used.codegenConfig) };
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return out;
    },

    // Security advisories for exact versions (the endpoint `npm audit` uses). Sends package
    // names and versions, nothing else. Returns { name: [advisory] }, or null if it failed.
    async advisories(versions) {
      const out = {};
      const names = Object.keys(versions);
      for (let i = 0; i < names.length; i += 200) {
        const chunk = Object.fromEntries(names.slice(i, i + 200).map((n) => [n, [versions[n]]]));
        const data = await get('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', { 'Content-Type': 'application/json' }, JSON.stringify(chunk));
        if (!data) return null;
        Object.assign(out, data);
      }
      return out;
    },

    // Stable versions of a package, newest release line first.
    async releaseLines(name, pick) {
      // The abbreviated "install" document is a fraction of the full packument's size.
      const data = await get(`https://registry.npmjs.org/${name}`, { Accept: 'application/vnd.npm.install-v1+json' });
      if (!data || !data.versions) return null;
      const stable = Object.keys(data.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
      // The `latest` dist-tag is the authority: lines published above it are previews
      // (Expo ships the next SDK's packages before tagging it). `pick` returns NaN for
      // versions outside the release scheme; NaN would corrupt the sort.
      const latest = data['dist-tags'].latest;
      const top = pick(latest);
      const lines = [...new Set(stable.map(pick))]
        .filter((n) => Number.isFinite(n) && n <= top)
        .sort((a, b) => b - a);
      return { latest, lines };
    },
  };
}

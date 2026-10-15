// Browser entry for nativekeel.com/check: the CLI's own analysis, run on a project that consists
// only of the pasted package.json (and app.json, if given). Same rules, same messages.
import { setFiles } from './vfs.js';
import { loadProject } from '../src/project.js';
import { analyze } from '../src/analyze.js';
import { buildPlan } from '../src/plan.js';

const ROOT = '/app';
const realFetch = globalThis.fetch.bind(globalThis);

// React Native Directory's per-package endpoint sends no CORS header; its search endpoint does
// and returns the same fields. npm's bulk advisory endpoint cannot be called from a browser.
async function browserFetch(input, init = {}) {
  const url = String(input);
  const clean = { ...init, headers: {} };
  const dir = url.match(/^https:\/\/reactnative\.directory\/api\/library\?name=(.*)$/);
  if (dir) {
    const names = dir[1].split(',').map(decodeURIComponent).filter(Boolean);
    const out = {};
    await Promise.all(names.map(async (name) => {
      try {
        const res = await realFetch(`https://reactnative.directory/api/libraries?search=${encodeURIComponent(name)}&limit=20`, { signal: init.signal });
        if (!res.ok) return;
        const data = await res.json();
        const hit = (data.libraries || []).find((l) => l.npmPkg === name);
        if (hit) out[name] = hit;
      } catch { /* leave unknown */ }
    }));
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/\/-\/npm\/v1\/security\/advisories\/bulk/.test(url)) return new Response('{}', { status: 404 });
  return realFetch(url, clean);
}

export async function runCheck({ packageJson, appJson = '' }) {
  const files = { [`${ROOT}/package.json`]: packageJson };
  if (appJson.trim()) files[`${ROOT}/app.json`] = appJson;
  setFiles(files);
  const prev = globalThis.fetch;
  globalThis.fetch = browserFetch;
  try {
    const project = loadProject(ROOT);
    const result = await analyze(project);
    let plan = null;
    try { plan = buildPlan(result); } catch { /* plan is optional here */ }
    return { result, plan };
  } finally {
    globalThis.fetch = prev;
  }
}

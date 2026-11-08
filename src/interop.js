import fs from './read-boundary.js';
import path from 'node:path';
import { findPackageDir } from './project.js';
import { stripComments } from './upcoming.js';

// Static checks for native modules that will run through the New Architecture interop layer
// (packages without their own codegen spec). Verified on a real upgrade: Kotlin @ReactMethods
// written as `fun x(...) = scope.launch { }` return a kotlinx.coroutines.Job, the interop only
// accepts void, and the whole module fails to load (a red screen if it is imported at startup).

const REACT_METHOD_RETURNS_JOB =
  /@ReactMethod(?!\s*\(\s*isBlockingSynchronousMethod\s*=\s*true)[^\n]*\n(?:\s*@[^\n]*\n)*\s*(?:override\s+)?fun\s+(\w+)\s*\([^)]*\)\s*=\s*([\w.]+\.)?(launch|async)\s*[({]/g;

function kotlinFiles(dir, out = []) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'build' && e.name !== 'generated') kotlinFiles(full, out);
    } else if (e.name.endsWith('.kt')) {
      out.push(full);
    }
  }
  return out;
}

// Returns [{ name, methods: [...] }] for installed native packages with interop-breaking methods.
export function interopProblems(project, deps) {
  if (!project.hasNodeModules) return [];
  const out = [];
  for (const dep of deps.filter((d) => d.native)) {
    const dir = findPackageDir(project.root, dep.name);
    if (!dir) continue;
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      // unreadable
    }
    if (manifest.codegenConfig) continue; // has its own TurboModule spec, no interop involved
    const methods = [];
    for (const file of kotlinFiles(path.join(dir, 'android'))) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      for (const [, method, receiver, call] of text.matchAll(REACT_METHOD_RETURNS_JOB)) {
        // A bare call can resolve to a local helper (patches can keep the name `launch`).
        // Without resolving Kotlin overloads, only trust a qualified call in that case.
        if (!receiver && new RegExp(`\\bfun\\s+${call}\\s*\\(`).test(text)) continue;
        methods.push(method);
      }
    }
    if (methods.length) out.push({ name: dep.name, version: dep.version, methods });
  }
  return out;
}

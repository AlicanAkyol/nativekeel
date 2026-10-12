// Names are also used as paths and command arguments. Accept legacy uppercase names, but
// never separators other than the one scope slash, option prefixes, whitespace or shell syntax.
export const validPackageName = (name) => typeof name === 'string' && name.length <= 214 && /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name);
// Returns a copy without entries that are not valid package names or version strings, and
// the names it left out. One typo ("@types/") or a workspace alias ("@global-ui") should not
// stop the whole scan; the skipped names never reach a path, a command or a registry request.
export function validateManifest(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must be an object');
  if (pkg.name !== undefined && typeof pkg.name !== 'string') throw new Error('package.json name must be a string');
  const clean = { ...pkg };
  const skipped = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) throw new Error(`Invalid dependency map in package.json ${field}`);
    clean[field] = {};
    for (const [name, spec] of Object.entries(deps)) {
      if (validPackageName(name) && typeof spec === 'string') clean[field][name] = spec;
      else skipped.push(name);
    }
  }
  return { pkg: clean, skipped: [...new Set(skipped)] };
}

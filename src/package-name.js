// Names are also used as paths and command arguments. Accept legacy uppercase names, but
// never separators other than the one scope slash, option prefixes, whitespace or shell syntax.
export const validPackageName = (name) => typeof name === 'string' && name.length <= 214 && /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name);
export function validateManifest(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must be an object');
  if (pkg.name !== undefined && typeof pkg.name !== 'string') throw new Error('package.json name must be a string');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) throw new Error(`Invalid dependency map in package.json ${field}`);
    if (Object.entries(deps).some(([name, spec]) => !validPackageName(name) || typeof spec !== 'string')) throw new Error(`Invalid dependency name or version in package.json ${field}`);
  }
}

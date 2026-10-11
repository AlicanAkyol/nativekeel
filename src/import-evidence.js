import { lex, split } from './security-source.js';

// A deliberately narrow syntax signal. Dynamic import() may be a TypeScript type query;
// no runtime recommendation is inferred from it. This is not a resolver or usage proof.
export function rootImportEvidence(text) {
  let tokens;
  try { tokens = lex(text); } catch { return []; }
  const wanted = (t) => t?.kind === 'string' && ['lodash', 'moment'].includes(t.value);
  const directRequire = (i) => tokens[i]?.kind === 'id' && tokens[i].value === 'require'
    && !['.', '?.'].includes(tokens[i - 1]?.value) && tokens[i + 1]?.value === '('
    && tokens[i + 2]?.kind === 'string' && tokens[i + 3]?.value === ')';
  // A declaration, parameter, assignment or otherwise ambiguous require reference anywhere
  // in the file makes CommonJS evidence uncertain. Prefer missing an opportunity to inventing it.
  const uncertainRequire = tokens.some((t, i) => t.kind === 'id' && t.value === 'require' && !directRequire(i));
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'id') continue;
    if (!uncertainRequire && directRequire(i) && wanted(tokens[i + 2])) {
      found.push({ name: tokens[i + 2].value, line: t.line });
      continue;
    }
    if (t.value !== 'import' || t.scope !== '') continue;
    // A declaration must start a source line or follow a statement boundary, not JSX text.
    const prefix = text.slice(text.lastIndexOf('\n', t.start - 1) + 1, t.start).trimEnd();
    if (prefix.trim() && !prefix.endsWith(';')) continue;
    let j = i + 1;
    if (tokens[j]?.kind === 'id') {
      if (['type', 'typeof'].includes(tokens[j].value)) continue;
      j++;
      if (tokens[j]?.value === ',') j++;
    }
    let hasRuntimeBinding = tokens[i + 1]?.kind === 'id';
    if (tokens[j]?.value === '{' && tokens[j].kind === 'punct') {
      const end = tokens[j].match;
      if (end === undefined) continue;
      const parts = split(tokens.slice(j + 1, end)).filter((p) => p.length);
      // Inline `type Foo` / `type Foo as Bar` is erased. `type as alias` is a value binding.
      hasRuntimeBinding ||= parts.some((p) => !(p[0].value === 'type' && p[1]?.kind === 'id' && p[1].value !== 'as'));
      j = end + 1;
    } else if (tokens[j]?.value === '*' && tokens[j + 1]?.value === 'as' && tokens[j + 2]?.kind === 'id') {
      hasRuntimeBinding = true;
      j += 3;
    }
    if (hasRuntimeBinding && tokens[j]?.value === 'from' && wanted(tokens[j + 1])) found.push({ name: tokens[j + 1].value, line: t.line });
  }
  return found;
}

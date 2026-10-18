import fs from './read-boundary.js';
import path from 'node:path';
import { gitIgnored } from './git.js';

// A bounded lexer for evidence, not a JavaScript parser. No project code is imported.
// Strings/comments/regex literals cannot manufacture calls; template expressions stay visible.
export function lex(text) {
  const out = []; let i = 0, line = 1;
  const push = (kind, value, start, row) => { if (out.length >= 60000) throw new Error('Static token limit exceeded'); out.push({ kind, value, start, end: i, line: row }); };
  const advance = () => { if (text[i] === '\n') line++; return text[i++]; };
  const code = (template = false, level = 0) => {
    if (level > 64) throw new Error('Template nesting exceeds static analysis limit');
    let braces = 0;
    while (i < text.length) {
      const ch = text[i], start = i, row = line;
      if (/\s/.test(ch)) { advance(); continue; }
      if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') advance(); continue; }
      if (text.startsWith('/*', i)) { advance(); advance(); while (i < text.length && !text.startsWith('*/', i)) advance(); if (i < text.length) { advance(); advance(); } continue; }
      if (ch === '"' || ch === "'") {
        advance(); let value = '';
        while (i < text.length && text[i] !== ch) { if (text[i] === '\\') { advance(); value += advance() || ''; } else value += advance(); }
        if (i < text.length) advance(); push('string', value, start, row); continue;
      }
      if (ch === '`') {
        advance(); push('punct', '`', start, row); let segment = '', pos = i, segmentLine = line;
        while (i < text.length) {
          if (text[i] === '\\') { segment += advance(); segment += advance() || ''; continue; }
          if (text[i] === '`' || text.startsWith('${', i)) {
            push('string', segment, pos, segmentLine); segment = '';
            if (text[i] === '`') { const p = i, l = line; advance(); push('punct', '`', p, l); break; }
            const p = i, l = line; advance(); advance(); push('punct', '${', p, l); code(true, level + 1); pos = i; segmentLine = line;
          } else segment += advance();
        }
        continue;
      }
      // Regex literals after expression-introducing punctuation/keywords. Ambiguous slash
      // forms are not used as security evidence; this is deliberately conservative.
      const prev = out.at(-1)?.value;
      if (ch === '/' && (!prev || ['=', '(', ',', ':', '[', '!', 'return', '=>', '&&', '||'].includes(prev))) {
        advance(); let cls = false;
        while (i < text.length) { const c = advance(); if (c === '\\') advance(); else if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') break; }
        while (/[a-z]/i.test(text[i] || '') && i < text.length) advance(); push('regex', '', start, row); continue;
      }
      const id = text.slice(i).match(/^[A-Za-z_$][\w$]*/);
      if (id) { i += id[0].length; push('id', id[0], start, row); continue; }
      const num = text.slice(i).match(/^\d+(?:\.\d+)?/);
      if (num) { i += num[0].length; push('number', num[0], start, row); continue; }
      const op = ['===', '!==', '=>', '?.', '==', '!=', '&&', '||', '??', '+=', '-=', '++', '--', '...'].find(s => text.startsWith(s, i));
      if (op) { i += op.length; push('punct', op, start, row); continue; }
      advance(); push('punct', ch, start, row);
      if (template && ch === '}' && braces === 0) return;
      if (ch === '{') braces++;
      if (ch === '}') braces--;
    }
  };
  code();
  const stack = []; let nextScope = 1;
  for (let n = 0; n < out.length; n++) {
    const t = out[n]; t.index = n; t.scope = stack.map(x => x.scope).join('/');
    if (stack.length > 256) throw new Error('Static delimiter nesting limit exceeded');
    if (['(', '[', '{', '${'].includes(t.value) && t.kind === 'punct') stack.push({ index: n, scope: nextScope++, close: { '(': ')', '[': ']', '{': '}', '${': '}' }[t.value] });
    else if (stack.length && t.value === stack.at(-1).close && t.kind === 'punct') { const open = stack.pop(); t.match = open.index; out[open.index].match = n; }
  }
  // Lexical block scope excludes call/array delimiters. Object scopes are conservative too.
  const blocks = [];
  for (const t of out) { if (t.value === '}' && t.kind === 'punct') blocks.pop(); t.block = blocks.join('/'); if (['{', '${'].includes(t.value) && t.kind === 'punct') blocks.push(t.index); }
  return out;
}
export function split(tokens, delimiter = ',') {
  const result = []; let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.match !== undefined && t.match > t.index) { while (i + 1 < tokens.length && tokens[i + 1].index <= t.match) i++; }
    else if (t.kind === 'punct' && t.value === delimiter) { result.push(tokens.slice(start, i)); start = i + 1; }
  }
  result.push(tokens.slice(start)); return result;
}
export const values = tokens => tokens.map(t => t.kind === 'string' ? JSON.stringify(t.value) : t.value).join('');
export function calls(tokens) {
  const result = [];
  const positions = new Map(tokens.map((t, i) => [t.index, i]));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value !== '(' || t.kind !== 'punct' || t.match === undefined || tokens[i - 1]?.kind !== 'id') continue;
    let start = i - 1;
    while (start > 1 && ['.', '?.'].includes(tokens[start - 1].value) && tokens[start - 2].kind === 'id') start -= 2;
    if (['function', 'new'].includes(tokens[start - 1]?.value) && tokens[start - 1].value === 'function') continue;
    const close = positions.get(t.match);
    if (close === undefined) continue;
    result.push({ name: values(tokens.slice(start, i)), token: tokens[start], open: t, args: split(tokens.slice(i + 1, close)) });
  }
  return result;
}
export function objectProperties(tokens) {
  if (tokens[0]?.value !== '{' || tokens.at(-1)?.value !== '}') return null;
  const props = new Map();
  for (const part of split(tokens.slice(1, -1))) {
    if (!part.length) continue;
    if (!['id', 'string'].includes(part[0].kind) || part[1]?.value !== ':' || props.has(part[0].value)) return null;
    props.set(part[0].value, part.slice(2));
  }
  return props;
}
export function declarations(tokens) {
  const decls = [];
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i].value !== 'const' || tokens[i + 1].kind !== 'id' || tokens[i + 2].value !== '=') continue;
    let end = i + 3;
    while (end < tokens.length) {
      const t = tokens[end];
      if (t.kind === 'punct' && [';', ','].includes(t.value) || t.value === '}' || (end > i + 3 && t.line > tokens[end - 1].line && !['.', '?.', '+', '-', '&&', '||', '?', ':', '(', '['].includes(t.value) && !['+', '-', '&&', '||', '?', ':', '=', 'await'].includes(tokens[end - 1].value))) break;
      if (t.match !== undefined && t.match > end) end = t.match + 1; else end++;
    }
    decls.push({ name: tokens[i + 1].value, token: tokens[i + 1], expr: tokens.slice(i + 3, end) });
  }
  return decls;
}
export function resolveLocal(expr, tokens, decls, before, depth = 0) {
  if (expr.length !== 1 || expr[0].kind !== 'id' || depth > 6) return expr;
  const d = decls.filter(d => d.name === expr[0].value && d.token.index < before.index && d.token.block === before.block).at(-1);
  if (!d || tokens.slice(d.token.index + 2, before.index).some((t, i, a) => t.value === d.name && ['=', '+=', '-=', '++', '--'].includes(a[i + 1]?.value))) return expr;
  return resolveLocal(d.expr, tokens, decls, d.token, depth + 1);
}
const SKIP = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage', 'vendor', '__tests__', '__mocks__', 'test', 'tests', 'androidTest', 'e2e', 'fixtures', 'examples', 'backend', 'server', 'web_app', 'desktop_app']);
export function sourceFiles(root, extensions = /\.(?:[cm]?[jt]sx?|xml)$/) {
  const files = []; const skipped = { unreadable: 0, oversized: 0, depth: 0, symlink: 0 };
  const ignored = gitIgnored(root);
  const walk = (dir, depth) => {
    if (depth > 20) { skipped.depth++; return; }
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { skipped.unreadable++; return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (ignored(f)) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.') && !(e.name === 'functions' && path.basename(dir) === 'supabase')) walk(f, depth + 1); }
      else if (e.isSymbolicLink()) skipped.symlink++;
      else if (e.isFile() && extensions.test(e.name) && !/\.(?:test|spec|d|web)\.[cm]?[jt]sx?$/.test(e.name)) {
        try { if (fs.statSync(f).size > 512 * 1024) { skipped.oversized++; continue; } files.push({ file: path.relative(root, f), text: fs.readFileSync(f, 'utf8') }); } catch { skipped.unreadable++; }
      }
    }
  };
  walk(root, 0); return { files, skipped };
}

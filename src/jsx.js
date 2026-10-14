// A bounded JSX element reader for evidence, not a JavaScript parser. It finds JSX elements in
// expression position and returns their names, attributes and children. Anything it cannot
// read with confidence throws, and callers skip the whole file rather than guess.
// No project code is imported or executed.

const MAX_ELEMENTS = 20000;
const MAX_DEPTH = 200;
const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[\w$]/;
// After these, `<` starts JSX rather than a comparison or a type argument.
const JSX_BEFORE_PUNCT = new Set(['(', ',', '=', ':', '?', '&', '|', '{', '}', '[', '!', ';', '>']);
const JSX_BEFORE_WORD = new Set(['return', 'yield', 'default', 'case', 'else', 'do', 'in', 'of', 'await']);

export function parseJsx(text) {
  let i = 0;
  let line = 1;
  let count = 0;
  const lines = [];
  for (let n = text.indexOf('\n'); n !== -1; n = text.indexOf('\n', n + 1)) lines.push(n);
  const lineAt = (pos) => {
    let lo = 0, hi = lines.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  const fail = (why) => { throw new Error(`JSX not readable at line ${lineAt(i)}: ${why}`); };

  const skipString = (q) => {
    i++;
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n' && q !== '`') fail('unterminated string');
      i++;
    }
    if (i >= text.length) fail('unterminated string');
    i++;
  };
  const skipComment = () => {
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; return true; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end === -1) fail('unterminated comment'); i = end + 2; return true; }
    return false;
  };
  const skipSpace = () => { for (;;) { while (i < text.length && /\s/.test(text[i])) i++; if (!skipComment()) return; } };

  // Previous significant token before position `pos`, to decide whether `<` or `/` starts JSX
  // or a regex. Looks back over whitespace and line comments only.
  const prevToken = (pos) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) return { punct: '(', at: -1 };
    if (ID_CHAR.test(text[j])) {
      let s = j;
      while (s > 0 && ID_CHAR.test(text[s - 1])) s--;
      return { word: text.slice(s, j + 1), at: s };
    }
    return { punct: text[j], at: j };
  };
  const jsxStartsAt = (pos) => {
    if (text[pos] !== '<') return false;
    const next = text[pos + 1];
    if (next !== '>' && !ID_START.test(next || '')) return false;
    const prev = prevToken(pos);
    if (prev.word) return JSX_BEFORE_WORD.has(prev.word);
    if (prev.punct === '>' && text[prev.at - 1] !== '=') return false; // `a > <b` is not JSX; `=> <X/>` is
    return JSX_BEFORE_PUNCT.has(prev.punct);
  };
  const regexStartsAt = (pos) => {
    const prev = prevToken(pos);
    if (prev.word) return JSX_BEFORE_WORD.has(prev.word) || prev.word === 'typeof';
    return JSX_BEFORE_PUNCT.has(prev.punct) && prev.punct !== '}' && prev.punct !== '>';
  };
  const skipRegex = () => {
    i++;
    let cls = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) break;
      else if (c === '\n') fail('unterminated regex');
    }
    while (i < text.length && /[a-z]/i.test(text[i])) i++;
  };

  // JavaScript code until `closer` (or end of file). JSX found inside is collected.
  const code = (closer, depth) => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    const found = [];
    const stack = [];
    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (skipComment()) continue;
      if (ch === '"' || ch === "'") { skipString(ch); continue; }
      if (ch === '`') { template(found, depth); continue; }
      if (ch === '/' && regexStartsAt(i)) { skipRegex(); continue; }
      if (ch === '<' && jsxStartsAt(i)) {
        // `<T,>(x) =>` and `<T extends U>(x) =>` are generic arrow functions in TSX, not elements.
        const generic = text.slice(i, i + 200).match(/^<[A-Za-z_$][\w$]*\s*(?:,|extends\b)[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\(/);
        if (generic) { i += generic[0].length - 1; continue; }
        found.push(element(depth + 1));
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') { stack.push(ch); i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (!stack.length) {
          if (ch === closer) return found;
          fail(`unexpected ${ch}`);
        }
        const open = stack.pop();
        if ({ ')': '(', ']': '[', '}': '{' }[ch] !== open) fail('unbalanced brackets');
        i++;
        continue;
      }
      i++;
    }
    if (closer || stack.length) fail('unexpected end of file');
    return found;
  };
  const template = (found, depth) => {
    i++;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') { i += 2; continue; }
      if (text.startsWith('${', i)) { i += 2; found.push(...code('}', depth + 1)); i++; continue; }
      i++;
    }
    if (i >= text.length) fail('unterminated template');
    i++;
  };

  const name = () => {
    const start = i;
    while (i < text.length && /[\w$.:-]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  const expression = (depth) => {
    // At `{`: an attribute value or a child expression. Returns its raw text and nested JSX.
    const start = ++i;
    skipSpace();
    if (text[i] === '}') { i++; return { raw: '', elements: [], empty: true }; }
    i = start;
    const elements = code('}', depth);
    const raw = text.slice(start, i).trim();
    i++;
    return { raw, elements, empty: !raw.replace(/\/\*[\s\S]*?\*\//g, '').trim() };
  };

  const element = (depth) => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    if (++count > MAX_ELEMENTS) fail('too many elements');
    const start = i;
    const row = lineAt(i);
    i++; // <
    const tag = name();
    // Type arguments on a generic component: <Select<Option> ...>.
    if (text[i] === '<') {
      let level = 0;
      do {
        if (text[i] === '<') level++;
        else if (text[i] === '>') level--;
        i++;
      } while (i < text.length && level > 0);
    }
    const attrs = new Map();
    let spread = false;
    for (;;) {
      skipSpace();
      if (i >= text.length) fail('unterminated tag');
      const selfClosing = text.slice(i, i + 40).match(/^\/\s*>/);
      if (selfClosing) { i += selfClosing[0].length; return { name: tag, attrs, spread, children: [], line: row, start, end: i }; }
      if (text[i] === '>') { i++; break; }
      if (text[i] === '{') {
        const e = expression(depth);
        if (!e.raw.startsWith('...')) fail('unexpected attribute expression');
        spread = true;
        continue;
      }
      const attr = name();
      if (!attr) fail('attribute name expected');
      skipSpace();
      if (text[i] !== '=') { attrs.set(attr, { kind: 'true' }); continue; }
      i++;
      skipSpace();
      if (text[i] === '"' || text[i] === "'") {
        const q = text[i];
        const end = text.indexOf(q, i + 1);
        if (end === -1) fail('unterminated attribute');
        attrs.set(attr, { kind: 'string', value: text.slice(i + 1, end) });
        i = end + 1;
      } else if (text[i] === '{') {
        const e = expression(depth);
        attrs.set(attr, { kind: 'expr', raw: e.raw, elements: e.elements });
      } else if (text[i] === '<') {
        attrs.set(attr, { kind: 'element', element: element(depth + 1) });
      } else fail('attribute value expected');
    }
    const children = [];
    for (;;) {
      if (i >= text.length) fail(`unclosed <${tag}>`);
      if (text.startsWith('</', i)) {
        i += 2;
        skipSpace();
        const closing = name();
        skipSpace();
        if (closing !== tag || text[i] !== '>') fail(`mismatched </${closing}> for <${tag}>`);
        i++;
        return { name: tag, attrs, spread, children, line: row, start, end: i };
      }
      if (text[i] === '<') { children.push({ kind: 'element', element: element(depth + 1) }); continue; }
      if (text[i] === '{') {
        const e = expression(depth);
        if (!e.empty) children.push({ kind: 'expr', raw: e.raw, elements: e.elements });
        continue;
      }
      const s = i;
      while (i < text.length && text[i] !== '<' && text[i] !== '{') i++;
      const value = text.slice(s, i);
      if (value.trim()) children.push({ kind: 'text', value: value.trim() });
    }
  };

  return code('', 0);
}

// Every element in the tree, depth first, including those inside attributes and expressions.
export function* walkElements(elements) {
  for (const el of elements) {
    yield el;
    for (const a of el.attrs.values()) {
      if (a.kind === 'expr') yield* walkElements(a.elements);
      if (a.kind === 'element') yield* walkElements([a.element]);
    }
    for (const c of el.children) {
      if (c.kind === 'element') yield* walkElements([c.element]);
      if (c.kind === 'expr') yield* walkElements(c.elements);
    }
  }
}

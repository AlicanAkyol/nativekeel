import fs from './read-boundary.js';
import path from 'node:path';
import { SITE_URL } from './config.js';
import { gitIgnored } from './git.js';

// Render loops: state updates that run on every render, so React renders again, forever. The app
// freezes or shows "Maximum update depth exceeded" / "Too many re-renders". Only the certain
// cases are reported:
//   onPress={setOpen(true)}                     a setter called (not passed) in a JSX handler
//   useEffect(() => { setItems([...]) })        no dependency array, new value every run
//   useEffect(() => { setN(n + 1) }, [n])       depends on the state it changes
// A setter inside an if, after an early return, or with a constant value is left alone: React
// stops when the value does not change, and a guard usually ends the loop.

const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', '.expo', 'coverage', '__tests__', '__mocks__', 'e2e', 'vendor', 'web-build']);
const MAX_FILES = 4000;

function sourceFiles(root) {
  const out = [];
  const ignored = gitIgnored(root);
  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.') && !ignored(path.join(dir, e.name))) walk(path.join(dir, e.name));
      } else if (/\.[jt]sx?$/.test(e.name) && !/\.(test|spec|stories)\.[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') && !ignored(path.join(dir, e.name))) out.push(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

// Comments and string contents become spaces (same length), so braces and names inside them do
// not count and offsets still map to lines.
function blank(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, ' ') + (text[j] === c ? c : '');
      i = text[j] === c ? j + 1 : j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index of the bracket that closes the one at `open`.
function closing(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// A value that differs on every call: a new object/array, `new X`, an updater function, or the
// state itself changed with an operator.
function alwaysNew(arg, state) {
  const a = arg.trim();
  if (/^[[{]/.test(a) || /^new\s/.test(a)) return true;
  if (/^\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>/.test(a)) return !/^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\1\s*$/.test(a);
  return new RegExp(`(^|[^\\w$.])${state}([^\\w$]|$)`).test(a) && /[-+*/!%]|\.\.\.|\bconcat\(|\.map\(|\.filter\(/.test(a);
}

function fileLoops(text) {
  const src = blank(text);
  const setters = new Map(); // setter -> state
  for (const m of src.matchAll(/\[\s*([A-Za-z_$][\w$]*)\s*,\s*(set[A-Z][\w$]*)\s*\]\s*=\s*(?:React\.)?useState\b/g)) setters.set(m[2], m[1]);
  if (!setters.size) return [];
  const hits = [];

  // 1. A setter called in a JSX event prop: it runs during render.
  for (const m of src.matchAll(/\bon[A-Z]\w*\s*=\s*\{\s*(set[A-Z][\w$]*)\s*\(/g)) {
    if (setters.has(m[1])) hits.push({ line: lineOf(src, m.index), kind: 'handler', setter: m[1] });
  }

  // 2 and 3. Effects that set state unconditionally.
  for (const m of src.matchAll(/\b(?:React\.)?use(?:Layout)?Effect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(src, open);
    if (close < 0) continue;
    const call = src.slice(open + 1, close);
    const arrow = call.match(/^\s*(?:async\s*)?(?:\(\s*\)|function\s*\(\s*\))\s*(?:=>)?\s*\{/);
    if (!arrow) continue;
    const bodyOpen = open + 1 + arrow[0].length - 1;
    const bodyClose = closing(src, bodyOpen);
    if (bodyClose < 0 || bodyClose > close) continue;
    const after = src.slice(bodyClose + 1, close).trim();
    const deps = after === '' ? null : (after.match(/^,\s*\[([\s\S]*)\]\s*,?$/) || [])[1];
    if (deps === undefined) continue; // something else after the callback
    const depNames = deps === null ? null : deps.split(',').map((d) => d.trim()).filter(Boolean);
    const body = src.slice(bodyOpen + 1, bodyClose);
    // No dependency array and a request whose result is stored: every response renders the
    // component, which runs the effect, which sends the request again (an endless request loop).
    // Any condition in the effect is taken as a guard.
    if (depNames === null && !/\b(?:if|switch|return)\b|\?\s*[^:]+:|&&|\|\|/.test(body) && /\b(?:fetch|axios(?:\.(?:get|post|request))?)\s*\(/.test(body)) {
      const stored = [...setters.keys()].find((name) => new RegExp(`\\.then\\(\\s*${name.replace(/\$/g, '\\$')}\\s*\\)|\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*(?![\\s)]|true\\b|false\\b|null\\b|undefined\\b|-?\\d|['"\`])`).test(body));
      if (stored) {
        hits.push({ line: lineOf(src, m.index), kind: 'no-deps-fetch', setter: stored });
        continue;
      }
    }
    // Walk the top level of the body; stop at the first guard (if/return/loop/try/switch).
    let depth = 0;
    let guarded = false;
    for (let i = 0; i < body.length && !guarded; i++) {
      const c = body[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(body[i - 1] || '')) {
        const word = body.slice(i).match(/^[A-Za-z_$][\w$]*/)[0];
        if (/^(if|return|for|while|do|switch|try|await)$/.test(word)) {
          guarded = true;
          break;
        }
        if (setters.has(word) && /^\s*\(/.test(body.slice(i + word.length))) {
          const argOpen = i + word.length + body.slice(i + word.length).indexOf('(');
          const argClose = closing(body, argOpen);
          if (argClose < 0) break;
          const state = setters.get(word);
          const arg = body.slice(argOpen + 1, argClose);
          const loops = depNames === null ? alwaysNew(arg, state) : depNames.includes(state) && alwaysNew(arg, state);
          if (loops) hits.push({ line: lineOf(src, bodyOpen + 1 + i), kind: depNames === null ? 'no-deps' : 'own-dep', setter: word, state });
          i = argClose;
        } else {
          i += word.length - 1;
        }
      }
    }
  }
  return hits;
}

// Timers and subscriptions started in an effect that can never be stopped: the call's return value
// (interval id, subscription, unsubscribe function) is thrown away and the effect returns no cleanup.
// Each mount adds another one; they keep running after the screen is gone. A stored return value
// may be cleaned up elsewhere, so only discarded ones are reported. Web-only receivers are skipped.
function effectLeaks(text) {
  const src = blank(text);
  const hits = [];
  for (const m of src.matchAll(/\b(?:React\.)?use(?:Layout)?Effect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(src, open);
    if (close < 0) continue;
    const call = src.slice(open + 1, close);
    const arrow = call.match(/^\s*(?:\(\s*\)|function\s*\(\s*\))\s*(?:=>)?\s*\{/);
    if (!arrow) continue;
    const bodyOpen = open + 1 + arrow[0].length - 1;
    const bodyClose = closing(src, bodyOpen);
    if (bodyClose < 0 || bodyClose > close) continue;
    const body = src.slice(bodyOpen + 1, bodyClose);
    if (/\breturn\b/.test(body)) continue;
    const leak = body.match(/(?:^|[;{}]|\n)\s*((?:setInterval)|(?!window\.|document\.)[\w$]+(?:\(\))?(?:\.[\w$]+(?:\(\))?)*\.(?:addListener|addEventListener))\s*\(/);
    if (!leak) continue;
    const at = bodyOpen + 1 + leak.index + leak[0].indexOf(leak[1]);
    hits.push({ line: lineOf(src, at), call: leak[1] });
  }
  return hits;
}

export function renderLoops(project) {
  const root = project.root;
  const found = [];
  const leaks = [];
  for (const file of sourceFiles(root)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.length > 400_000 || !/use(?:Layout)?Effect|useState/.test(text)) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (/useState/.test(text)) for (const h of fileLoops(text)) found.push({ ...h, file: rel });
    if (/\.web\.[jt]sx?$/.test(rel)) continue;
    for (const h of effectLeaks(text)) leaks.push({ ...h, file: rel });
  }
  const out = [];
  if (found.length) {
    const say = (h) => {
      const at = `${h.file}:${h.line}`;
      if (h.kind === 'handler') return `${at}: \`${h.setter}(…)\` is called while rendering instead of being passed (write \`() => ${h.setter}(…)\`)`;
      if (h.kind === 'no-deps') return `${at}: an effect with no dependency array calls \`${h.setter}\` with a new value on every run`;
      if (h.kind === 'no-deps-fetch') return `${at}: an effect with no dependency array sends a request and stores the result with \`${h.setter}\`, so every response starts the next request (add \`[]\` or the values it depends on)`;
      return `${at}: an effect that depends on \`${h.state}\` always changes \`${h.state}\``;
    };
    const sync = found.some((h) => h.kind !== 'no-deps-fetch');
    const requests = found.some((h) => h.kind === 'no-deps-fetch');
    out.push({
      id: 'crash-render-loop',
      severity: 'high',
      area: 'crash',
      title: `${found.length} render loop${found.length === 1 ? '' : 's'}: state set on every render (${found[0].file}:${found[0].line}${found.length > 1 ? ', …' : ''})`,
      detail: `${found.slice(0, 5).map(say).join('; ')}${found.length > 5 ? `; and ${found.length - 5} more` : ''}.${sync ? ' Each update renders the component again, which runs the update again: the screen freezes and React stops with "Too many re-renders" or "Maximum update depth exceeded".' : ''}${requests ? ' A request loop does not freeze the screen: it keeps sending requests while the screen is open, using data, battery and API quota, and can get the app rate-limited.' : ''} Fixes for each pattern: ${SITE_URL}/fix/maximum-update-depth-exceeded-react-native`,
      fix: { kind: 'crash', step: `Break each render loop: pass handlers as \`() => setX(…)\`, give effects a dependency array, and do not set state an effect depends on without a condition (${found.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ')}).` },
      evidence: found.slice(0, 20).map((h) => ({ file: h.file, line: h.line, role: h.kind })),
    });
  }
  if (leaks.length) {
    out.push({
      id: 'perf-effect-leak',
      severity: 'medium',
      area: 'performance',
      title: `${leaks.length} timer${leaks.length === 1 ? ' or listener' : 's or listeners'} started in an effect can never be stopped (${leaks[0].file}:${leaks[0].line}${leaks.length > 1 ? ', …' : ''})`,
      detail: `${leaks.slice(0, 5).map((h) => `${h.file}:${h.line} \`${h.call}(…)\``).join('; ')}${leaks.length > 5 ? `; and ${leaks.length - 5} more` : ''}. The return value (the interval id or the subscription) is thrown away and the effect returns no cleanup, so nothing can stop it: it keeps running after the screen closes, and every new mount adds another one (handlers fire twice, three times, …; state updates hit unmounted screens). Keep the value and return a cleanup: \`const sub = Keyboard.addListener(…); return () => sub.remove();\` or \`const id = setInterval(…); return () => clearInterval(id);\`.`,
      fix: { kind: 'performance', step: `Return a cleanup from each effect that starts a timer or listener (${leaks.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ')}).` },
      evidence: leaks.slice(0, 20).map((h) => ({ file: h.file, line: h.line, role: h.call })),
    });
  }
  return out;
}

export const __test = { fileLoops, effectLeaks, blank, alwaysNew };

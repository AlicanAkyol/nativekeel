import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLoops, __test } from '../src/render-loops.js';
import { stabilityChecks } from '../src/stability.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const kinds = (code) => __test.fileLoops(code).map((h) => h.kind);

test('render loops: the certain cases are found', () => {
  assert.deepEqual(kinds('const [open, setOpen] = useState(false);\nreturn <Button onPress={setOpen(true)} />;'), ['handler']);
  assert.deepEqual(kinds('const [items, setItems] = useState<string[]>([]);\nuseEffect(() => {\n  setItems([...items, "a"]);\n});'), ['no-deps']);
  assert.deepEqual(kinds('const [n, setN] = React.useState(0);\nReact.useEffect(() => { setN(n + 1); }, [n]);'), ['own-dep']);
  assert.deepEqual(kinds('const [c, setC] = useState(0);\nuseLayoutEffect(() => { setC((p) => p + 1); });'), ['no-deps']);
});

test('render loops: guards, constants, async work, other deps and comments are not loops', () => {
  for (const code of [
    'const [open, setOpen] = useState(false); return <Button onPress={() => setOpen(true)} />;',
    'const [ready, setReady] = useState(false); useEffect(() => { setReady(true); });',
    'const [n, setN] = useState(0); useEffect(() => { if (n < 3) setN(n + 1); }, [n]);',
    'const [n, setN] = useState(0); useEffect(() => { setN(n + 1); }, [id]);',
    'const [d, setD] = useState(null); useEffect(() => { fetch(u).then((r) => setD({ r })); }, []);',
    'const [d, setD] = useState(null); useEffect(() => { load(); setD({ x: 1 }); }, []);',
    'const [c, setC] = useState(0); useEffect(() => { // setC({})\n log(); });',
    'const [c, setC] = useState(0); useEffect(() => { const t = setInterval(() => setC((p) => p + 1), 1000); return () => clearInterval(t); }, []);',
    'const [s, setS] = useState(""); useEffect(() => { return; setS(s + "x"); });',
  ]) assert.deepEqual(kinds(code), [], code);
});

test('render loops: one finding per project, with file and line', () => {
  const root = makeProject({
    'package.json': { name: 'l', dependencies: { 'react-native': '0.81.0' } },
    'src/Screen.tsx': 'import { useEffect, useState } from "react";\nexport function Screen() {\n  const [items, setItems] = useState([]);\n  useEffect(() => {\n    setItems([]);\n  });\n  return null;\n}\n',
    'src/Screen.test.tsx': 'const [a, setA] = useState(0); useEffect(() => { setA({}); });',
  });
  const f = stabilityChecks(loadProject(root)).find((x) => x.id === 'crash-render-loop');
  assert.equal(f.severity, 'high');
  assert.match(f.title, /1 render loop: .*src\/Screen\.tsx:5/);
  assert.match(f.detail, /Maximum update depth exceeded/);
  assert.equal(renderLoops({ root: makeProject({ 'a.js': 'x' }) }).length, 0);
});

test('render loops: a request in an effect with no dependency array whose result is stored', () => {
  for (const code of [
    "const [d, setD] = useState(null);\nuseEffect(() => {\n  fetch('/me').then((r) => r.json()).then(setD);\n});",
    "const [d, setD] = useState(null);\nuseEffect(() => {\n  axios.get('/me').then((r) => setD(r.data));\n});",
    "const [d, setD] = useState([]);\nuseEffect(() => {\n  const load = async () => { const r = await fetch('/x'); setD(await r.json()); };\n  load();\n});",
  ]) assert.deepEqual(kinds(code), ['no-deps-fetch'], code);
  for (const code of [
    "const [d, setD] = useState(null); useEffect(() => { fetch('/me').then((r) => r.json()).then(setD); }, []);",
    "const [d, setD] = useState(null); useEffect(() => { if (!d) fetch('/me').then((r) => r.json()).then(setD); });",
    "const [d, setD] = useState(null); useEffect(() => { d || fetch('/me').then((r) => r.json()).then(setD); });",
    "const [busy, setBusy] = useState(false); useEffect(() => { fetch('/ping').then(() => setBusy(false)); });",
    "const [d, setD] = useState(null); useEffect(() => { fetch('/log', { method: 'POST' }); });",
  ]) assert.deepEqual(kinds(code), [], code);
});

test('effect leaks: discarded timers and subscriptions with no cleanup', () => {
  const leaks = (code) => __test.effectLeaks(code).map((h) => h.call);
  assert.deepEqual(leaks('useEffect(() => {\n  setInterval(() => tick(), 1000);\n}, []);'), ['setInterval']);
  assert.deepEqual(leaks("useEffect(() => {\n  Keyboard.addListener('keyboardDidShow', onShow);\n}, []);"), ['Keyboard.addListener']);
  assert.deepEqual(leaks("useEffect(() => { AppState.addEventListener('change', onChange); }, []);"), ['AppState.addEventListener']);
  assert.deepEqual(leaks("useEffect(() => { messaging().onMessage(h); navigation.addListener('focus', load); }, []);"), ['navigation.addListener']);
  for (const code of [
    'useEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, []);',
    "useEffect(() => { const sub = Keyboard.addListener('x', f); return () => sub.remove(); }, []);",
    "useEffect(() => { subRef.current = AppState.addEventListener('change', f); }, []);",
    "useEffect(() => { window.addEventListener('resize', f); }, []);",
    "useEffect(() => { setTimeout(go, 500); }, []);",
    "useEffect(() => { // setInterval(x, 1)\n go(); }, []);",
    "useEffect(() => navigation.addListener('focus', load), [navigation]);",
  ]) assert.deepEqual(leaks(code), [], code);
});

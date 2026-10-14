import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseJsx, walkElements } from '../src/jsx.js';
import { uiChecks } from '../src/ui.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const names = (src) => [...walkElements(parseJsx(src))].map((e) => e.name);

test('JSX reader handles text with quotes, comments, generics and arrows without guessing', () => {
  assert.deepEqual(names(`const A = () => <View><Text>Don't "panic"</Text>{/* c */}</View>;`), ['View', 'Text']);
  assert.deepEqual(names(`const a = b < c && d > e; const x = useState<string>(''); return <Select<Option> value={1} / >;`), ['Select']);
  assert.deepEqual(names(`const toRow = <T,>(row: unknown): T => row as T; const B = () => (<Item onPress={() => go(<Icon/>)} />);`), ['Item', 'Icon']);
  assert.deepEqual(names("const s = `<View>${<Text>x</Text>}`; const r = /<View>/g;"), ['Text']);
  assert.throws(() => parseJsx('const A = () => <View><Text>x</View>;'), /JSX not readable/);
});

const app = (files, deps = {}) => makeProject({ 'package.json': { name: 'fixture', dependencies: { 'react-native': '0.77.0', ...deps } }, ...files });
const run = (root, rn) => {
  try {
    const project = loadProject(root);
    if (rn) project.rnVersion = rn;
    return uiChecks(project).findings;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const header = `import { Pressable, TouchableOpacity, View, Text, TextInput, Image } from 'react-native';\nimport { Ionicons } from '@expo/vector-icons';\n`;

test('icon-only buttons without a label are reported; labeled, text, spread and custom content are not', () => {
  const f = run(app({ 'src/A.tsx': `${header}export const A = (p) => (<View>
    <Pressable onPress={p.close}><Ionicons name="close" /></Pressable>
    <TouchableOpacity onPress={p.back}><View><Image source={1} /></View></TouchableOpacity>
    <Pressable onPress={p.a} accessibilityLabel="Close"><Ionicons name="close" /></Pressable>
    <Pressable onPress={p.b}><Ionicons name="add" /><Text>Add</Text></Pressable>
    <Pressable onPress={p.c} {...p.rest}><Ionicons name="add" /></Pressable>
    <Pressable onPress={p.d}><Badge /></Pressable>
    <Pressable onPress={p.e}>{p.icon}</Pressable>
    <Pressable><Ionicons name="add" /></Pressable>
  </View>);` }));
  const b = f.find((x) => x.id === 'a11y-icon-button-unlabeled');
  assert.ok(b);
  assert.match(b.title, /^2 icon-only buttons/);
  assert.deepEqual(b.evidence.map((e) => e.at), ['src/A.tsx:4', 'src/A.tsx:5']);
});

test('a Pressable that is not React Native\'s is left alone', () => {
  const f = run(app({ 'src/A.tsx': `import { Pressable } from './ui';\nimport { Ionicons } from '@expo/vector-icons';\nexport const A = () => <Pressable onPress={go}><Ionicons name="x" /></Pressable>;` }));
  assert.equal(f.length, 0);
});

test('text fields need a label or placeholder; hidden helper inputs are ignored', () => {
  const f = run(app({ 'src/F.tsx': `${header}export const F = () => (<View>
    <Text>Email</Text><TextInput value={v} onChangeText={s} />
    <TextInput placeholder="Email" />
    <TextInput accessibilityLabel="Email" />
    <TextInput autoFocus style={{ position: 'absolute', opacity: 0 }} />
  </View>);` }));
  const i = f.find((x) => x.id === 'a11y-input-unlabeled');
  assert.deepEqual(i.evidence.map((e) => e.at), ['src/F.tsx:4']);
});

const scaling = { 'index.js': `import { Text, TextInput } from 'react-native';\nText.defaultProps = Text.defaultProps || {};\nText.defaultProps.allowFontScaling = false;\n// TextInput.defaultProps.allowFontScaling = false;\n` };

test('Text.defaultProps before React 19: app-wide scaling off and the 0.78 upgrade trap', () => {
  const ids = run(app(scaling), '0.77.0').map((x) => x.id).sort();
  assert.deepEqual(ids, ['a11y-font-scaling-disabled', 'text-defaultprops-react19']);
});

test('Text.defaultProps on React 19 is reported as ignored, except where createElement still applies it', () => {
  const f = run(app(scaling), '0.82.0');
  assert.deepEqual(f.map((x) => x.id), ['text-defaultprops-ignored']);
  assert.match(f[0].detail, /text follows the system text size/);
  assert.equal(run(app(scaling, { nativewind: '4.1.0' }), '0.82.0').length, 0);
  assert.equal(run(app({ ...scaling, 'babel.config.js': "module.exports = { presets: [['babel-preset-expo', { jsxRuntime: 'classic' }]] };" }), '0.82.0').length, 0);
});

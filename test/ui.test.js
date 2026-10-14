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

test('small touch targets: explicit size under 44 or a bare small icon, unless hitSlop or unknown size', () => {
  const f = run(app({ 'src/T.tsx': `${header}import { StyleSheet } from 'react-native';
export const T = (p) => (<View>
    <Pressable onPress={p.a} accessibilityLabel="A" style={styles.small}><Ionicons name="x" /></Pressable>
    <Pressable onPress={p.b} accessibilityLabel="B"><Ionicons name="x" size={20} /></Pressable>
    <Pressable onPress={p.c} accessibilityLabel="C" style={{ width: 30, height: 30 }}><Text>+</Text></Pressable>
    <Pressable onPress={p.d} accessibilityLabel="D" style={styles.small} hitSlop={10}><Ionicons name="x" /></Pressable>
    <Pressable onPress={p.e} accessibilityLabel="E" style={styles.card}><Text>Card</Text></Pressable>
    <Pressable onPress={p.f} accessibilityLabel="F" style={styles.big}><Ionicons name="x" /></Pressable>
    <Pressable onPress={p.g} accessibilityLabel="G" style={[styles.small, p.style]}><Ionicons name="x" /></Pressable>
    <Pressable onPress={p.h} accessibilityLabel="H"><Ionicons name="x" size={48} /></Pressable>
  </View>);
const styles = StyleSheet.create({
  small: { width: 32, height: 32, borderRadius: 16 },
  card: { padding: 16, shadowOffset: { width: 0, height: 2 } },
  big: { width: 48, height: 48 },
});` }));
  const t = f.find((x) => x.id === 'a11y-small-touch-target');
  assert.deepEqual(t.evidence.map((e) => `${e.at} ${e.size}`), ['src/T.tsx:5 32×32', 'src/T.tsx:6 icon 20', 'src/T.tsx:7 30×30']);
  assert.match(t.detail, /Some are under 24×24, below the WCAG 2.2 AA minimum/);
});

test('low contrast: only literal colors with a known background behind them', () => {
  const f = run(app({ 'src/C.tsx': `${header}import { StyleSheet } from 'react-native';
export const C = (p) => (<View style={styles.page}>
    <Text style={styles.muted}>Muted</Text>
    <Text style={{ color: '#000' }}>Fine</Text>
    <Text style={{ color: '#888', fontSize: 28 }}>Large passes 3:1</Text>
    <View style={{ backgroundColor: '#4caf50' }}><Text style={{ color: 'white' }}>On green</Text></View>
    <Card><Text style={{ color: '#ccc' }}>Unknown background</Text></Card>
    <View style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}><Text style={{ color: '#333' }}>Translucent</Text></View>
    <Text style={{ color: theme.muted }}>Themed</Text>
    <View style={{ opacity: 0.5 }}><Text style={{ color: '#ccc' }}>Faded</Text></View>
  </View>);
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: '#ffffff' }, muted: { color: '#bbbbbb' } });` }));
  const c = f.find((x) => x.id === 'a11y-low-contrast');
  assert.deepEqual(c.evidence.map((e) => `${e.at} ${e.color}/${e.background}`), ['src/C.tsx:5 #bbbbbb/#ffffff', 'src/C.tsx:8 #ffffff/#4caf50']);
  assert.equal(c.severity, 'medium');
});

test('missing accessibilityRole is a note with the share of touchables', () => {
  const f = run(app({ 'src/R.tsx': `${header}export const R = (p) => (<View>
    <Pressable onPress={p.a}><Text>Save</Text></Pressable>
    <Pressable onPress={p.b} accessibilityRole="button"><Text>Send</Text></Pressable>
    <Pressable onPress={p.c} role="link"><Text>Open</Text></Pressable>
  </View>);` }));
  const r = f.find((x) => x.id === 'a11y-button-role-missing');
  assert.equal(r.severity, 'info');
  assert.match(r.title, /^1 of 3 touchables/);
});

test('placeholder text is checked for contrast against the input or the view behind it', () => {
  const f = run(app({ 'src/P.tsx': `${header}export const P = () => (<View style={{ backgroundColor: '#ffffff' }}>
    <TextInput placeholder="Email" placeholderTextColor="#999" accessibilityLabel="Email" />
    <TextInput placeholder="Name" placeholderTextColor="#555" accessibilityLabel="Name" />
    <TextInput placeholder="Code" placeholderTextColor="#999" style={{ backgroundColor: '#000' }} accessibilityLabel="Code" />
    <TextInput placeholder="Note" placeholderTextColor={colors.muted} accessibilityLabel="Note" />
  </View>);` }));
  const c = f.find((x) => x.id === 'a11y-low-contrast');
  assert.deepEqual(c.evidence.map((e) => `${e.at} ${e.placeholder}`), ['src/P.tsx:4 true']);
  assert.match(c.title, /1 of them placeholder/);
});

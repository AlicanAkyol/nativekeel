import path from 'node:path';
import fs from './read-boundary.js';
import { parseJsx, walkElements } from './jsx.js';
import { sourceFiles } from './security-source.js';

// Screen reader and text size problems you can see in the source. Static: it cannot tell how a
// screen reader announces a custom component, so anything it cannot resolve to a React Native
// touchable, input, icon or image is left alone. Device testing with VoiceOver/TalkBack and the
// largest text size is still needed; zero findings is not an accessibility audit.

const TOUCHABLES = new Set(['TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'TouchableNativeFeedback', 'Pressable']);
// Props that name an element for assistive technology, or deliberately take it out.
const LABEL_PROPS = ['accessibilityLabel', 'aria-label', 'accessibilityLabelledBy', 'aria-labelledby', 'accessibilityHint', 'accessible', 'accessibilityElementsHidden', 'importantForAccessibility', 'aria-hidden'];
const ICON_MODULES = /^(?:@expo\/vector-icons(?:\/.*)?|react-native-vector-icons(?:\/.*)?|@react-native-vector-icons\/.+|lucide-react-native|phosphor-react-native|react-native-heroicons(?:\/.*)?|@tabler\/icons-react-native|react-native-feather|iconsax-react-native|@fortawesome\/react-native-fontawesome|@hugeicons\/react-native|expo-symbols)$/;
const IMAGE_MODULES = /^(?:expo-image|react-native-fast-image|@d11\/react-native-fast-image)$/;
const MAX_LOCATIONS = 20;

// Names a file imports from a module, mapped local name → imported name. Default and namespace
// imports map to '*' / 'default'. Only literal import/require statements are read.
function imports(text) {
  const out = [];
  const add = (spec, local, imported) => out.push({ spec, local, imported });
  const named = (list, spec) => {
    for (const part of list.split(',')) {
      const m = part.trim().replace(/^type\s+/, '').match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (m) add(spec, m[2] || m[1], m[1]);
    }
  };
  for (const m of text.matchAll(/import\s+(?!type\b)([\w$]+\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[5];
    if (m[1]) add(spec, m[1].replace(/[\s,]/g, ''), 'default');
    if (m[2]) named(m[2], spec);
    if (m[3]) add(spec, m[3], '*');
    if (m[4]) add(spec, m[4], 'default');
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    named(m[1].replace(/:\s*/g, ' as '), m[2]);
  }
  return out;
}

function classify(text) {
  const rn = new Map(); // local JSX name → React Native component name
  const icons = new Set();
  for (const { spec, local, imported } of imports(text)) {
    if (spec === 'react-native') {
      if (imported === '*' || imported === 'default') rn.set(`${local}.*`, local);
      else rn.set(local, imported);
    } else if (ICON_MODULES.test(spec) || /\.svg$/.test(spec)) icons.add(local);
    else if (IMAGE_MODULES.test(spec) && ['Image', 'default', 'FastImage'].includes(imported)) icons.add(local);
  }
  const rnName = (tag) => {
    if (rn.has(tag)) return rn.get(tag);
    const dot = tag.indexOf('.');
    if (dot > 0 && rn.has(`${tag.slice(0, dot)}.*`)) return tag.slice(dot + 1);
    return null;
  };
  const isIcon = (tag) => icons.has(tag) || icons.has(tag.split('.')[0]) || rnName(tag) === 'Image';
  return { rnName, isIcon };
}

const hasAny = (el, props) => el.spread || props.some((p) => el.attrs.has(p));

// The touchable's content is only icons/images (optionally wrapped in Views), with no text,
// no expression that could produce text, and no unknown component that could carry a label.
function iconOnly(el, { rnName, isIcon }) {
  let icon = false;
  const visit = (node) => {
    for (const c of node.children) {
      if (c.kind !== 'element') return false;
      const child = c.element;
      if (hasAny(child, LABEL_PROPS.concat(['alt']))) return false;
      if (isIcon(child.name)) { icon = true; if (child.children.length) return false; continue; }
      if (rnName(child.name) === 'View' && visit(child)) continue;
      return false;
    }
    return true;
  };
  return visit(el) && icon;
}

// React 19 (React Native 0.78+) no longer applies defaultProps to function components in JSX
// compiled with the automatic runtime (the React Native and Expo default). Only
// React.createElement callers and the classic runtime still apply them.
const DEFAULT_PROPS = /\b(Text|TextInput)\s*(?:as\s+any\s*\)\s*)?\.defaultProps\s*(?:\.\s*([\w$]+)\s*=|=\s*\{([^}]*)\}|\[\s*['"]([\w$]+)['"]\s*\]\s*=)/g;

export function uiChecks(project) {
  const root = project.root;
  const { files, skipped } = sourceFiles(root, /\.(?:jsx|tsx|js|ts)$/);
  const unlabeledButtons = [];
  const unlabeledInputs = [];
  const defaultProps = []; // { file, line, component, props }
  let readable = 0, unreadable = 0;
  for (const { file, text } of files) {
    const rel = file.split(path.sep).join('/');
    if (!/react-native/.test(text)) continue;
    const kinds = classify(text);
    for (const m of text.matchAll(DEFAULT_PROPS)) {
      const before = text.slice(0, m.index);
      // Must be React Native's Text/TextInput, imported in this file.
      if (kinds.rnName(m[1]) !== m[1]) continue;
      const lineStart = before.lastIndexOf('\n') + 1;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;
      const props = m[2] || m[4] ? [m[2] || m[4]] : [...(m[3] || '').matchAll(/([\w$]+)\s*:/g)].map((x) => x[1]);
      const value = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      defaultProps.push({ file: rel, line: before.split('\n').length, component: m[1], props, value: m[3] !== undefined ? m[3] : value });
    }
    // Type assertions (`<T>x`) make .ts files ambiguous; JSX lives in .js/.jsx/.tsx.
    if (rel.endsWith('.ts') || !/<[A-Z]/.test(text)) continue;
    let tree;
    try { tree = parseJsx(text); readable++; } catch { unreadable++; continue; }
    for (const el of walkElements(tree)) {
      const name = kinds.rnName(el.name);
      if (TOUCHABLES.has(name)) {
        if (!el.attrs.has('onPress') && !el.attrs.has('onLongPress')) continue;
        if (hasAny(el, LABEL_PROPS)) continue;
        if (el.attrs.get('disabled')?.kind === 'true') continue;
        if (iconOnly(el, kinds)) unlabeledButtons.push(`${rel}:${el.line}`);
      } else if (name === 'TextInput') {
        if (hasAny(el, LABEL_PROPS.concat(['placeholder']))) continue;
        // Invisible focus or keyboard helpers are not fields anyone reads.
        const style = el.attrs.get('style');
        if (style?.kind === 'expr' && /opacity\s*:\s*0(?![.\d])/.test(style.raw)) continue;
        const editable = el.attrs.get('editable');
        if (editable && editable.kind === 'expr' && editable.raw === 'false') continue;
        unlabeledInputs.push(`${rel}:${el.line}`);
      }
    }
  }

  const findings = [];
  const where = (list) => `${list[0]}${list.length > 1 ? ` and ${list.length - 1} more` : ''}`;
  if (unlabeledButtons.length) {
    findings.push({
      id: 'a11y-icon-button-unlabeled',
      severity: 'medium',
      area: 'accessibility',
      title: `${unlabeledButtons.length} icon-only button${unlabeledButtons.length === 1 ? ' has' : 's have'} no accessibility label (${where(unlabeledButtons)})`,
      detail: 'These touchables contain only an icon or image and set no accessibilityLabel. VoiceOver and TalkBack announce them as an unnamed "button" (or read the icon font glyph), so a screen reader user cannot tell back from close from delete. Add accessibilityLabel describing the action ("Close", "Delete photo") and accessibilityRole="button". (WCAG 2.2: 1.1.1 Non-text Content, 4.1.2 Name, Role, Value)',
      evidence: unlabeledButtons.slice(0, MAX_LOCATIONS).map((at) => ({ kind: 'source', at })),
      fix: { kind: 'accessibility', step: `Add \`accessibilityLabel\` (what the button does) and \`accessibilityRole="button"\` to the icon-only buttons: ${unlabeledButtons.slice(0, 5).map((a) => `\`${a}\``).join(', ')}${unlabeledButtons.length > 5 ? ` and ${unlabeledButtons.length - 5} more` : ''}. Check each with VoiceOver or TalkBack.` },
    });
  }
  if (unlabeledInputs.length) {
    findings.push({
      id: 'a11y-input-unlabeled',
      severity: 'low',
      area: 'accessibility',
      title: `${unlabeledInputs.length} text field${unlabeledInputs.length === 1 ? ' has' : 's have'} no label or placeholder (${where(unlabeledInputs)})`,
      detail: 'A TextInput without accessibilityLabel or placeholder is announced only as "text field". A visible label next to it is not linked to the field for VoiceOver (accessibilityLabelledBy works on Android only), so the user hears no name. Add accessibilityLabel matching the visible label. (WCAG 2.2: 1.3.1, 4.1.2)',
      evidence: unlabeledInputs.slice(0, MAX_LOCATIONS).map((at) => ({ kind: 'source', at })),
      fix: { kind: 'accessibility', step: `Add \`accessibilityLabel\` to the text fields without a label or placeholder: ${unlabeledInputs.slice(0, 5).map((a) => `\`${a}\``).join(', ')}${unlabeledInputs.length > 5 ? ` and ${unlabeledInputs.length - 5} more` : ''}.` },
    });
  }

  if (defaultProps.length) {
    const minor = Number(String(project.rnVersion || '').split('.')[1]);
    const react19 = Number.isFinite(minor) && minor >= 78;
    const known = Number.isFinite(minor) && project.rnVersion;
    const classic = /jsxRuntime\s*:\s*['"]classic|runtime\s*:\s*['"]classic/.test(['babel.config.js', 'babel.config.cjs', '.babelrc', '.babelrc.js'].map((f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } }).join('\n'));
    const scaling = defaultProps.filter((d) => d.props.includes('allowFontScaling') && /^\s*false\b|allowFontScaling\s*:\s*false/.test(d.value)
      || d.props.includes('maxFontSizeMultiplier') && /^\s*1(?:\.0*)?\b(?![.\d])|maxFontSizeMultiplier\s*:\s*1(?:\.0*)?\b(?![.\d])/.test(d.value));
    const at = `${defaultProps[0].file}:${defaultProps[0].line}`;
    const names = [...new Set(defaultProps.flatMap((d) => d.props))].filter(Boolean).slice(0, 6);
    // NativeWind's JSX runtime renders through React.createElement, which still applies defaultProps.
    const viaCreateElement = ['nativewind', 'react-native-css-interop'].some((n) => project.deps[n] || project.devDeps?.[n]);
    if (known && react19 && !classic && !viaCreateElement) {
      findings.push({
        id: 'text-defaultprops-ignored',
        severity: 'low',
        area: 'react-native',
        title: `Text.defaultProps has no effect on React Native ${project.rnVersion} (${at})`,
        detail: `This app sets ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'defaults'} through \`Text.defaultProps\`/\`TextInput.defaultProps\`. React 19 (React Native 0.78 and later) applies defaultProps only to class components, and React Native and Expo compile JSX with the automatic runtime, so <Text> and <TextInput> in your code no longer get these defaults. Only components rendered through React.createElement (some styling libraries do this) still see them.${scaling.length ? ' In particular, the app-wide font scaling limit does not apply: text follows the system text size.' : ''} Move the defaults into your own Text/TextInput wrapper components.`,
        evidence: defaultProps.slice(0, MAX_LOCATIONS).map((d) => ({ kind: 'source', at: `${d.file}:${d.line}` })),
        fix: { kind: 'text-defaults', step: `Replace the \`Text.defaultProps\` assignment in \`${at}\` with an app Text (and TextInput) component that sets these props, and use it everywhere; test screens with the largest system text size.` },
      });
    } else if (known && !react19) {
      findings.push({
        id: 'text-defaultprops-react19',
        severity: 'low',
        area: 'react-native',
        title: `Text.defaultProps stops working when you move to React Native 0.78 (${at})`,
        detail: `This app sets ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'defaults'} through \`Text.defaultProps\`/\`TextInput.defaultProps\`. React Native 0.78 ships React 19, which applies defaultProps only to class components; with the automatic JSX runtime that React Native and Expo use, <Text> and <TextInput> lose these defaults with no error, so fonts, colors or text scaling change after the upgrade. Move them into your own Text/TextInput components before upgrading.`,
        evidence: defaultProps.slice(0, MAX_LOCATIONS).map((d) => ({ kind: 'source', at: `${d.file}:${d.line}` })),
        fix: { kind: 'text-defaults', step: `Before upgrading to React Native 0.78, replace the \`Text.defaultProps\` assignment in \`${at}\` with an app Text (and TextInput) component that sets these props.` },
      });
      if (scaling.length) {
        const s = `${scaling[0].file}:${scaling[0].line}`;
        findings.push({
          id: 'a11y-font-scaling-disabled',
          severity: 'medium',
          area: 'accessibility',
          title: `Text scaling is turned off for the whole app (${s})`,
          detail: 'Text.defaultProps sets allowFontScaling to false (or maxFontSizeMultiplier to 1), so text ignores the size people choose in iOS Dynamic Type or Android font size settings. People with low vision cannot enlarge it. Allow scaling and fix the layouts that break at large sizes, or cap it with maxFontSizeMultiplier (for example 1.5–2) on the few places that cannot grow. (WCAG 2.2: 1.4.4 Resize Text)',
          evidence: scaling.slice(0, MAX_LOCATIONS).map((d) => ({ kind: 'source', at: `${d.file}:${d.line}` })),
          fix: { kind: 'accessibility', step: `Remove the global \`allowFontScaling = false\` in \`${s}\`, then check every screen at the largest system text size; cap individual elements with \`maxFontSizeMultiplier\` where a layout cannot grow.` },
        });
      }
    }
  }

  return {
    findings,
    coverage: { filesRead: readable, unreadable, skipped, scope: 'React Native touchables, TextInput and Text/TextInput defaultProps in JS/TS source' },
  };
}

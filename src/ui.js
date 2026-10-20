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
    } else if (spec === 'react-native-gesture-handler' && TOUCHABLES.has(imported)) {
      // Gesture Handler's Pressable and Touchable* take the same accessibility props.
      rn.set(local, imported);
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

// Size-related numbers from a style object literal's own text. Only plain numeric literals
// count; anything computed, spread or percentage leaves the value unknown.
const SIZE_KEYS = ['width', 'height', 'minWidth', 'minHeight', 'padding', 'paddingHorizontal', 'paddingVertical', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'flex', 'flexGrow', 'aspectRatio'];
// The object's own top-level `key: value` texts, or null when a spread hides some of them.
// Nested objects (shadowOffset: { width, height }) are not the element's own keys.
function ownProps(objectText, keys) {
  if (/\.\.\./.test(objectText)) return null;
  let inner = objectText.trim().replace(/^\{|\}$/g, '');
  for (let prev = ''; prev !== inner;) { prev = inner; inner = inner.replace(/\{[^{}]*\}/g, '0'); }
  const out = {};
  for (const k of keys) {
    const m = `{${inner}}`.match(new RegExp(`(?:^|[{,\\s])${k}\\s*:\\s*((?:'[^']*'|"[^"]*"|[^,}\\n'"])+)`));
    if (m) out[k] = m[1].trim();
  }
  return out;
}
function sizeOf(objectText) {
  const props = ownProps(objectText, SIZE_KEYS);
  if (!props) return null;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN]));
}
// `StyleSheet.create({ name: { ... } })` in the same file: name → the style object's text.
function styleSheets(text) {
  const sheets = new Map();
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*StyleSheet\.create\(\s*\{/g)) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    while (i < text.length && depth) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
    const body = text.slice(start, i - 1);
    const entries = new Map();
    let level = 0, keyStart = 0, key = null, objStart = -1;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === '{') { if (level === 0) { const k = body.slice(keyStart, j).match(/([\w$]+)['"]?\s*:\s*$/); key = k && k[1]; objStart = j; } level++; }
      else if (c === '}') { level--; if (level === 0 && key) { entries.set(key, body.slice(objStart, j + 1)); key = null; keyStart = j + 1; } }
      else if (c === ',' && level === 0) keyStart = j + 1;
    }
    sheets.set(m[1], entries);
  }
  return sheets;
}
// What a style attribute sets, read with `reader` from each part, when every part can be read.
// Later parts win, as in React Native's style arrays.
function styleSize(attr, sheets) { return styleRead(attr, sheets, sizeOf); }
function styleRead(attr, sheets, reader) {
  if (!attr || attr.kind !== 'expr') return null;
  const raw = attr.raw.trim();
  const parts = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(/,(?![^{]*})/).map((x) => x.trim()).filter(Boolean) : [raw];
  const merged = {};
  for (const part of parts) {
    let info = null;
    const ref = part.match(/^([\w$]+)\.([\w$]+)$/);
    if (ref && sheets.has(ref[1])) { const text = sheets.get(ref[1]).get(ref[2]); info = text === undefined ? null : reader(text); }
    else if (part.startsWith('{') && part.endsWith('}')) info = reader(part);
    if (!info) return null;
    Object.assign(merged, info);
  }
  return merged;
}
const SMALL = 44;

// Opaque colors written as literals: #rgb, #rrggbb, rgb(), rgba(..., 1) and common names.
// Anything translucent, computed or themed is unknown.
const NAMED = { white: 'ffffff', black: '000000', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', orange: 'ffa500', purple: '800080', pink: 'ffc0cb', gray: '808080', grey: '808080', silver: 'c0c0c0', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', navy: '000080', teal: '008080', maroon: '800000', olive: '808000', lime: '00ff00', aqua: '00ffff', cyan: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', gold: 'ffd700', whitesmoke: 'f5f5f5', gainsboro: 'dcdcdc', dimgray: '696969', dimgrey: '696969', slategray: '708090', slategrey: '708090', lightslategray: '778899', beige: 'f5f5dc', ivory: 'fffff0', khaki: 'f0e68c', tomato: 'ff6347', coral: 'ff7f50', salmon: 'fa8072', crimson: 'dc143c', skyblue: '87ceeb', steelblue: '4682b4', royalblue: '4169e1', dodgerblue: '1e90ff', lightblue: 'add8e6', darkblue: '00008b', darkgreen: '006400', lightgreen: '90ee90', limegreen: '32cd32', seagreen: '2e8b57', orangered: 'ff4500', darkorange: 'ff8c00', goldenrod: 'daa520', chocolate: 'd2691e', brown: 'a52a2a', tan: 'd2b48c', violet: 'ee82ee', indigo: '4b0082', plum: 'dda0dd', lavender: 'e6e6fa', snow: 'fffafa', linen: 'faf0e6', mintcream: 'f5fffa', aliceblue: 'f0f8ff', ghostwhite: 'f8f8ff', honeydew: 'f0fff0', azure: 'f0ffff', lightyellow: 'ffffe0', lightcyan: 'e0ffff', lightpink: 'ffb6c1', hotpink: 'ff69b4', deeppink: 'ff1493', turquoise: '40e0d0' };
function parseColor(raw) {
  if (!raw) return null;
  const v = raw.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
  if (raw.trim()[0] !== "'" && raw.trim()[0] !== '"') return null; // a variable or expression
  let hex = NAMED[v];
  const h = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (h) {
    let x = h[1];
    if (x.length === 3) x = x.split('').map((c) => c + c).join('');
    if (x.length === 8) { if (x.slice(6) !== 'ff') return null; x = x.slice(0, 6); }
    hex = x;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 1) return null;
    return [1, 2, 3].map((n) => Math.min(255, Number(rgb[n])));
  }
  if (!hex) return null;
  return [0, 2, 4].map((n) => parseInt(hex.slice(n, n + 2), 16));
}
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const hexOf = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const COLOR_KEYS = ['color', 'backgroundColor', 'opacity', 'fontSize', 'fontWeight'];
const colorProps = (text) => ownProps(text, COLOR_KEYS);
// React Native views that draw nothing of their own beyond their style.
const PLAIN_HOSTS = new Set(['View', 'ScrollView', 'SafeAreaView', 'KeyboardAvoidingView', 'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'Text']);

// Text whose color and the background behind it are both known literals, with contrast below
// WCAG 2.2 AA (4.5:1, or 3:1 for large text). Walks up the JSX ancestors to the nearest
// background; any ancestor it cannot see through (custom component, image, opacity) stops it.
function lowContrast(tree, kinds, sheets, rel, out) {
  const visit = (el, ancestors) => {
    const host = kinds.rnName(el.name);
    if (host === 'Text' && !el.spread) checkText(el, ancestors);
    if (host === 'TextInput' && !el.spread) checkPlaceholder(el, ancestors);
    const next = [...ancestors, el];
    for (const c of el.children) {
      if (c.kind === 'element') visit(c.element, next);
      else if (c.kind === 'expr') for (const e of c.elements) visit(e, next);
    }
    // Elements passed as props render somewhere else: start over without ancestors.
    for (const a of el.attrs.values()) {
      if (a.kind === 'expr') for (const e of a.elements) visit(e, []);
      if (a.kind === 'element') visit(a.element, []);
    }
  };
  const checkText = (el, ancestors) => {
    // A Text that holds only a symbol (✓, •, →, ★) and no letter or digit is an icon or a
    // decoration, not text to read; WCAG's text contrast does not apply to it.
    const literal = el.children.filter((c) => c.kind === 'text').map((c) => c.value).join('');
    if (literal && el.children.every((c) => c.kind === 'text') && !/[\p{L}\p{N}]/u.test(literal)) return;
    const style = el.attrs.get('style');
    const own = styleRead(style, sheets, colorProps);
    if (!own || own.color === undefined || own.opacity !== undefined) return;
    const fg = parseColor(own.color);
    if (!fg) return;
    const bg = behind(ancestors);
    if (!bg) return;
    report(el, own, fg, bg, false);
  };
  // The nearest opaque literal background up the plain-view ancestors, or null if unknown.
  const behind = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      const host = kinds.rnName(a.name);
      if (!PLAIN_HOSTS.has(host) || a.spread) return null;
      const st = a.attrs.get('style');
      if (!st) continue;
      const p = styleRead(st, sheets, colorProps);
      if (!p || p.opacity !== undefined) return null;
      if (p.backgroundColor !== undefined) return parseColor(p.backgroundColor);
    }
    return null;
  };
  // Placeholder text counts as text for contrast. Its color comes from placeholderTextColor;
  // the background from the input's own style or, failing that, the views behind it.
  const checkPlaceholder = (el, ancestors) => {
    if (!el.attrs.has('placeholder')) return;
    const c = el.attrs.get('placeholderTextColor');
    const fg = c && parseColor(c.kind === 'string' ? `'${c.value}'` : c.kind === 'expr' ? c.raw : null);
    if (!fg) return;
    const style = el.attrs.get('style');
    const own = style ? styleRead(style, sheets, colorProps) : {};
    if (!own || own.opacity !== undefined) return;
    let bg;
    if (own.backgroundColor !== undefined) bg = parseColor(own.backgroundColor);
    else bg = behind(ancestors);
    if (!bg) return;
    report(el, own, fg, bg, true);
  };
  const report = (el, own, fg, bg, placeholder) => {
    const size = Number(own.fontSize);
    const bold = /bold|[6-9]00/.test(own.fontWeight || '');
    const large = size >= 24 || (size >= 18.66 && bold);
    const ratio = contrastRatio(fg, bg);
    if (ratio < (large ? 3 : 4.5)) out.push({ at: `${rel}:${el.line}`, fg: hexOf(fg), bg: hexOf(bg), ratio: Math.round(ratio * 100) / 100, large, ...(placeholder ? { placeholder: true } : {}) });
  };
  for (const el of tree) visit(el, []);
}

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

// A touchable whose tappable area is certainly under 44×44: explicit width and height below 44
// (padding is inside them in React Native), or no style at all around a single small icon.
function smallTarget(el, kinds, sheets) {
  const style = el.attrs.get('style');
  if (style) {
    const size = styleSize(style, sheets);
    if (!size) return null;
    const { width, height, minWidth, minHeight, flex, flexGrow, aspectRatio } = size;
    if ([flex, flexGrow, aspectRatio, minWidth, minHeight].some((v) => v !== undefined)) return null;
    if (!(width < SMALL && height < SMALL)) return null;
    return `${width}×${height}`;
  }
  const kids = el.children;
  if (kids.length !== 1 || kids[0].kind !== 'element') return null;
  const icon = kids[0].element;
  if (!kinds.isIcon(icon.name) || icon.spread) return null;
  const sz = icon.attrs.get('size');
  const n = sz && (sz.kind === 'expr' ? Number(sz.raw) : sz.kind === 'string' ? Number(sz.value) : NaN);
  if (!(n > 0 && n < SMALL)) return null;
  return `icon ${n}`;
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
  const smallTargets = [];
  const contrast = [];
  let buttons = 0;
  const noRole = [];
  const defaultProps = []; // { file, line, component, props }
  let readable = 0, unreadable = 0;
  for (const { file, text } of files) {
    const rel = file.split(path.sep).join('/');
    if (!/react-native/.test(text)) continue;
    // Developer-only screens (a debug menu, dev tools, storybook) are not seen by users.
    if (/(?:^|\/)(?:debug|dev-?tools?|dev-?menu|developer|__dev__|storybook|\.storybook|[\w-]*inspector|flipper)\/|(?:^|\/)(?:Debug|DevMenu|DevTools|\w*Inspector)\w*\.[jt]sx?$/i.test(rel)) continue;
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
    const sheets = /StyleSheet\.create/.test(text) ? styleSheets(text) : new Map();
    lowContrast(tree, kinds, sheets, rel, contrast);
    for (const el of walkElements(tree)) {
      const name = kinds.rnName(el.name);
      if (TOUCHABLES.has(name)) {
        if (!el.attrs.has('onPress') && !el.attrs.has('onLongPress')) continue;
        if (el.attrs.get('disabled')?.kind === 'true') continue;
        if (!el.spread) {
          buttons++;
          if (!el.attrs.has('accessibilityRole') && !el.attrs.has('role')) noRole.push(`${rel}:${el.line}`);
        }
        if (!el.attrs.has('hitSlop') && !el.spread) {
          const size = smallTarget(el, kinds, sheets);
          if (size) smallTargets.push({ at: `${rel}:${el.line}`, size });
        }
        if (hasAny(el, LABEL_PROPS)) continue;
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
      detail: 'These touchables contain only an icon or image and set no accessibilityLabel. VoiceOver and TalkBack announce them as an unnamed "button", so a screen reader user cannot tell back from close from delete. Add accessibilityLabel describing the action ("Close", "Delete photo") and accessibilityRole="button". (WCAG 2.2: 1.1.1 Non-text Content, 4.1.2 Name, Role, Value)',
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

  if (noRole.length) {
    findings.push({
      id: 'a11y-button-role-missing',
      severity: 'info',
      area: 'accessibility',
      title: `${noRole.length} of ${buttons} touchables have no accessibilityRole (${where(noRole)})`,
      detail: 'TouchableOpacity, TouchableHighlight, TouchableWithoutFeedback and Pressable do not tell VoiceOver or TalkBack that they are buttons: the user hears the text but not that it can be pressed. Set accessibilityRole="button" (or "link", "tab", "switch" where that fits), ideally once in your own Button component. This is missing in most React Native apps (94% of 676 open-source apps with touchables), so it is listed as a note.',
      evidence: noRole.slice(0, MAX_LOCATIONS).map((at) => ({ kind: 'source', at })),
      fix: { kind: 'accessibility', step: 'Add `accessibilityRole="button"` (or the role that fits) to touchables, ideally in your shared Button component.' },
    });
  }

  if (contrast.length) {
    const worst = [...contrast].sort((a, b) => a.ratio - b.ratio);
    const list = worst.map((c) => `${c.at} (${c.placeholder ? 'placeholder ' : ''}${c.fg} on ${c.bg}, ${c.ratio}:1)`);
    const placeholders = contrast.filter((c) => c.placeholder).length;
    findings.push({
      id: 'a11y-low-contrast',
      severity: worst[0].ratio < 3 ? 'medium' : 'low',
      area: 'accessibility',
      title: `${contrast.length} text style${contrast.length === 1 ? ' has' : 's have'} too little contrast with the background${placeholders ? `, ${placeholders} of them placeholder${placeholders === 1 ? '' : 's'}` : ''} (${where(list)})`,
      detail: `The text color and the background color behind it are both set in the code, and their contrast is below WCAG 2.2 AA: 4.5:1 for normal text, 3:1 for large text (24 pt, or 18.66 pt bold). The lowest is ${worst[0].ratio}:1.${placeholders ? ' Placeholder text (placeholderTextColor) is text too: people read it to know what to type.' : ''} Low contrast text is hard to read in sunlight, on dim screens and for people with low vision. Only literal colors are compared; themed or computed colors were not checked. (WCAG 2.2: 1.4.3 Contrast (Minimum))`,
      evidence: worst.slice(0, MAX_LOCATIONS).map((c) => ({ kind: 'source', at: c.at, color: c.fg, background: c.bg, ratio: c.ratio, ...(c.placeholder ? { placeholder: true } : {}) })),
      fix: { kind: 'accessibility', step: `Darken the text or lighten the background until each pair reaches 4.5:1 (3:1 for large text): ${list.slice(0, 5).map((a) => `\`${a}\``).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}.` },
    });
  }

  if (smallTargets.length) {
    const tiny = smallTargets.some((t) => Math.min(...(t.size.match(/\d+(?:\.\d+)?/g) || []).map(Number)) < 24);
    const list = smallTargets.map((t) => `${t.at} (${t.size})`);
    findings.push({
      id: 'a11y-small-touch-target',
      severity: 'low',
      area: 'accessibility',
      title: `${smallTargets.length} button${smallTargets.length === 1 ? ' is' : 's are'} smaller than 44×44 with no hitSlop (${where(list)})`,
      detail: `These touchables have an explicit size under 44×44 points, or no style around a single small icon, and no hitSlop to extend the tappable area. Apple recommends at least 44×44 pt and Android 48×48 dp; small targets are missed by people with tremors and by everyone on the move.${tiny ? ' Some are under 24×24, below the WCAG 2.2 AA minimum (2.5.8 Target Size).' : ' WCAG 2.2 AA asks for at least 24×24, which these meet; the platform guidelines ask for more.'} Add hitSlop (for example hitSlop={10}) or padding to reach 44–48.`,
      evidence: smallTargets.slice(0, MAX_LOCATIONS).map((t) => ({ kind: 'source', at: t.at, size: t.size })),
      fix: { kind: 'accessibility', step: `Give the small buttons a 44–48 point tappable area with \`hitSlop\` or padding: ${list.slice(0, 5).map((a) => `\`${a}\``).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}.` },
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

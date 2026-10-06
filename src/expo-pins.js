import fs from 'node:fs';
import path from 'node:path';

// Libraries whose version an Expo SDK decides (from Expo's bundledNativeModules.json). When the
// app's own copy of that file is installed it is used instead; this list covers scans without
// node_modules.
const EXPO_PINNED = new Set([
  'react-native-reanimated', 'react-native-worklets', 'react-native-gesture-handler', 'react-native-screens',
  'react-native-safe-area-context', 'react-native-webview', 'react-native-svg', 'react-native-pager-view',
  'react-native-maps', 'react-native-view-shot', 'react-native-get-random-values', 'react-native-keyboard-controller',
  '@react-native-async-storage/async-storage', '@react-native-community/datetimepicker', '@react-native-community/slider',
  '@react-native-community/netinfo', '@react-native-picker/picker', '@react-native-masked-view/masked-view',
  'lottie-react-native', '@shopify/flash-list', '@shopify/react-native-skia', '@stripe/stripe-react-native',
  '@react-native-segmented-control/segmented-control', '@sentry/react-native', 'react-native-bootsplash',
]);

export function expoPinnedNames(root) {
  try {
    let dir = root;
    while (true) {
      const file = path.join(dir, 'node_modules', 'expo', 'bundledNativeModules.json');
      if (fs.existsSync(file)) return new Set(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))));
      const parent = path.dirname(dir);
      if (parent === dir) return EXPO_PINNED;
      dir = parent;
    }
  } catch {
    return EXPO_PINNED;
  }
}

// Packages an Expo SDK upgrade moves on its own (`npx expo install --fix`): no separate work.
export function movesWithExpoSdk(name, pinned) {
  return /^(expo-|@expo\/)/.test(name) || ['expo', 'jest-expo', 'react-native', 'react', 'react-dom'].includes(name) || pinned.has(name);
}

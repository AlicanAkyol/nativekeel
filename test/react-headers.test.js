import test from 'node:test';
import assert from 'node:assert/strict';
import { unprefixedReactImports } from '../src/react-headers.js';
import { nativeChecks } from '../src/native.js';
import { upcomingChanges } from '../src/upcoming.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const RN = (version) => ({
  'node_modules/react-native/package.json': { name: 'react-native', version },
  'node_modules/react-native/React/Base/RCTBridge.h': '',
  'node_modules/react-native/React/Base/RCTConvert.h': '',
  'node_modules/react-native/React/Views/RCTComponent.h': '',
  'node_modules/react-native/React/Fabric/Mounting/ComponentViews/RCTFabricComponentsPlugins.h': '',
  'node_modules/react-native/React/CoreModules/RCTDeviceInfo.h': '',
});
const lib = (name, files) => Object.fromEntries([[`node_modules/${name}/package.json`, { name, version: '1.0.0' }], ...Object.entries(files).map(([f, t]) => [`node_modules/${name}/${f}`, t])]);
const app = (rn, extra = {}) => makeProject({
  'package.json': { name: 'app', dependencies: { 'react-native': rn, picker: '1.0.0', guarded: '1.0.0', fabric: '1.0.0', own: '1.0.0' } },
  'ios/Podfile': "platform :ios, '15.1'\n",
  ...RN(rn),
  ...lib('picker', { 'ios/DatePicker.m': '#import "DatePicker.h"\n#import "RCTComponent.h"\n', 'ios/DatePicker.h': '' }),
  ...lib('guarded', { 'ios/G.mm': '#if __has_include(<React/RCTBridge.h>)\n#import <React/RCTBridge.h>\n#else\n#import "RCTBridge.h"\n#endif\n' }),
  ...lib('fabric', { 'ios/V.mm': '#import "RCTFabricComponentsPlugins.h"\n#import "RCTDeviceInfo.h"\n#import <React/RCTConvert.h>\n' }),
  ...lib('own', { 'ios/RCTConvert.h': '', 'ios/O.m': '#import "RCTConvert.h"\n' }),
  ...extra,
});

test('react headers: unguarded imports without React/ are found; fallbacks, own headers and still-resolving ones are not', () => {
  const r = unprefixedReactImports(loadProject(app('0.87.1')));
  assert.deepEqual(r.libraries.map((l) => [l.name, l.hits[0].file, l.hits[0].line, l.hits[0].header]), [['picker', 'ios/DatePicker.m', 2, '"RCTComponent.h"']]);
  assert.equal(r.prebuilt, true);
});

test('react headers: building from source resolves the quoted form, not the bare angle form', () => {
  const r = unprefixedReactImports(loadProject(app('0.87.1', {
    'ios/Podfile': "ENV['RCT_USE_PREBUILT_RNCORE'] = '0'\nplatform :ios, '15.1'\n",
    ...lib('angle', { 'ios/A.m': '#import <RCTBridge.h>\n' }),
    'package.json': { name: 'app', dependencies: { 'react-native': '0.87.1', picker: '1.0.0', angle: '1.0.0' } },
  })));
  assert.equal(r.prebuilt, false);
  assert.deepEqual(r.libraries.map((l) => l.name), ['angle'], 'quoted picker resolves from source; the bare angle form does not');
});

test('react headers: the app\'s own files are never reported (they resolve in the app target)', () => {
  const r = unprefixedReactImports(loadProject(app('0.87.1', { 'ios/App/AppDelegate.h': '#import <RCTAppDelegate.h>\n#import "RCTBridge.h"\n' })));
  assert.deepEqual(r.app, []);
  assert.deepEqual(r.libraries.map((l) => l.name), ['picker']);
});

test('react headers: a build failure on 0.87+, a planned change before it', () => {
  const now = nativeChecks(loadProject(app('0.87.1'))).find((f) => f.id === 'ios-unprefixed-react-imports');
  assert.equal(now.severity, 'critical');
  assert.match(now.detail, /picker 1\.0\.0 \(ios\/DatePicker\.m:2 "RCTComponent\.h"\)/);
  assert.match(now.detail, /RCT_USE_PREBUILT_RNCORE=0/);
  assert.equal(nativeChecks(loadProject(app('0.86.3'))).find((f) => f.id === 'ios-unprefixed-react-imports'), undefined);
  const ahead = upcomingChanges(loadProject(app('0.86.3'))).find((c) => c.id === 'rn87-bare-includes');
  assert.deepEqual(ahead.hits, ['picker 1.0.0 (ios/DatePicker.m:2)']);
});

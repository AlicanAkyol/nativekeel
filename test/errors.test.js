import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERRORS, explainError } from '../src/errors.js';

// Real messages (quoted on the /fix/ pages, or reproduced by us).
const SAMPLES = {
  'android-exported': 'Manifest merger failed : Apps targeting Android 12 and higher are required to specify an explicit value for android:exported when the corresponding component has an intent filter defined.',
  'itms-91061': 'ITMS-91061: Missing privacy manifest - Your app includes "Frameworks/FirebaseCore.framework/FirebaseCore"',
  'missing-foreground-service-type': 'android.app.MissingForegroundServiceTypeException: Starting FGS without a type',
  'expo-packages-should-be-updated': 'The following packages should be updated for best compatibility with the installed expo version:\n  react-native-reanimated@3.19.5 - expected version: ~4.1.1',
  'deprecated-core-components': 'WARN  SafeAreaView has been deprecated and will be removed in a future release.',
  'supabase-rls-disabled': 'Lint: 0013_rls_disabled_in_public',
  'app-store-5-1-1-v': 'Guideline 5.1.1(v) - Data Collection and Storage. The app supports account creation but does not include an option to initiate account deletion.',
  'app-store-4-8': 'Guideline 4.8 - Design - Login Services',
  'google-play-target-api': 'Your app currently targets API level 34 and must target at least API level 36',
  'google-play-16kb': 'Your app does not support 16 KB memory page sizes',
  'google-play-debug-signed': 'You uploaded an APK or Android App Bundle that was signed in debug mode.',
  'uiscene-required': 'Application failed to launch: UIScene life cycle is required for apps built with this SDK.',
  'appdelegate-window-selector': "reason: '-[AppDelegate window]: unrecognized selector sent to instance 0x6000'",
  'rctcomponent-header-not-found': "error: 'RCTComponent.h' file not found",
  'removed-from-core': 'Invariant Violation: AsyncStorage has been removed from react-native core. It can now be installed and imported from @react-native-async-storage/async-storage',
  'interaction-manager-removed': "TypeError: Cannot read property 'runAfterInteractions' of undefined",
  'strict-typescript-deep-import': "src/a.ts(2,8): error TS2307: Cannot find module 'react-native/Libraries/Utilities/codegenNativeComponent'",
  'reanimated-worklet': '[Reanimated] Failed to create a worklet.',
  'invalid-hook-call': 'Error: Invalid hook call. Hooks can only be called inside of the body of a function component.',
  'codegen-eventemitter-property': "UnsupportedModulePropertyParserError: Module NativeReactNativeFs: TypeScript interfaces extending TurboModule must only contain 'FunctionTypeAnnotation's. Property 'onDownloadBegin'",
  'recycle-mounted-view': 'RCTComponentViewRegistry: Attempt to recycle a mounted view.',
};

test('explain_error: each known error is recognised from its real message', () => {
  for (const e of ERRORS) {
    assert.ok(SAMPLES[e.id], `sample message for ${e.id}`);
    assert.equal(explainError(SAMPLES[e.id])[0]?.id, e.id, e.id);
  }
});

test('explain_error: both forms of the removed-API message', () => {
  assert.equal(explainError('ART has been removed from React Native. ')[0].id, 'removed-from-core');  assert.equal(explainError("Invariant Violation: InteractionManager has been removed from react-native core. Please refactor long tasks into smaller ones, and use 'requestIdleCallback' instead.")[0].id, 'interaction-manager-removed');
  assert.equal(explainError("MenuViewManager.mm:3:9 'RCTBridge.h' file not found")[0].id, 'rctcomponent-header-not-found');
});

test('explain_error: unrelated text matches nothing', () => {
  for (const t of ['', 'BUILD SUCCESSFUL in 41s', 'error: cannot find symbol MainApplication', 'Metro waiting on exp://192.168.1.2:8081']) assert.deepEqual(explainError(t), [], t);
});

test('explain_error: related ids point at checks that exist', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const code = fs.readdirSync(src).map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
  for (const e of ERRORS) for (const prefix of e.related || []) assert.ok(code.includes(`'${prefix}`) || code.includes(`\`${prefix}`), `${e.id}: no check id starts with ${prefix}`);
});

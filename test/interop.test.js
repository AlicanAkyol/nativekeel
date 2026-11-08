import test from 'node:test';
import assert from 'node:assert/strict';
import { interopProblems } from '../src/interop.js';
import { nativeChecks } from '../src/native.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const kotlin = `
class MusicModule {
    @ReactMethod
    fun play(callback: Promise) = scope.launch {
        callback.resolve(null)
    }

    @ReactMethod
    @Suppress("unused")
    fun pause(callback: Promise) = launch { }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun isReady() = scope.async { true }

    @ReactMethod
    fun reset(callback: Promise) {
        scope.launch { callback.resolve(null) }
    }

    @ReactMethod
    fun fixed(callback: Promise) = launchUnit { }
}
`;

function project(withCodegen = false, source = kotlin) {
  return makeProject({
    'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', 'some-player': '3.2.0' } },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/some-player/package.json': { version: '3.2.0', ...(withCodegen ? { codegenConfig: { name: 'X' } } : {}) },
    'node_modules/some-player/android/src/main/java/x/MusicModule.kt': source,
    'node_modules/some-player/android/build/tmp/Ignored.kt': kotlin,
  });
}

test('flags only @ReactMethods whose expression body is a coroutine launch/async', () => {
  const deps = [{ name: 'some-player', version: '3.2.0', native: true }];
  const [p] = interopProblems(loadProject(project()), deps);
  assert.deepEqual(p.methods, ['play', 'pause'], 'sync methods, block bodies and Unit helpers are fine; build dirs ignored');
});

test('packages with their own codegen spec do not use the interop', () => {
  const deps = [{ name: 'some-player', version: '3.2.0', native: true }];
  assert.deepEqual(interopProblems(loadProject(project(true)), deps), []);
});

test('a local Unit-returning launch helper does not hide a qualified coroutine call', () => {
  const deps = [{ name: 'some-player', version: '3.2.0', native: true }];
  const patched = kotlin.replace('class MusicModule {', `class MusicModule {
    private fun launch(block: suspend CoroutineScope.() -> Unit) {
        scope.launch(block = block)
    }
    /*
    @ReactMethod
    fun oldPlay(callback: Promise) = scope.launch { }
    */
  `);
  const [problem] = interopProblems(loadProject(project(false, patched)), deps);
  assert.deepEqual(problem.methods, ['play']);
});

test('Track Player legacy host crashes only when the installed emitter uses a missing host', () => {
  const legacy = 'reactNativeHost.reactInstanceManager.currentReactContext';
  const service = `class MusicService : HeadlessJsTaskService() {
    private fun emit(event: String, data: Bundle? = null) {
        ${legacy}
            ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(event, data)
    }
  }`;
  const app = `class MainApplication : Application(), ReactApplication {
    override val reactHost: ReactHost by lazy { getDefaultReactHost(this) }
  }`;
  const check = (rn, appSource, serviceSource) => {
    const root = makeProject({
      'package.json': { dependencies: { 'react-native': rn, 'react-native-track-player': '4.1.2' } },
      'node_modules/react-native-track-player/package.json': { version: '4.1.2' },
      'node_modules/react-native-track-player/android/src/main/java/com/doublesymmetry/trackplayer/service/MusicService.kt': serviceSource,
      'android/app/src/main/java/com/app/MainApplication.kt': appSource,
    });
    return nativeChecks(loadProject(root)).find((f) => f.id === 'crash-track-player-legacy-host');
  };
  const finding = check('0.86.3', app, service);
  assert.equal(finding.area, 'crash');
  assert.match(finding.detail, /MusicService\.kt:3/);
  assert.equal(check('0.81.0', app, service), undefined);
  assert.equal(check('0.86.3', app, service.replace(legacy, 'reactHost?.currentReactContext')), undefined);
  assert.equal(check('0.86.3', app.replace('override val reactHost', 'override val reactNativeHost'), service), undefined);
  assert.equal(check('0.86.3', app, service.replace(legacy, `if (legacyMode) ${legacy}`)), undefined);
});

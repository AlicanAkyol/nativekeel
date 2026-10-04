import test from 'node:test';
import assert from 'node:assert/strict';
import { interopProblems } from '../src/interop.js';
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

function project(withCodegen = false) {
  return makeProject({
    'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', 'some-player': '3.2.0' } },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/some-player/package.json': { version: '3.2.0', ...(withCodegen ? { codegenConfig: { name: 'X' } } : {}) },
    'node_modules/some-player/android/src/main/java/x/MusicModule.kt': kotlin,
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { rootImportEvidence } from '../src/import-evidence.js';

test('type-only imports and shadowed require never become runtime import evidence', () => {
  for (const text of [
    "import { type DebouncedFunc } from 'lodash';",
    "import { type DebouncedFunc as F, type Many } from 'lodash';",
    "type T = import('lodash').DebouncedFunc<() => void>;",
    "const result = await import('lodash');", // deliberately unsupported, not proof of no use
    "function require(name) { return name; } const x = require('lodash');",
    "function f(require) { return require('lodash'); }",
    "const require = makeLoader(); const x = require('lodash');",
    "require = makeLoader(); require('lodash');",
    "const data = <Text>import x from 'lodash'</Text>;",
    "import 'lodash';", // side effects do not justify a per-method replacement
  ]) assert.deepEqual(rootImportEvidence(text), [], text);
});

test('static value imports, aliases, namespaces and unambiguous CommonJS retain evidence', () => {
  for (const text of [
    "import { debounce } from 'lodash';",
    "import { type DebouncedFunc, debounce as d } from 'lodash';",
    "import _ from 'lodash';",
    "import * as _ from 'lodash';",
    "import _, { debounce } from 'lodash';",
    "const _ = require('lodash');",
    "import {\n debounce,\n throttle as t\n} from 'lodash';",
  ]) assert.deepEqual(rootImportEvidence(text), [{ name: 'lodash', line: 1 }], text);
});

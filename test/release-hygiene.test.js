import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Every release must be visible (the owner's standing rule): README "What's new" (the npm page)
// and the top changelog entry name the version in package.json. A release cannot go out without.
const root = new URL('..', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');

test('README "What\'s new" and the changelog match the package version', () => {
  const { version } = JSON.parse(read('package.json'));
  const readme = read('README.md').match(/\*\*What's new in ([\d.]+):\*\*/);
  assert.ok(readme, 'README has a "What\'s new in X" line');
  assert.equal(readme[1], version, 'README "What\'s new" names the current version');
  const top = read('site/changelog.html').match(/<div class="rel"><h2>([\d.]+)<\/h2>/);
  assert.equal(top && top[1], version, 'the newest changelog entry is the current version');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlReport } from '../src/report-html.js';

const base = (findings) => ({ project: { root: '/x', name: 'app', reactNative: '0.80.0', newArch: {} }, deps: [], latest: {}, warnings: [], findings, scannedAt: '2026-10-24T00:00:00Z' });
const deadline = { id: 'play-target-sdk-updates', severity: 'critical', area: 'store', title: 'Target SDK too low', detail: 'd' };

test('html report: the hand-over line appears only on unbranded reports with a store deadline', () => {
  assert.match(htmlReport(base([deadline])), /hello@nativekeel\.com/);
  assert.doesNotMatch(htmlReport(base([deadline]), { brand: 'Acme Agency' }), /hello@nativekeel\.com/, 'an agency report to its own client carries no offer from us');
  assert.doesNotMatch(htmlReport(base([{ id: 'a11y-icon-button-unlabeled', severity: 'medium', area: 'accessibility', title: 't', detail: 'd' }])), /hello@nativekeel\.com/);
});

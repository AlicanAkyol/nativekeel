import { executionSafety } from './safety.js';
import { buildPlan } from './plan.js';

const severity = ['critical', 'high', 'medium', 'low', 'info'];
const domains = ['security', 'stability', 'accessibility', 'performance', 'delivery', 'upgrade', 'dependencies'];
const UPGRADE_AREAS = new Set(['react-native', 'expo', 'new-architecture', 'native']);
function domain(f) {
  if (f.area === 'security' || f.area === 'secret' || f.masvs || f.id === 'malicious-code' || f.id.startsWith('malware-dep:')) return 'security';
  if (f.area === 'crash') return 'stability';
  if (f.area === 'accessibility') return 'accessibility';
  if (f.area === 'performance') return 'performance';
  if (f.area === 'store') return 'delivery';
  if (UPGRADE_AREAS.has(f.area)) return 'upgrade';
  return 'dependencies';
}
const guidance = {
  security: {
    effect: 'Reduce the reported exposure of user data, accounts or the app itself.',
    prerequisite: 'Confirm the reported code is part of the shipped app and check for protections the scan could not see.',
    validate: 'Rescan to confirm the finding is gone, then run the affected flow with synthetic data: the sensitive value or untrusted input must no longer reach the reported destination, and the feature must still work.',
  },
  stability: {
    effect: 'Remove the reported crash or compatibility condition if the affected feature is used.',
    prerequisite: 'Confirm the resolved versions, platform and affected execution path.',
    validate: 'Reproduce the affected flow, apply one change, then repeat it in a release build on each supported platform; retain crash logs.',
  },
  accessibility: {
    effect: 'Let screen reader users identify the control, or let people who enlarge text read it.',
    prerequisite: 'Open the screen with VoiceOver (iOS) or TalkBack (Android) and confirm what is announced today.',
    validate: 'With VoiceOver and TalkBack, check each changed control is announced with its name and role; with the largest system text size, check the screen still fits and nothing is cut off.',
  },
  performance: {
    effect: 'A potential optimization, with no measured size, memory, startup or frame-rate gain yet.',
    prerequisite: 'Inspect the shipped release code and reproduce a bottleneck before selecting a change; retain the current implementation if no benefit is established.',
    validate: 'Compare the same user flow, device, data and release configuration before and after. Repeat measurements and record variability, behavior regressions and the metric actually measured.',
  },
  delivery: {
    effect: 'Address the reported platform or store submission requirement.',
    prerequisite: 'Confirm the requirement applies to the intended platform, submission date and release artifact.',
    validate: 'Inspect the actual signed release artifact and platform validation results; source configuration alone does not establish store acceptance.',
  },
  upgrade: {
    effect: 'Keep the app buildable on a supported React Native or Expo version.',
    prerequisite: 'Confirm the installed versions and the platforms the change affects; `npx nativekeel plan` orders it with the related upgrade steps.',
    validate: 'After this one change, build debug and release on each supported platform and go through the screens that use native modules.',
  },
  dependencies: {
    effect: 'Resolve the reported dependency constraint if it applies to the installed graph and used features.',
    prerequisite: 'Review resolved versions, direct and transitive consumers, dynamic/native/generated usage, and feature parity. Popularity or age alone does not justify replacement.',
    validate: 'Change one dependency decision at a time, test affected behavior on supported platforms, and compare actual release artifacts before claiming a saving.',
  },
};


function secretGuidance(f) {
  const x = f.fix;
  // An AI key read from a public env variable ships in the bundle. Revoking it before the
  // server endpoint exists breaks the feature for installed copies, so the scanner's order stays.
  if (f.id.startsWith('ai-key-in-bundle:') && x?.step) return {
    change: `${x.step} Until the key is revoked, set a spending limit on it at the provider if one is offered.`,
    prerequisite: 'Identify the provider account that owns the key without exposing the value.',
    effect: 'Invalidate the shipped key and keep its replacement on a server you control.',
    validate: 'Confirm at the provider that the shipped key is revoked, check its usage for requests you did not make, and verify the new release bundle no longer contains a provider key.',
    rollback: 'Keep the shipped key revoked. Restore the feature through the server endpoint; never put a provider key back into the app.',
    exposure: 'bundle',
  };
  if (x?.kind !== 'secret') return null;
  const location = `${x.file}${x.line ? `:${x.line}` : ''}`;
  let change;
  if (f.id.startsWith('secret:aws-access-key:')) change = `Deactivate the IAM access key matching the AWS access key ID in ${location} immediately, then replace legitimate use through protected credentials. Remove the value from the app and review AWS activity logs; deleting source alone does not revoke the key.`;
  else if (f.id.startsWith('signing-keystore:')) change = `Move the release keystore in ${location} into protected signing storage. If exposed, use the appropriate signing-key recovery process; for Play App Signing, reset the upload key rather than replacing the app signing identity blindly.`;
  else if (f.id.startsWith('signing-asc-key:')) change = `Revoke the App Store Connect API key in ${location} in Users and Access → Integrations; provision its replacement in CI secrets.`;
  else if (f.id.startsWith('signing-p12:')) change = `Revoke the exposed signing certificate associated with ${location} in the Apple Developer portal, then provision a protected replacement signing identity.`;
  else if (x.label === 'Signing passwords') change = `Move signing passwords in ${location} to protected signing storage. Change them if the keystore or passwords left your control; assess the signing key's exposure separately.`;
  else if (x.exposure === 'test-key') change = `Confirm the private key in ${location} is dedicated to tests. If it is also used by a real service, rotate it there; do not rotate unrelated production keys for a dedicated test fixture.`;
  else if (x.exposure === 'comment') change = `If the credential in ${location} is real, revoke or rotate it at its provider; then delete the commented value. A comment can remain exposed through repository history.`;
  else change = `Revoke or rotate the ${x.label || 'credential'} in ${location} at its provider immediately. Removing it from source does not invalidate exposed copies. ${x.bundled ? 'Move privileged operations to a backend; never put the replacement secret in the app.' : 'Store the replacement in protected server or CI secrets, outside the repository.'}`;
  const signing = f.id.startsWith('signing-') || x.label === 'Signing passwords';
  if (signing) return {
    change,
    prerequisite: 'Find out who had access to the repository and whether release builds were signed with this key; for Play App Signing the upload key can be reset.',
    effect: 'Keep the signing key and its passwords out of the repository, so nobody else can sign builds as you.',
    validate: 'Confirm the file or passwords are gone from the current source and from CI logs, a release build still signs with the protected copy, and (if reset) Google Play or Apple accepts the new key.',
    rollback: 'Keep the exposed key material out of the repository; restore signing from protected storage, never from the committed copy.',
  };
  return {
    change,
    prerequisite: x.exposure === 'test-key' ? 'Check whether this key is dedicated to tests or also protects a real service.' : x.exposure === 'comment' ? 'Determine whether this is a real credential; comments do not establish active use or invalidate a previously exposed key.' : 'Identify the credential owner and provider without exposing the value. For a real exposed credential, containment must not wait for path reachability or an exploit reproduction.',
    effect: 'Invalidate the exposed credential and prevent its replacement from being distributed through the same path; assess any prior misuse separately.',
    validate: x.exposure === 'test-key' ? 'Verify the test key is absent from production configuration and release inputs; if production reuse is found, confirm rotation with its provider.' : x.exposure === 'comment' ? 'Verify removal from current source; if the value was real, confirm provider revocation or rotation. Deleting the comment alone does not remove history.' : 'Confirm revocation or rotation in provider records, inspect access logs for misuse, and verify legitimate operations with the replacement. Check repository and release outputs for the old value without displaying it.',
    rollback: 'Keep the exposed credential revoked. Restore legitimate service using a protected replacement; never roll back to the leaked value.',
  };
}

// Concrete steps for one finding, taken from the upgrade plan so both commands give the same
// instructions. Phases every plan carries (safety net, final verification) are not specific to it.
const SHARED_PHASES = new Set(['Set up a safety net', 'Verify before you ship']);
function planSteps(result, f) {
  try {
    return buildPlan({ ...result, findings: [f] }).phases
      .filter((p) => !SHARED_PHASES.has(p.title))
      .flatMap((p) => p.steps)
      .map((s) => s.replace(/\*\*/g, ''));
  } catch {
    return [];
  }
}

// Before React Native 0.76 the upgrade plan folds the architecture switch into the version
// upgrade, so a single-finding plan has no steps for it.
function fallbackChange(f) {
  if (f.fix?.kind === 'enable-new-arch') return 'Upgrade to a React Native version between 0.76 and 0.81 first, then switch on the New Architecture there in its own commit: set newArchEnabled=true in android/gradle.properties and in ios/Podfile.properties.json (newArchEnabled in app.json for Expo), clean-build both platforms and test every screen that uses a native module. `npx nativekeel plan` lists the upgrade stops.';
  return 'Apply the fix described under Why. `npx nativekeel plan` puts it in order with the upgrade steps it depends on.';
}

// This is a decision layer over existing checks, not a new vulnerability detector.
// Severity determines review order; it is never converted to an app quality score.
export function buildImprovementPlan(result, { limit = 80 } = {}) {
  const safety = executionSafety(result.findings);
  const findings = result.findings.filter(f => f.severity !== 'info');
  const sorted = [...findings].sort((a, b) =>
    Number(b.id === 'malicious-code' || b.id.startsWith('malware-dep:')) - Number(a.id === 'malicious-code' || a.id.startsWith('malware-dep:')) ||
    severity.indexOf(a.severity) - severity.indexOf(b.severity) ||
    domains.indexOf(domain(a)) - domains.indexOf(domain(b)) || a.id.localeCompare(b.id));
  const cap = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 1000) : 80;
  const actions = sorted.slice(0, cap).map((f, i) => {
    const category = domain(f);
    const secret = secretGuidance(f);
    const guide = secret || guidance[category];
    return {
      order: i + 1, findingId: f.id, domain: category, severity: f.severity,
      title: f.title, reason: f.detail,
      priorityReason: f.id === 'malicious-code' || f.id.startsWith('malware-dep:') ? 'Execution safety takes precedence over all improvements.' : `Review ${f.severity} findings first; this order does not estimate exploit likelihood or measured benefit.`,
      confidence: f.confidence || 'not-specified-by-check',
      evidence: f.evidence || f.recommendation?.evidence || [],
      evidenceLimit: 'Static scan finding; reachability, build inclusion and runtime impact are not independently verified by this plan.',
      prerequisites: safety.blocked ? ['Inspect the flagged files as text in isolation before considering any execution.'] : [guide.prerequisite, ...(f.attack?.prerequisite ? [f.attack.prerequisite] : []), ...(f.recommendation?.requirements || [])],
      expectedEffect: f.attack?.impact ? `Address this reported potential impact: ${f.attack.impact}` : guide.effect,
      measuredBenefit: null,
      automaticFix: false,
      status: safety.blocked ? 'blocked-by-execution-safety' : secret && !['comment', 'test-key'].includes(secret.exposure || f.fix.exposure) ? 'containment-required' : 'review-required',
      proposedChange: safety.blocked ? null : secret?.change || f.fix?.step || planSteps(result, f).join(' ') || fallbackChange(f),
      validation: safety.blocked ? [] : [f.attack?.validation || guide.validate],
      rollback: safety.blocked ? null : secret?.rollback || 'Keep the original implementation in version control; revert if behavior regresses or the intended benefit cannot be verified.',
    };
  });
  return {
    schemaVersion: 1, project: result.project, safety,
    conclusion: safety.blocked ? safety.warning : findings.length ? 'Review source-backed candidates, validate applicability, then measure the effect of each change.' : 'No actionable matches in the checks run. App security and quality remain unverified.',
    ordering: 'Malware stop condition, then severity, then security/stability/accessibility/performance/delivery/upgrade/dependencies. No quality score or benefit estimate.',
    totalActions: sorted.length, omittedActions: Math.max(0, sorted.length - actions.length), actions,
    coverage: domains.map(name => ({ domain: name, scope: 'existing static checks only', findings: findings.filter(f => domain(f) === name).length, verdict: 'not-certified' })),
    unassessed: [
      { domain: 'runtime-performance', reason: 'No device measurements collected.', evidenceNeeded: 'Repeated release startup, frame timing, memory, battery and network measurements for representative user flows.' },
      { domain: 'live-backend-authorization', reason: 'Deployed rules and account isolation were not exercised.', evidenceNeeded: 'Authorized tests with two test accounts, synthetic records and the deployed backend configuration.' },
      { domain: 'accessibility-and-usability', reason: 'Static checks cover icon-only button labels, text field labels and app-wide text scaling only. Focus order, custom components, color contrast, touch target size and task completion with a screen reader were not tested.', evidenceNeeded: 'Representative screen flows on supported devices with accessibility testing and user observation.' },
      { domain: 'reliability', reason: 'Offline use, interrupted requests, upgrades and long sessions were not exercised.', evidenceNeeded: 'Controlled lifecycle, network failure, migration and recovery tests.' },
      { domain: 'dependency-advisories', reason: result.offline ? 'Online advisory checks were skipped or unavailable.' : 'Advisory lookup coverage is limited to the scanner; absence of findings does not prove absence of vulnerabilities.', evidenceNeeded: 'Resolved release dependency inventory and current advisories, including native dependencies.' },
    ],
    warnings: result.warnings || [],
    securityCoverage: result.securityReview || null,
  };
}

// Render repository-derived values as escaped text, never active Markdown links/HTML.
const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/[&<>]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[c])).replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
export function improvementToMarkdown(plan) {
  const lines = ['# App improvement plan', '', safe(plan.conclusion), '', safe(plan.ordering), '', `Actions: ${plan.totalActions}; omitted: ${plan.omittedActions}.`, ''];
  for (const a of plan.actions) {
    lines.push(`## ${a.order}. ${safe(a.title)}`, '', `${safe(a.domain)} · ${safe(a.severity)} · ${safe(a.status)}`, '', `Finding: ${safe(a.findingId)}`, '', `Why: ${safe(a.reason)}`, '', `Expected effect: ${safe(a.expectedEffect)}`, '', ...(a.evidence && Object.keys(a.evidence).length ? [`Evidence: ${safe(JSON.stringify(a.evidence))}`, ''] : []), safe(a.evidenceLimit), '', ...(a.confidence !== 'not-specified-by-check' ? [`Confidence: ${safe(a.confidence)}`, ''] : []), ...a.prerequisites.map(p => `- Before changing: ${safe(p)}`), '');
    if (a.proposedChange) lines.push(`Action: ${safe(a.proposedChange)}`, '', ...a.validation.map(v => `- Validate: ${safe(v)}`), '', `Rollback: ${safe(a.rollback)}`, '');
  }
  lines.push('## Still unassessed', '', ...plan.unassessed.map(u => `- ${safe(u.domain)}: ${safe(u.reason)} Needed: ${safe(u.evidenceNeeded)}`), '', ...plan.warnings.map(w => `- Scan warning: ${safe(w)}`), '');
  return lines.join('\n');
}

// Terminal output needs no Markdown escaping; retain control/bidi stripping.
const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
export function improvementToText(plan) {
  const lines = ['App improvement plan', plain(plan.conclusion), `Actions: ${plan.totalActions}; omitted: ${plan.omittedActions}.`, ''];
  for (const a of plan.actions) {
    lines.push(`${a.order}. [${plain(a.severity)} / ${plain(a.domain)}] ${plain(a.title)}`, `   Why: ${plain(a.reason)}`);
    if (a.proposedChange) lines.push(`   Action: ${plain(a.proposedChange)}`);
    for (const p of a.prerequisites) lines.push(`   Check: ${plain(p)}`);
    for (const v of a.validation) lines.push(`   Verify: ${plain(v)}`);
    if (a.rollback) lines.push(`   Recovery: ${plain(a.rollback)}`);
    lines.push('');
  }
  lines.push('Still unassessed:', ...plan.unassessed.map(u => `  ${plain(u.domain)}: ${plain(u.reason)} Needed: ${plain(u.evidenceNeeded)}`), ...plan.warnings.map(w => `  Scan warning: ${plain(w)}`));
  return lines.join('\n');
}

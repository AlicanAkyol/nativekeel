import { executionSafety } from './safety.js';

const severity = ['critical', 'high', 'medium', 'low', 'info'];
const domains = ['security', 'stability', 'performance', 'delivery', 'dependencies'];
function domain(f) {
  if (f.area === 'security' || f.area === 'secret' || f.masvs || f.id === 'malicious-code') return 'security';
  if (f.area === 'crash') return 'stability';
  if (f.area === 'performance') return 'performance';
  if (f.area === 'store') return 'delivery';
  return 'dependencies';
}
const guidance = {
  security: {
    effect: 'Reduce the reported exposure if its attacker prerequisites hold.',
    prerequisite: 'Confirm the affected path is reachable and inspect existing protections before treating this as an exploitable vulnerability.',
    validate: 'In an isolated test environment with synthetic data, reproduce the reported condition and verify the protection rejects it while legitimate access still works.',
  },
  stability: {
    effect: 'Remove the reported crash or compatibility condition if the affected feature is used.',
    prerequisite: 'Confirm the resolved versions, platform and affected execution path.',
    validate: 'Reproduce the affected flow, apply one change, then repeat it in a release build on each supported platform; retain crash logs.',
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
  dependencies: {
    effect: 'Resolve the reported dependency constraint if it applies to the installed graph and used features.',
    prerequisite: 'Review resolved versions, direct and transitive consumers, dynamic/native/generated usage, and feature parity. Popularity or age alone does not justify replacement.',
    validate: 'Change one dependency decision at a time, test affected behavior on supported platforms, and compare actual release artifacts before claiming a saving.',
  },
};

// This is a decision layer over existing checks, not a new vulnerability detector.
// Severity determines review order; it is never converted to an app quality score.
export function buildImprovementPlan(result, { limit = 80 } = {}) {
  const safety = executionSafety(result.findings);
  const findings = result.findings.filter(f => f.severity !== 'info');
  const sorted = [...findings].sort((a, b) =>
    Number(b.id === 'malicious-code') - Number(a.id === 'malicious-code') ||
    severity.indexOf(a.severity) - severity.indexOf(b.severity) ||
    domains.indexOf(domain(a)) - domains.indexOf(domain(b)) || a.id.localeCompare(b.id));
  const cap = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 1000) : 80;
  const actions = sorted.slice(0, cap).map((f, i) => {
    const category = domain(f);
    const guide = guidance[category];
    return {
      order: i + 1, findingId: f.id, domain: category, severity: f.severity,
      title: f.title, reason: f.detail,
      priorityReason: f.id === 'malicious-code' ? 'Execution safety takes precedence over all improvements.' : `Review ${f.severity} findings first; this order does not estimate exploit likelihood or measured benefit.`,
      confidence: f.confidence || 'not-specified-by-check',
      evidence: f.evidence || f.recommendation?.evidence || [],
      evidenceLimit: 'Static scan finding; reachability, build inclusion and runtime impact are not independently verified by this plan.',
      prerequisites: safety.blocked ? ['Inspect the flagged files as text in isolation before considering any execution.'] : [guide.prerequisite, ...(f.attack?.prerequisite ? [f.attack.prerequisite] : []), ...(f.recommendation?.requirements || [])],
      expectedEffect: f.attack?.impact ? `Address this reported potential impact: ${f.attack.impact}` : guide.effect,
      measuredBenefit: null,
      automaticFix: false,
      status: safety.blocked ? 'blocked-by-execution-safety' : 'review-required',
      proposedChange: safety.blocked ? null : f.fix?.step || 'Review the finding in context before choosing a change.',
      validation: safety.blocked ? [] : [f.attack?.validation || guide.validate],
      rollback: safety.blocked ? null : 'Keep the original implementation in version control; revert if behavior regresses or the intended benefit cannot be verified.',
    };
  });
  return {
    schemaVersion: 1, project: result.project, safety,
    conclusion: safety.blocked ? safety.warning : findings.length ? 'Review source-backed candidates, validate applicability, then measure the effect of each change.' : 'No actionable matches in the checks run. App security and quality remain unverified.',
    ordering: 'Malware stop condition, then severity, then security/stability/performance/delivery/dependencies. No quality score or benefit estimate.',
    totalActions: sorted.length, omittedActions: Math.max(0, sorted.length - actions.length), actions,
    coverage: domains.map(name => ({ domain: name, scope: 'existing static checks only', findings: findings.filter(f => domain(f) === name).length, verdict: 'not-certified' })),
    unassessed: [
      { domain: 'runtime-performance', reason: 'No device measurements collected.', evidenceNeeded: 'Repeated release startup, frame timing, memory, battery and network measurements for representative user flows.' },
      { domain: 'live-backend-authorization', reason: 'Deployed rules and account isolation were not exercised.', evidenceNeeded: 'Authorized tests with two test accounts, synthetic records and the deployed backend configuration.' },
      { domain: 'accessibility-and-usability', reason: 'Screen reader behavior, focus, text scaling and task completion were not tested.', evidenceNeeded: 'Representative screen flows on supported devices with accessibility testing and user observation.' },
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
    lines.push(`## ${a.order}. ${safe(a.title)}`, '', `${safe(a.domain)} · ${safe(a.severity)} · ${safe(a.status)}`, '', `Finding: ${safe(a.findingId)}`, '', `Why: ${safe(a.reason)}`, '', `Expected effect: ${safe(a.expectedEffect)}`, '', `Evidence: ${safe(JSON.stringify(a.evidence))}`, '', safe(a.evidenceLimit), '', `Confidence: ${safe(a.confidence)}. Measured benefit: none.`, '', ...a.prerequisites.map(p => `- Before changing: ${safe(p)}`), '');
    if (a.proposedChange) lines.push(`Proposed change (review first): ${safe(a.proposedChange)}`, '', ...a.validation.map(v => `- Validate: ${safe(v)}`), '', `Rollback: ${safe(a.rollback)}`, '');
  }
  lines.push('## Still unassessed', '', ...plan.unassessed.map(u => `- ${safe(u.domain)}: ${safe(u.reason)} Needed: ${safe(u.evidenceNeeded)}`), '', ...plan.warnings.map(w => `- Scan warning: ${safe(w)}`), '');
  return lines.join('\n');
}

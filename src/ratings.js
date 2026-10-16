// A–E rating per area, the way SonarQube rates code: A = no findings, B = only low ones,
// C = at least one medium, D = at least one high, E = at least one critical. Info notes do not
// count. A rating says what the scan found in that area, not that the area is safe.
export const AREAS = [
  { key: 'security', label: 'Security', areas: ['security', 'secret'] },
  { key: 'store', label: 'Store', areas: ['store'] },
  { key: 'stability', label: 'Stability', areas: ['crash'] },
  { key: 'upgrade', label: 'Upgrade', areas: ['react-native', 'native', 'dependency', 'new-architecture', 'expo'] },
  { key: 'performance', label: 'Performance', areas: ['performance'] },
  { key: 'accessibility', label: 'Accessibility', areas: ['accessibility'] },
];
const GRADE = { critical: 'E', high: 'D', medium: 'C', low: 'B' };
const ORDER = ['critical', 'high', 'medium', 'low'];

export function ratings(findings) {
  return AREAS.map(({ key, label, areas }) => {
    const mine = findings.filter((f) => areas.includes(f.area) && f.severity !== 'info');
    const worst = ORDER.find((s) => mine.some((f) => f.severity === s));
    return { key, label, rating: worst ? GRADE[worst] : 'A', findings: mine.length };
  });
}

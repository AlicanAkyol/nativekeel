#!/usr/bin/env node
// Writes npm download numbers into the homepage between the usage markers.
// Run weekly by .github/workflows/usage.yml; the page itself makes no third-party requests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const page = path.join(repo, 'site/index.html');
const LAUNCH = '2026-10-04';
const START = '<!-- usage:start -->';
const END = '<!-- usage:end -->';

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const today = new Date().toISOString().slice(0, 10);
const range = await json(`https://api.npmjs.org/downloads/range/${LAUNCH}:${today}/nativekeel`);
const days = range.downloads.slice();
// npm publishes a day's count a day or two later; trailing zeros are days not counted yet.
while (days.length && days[days.length - 1].downloads === 0) days.pop();
if (days.length < 7) throw new Error('not enough download data');
const last30 = days.slice(-30);
const total = days.reduce((n, d) => n + d.downloads, 0);
const month = last30.reduce((n, d) => n + d.downloads, 0);
const week = days.slice(-7).reduce((n, d) => n + d.downloads, 0);

const fmt = (n) => n.toLocaleString('en-US');
const dayName = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const max = Math.max(...last30.map((d) => d.downloads));
const W = 300, H = 64, gap = 2;
const bw = (W - gap * (last30.length - 1)) / last30.length;
const bars = last30.map((d, i) => {
  const h = Math.max(1, Math.round((d.downloads / max) * H));
  return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${H - h}" width="${bw.toFixed(1)}" height="${h}" rx="1.5"><title>${dayName(d.day)}: ${fmt(d.downloads)}</title></rect>`;
}).join('');
const through = dayName(days[days.length - 1].day);

const html = `${START}
  <section id="usage" class="usage" aria-labelledby="usage-h">
    <h2 id="usage-h" class="usage-k">In use</h2>
    <div class="usage-stats">
      <div><b>${fmt(week)}</b><span>npm downloads, last 7 days</span></div>
${days.length >= 60 ? `      <div><b>${fmt(month)}</b><span>last 30 days</span></div>
` : ''}      <div><b>${fmt(total)}</b><span>since launch, ${dayName(LAUNCH)} 2026</span></div>
    </div>
    <figure class="usage-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily npm downloads, ${dayName(last30[0].day)} to ${through}" preserveAspectRatio="none">${bars}</svg><figcaption>Daily downloads through ${through}</figcaption></figure>
    <p class="usage-note">From npm's public download counts, which include CI runs and package mirrors. NativeKeel sends no telemetry, so we do not know more than this.</p>
  </section>
  ${END}`;

const src = fs.readFileSync(page, 'utf8');
const a = src.indexOf(START), b = src.indexOf(END);
if (a < 0 || b < a) throw new Error('usage markers not found in site/index.html');
fs.writeFileSync(page, src.slice(0, a) + html + src.slice(b + END.length));
console.log(`usage: ${fmt(week)} / 7 days, ${fmt(month)} / ${last30.length} days, ${fmt(total)} total, through ${through}`);

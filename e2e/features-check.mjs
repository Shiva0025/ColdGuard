// Browser check for: response analytics panel, alert toggle + title badge, time-to-breach forecast, CSV export.
// Needs `npm run dev` running. Usage: node e2e/features-check.mjs [deviceId] [outDir]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [, , dev = 'DC-S09', outDir = '.'] = process.argv;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
await p.goto('http://localhost:5173/');
await p.getByLabel('Username').fill('operator');
await p.getByLabel('Password').fill('coldguard-demo');
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForTimeout(1500);
const token = await p.evaluate(() => sessionStorage.getItem('coldguard.token'));
const fault = (kind) =>
  fetch('http://localhost:4000/api/sim/fault', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind, deviceId: dev }) }).then((r) => r.status);

// 1. Alert toggle
const toggle = p.getByRole('button', { name: /Alerts muted|Alerts on/ });
await toggle.click();
console.log('alerts toggle pressed:', await toggle.getAttribute('aria-pressed'));

// 2. Forecast banner after a cooling failure
await p.goto(`http://localhost:5173/device/${dev}`);
await p.waitForTimeout(1500);
console.log('fault status:', await fault('cooling_failure'));
const banner = p.getByText(/Forecast: reaches/);
await banner.waitFor({ timeout: 90_000 });
console.log('forecast:', (await banner.locator('..').innerText()).replace(/\s+/g, ' '));
await p.screenshot({ path: `${outDir}/feature-forecast.png` });

// 3. CSV export
const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Export CSV' }).click()]);
const csv = readFileSync(await dl.path(), 'utf8').trim().split('\n');
console.log('csv:', dl.suggestedFilename(), 'rows:', csv.length - 1, '| header:', csv[0].slice(0, 60), '| last:', csv[csv.length - 1].slice(0, 70));

// 4. Wait for the incident, then check the title badge and the analytics panel
await p.getByText(/Temperature above range|Rapid temperature drift/).first().waitFor({ timeout: 90_000 });
await p.waitForTimeout(1000);
console.log('title:', await p.title());
await p.goto('http://localhost:5173/incidents');
await p.getByText('Response performance').waitFor();
await p.waitForTimeout(2500);
console.log('analytics:', (await p.locator('section[aria-labelledby="resp-h"]').innerText()).replace(/\s+/g, ' ').slice(0, 420));
await p.screenshot({ path: `${outDir}/feature-analytics.png` });
console.log('restore status:', await fault('restore'));
console.log('errors:', JSON.stringify(errs));
await b.close();

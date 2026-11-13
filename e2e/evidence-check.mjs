// Scripted check: verify → tamper → broken → undo → intact; then open the evidence report (needs `npm run dev`).
import { chromium } from '@playwright/test';
const [, , out = 'evidence', dev = 'DC-S04', incident = ''] = process.argv;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 1200 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5173/');
await p.getByLabel('Username').fill('operator');
await p.getByLabel('Password').fill('coldguard-demo');
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForTimeout(800);
await p.goto(`http://localhost:5173/device/${dev}`);
const panel = p.getByRole('region', { name: 'Evidence chain' });
await panel.getByText(/Intact|Chain broken/).waitFor();
console.log('before:', (await panel.getByRole('status').innerText()).split('\n')[0]);
await panel.getByRole('button', { name: /Tamper with a stored reading/ }).click();
await panel.getByText(/Chain broken/).waitFor();
console.log('after tamper:', (await panel.getByRole('status').innerText()).split('\n').slice(0, 2).join(' | '));
await panel.scrollIntoViewIfNeeded();
await panel.screenshot({ path: `${out}-broken.png` });
if (incident) {
  await p.goto(`http://localhost:5173/incident/${incident}/report`);
  await p.getByText(/Evidence (verified|FAILED)/).waitFor();
  console.log('report while tampered:', await p.getByText(/Evidence (verified|FAILED)/).innerText());
}
await p.goto(`http://localhost:5173/device/${dev}`);
await panel.getByRole('button', { name: /Undo tamper/ }).click();
await panel.getByText(/Intact/).waitFor();
console.log('after undo:', (await panel.getByRole('status').innerText()).split('\n')[0]);
if (incident) {
  await p.goto(`http://localhost:5173/incident/${incident}/report`);
  await p.getByText(/Evidence (verified|FAILED)/).waitFor();
  await p.screenshot({ path: `${out}-report.png`, fullPage: true });
}
console.log('errors', errs);
await b.close();

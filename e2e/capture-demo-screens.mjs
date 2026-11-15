import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('demo-screens');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log('[capture] Launching Chrome...');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const TARGET = 'DC-S03';

try {
  console.log('[capture] 1. Login page');
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, '01-login.png') });

  console.log('[capture] 2. Overview page');
  await page.getByLabel('Username').fill('operator');
  await page.getByLabel('Password').fill('coldguard-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(2000);

  // Reset demo to clean baseline
  await page.evaluate(async () => {
    const h = { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('coldguard.token') };
    await fetch('/api/sim/fault', { method: 'POST', headers: h, body: JSON.stringify({ kind: 'restore' }) });
    await fetch('/api/demo/reset', { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'RESET' }) });
  });
  await page.waitForTimeout(3000);
  await page.reload();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, '02-overview.png') });

  console.log('[capture] 3. Lane board & fleet table');
  await page.mouse.wheel(0, 350);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, '03-laneboard.png') });
  await page.mouse.wheel(0, -350);
  await page.waitForTimeout(1000);

  console.log('[capture] 4. Control Centre & QR Invite');
  await page.getByRole('link', { name: 'Control centre' }).click();
  await page.waitForTimeout(1500);
  const inviteBtn = page.getByRole('button', { name: /Create invite|New code/i });
  if (await inviteBtn.isVisible()) {
    await inviteBtn.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(outDir, '04-control-qr.png') });

  console.log('[capture] 5. Injecting fault on ' + TARGET);
  await page.getByLabel('Target logger').selectOption(TARGET);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Door left open/i }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^Cooling failure/i }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, '05-control-fault.png') });

  console.log('[capture] 6. Device Investigation Page');
  await page.goto(`http://localhost:5173/device/${TARGET}`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(outDir, '06-device-telemetry.png') });

  console.log('[capture] 7. Waiting for early drift warning...');
  await page.waitForTimeout(15000);
  await page.screenshot({ path: path.join(outDir, '07-drift-warning.png') });

  console.log('[capture] 8. Acknowledging incident...');
  const ackInput = page.getByLabel('Acknowledgement note');
  if (await ackInput.isVisible()) {
    await ackInput.fill('ColdGuard Operator: Alert verified. Secondary cooling activated.');
    await page.waitForTimeout(500);
    const ackBtn = page.getByRole('button', { name: 'Acknowledge' });
    if (await ackBtn.isVisible()) {
      await ackBtn.click();
      await page.waitForTimeout(1500);
    }
  }
  await page.screenshot({ path: path.join(outDir, '08-critical-excursion.png') });

  console.log('[capture] 9. Break the network (cut signal)');
  const cutSignalBtn = page.getByRole('button', { name: 'Cut signal' });
  if (await cutSignalBtn.isVisible()) {
    await cutSignalBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await cutSignalBtn.click();
    await page.waitForTimeout(4000);
  }
  await page.screenshot({ path: path.join(outDir, '09-network-offline.png') });

  console.log('[capture] 10. Remote rescue commands & restore signal');
  const closeBtn = page.getByRole('button', { name: /Close refrigerated compartment/i }).first();
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
    await page.waitForTimeout(1000);
  }
  const backupBtn = page.getByRole('button', { name: /Activate backup cooling/i }).first();
  if (await backupBtn.isVisible()) {
    await backupBtn.click();
    await page.waitForTimeout(1500);
  }
  const restoreSignalBtn = page.getByRole('button', { name: 'Restore signal' });
  if (await restoreSignalBtn.isVisible()) {
    await restoreSignalBtn.click();
    await page.waitForTimeout(5000);
  }
  await page.screenshot({ path: path.join(outDir, '10-rescue-command.png') });

  console.log('[capture] 11. Evidence chain tampering & verification');
  const evidenceRegion = page.getByRole('region', { name: 'Evidence chain' });
  if (await evidenceRegion.isVisible()) {
    await evidenceRegion.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    const tamperBtn = page.getByRole('button', { name: /Tamper with a stored reading/i });
    if (await tamperBtn.isVisible()) {
      await tamperBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(outDir, '11-evidence-tampered.png') });
      const undoBtn = page.getByRole('button', { name: /Undo tamper/i });
      if (await undoBtn.isVisible()) {
        await undoBtn.click();
        await page.waitForTimeout(1500);
      }
    }
  }

  console.log('[capture] 12. Incident Replay');
  const replayBtn = page.getByRole('link', { name: /Replay incident/i });
  if (await replayBtn.isVisible()) {
    await replayBtn.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, '12-incident-replay.png') });
  }

  console.log('[capture] 13. Platform Health');
  await page.goto('http://localhost:5173/platform');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, '13-platform-health.png') });

  console.log('[capture] All screenshots captured successfully in demo-screens/');
} catch (e) {
  console.error('[capture] Error:', e);
} finally {
  await browser.close();
}

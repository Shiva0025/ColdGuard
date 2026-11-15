import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('demo-video');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log('[video] Launching browser to record demo...');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: {
    dir: outDir,
    size: { width: 1440, height: 900 },
  },
});

const page = await context.newPage();
const TARGET = 'DC-S03';

try {
  console.log('[video] Step 1: Login');
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(2000);
  await page.getByLabel('Username').fill('operator');
  await page.waitForTimeout(500);
  await page.getByLabel('Password').fill('coldguard-demo');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(3000);

  // Reset demo to clean state first
  console.log('[video] Resetting demo state to baseline...');
  await page.evaluate(async () => {
    const h = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + sessionStorage.getItem('coldguard.token'),
    };
    await fetch('/api/sim/fault', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ kind: 'restore' }),
    });
    await fetch('/api/demo/reset', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ confirm: 'RESET' }),
    });
  });
  await page.waitForTimeout(3000);
  await page.reload();
  await page.waitForTimeout(3000);

  console.log('[video] Step 2: Overview & Lane Board');
  // Scroll around overview
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(2000);

  // Filter chips
  const westernBtn = page.getByRole('button', { name: /Western/i }).first();
  if (await westernBtn.isVisible()) {
    await westernBtn.click();
    await page.waitForTimeout(2000);
    const allBtn = page.getByRole('button', { name: /All/i }).first();
    if (await allBtn.isVisible()) {
      await allBtn.click();
      await page.waitForTimeout(2000);
    }
  }

  console.log('[video] Step 3: Control Centre & QR Phone Invite');
  await page.getByRole('link', { name: 'Control centre' }).click();
  await page.waitForTimeout(3000);

  const inviteBtn = page.getByRole('button', { name: /Create invite|New code/i });
  if (await inviteBtn.isVisible()) {
    await inviteBtn.click();
    await page.waitForTimeout(3000);
  }

  // Inject failure on DC-S03
  console.log('[video] Step 4: Injecting failure on ' + TARGET);
  await page.getByLabel('Target logger').selectOption(TARGET);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Door left open/i }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /^Cooling failure/i }).click();
  await page.waitForTimeout(2000);

  console.log('[video] Step 5: Device Investigation & Alerting');
  await page.goto(`http://localhost:5173/device/${TARGET}`);
  await page.waitForTimeout(4000);

  // Wait for temperature drift to build up
  console.log('[video] Observing temperature rise on ' + TARGET + '...');
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(3000);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(3000);
  }

  // Acknowledge incident if visible
  const ackInput = page.getByLabel('Acknowledgement note');
  if (await ackInput.isVisible()) {
    await ackInput.fill('ColdGuard Operator: Alert verified. Dispatching secondary cooling.');
    await page.waitForTimeout(1000);
    const ackBtn = page.getByRole('button', { name: 'Acknowledge' });
    if (await ackBtn.isVisible()) {
      await ackBtn.click();
      await page.waitForTimeout(2000);
    }
  }

  console.log('[video] Step 6: Break the Network & Rescue Command');
  const cutSignalBtn = page.getByRole('button', { name: 'Cut signal' });
  if (await cutSignalBtn.isVisible()) {
    await cutSignalBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await cutSignalBtn.click();
    console.log('[video] Signal cut, buffering data...');
    await page.waitForTimeout(5000);

    const closeBtn = page.getByRole('button', { name: /Close refrigerated compartment/i }).first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(2000);
    }

    const backupBtn = page.getByRole('button', { name: /Activate backup cooling/i }).first();
    if (await backupBtn.isVisible()) {
      await backupBtn.click();
      await page.waitForTimeout(3000);
    }

    const restoreSignalBtn = page.getByRole('button', { name: 'Restore signal' });
    if (await restoreSignalBtn.isVisible()) {
      await restoreSignalBtn.click();
      console.log('[video] Signal restored, backfilling...');
      await page.waitForTimeout(6000);
    }
  }

  console.log('[video] Step 7: Tamper-Evident Evidence Verification');
  const evidenceRegion = page.getByRole('region', { name: 'Evidence chain' });
  if (await evidenceRegion.isVisible()) {
    await evidenceRegion.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);

    const tamperBtn = page.getByRole('button', { name: /Tamper with a stored reading/i });
    if (await tamperBtn.isVisible()) {
      await tamperBtn.click();
      await page.waitForTimeout(3000);
    }

    const undoBtn = page.getByRole('button', { name: /Undo tamper/i });
    if (await undoBtn.isVisible()) {
      await undoBtn.click();
      await page.waitForTimeout(3000);
    }
  }

  console.log('[video] Step 8: Incident Replay');
  const replayBtn = page.getByRole('link', { name: /Replay incident/i });
  if (await replayBtn.isVisible()) {
    await replayBtn.click();
    await page.waitForTimeout(3000);

    const playBtn = page.getByRole('button', { name: /Play/i }).first();
    if (await playBtn.isVisible()) {
      await playBtn.click();
      await page.waitForTimeout(8000);
    }
  }

  console.log('[video] Step 9: Platform Metrics');
  await page.goto('http://localhost:5173/platform');
  await page.waitForTimeout(4000);

  console.log('[video] Returning to Overview');
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(3000);

  console.log('[video] Recording completed successfully!');
} catch (err) {
  console.error('[video] Recording encountered an issue:', err);
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

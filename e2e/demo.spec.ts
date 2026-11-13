import { expect, test, type Browser, type Page } from '@playwright/test';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'coldguard-demo';
const TARGET = 'DC-S07';

async function signIn(browser: Browser, username: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as any).errors = errors;
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Monitored loggers')).toBeVisible();
  return page;
}

test('cold-chain incident: two users, live alert, acknowledgement, reconnect catch-up', async ({ browser }) => {
  const op = await signIn(browser, 'operator');
  // Start from a clean slate (requires ALLOW_DEMO_RESET=true, the local default).
  await op.evaluate(async () => {
    const h = { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('coldguard.token') };
    await fetch('/api/sim/fault', { method: 'POST', headers: h, body: JSON.stringify({ kind: 'restore' }) });
    await fetch('/api/demo/reset', { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'RESET' }) });
  });
  // Wait until the target is back inside the band (a previous run may have left it warm).
  await expect
    .poll(
      () =>
        op.evaluate(async (id) => {
          const r = await fetch(`/api/devices/${id}`, { headers: { authorization: 'Bearer ' + sessionStorage.getItem('coldguard.token') } });
          return (await r.json()).state?.tc ?? 99;
        }, TARGET),
      { timeout: 180_000, intervals: [2000] },
    )
    .toBeLessThan(6.5);
  await op.waitForTimeout(30_000); // a calm baseline before the failure
  await op.reload();
  const western = await signIn(browser, 'viewer.western');

  // Independent subscriptions: the Western viewer only sees Western loggers.
  await expect(western.getByRole('listitem').filter({ hasText: 'WC-S01' })).toBeVisible();
  await expect(western.getByRole('listitem').filter({ hasText: 'DC-S01' })).toHaveCount(0);

  // Operator injects a cooling failure from the control centre.
  await op.getByRole('link', { name: 'Control centre' }).click();
  await op.getByLabel('Target logger').selectOption(TARGET);
  await op.getByRole('button', { name: /^Cooling failure/ }).click();
  await expect(op.getByText(/cooling failure injected on DC-S07/i)).toBeVisible();

  // Investigate: live chart, drift warning first, then a critical excursion with an explanation.
  await op.goto(`/device/${TARGET}`);
  await expect(op.getByTestId('stream-phase')).toHaveText(/Live/, { timeout: 15_000 });
  const timeline = op.getByRole('region', { name: 'Incident timeline' });
  await expect(timeline.getByText('Rapid temperature drift').first()).toBeVisible({ timeout: 90_000 });
  const excursion = timeline.getByRole('article', { name: /Temperature above range on DC-S07/ }).first();
  await expect(excursion).toBeVisible({ timeout: 120_000 });
  await expect(excursion).toContainText(/stayed above 8\.0 °C/);

  // The Western viewer never receives the Deccan incident.
  await expect(western.getByRole('article', { name: /DC-S07/ })).toHaveCount(0);

  // Acknowledge with a note.
  await excursion.getByLabel('Acknowledgement note').fill('E2E: moved to backup reefer');
  await excursion.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(excursion).toContainText('Acknowledged by operator');

  // Zoom/pause keeps data merging; resume returns to live.
  const over = op.locator('.u-over').first();
  await over.scrollIntoViewIfNeeded();
  const box = (await over.boundingBox())!;
  await op.mouse.move(box.x + box.width * 0.5, box.y + 80);
  await op.mouse.down();
  await op.mouse.move(box.x + box.width * 0.75, box.y + 80, { steps: 6 });
  await op.mouse.up();
  await expect(op.getByTestId('stream-phase')).toHaveText(/Paused/);
  await op.getByRole('button', { name: 'Resume live' }).click();
  await expect(op.getByTestId('stream-phase')).toHaveText(/Live/);

  // Real disconnect → reconnect → catch-up from MongoDB by cursor.
  await op.getByRole('button', { name: /Drop connection/ }).click();
  await expect(op.getByTestId('stream-phase')).toHaveText(/Reconnecting/);
  await expect(op.getByTestId('stream-phase')).toHaveText(/Live/, { timeout: 30_000 });
  const catchUps = op.locator('div[title="after reconnect, fetched by cursor"] dd');
  await expect(catchUps).not.toHaveText(/^0 /);

  // Restore for the next run.
  await op.goto('/control');
  await op.getByLabel('Target logger').selectOption(TARGET);
  await op.getByRole('button', { name: `Restore ${TARGET}` }).click();

  expect((op as any).errors).toEqual([]);
  expect((western as any).errors).toEqual([]);
});

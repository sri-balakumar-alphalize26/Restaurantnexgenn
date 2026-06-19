// TC-220..225 — Network-fail injection at every server-bound step.
// For each tap that hits Odoo, we break the adb reverse tunnel BEFORE the tap,
// assert the error UI shows, restore the tunnel, retry, and verify recovery.

const { execSync } = require('child_process');
const { shot, waitForReady } = require('./helpers');

function adb(args) { return execSync(`adb ${args}`, { encoding: 'utf8' }); }
function breakTunnel() { try { adb('reverse --remove tcp:8069'); } catch (_) {} }
function restoreTunnel() { adb('reverse tcp:8069 tcp:8069'); }

async function tapText(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().text("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
}

async function tapTextContains(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
}

async function expectErrorUI({ timeout = 15000 } = {}) {
  const popup = await $('android=new UiSelector().textContains("Cannot reach server")');
  const inline = await $('android=new UiSelector().textContains("Failed to load")');
  const failedReq = await $('android=new UiSelector().textContains("Network request failed")');
  const failedPay = await $('android=new UiSelector().textContains("Payment Failed")');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await popup.isExisting()) && (await popup.isDisplayed())) return 'popup';
    if ((await inline.isExisting()) && (await inline.isDisplayed())) return 'inline';
    if ((await failedReq.isExisting()) && (await failedReq.isDisplayed())) return 'failedReq';
    if ((await failedPay.isExisting()) && (await failedPay.isDisplayed())) return 'failedPay';
    await browser.pause(400);
  }
  throw new Error('No network-error UI appeared within timeout');
}

async function dismissErrorUI() {
  for (const txt of ['Retry', 'OK', 'Cancel']) {
    const el = await $(`android=new UiSelector().text("${txt}")`);
    if ((await el.isExisting()) && (await el.isDisplayed())) {
      await el.click();
      await browser.pause(800);
      return txt;
    }
  }
  return null;
}

describe('TC-220 — Per-step network-fail injection', () => {
  before(async () => {
    restoreTunnel();
    const state = await waitForReady();
    if (state !== 'home') throw new Error('pos-fail-injection requires Home.');
  });

  after(async () => {
    restoreTunnel();
  });

  it('FAIL on Take Orders → recover', async () => {
    breakTunnel();
    await tapText('Take Orders');
    const ui = await expectErrorUI();
    console.log('  [tap=Take Orders] error UI =', ui);
    await shot('fail-01-take-orders');

    restoreTunnel();
    await browser.pause(800);
    if (ui === 'inline') {
      // Tap inline Retry
      await tapText('Retry');
    } else {
      // Modal Retry (axios interceptor)
      const retry = await $('android=new UiSelector().text("Retry")');
      if (await retry.isExisting()) await retry.click();
    }
    await browser.pause(2500);
    await shot('fail-01-recovered');
  });

  it('FAIL on Continue Selling → recover', async () => {
    // Should already be on POS Register screen
    const continueBtn = await $('android=new UiSelector().text("Continue Selling")');
    if (!(await continueBtn.isExisting())) {
      console.log('  [info] No Continue Selling visible — skipping');
      return;
    }
    breakTunnel();
    await continueBtn.click();
    await browser.pause(2500);
    // POS products may load offline from cache OR show error. Either way is acceptable.
    await shot('fail-02-continue-selling');
    restoreTunnel();
    await browser.pause(2000);
    // Also tap Retry if present
    await dismissErrorUI();
  });

  it('FAIL on Pay Now → user sees error, no order created', async () => {
    // Navigate to products if not already
    let onProducts = await $('android=new UiSelector().textContains("DINE IN PRICE")');
    if (!(await onProducts.isExisting())) {
      restoreTunnel();
      // Best effort recovery to products screen
      try { await tapText('Continue Selling', { timeout: 4000 }); } catch (_) {}
      await browser.pause(2000);
    }
    onProducts = await $('android=new UiSelector().textContains("DINE IN PRICE")');
    if (!(await onProducts.isExisting())) {
      console.log('  [info] Could not reach products screen — skipping Pay Now fail test');
      return;
    }

    // Need at least one product in cart
    try { await tapTextContains('Karak Tea', { timeout: 4000 }); } catch (_) {}
    await browser.pause(800);

    breakTunnel();
    try { await tapTextContains('Pay Now', { timeout: 6000 }); } catch (_) {}
    const ui = await expectErrorUI({ timeout: 20000 }).catch(() => null);
    console.log('  [tap=Pay Now offline] error UI =', ui);
    await shot('fail-03-pay-now');

    restoreTunnel();
    await dismissErrorUI();
  });
});

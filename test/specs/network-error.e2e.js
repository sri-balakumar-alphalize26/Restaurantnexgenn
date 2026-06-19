const { shot, waitForReady } = require('./helpers');

/**
 * TC-090 / TC-091 — Cannot reach server popup
 *
 * Flow: simulate Odoo unreachable, trigger an action that calls Odoo,
 * assert the Retry/Cancel popup appears. Then restore connectivity and
 * tap Retry, assert the popup dismisses.
 *
 * Strategy: with USB-tunneled localhost (adb reverse tcp:8069 tcp:8069)
 * we can break the connection by removing the reverse port, then trigger
 * any data fetch (e.g. open Take Orders), then verify the popup, then
 * restore the reverse and tap Retry.
 */

const { execSync } = require('child_process');

function adb(args) {
  return execSync(`adb ${args}`, { encoding: 'utf8' });
}

async function tapText(text, { timeout = 8000 } = {}) {
  const el = await $(`android=new UiSelector().text("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
}

async function visible(text, { timeout = 8000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  return el;
}

describe('TC-090 / TC-091 — Cannot reach server popup', () => {
  before(async () => {
    const state = await waitForReady();
    if (state !== 'home') {
      throw new Error('network-error spec requires user to be on Home (logged in).');
    }
    await shot('net-00-home');
  });

  it('breaks the Odoo tunnel and triggers a server call', async () => {
    // Remove adb reverse — tablet's localhost:8069 now points nowhere
    try { adb('reverse --remove tcp:8069'); } catch (_) {}
    console.log('[net] removed adb reverse tunnel');

    // Trigger an axios call by going into POS Register
    await tapText('Take Orders');
    await browser.pause(2500);
    await shot('net-01-after-tap');
  });

  it('shows a network-error UI (popup OR inline) with a Retry button', async () => {
    // Two valid UIs: axios-interceptor modal ("Cannot reach server") OR
    // POS Register inline error ("Failed to load POS registers or sessions").
    const popup = await $('android=new UiSelector().textContains("Cannot reach server")');
    const inline = await $('android=new UiSelector().textContains("Failed to load")');
    const deadline = Date.now() + 15000;
    let saw = null;
    while (Date.now() < deadline) {
      if (await popup.isExisting() && await popup.isDisplayed()) { saw = 'popup'; break; }
      if (await inline.isExisting() && await inline.isDisplayed()) { saw = 'inline'; break; }
      await browser.pause(500);
    }
    if (!saw) throw new Error('Neither popup nor inline network error appeared');
    console.log('[net] saw error UI:', saw);

    const retry = await $('android=new UiSelector().text("Retry")');
    await retry.waitForDisplayed({ timeout: 5000 });
    await shot('net-02-error-shown');
  });

  it('tapping Retry while still offline keeps the error visible', async () => {
    await tapText('Retry');
    await browser.pause(3000);
    const popup = await $('android=new UiSelector().textContains("Cannot reach server")');
    const inline = await $('android=new UiSelector().textContains("Failed to load")');
    const stillFailing = (await popup.isExisting() && await popup.isDisplayed())
                      || (await inline.isExisting() && await inline.isDisplayed());
    if (!stillFailing) throw new Error('Error UI vanished even though tunnel is still broken');
    await shot('net-03-retry-still-offline');
  });

  it('restores tunnel, tap Retry — error clears and content loads', async () => {
    adb('reverse tcp:8069 tcp:8069');
    console.log('[net] restored adb reverse tunnel');
    await browser.pause(1500);

    await tapText('Retry');
    await browser.pause(4000);

    const popup = await $('android=new UiSelector().textContains("Cannot reach server")');
    const inline = await $('android=new UiSelector().textContains("Failed to load")');
    const stillFailing = (await popup.isExisting() && await popup.isDisplayed())
                      || (await inline.isExisting() && await inline.isDisplayed());
    if (stillFailing) throw new Error('Error UI still visible after restore + Retry');
    await shot('net-04-recovered');
  });

  after(async () => {
    // Always restore the tunnel so other specs don't run offline
    try { adb('reverse tcp:8069 tcp:8069'); } catch (_) {}
  });
});

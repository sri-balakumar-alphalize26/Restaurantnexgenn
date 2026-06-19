// TC-200..210 — Deep POS flow: multi-order, every button tapped, latency tracked.
// Pre-condition: user logged in + on Home, Odoo reachable (adb reverse active).

const { shot, waitForReady } = require('./helpers');
const { timed, reportSummary, failIfAnySlow } = require('./helpers-perf');

async function tapText(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().text("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
  return el;
}

async function tapTextContains(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
  return el;
}

async function visible(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  return el;
}

async function existsNow(text) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  return await el.isExisting();
}

describe('TC-200 — Deep POS flow with lag detection', () => {
  before(async () => {
    const state = await waitForReady();
    if (state !== 'home') {
      throw new Error('pos-deep-flow requires logged-in Home state.');
    }
    await shot('deep-00-home');
  });

  after(async () => {
    reportSummary();
  });

  it('navigates Home -> POS Register -> Continue Selling -> Choose Order Type', async () => {
    await timed('Home: tap Take Orders', async () => tapText('Take Orders'));
    await timed('POS Register: load', async () => visible('Active Sessions'));
    await shot('deep-01-pos-register');

    await timed('Tap Continue Selling', async () => tapText('Continue Selling'));

    // App now shows "Choose Order Type" with: Dine In, New Takeout Order, Takeout Orders
    await timed('Choose Order Type: load', async () => visible('How would you like to serve today', { timeout: 10000 }));
    await shot('deep-02-choose-order-type');

    // Verify the three options are visible
    const dineIn = await $('android=new UiSelector().text("Dine In")');
    const newTakeout = await $('android=new UiSelector().text("New Takeout Order")');
    const takeoutOrders = await $('android=new UiSelector().text("Takeout Orders")');
    if (!(await dineIn.isDisplayed())) throw new Error('Dine In option missing');
    if (!(await newTakeout.isDisplayed())) throw new Error('New Takeout Order option missing');
    if (!(await takeoutOrders.isDisplayed())) throw new Error('Takeout Orders option missing');
  });

  it('takes the Dine In branch -> Select Table -> POS Products', async () => {
    await timed('Tap Dine In', async () => tapText('Dine In'));
    await timed('Select Table: load', async () => visible('Main Floor', { timeout: 10000 }));
    await shot('deep-03-select-table');

    await timed('Tap table T2', async () => tapText('T2'));
    await timed('POS Products: load', async () => visible('DINE IN PRICE', { timeout: 15000 }));
    await shot('deep-04-products');
  });

  it('adds 3 different products to cart', async () => {
    for (const item of ['Karak Tea', 'Barotta', 'Fried Rice']) {
      await timed(`Tap product "${item}"`, async () => tapTextContains(item));
      await browser.pause(400);
    }
    await shot('deep-03-cart-3-items');
  });

  it('toggles DINE IN / APPLICATION PRICE pricelist buttons', async () => {
    if (await existsNow('APPLICATION PRICE')) {
      await timed('Toggle APPLICATION PRICE', async () => tapText('APPLICATION PRICE'));
      await browser.pause(600);
      await shot('deep-04-application-price');
    }
    if (await existsNow('DINE IN PRICE')) {
      await timed('Toggle DINE IN PRICE', async () => tapText('DINE IN PRICE'));
      await browser.pause(600);
      await shot('deep-05-dine-in-price');
    }
  });

  it('opens Pay Now and selects payment method', async () => {
    await timed('Tap Pay Now', async () => tapTextContains('Pay Now'));
    // Either PIN gate or Select Payment Method modal
    const ppin = await $('android=new UiSelector().textContains("Payment PIN")');
    if (await ppin.isExisting()) {
      console.log('  [info] Payment PIN gate visible — closing modal, skipping Pay');
      const closeBtn = await $('android=new UiSelector().description("Close")');
      if (await closeBtn.isExisting()) await closeBtn.click();
      return;
    }
    await timed('Payment modal: render', async () =>
      visible('Select Payment Method', { timeout: 8000 }).catch(() =>
        visible('Order Total', { timeout: 4000 })
      ));
    await shot('deep-06-payment-modal');

    // Close modal — full Pay flow tested in idempotency specs
    const closeBtn = await $('android=new UiSelector().text("✕")');
    if (await closeBtn.isExisting()) await closeBtn.click();
    await browser.pause(800);
  });

  it('tries Customer / Note / Course / Dine In / Takeout / Delivery if visible', async () => {
    for (const label of ['Customer', 'Note', 'Course', 'Dine In', 'Takeout', 'Delivery']) {
      if (await existsNow(label)) {
        try {
          await timed(`Tap "${label}"`, async () => tapText(label));
          await browser.pause(800);
          await shot(`deep-btn-${label.replace(/\s+/g, '_').toLowerCase()}`);
          // Best effort: dismiss any opened modal via back button
          await browser.back().catch(() => {});
          await browser.pause(500);
        } catch (e) {
          console.log(`  [info] could not tap ${label}: ${e.message.slice(0, 80)}`);
        }
      }
    }
  });

  it('returns to Tables / Register and back home', async () => {
    if (await existsNow('Tables')) {
      await timed('Tap Tables tab', async () => tapText('Tables'));
      await browser.pause(800);
      await shot('deep-08-tables');
    }
    if (await existsNow('Register')) {
      await timed('Tap Register tab', async () => tapText('Register'));
      await browser.pause(800);
      await shot('deep-09-register');
    }
    if (await existsNow('Orders')) {
      await timed('Tap Orders tab', async () => tapText('Orders'));
      await browser.pause(1200);
      await shot('deep-10-orders');
    }

    // Back navigation to Home
    for (let i = 0; i < 4; i++) {
      try { await browser.back(); } catch (_) {}
      await browser.pause(500);
      if (await existsNow('Take Orders')) break;
    }
    await shot('deep-11-back-home');
  });

  it('passes the lag SLA — no step exceeds threshold', async () => {
    failIfAnySlow();
  });
});

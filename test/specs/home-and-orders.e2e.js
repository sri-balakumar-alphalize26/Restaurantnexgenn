const { shot, waitForReady } = require('./helpers');

async function tapText(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().text("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
}

async function tapContains(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  await el.click();
}

async function seeText(text, { timeout = 10000 } = {}) {
  const el = await $(`android=new UiSelector().textContains("${text}")`);
  await el.waitForDisplayed({ timeout });
  return el;
}

describe('Post-login home + orders flow', () => {
  before(async () => {
    const state = await waitForReady();
    if (state !== 'home') {
      throw new Error('home-and-orders spec requires the user to be logged in. Run real-login first, or log in manually on the tablet.');
    }
    await shot('00-start');
  });

  it('landed on home dashboard after login', async () => {
    await seeText('Take Orders');
    await seeText('Our Specials');
    await shot('01-home');
  });

  it('shows Food and Drinks specials', async () => {
    await seeText('Food');
    await seeText('Drinks');
  });

  it('opens Take Orders banner', async () => {
    await tapText('Take Orders');
    await browser.pause(1500);
    await shot('02-take-orders-opened');
  });

  it('returns to home (back button)', async () => {
    await browser.back();
    await browser.pause(1000);
    await seeText('Our Specials');
    await shot('03-back-to-home');
  });

  it('opens Food special card', async () => {
    await tapText('Food');
    await browser.pause(1500);
    await shot('04-food-card');
  });

  it('bottom nav: Profile tab is tappable', async () => {
    // go back to home first if needed
    try { await browser.back(); } catch (_) {}
    await browser.pause(800);
    await tapText('Profile');
    await browser.pause(1500);
    await shot('05-profile-tab');
  });

  it('bottom nav: Home tab is tappable', async () => {
    await tapText('Home');
    await browser.pause(1000);
    await seeText('Our Specials');
    await shot('06-home-tab');
  });
});

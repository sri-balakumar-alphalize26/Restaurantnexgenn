const { shot, waitForReady, logoutIfLoggedIn } = require('./helpers');

const USERNAME = 'admin';
const PASSWORD = 'admin';

describe('Real login with admin/admin', () => {
  before(async () => {
    await waitForReady();
    await logoutIfLoggedIn();
    await waitForReady();
    await shot('real-00-before-login');
  });

  it('landed on Login screen', async () => {
    const title = await $('~login-welcome-title');
    await title.waitForDisplayed({ timeout: 15000 });
    await shot('real-01-login-screen');
  });

  it('types admin credentials', async () => {
    const user = await $('~login-username');
    const pass = await $('~login-password');
    await user.clearValue();
    await user.setValue(USERNAME);
    await pass.clearValue();
    await pass.setValue(PASSWORD);
    await shot('real-02-credentials-typed');
  });

  it('submits and lands on Home', async () => {
    try { await browser.hideKeyboard(); } catch (_) {}
    await $('~login-submit').click();
    const takeOrders = await $('android=new UiSelector().textContains("Take Orders")');
    await takeOrders.waitForDisplayed({ timeout: 30000 });
    await shot('real-03-home-after-login');
  });

  it('home shows Food and Drinks cards', async () => {
    const food = await $('android=new UiSelector().text("Food")');
    const drinks = await $('android=new UiSelector().text("Drinks")');
    await food.waitForDisplayed({ timeout: 10000 });
    await drinks.waitForDisplayed({ timeout: 10000 });
  });
});

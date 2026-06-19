const { shot, waitForReady, logoutIfLoggedIn } = require('./helpers');

describe('APK smoke - login screen', () => {
  before(async () => {
    await waitForReady();
    await logoutIfLoggedIn();
    await waitForReady();
    await shot('login-00-ready');
  });

  it('shows Welcome Back title', async () => {
    const title = await $('~login-welcome-title');
    await title.waitForDisplayed({ timeout: 15000 });
    await shot('login-01-welcome');
  });

  it('has no Device Setup gear icon in header', async () => {
    const gear = await $('~device-setup-gear');
    expect(await gear.isExisting()).toBe(false);
  });

  it('shows language toggle buttons', async () => {
    const en = await $('~lang-toggle-en');
    const ar = await $('~lang-toggle-ar');
    await en.waitForDisplayed();
    await ar.waitForDisplayed();
  });

  it('types into username and password fields', async () => {
    await $('~login-username').setValue('test@example.com');
    await $('~login-password').setValue('pw123456');
    await shot('login-02-typed');
  });

  it('shows validation errors when submitting empty form', async () => {
    await $('~login-username').clearValue();
    await $('~login-password').clearValue();
    await $('~login-submit').click();
    const usernameErr = await $('~login-username-error');
    const passwordErr = await $('~login-password-error');
    await usernameErr.waitForDisplayed({ timeout: 5000 });
    await passwordErr.waitForDisplayed({ timeout: 5000 });
    await shot('login-03-errors');
  });

  it('toggles autofill switch', async () => {
    await $('~autofill-toggle').click();
    await shot('login-04-autofill-on');
  });
});

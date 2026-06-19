/* eslint-env detox/detox, jest */

describe('Login screen', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('shows Welcome Back title', async () => {
    await expect(element(by.id('login-welcome-title'))).toBeVisible();
  });

  it('has no Device Setup gear icon in header', async () => {
    await expect(element(by.id('device-setup-gear'))).not.toExist();
  });

  it('shows language toggle buttons (EN / AR)', async () => {
    await expect(element(by.id('lang-toggle-en'))).toBeVisible();
    await expect(element(by.id('lang-toggle-ar'))).toBeVisible();
  });

  it('switches to Arabic when AR tapped', async () => {
    await element(by.id('lang-toggle-ar')).tap();
    await expect(element(by.id('lang-toggle-ar'))).toBeVisible();
  });

  it('validates empty username and password', async () => {
    await element(by.id('login-submit')).tap();
    await expect(element(by.id('login-username-error'))).toBeVisible();
    await expect(element(by.id('login-password-error'))).toBeVisible();
  });

  it('types into username and password fields', async () => {
    await element(by.id('login-username')).typeText('test@example.com');
    await element(by.id('login-password')).typeText('pw123456');
    await expect(element(by.id('login-username'))).toHaveText('test@example.com');
  });

  it('toggles password visibility', async () => {
    await element(by.id('login-password')).typeText('secret');
    await element(by.id('login-password-toggle')).tap();
  });

  it('toggles autofill credentials switch', async () => {
    await element(by.id('autofill-toggle')).tap();
  });
});

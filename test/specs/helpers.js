const path = require('path');
const fs = require('fs');

const ARTIFACTS = path.resolve(__dirname, '..', '..', 'appium-artifacts');
if (!fs.existsSync(ARTIFACTS)) fs.mkdirSync(ARTIFACTS, { recursive: true });

async function shot(name) {
  const file = path.join(ARTIFACTS, `${name}-${Date.now()}.png`);
  await browser.saveScreenshot(file);
  console.log(`  📸 ${file}`);
}

async function tryClick(sel, { timeout = 2000 } = {}) {
  try {
    const el = await $(sel);
    await el.waitForDisplayed({ timeout });
    await el.click();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Wait for the app to be past splash: either Login screen (Welcome Back)
 * or Home (Take Orders) is visible. Polls up to `timeout` ms.
 */
async function waitForReady({ timeout = 45000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const login = await $('~login-welcome-title');
    if (await login.isExisting()) return 'login';
    const home = await $('android=new UiSelector().textContains("Take Orders")');
    if (await home.isExisting()) return 'home';
    await browser.pause(interval);
  }
  throw new Error('App never reached Login or Home within ' + timeout + 'ms');
}

/**
 * If on Home, tap Logout and confirm the dialog so Login screen is visible.
 */
async function logoutIfLoggedIn() {
  const logoutTab = await $('android=new UiSelector().text("Logout")');
  if (!(await logoutTab.isExisting())) return false;
  try {
    if (await logoutTab.isDisplayed()) {
      await logoutTab.click();
      await browser.pause(1500);
      await shot('debug-logout-dialog');
      // Dump the visible button/text nodes so we can see exactly what's in the dialog
      try {
        const all = await $$('android.widget.Button');
        for (const b of all) {
          try {
            const t = await b.getText();
            const d = await b.isDisplayed();
            if (d && t) console.log('  [dialog button]', JSON.stringify(t));
          } catch (_) {}
        }
      } catch (_) {}
      const clicked =
           (await tryClick('android=new UiSelector().text("LOGOUT")'))
        || (await tryClick('android=new UiSelector().textMatches("(?i)logout").className("android.widget.Button")'))
        || (await tryClick('android=new UiSelector().resourceId("android:id/button1")'))
        || (await tryClick('android=new UiSelector().text("OK")'))
        || (await tryClick('android=new UiSelector().text("YES")'));
      console.log('  [logout confirm clicked?]', clicked);
      await browser.pause(3000);
      return true;
    }
  } catch (_) {}
  return false;
}

module.exports = { shot, tryClick, waitForReady, logoutIfLoggedIn };

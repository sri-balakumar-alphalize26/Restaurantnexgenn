exports.config = {
  runner: 'local',
  // Default (nightly CI): stable regression specs.
  specs: [
    './test/specs/home-and-orders.e2e.js',
    './test/specs/network-error.e2e.js',
  ],
  suites: {
    nightly: [
      './test/specs/home-and-orders.e2e.js',
      './test/specs/network-error.e2e.js',
    ],
    deep: [
      './test/specs/home-and-orders.e2e.js',
      './test/specs/pos-deep-flow.e2e.js',
      './test/specs/pos-fail-injection.e2e.js',
      './test/specs/network-error.e2e.js',
    ],
    full: [
      './test/specs/real-login.e2e.js',
      './test/specs/home-and-orders.e2e.js',
      './test/specs/pos-deep-flow.e2e.js',
      './test/specs/pos-fail-injection.e2e.js',
      './test/specs/network-error.e2e.js',
      './test/specs/smoke-login.e2e.js',
    ],
  },
  maxInstances: 1,
  capabilities: [
    {
      platformName: 'Android',
      'appium:deviceName': 'attached',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': 'com.danat.alphalize',
      'appium:appActivity': '.MainActivity',
      'appium:noReset': true,
      'appium:fullReset': false,
      'appium:skipDeviceInitialization': false,
      'appium:autoLaunch': true,
      'appium:forceAppLaunch': true,
      'appium:skipServerInstallation': false,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 120,
      'appium:adbExecTimeout': 60000,
      'appium:systemPort': 8200,
      'appium:adbExecPath': 'C:\\platform-tools\\adb.exe',
    },
  ],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [
    [
      'appium',
      {
        args: {
          address: '127.0.0.1',
          port: 4723,
          relaxedSecurity: true,
        },
        command: 'appium',
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },
};

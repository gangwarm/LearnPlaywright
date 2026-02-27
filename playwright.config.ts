import { defineConfig, devices } from '@playwright/test';
import { ConfigManager } from './utils/ConfigManager';
import * as fs from 'fs';
import * as path from 'path';

// 1. Define the available browser configurations
const browserConfigs = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
  },
  {
    name: 'webkit',
    use: { ...devices['Desktop Safari'] },
  },
   /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
];

// 2. FUNCTION to read the JSON from disk (Dynamic Project Selection)
function getActiveProjects() {
  const jsonPath = path.join(__dirname, 'data/testRegistry.json');
  
  if (!fs.existsSync(jsonPath)) {
    console.warn('⚠️ testRegistry.json not found, defaulting to all browsers');
    return browserConfigs;
  }

  const registry = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  
  const requestedBrowsers = registry.map((t: any) => t.execution.browser.toLowerCase());
  const needsAll = requestedBrowsers.includes('all');

  return needsAll 
    ? browserConfigs 
    : browserConfigs.filter(p => requestedBrowsers.includes(p.name));
}

export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',

// 3. Register the Global Setup
  globalSetup: require.resolve('./utils/globalSetup'),

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    // Dynamically gets the URL from our JSON manager
    screenshot: 'only-on-failure',
  },

// 4. CALL THE FUNCTION to get projects dynamically
  projects: getActiveProjects(),

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },

});
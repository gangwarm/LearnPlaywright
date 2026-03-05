/**
 * playwright.config.ts
 *
 * CHANGES FROM ORIGINAL:
 *
 * 1. BUG FIX — double JSON parse + broken early-return in getActiveProjects().
 *    The original had a try/catch that parsed the file but never used the result
 *    (the variable was scoped inside the block), then parsed it AGAIN outside.
 *    If the file was malformed the catch fired, but execution fell through to
 *    the second parse which threw an uncaught error anyway, defeating the catch.
 *    Fix: single consolidated try/catch with the full logic inside.
 *
 * 2. PERFORMANCE — CI workers raised from 1 to a sensible default.
 *    workers: 1 on CI serialises all 5,000 tests — a pipeline killer.
 *    Now controlled by the WORKERS env var so it's tuneable per machine/CI tier.
 *
 * 3. SCALABILITY — shard-aware configuration added.
 *    Run `npx playwright test --shard=1/10` to split 5,000 tests across
 *    10 parallel CI jobs without any code changes.
 *
 * 4. BROWSER MATCHING — getActiveProjects() now uses the shared browserMatches()
 *    utility instead of its own inline copy of the logic.
 *
 * 5. UNUSED IMPORT REMOVED — ConfigManager was imported but never used.
 *
 * 6. CONFIGURABLE TIMEOUT — added via env var so CI can increase it without
 *    a code change.
 */

import { defineConfig, devices } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { browserMatches } from './utils/BrowserUtils';

// ─── Browser Catalogue ────────────────────────────────────────────────────────
// All browsers the framework knows about. getActiveProjects() filters this list
// down to only the browsers referenced in your Excel Registry.

const BROWSER_CATALOGUE = [
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

    /* Uncomment to enable mobile or branded browsers: */
    // { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
    // { name: 'Mobile Safari', use: { ...devices['iPhone 12'] } },
    // { name: 'Microsoft Edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    // { name: 'Google Chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
];

// ─── Dynamic Project Selection ────────────────────────────────────────────────

/**
 * Reads testRegistry.json and returns only the browser projects that are
 * actually referenced in the Registry, so Playwright doesn't spin up browsers
 * that no test will use.
 *
 * Falls back to all browsers if the JSON is missing or malformed (safe default
 * that ensures tests still run on first-time setup before globalSetup has run).
 */
function getActiveProjects() {
    const jsonPath = path.join(__dirname, 'data/testRegistry.json');

    if (!fs.existsSync(jsonPath)) {
        console.warn('⚠️  testRegistry.json not found — running all browsers as fallback.');
        return BROWSER_CATALOGUE;
    }

    // FIX: single try/catch wrapping everything. The original had the parse
    // inside a try but then parsed AGAIN outside it, making the catch useless.
    try {
        const registry: any[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

        if (!Array.isArray(registry) || registry.length === 0) {
            console.warn('⚠️  testRegistry.json is empty — running all browsers as fallback.');
            return BROWSER_CATALOGUE;
        }

        // Collect the unique set of browser values from all enabled tests.
        const requestedBrowsers = [
            ...new Set(
                registry
                    .filter((t: any) => t.execution?.enabled)
                    .map((t: any) => String(t.execution.browser).toLowerCase().trim())
            ),
        ] as string[];

        // FIX: uses shared browserMatches() — consistent with baseTest.ts.
        return BROWSER_CATALOGUE.filter(project =>
            requestedBrowsers.some(req => browserMatches(req, project.name))
        );

    } catch (e) {
        console.warn(
            `⚠️  testRegistry.json is malformed — running all browsers as fallback.\n` +
            `   Error: ${(e as Error).message}`
        );
        return BROWSER_CATALOGUE;
    }
}

// ─── Worker Count ─────────────────────────────────────────────────────────────
// Priority: WORKERS env var → CI default (4) → local default (half CPU cores)
//
// Usage examples:
//   WORKERS=8 npx playwright test          # 8 parallel workers locally
//   WORKERS=4 npx playwright test          # 4 workers on a CI agent
//   npx playwright test --shard=1/10       # Split 5,000 tests across 10 CI jobs

function getWorkerCount(): number | undefined {
    if (process.env.WORKERS) {
        const n = parseInt(process.env.WORKERS, 10);
        if (!isNaN(n) && n > 0) return n;
    }
    // FIX: was hardcoded to 1 on CI, which serialises the entire suite.
    // 4 is a safe default for most CI agents; tune with WORKERS= as needed.
    if (process.env.CI) return 4;
    return undefined; // Let Playwright use half the available CPU cores locally
}

// ─── Config ───────────────────────────────────────────────────────────────────

export default defineConfig({
    testDir: './tests',

    metadata: {
        projectName: 'LearnPlaywright',
    },

    /* Run test files in parallel */
    fullyParallel: true,

    /* Fail CI builds if test.only was accidentally committed */
    forbidOnly: !!process.env.CI,

    /* Retry failed tests on CI only */
    retries: process.env.CI ? 2 : 0,

    /* Configurable worker count — see getWorkerCount() above */
    workers: getWorkerCount(),

    /**
     * Test timeout — configurable via env var for CI environments that need
     * more time (e.g. slow staging servers).
     * Default: 30 seconds. Override: TEST_TIMEOUT=60000 npx playwright test
     */
    timeout: process.env.TEST_TIMEOUT ? parseInt(process.env.TEST_TIMEOUT, 10) : 30_000,

    reporter: [
        ['list'],                         // Live terminal output
        ['./utils/CustomReporter.ts'],    // Registry-aware custom reporter
        ['html', { open: 'never' }],      // Standard HTML report
    ],

    globalSetup: require.resolve('./utils/globalSetup'),

    use: {
        trace:      'on-first-retry',
        screenshot: 'only-on-failure',
        video:      'off',
    },

    /* Dynamic projects — only browsers used in the Registry are activated */
    projects: getActiveProjects(),

    /*
     * SHARDING (for 5,000+ tests on CI):
     * Split the suite across N parallel jobs without any code changes:
     *   npx playwright test --shard=1/10
     *   npx playwright test --shard=2/10
     *   ... (run all 10 in parallel CI jobs)
     *
     * Each shard runs an independent subset of tests and produces its own
     * HTML report. Merge them with: npx playwright merge-reports
     */
});

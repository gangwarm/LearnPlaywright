/**
 * baseTest.ts
 *
 * The custom Playwright test fixture that injects `tcData` into every test.
 *
 * CHANGES FROM ORIGINAL:
 *
 * 1. BUG FIX — `tcId` was referenced in beforeEach error message but it was
 *    only in scope inside the fixture above. This caused a ReferenceError
 *    (a crash with a confusing message) instead of the intended helpful error.
 *    Fix: extract tcId from testInfo.title inside beforeEach directly.
 *
 * 2. BUG FIX — browser-matching logic was copy-pasted in two places (the
 *    fixture and beforeEach). Any change to one was silently missed in the
 *    other. Fix: both now import `browserMatches()` from BrowserUtils.ts.
 *
 * 3. PERFORMANCE — replaced `registry.find()` O(n) scan with O(1) Map
 *    lookup via RegistryCache. At 5,000 tests × multiple workers this
 *    eliminates millions of redundant comparisons.
 *
 * 4. TYPE SAFETY — replaced `typeof registry[0]` (fragile, inferred from JSON)
 *    with the explicit `TestCaseData` interface from types/TestCaseData.ts.
 *    An empty JSON or renamed column no longer silently collapses types.
 *
 * 5. STATIC IMPORT REMOVED — the original `import registry from '../data/testRegistry.json'`
 *    forced TypeScript to parse and type-check the entire JSON at compile time.
 *    At 5,000 rows this makes the IDE and tsc noticeably slow. RegistryCache
 *    reads the file at runtime instead.
 */

import { test as base, expect } from '@playwright/test';
import { TestCaseData }         from '../types/UiTestData';
import { getTestCase }          from '../utils/RegistryCache';
import { browserMatches }       from '../utils/BrowserUtils';

export type { TestCaseData };

// ─── Extended Test Fixture ────────────────────────────────────────────────────

export const test = base.extend<{ tcData: TestCaseData }>({

    tcData: [async ({}, use, testInfo) => {

        // Parse the TcId from the test title.
        // Convention: test title MUST start with "<TcId>: <description>"
        // e.g. "AppLogin: User should be able to login successfully"
        const tcId = testInfo.title.split(':')[0].trim();

        const data = getTestCase(tcId); // O(1) Map lookup

        if (data) {
            // Push all annotations here, in the fixture, rather than in
            // beforeEach. Reason: test.skip() in beforeEach throws an internal
            // Playwright interrupt — any annotations pushed BEFORE the skip()
            // call in beforeEach are lost. Annotations pushed here in the
            // fixture are always committed, regardless of what beforeEach does.
            testInfo.annotations.push({ type: 'TcId',        description: data.metadata.tcId });
            testInfo.annotations.push({ type: 'Priority',    description: data.metadata.priority });
            testInfo.annotations.push({ type: 'TestType',    description: data.metadata.testType });
            testInfo.annotations.push({ type: 'Environment', description: data.execution.environment });
            testInfo.annotations.push({
                type:        'UserRole',
                description: data.data.Login?.UserRole ?? 'N/A',
            });
            testInfo.annotations.push({
                type:        'Tags',
                description: Array.isArray(data.metadata.tags)
                    ? data.metadata.tags.join(', ')
                    : (data.metadata.tags ?? 'N/A'),
            });

            // Pre-annotate browser mismatches here so the annotation is
            // recorded even when the test is subsequently skipped in beforeEach.
            const projectName = testInfo.project.name;
            if (!browserMatches(data.execution.browser, projectName)) {
                testInfo.annotations.push({
                    type:        'BrowserMismatch',
                    description: `N/A for ${projectName}`,
                });
            }
        }

        await use(data as TestCaseData);

    }, { auto: true }],
});

// ─── beforeEach Guards ────────────────────────────────────────────────────────

test.beforeEach(async ({ browserName, tcData }, testInfo) => {

    // ── Guard 1: Registry entry must exist ───────────────────────────────────
    if (!tcData) {
        // FIX: tcId is now correctly derived here, in the same scope it's used.
        const tcId = testInfo.title.split(':')[0].trim();
        throw new Error(
            `❌ No registry entry found for TcId "${tcId}".\n` +
            `   Check that your test title starts with a valid TcId and that\n` +
            `   globalSetup has run to generate testRegistry.json.`
        );
    }

    // ── Guard 2: Test must be enabled in the Registry ────────────────────────
    if (!tcData.execution.enabled) {
        test.skip(true, `Disabled in Registry (Run ≠ "Yes") — TcId: ${tcData.metadata.tcId}`);
    }

    // ── Guard 3: Test must be targeting the current browser ──────────────────
    // FIX: uses shared browserMatches() instead of duplicated inline logic.
    if (!browserMatches(tcData.execution.browser, browserName)) {
        test.skip(
            true,
            `Registry restricts this test to [${tcData.execution.browser}]. ` +
            `Skipping on [${browserName}].`
        );
    }
});

export { expect };

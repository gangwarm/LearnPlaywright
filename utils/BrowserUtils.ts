/**
 * Shared browser-matching utilities.
 *
 * WHY THIS FILE EXISTS:
 * The original framework had the isChromiumFamily + match logic copy-pasted
 * in two places: the tcData fixture AND beforeEach. That meant any change to
 * the matching rules had to be made in both places — a classic drift bug.
 *
 * This single utility is imported by both baseTest.ts and playwright.config.ts
 * so the logic is always consistent.
 */

/** Browsers that all map to Playwright's 'chromium' project. */
const CHROMIUM_ALIASES = new Set(['chromium', 'chrome', 'edge']);

/**
 * Returns true if the given browser string belongs to the Chromium family.
 * Handles the common case where a tester writes "chrome" or "edge" in Excel
 * but Playwright's project is named "chromium".
 */
export function isChromiumFamily(browser: string): boolean {
    return CHROMIUM_ALIASES.has(browser.toLowerCase().trim());
}

/**
 * Returns true if a test's registry browser target matches the currently
 * running Playwright browser/project name.
 *
 * @param target  - The `browser` value from testRegistry.xlsx (e.g. "chrome", "all", "firefox")
 * @param current - The Playwright project name or browserName (e.g. "chromium", "firefox")
 */
export function browserMatches(target: string, current: string): boolean {
    const t = target.toLowerCase().trim();
    const c = current.toLowerCase().trim();

    return (
        t === 'all' ||
        t === c ||
        (isChromiumFamily(t) && isChromiumFamily(c))
    );
}

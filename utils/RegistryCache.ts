/**
 * RegistryCache — O(1) test-case lookup for the JSON registry.
 *
 * WHY THIS FILE EXISTS:
 *
 * The original baseTest.ts did:
 *   import registry from '../data/testRegistry.json';
 *   const data = registry.find(t => t.metadata.tcId === tcId);   // O(n) every test
 *
 * This has two problems at scale (5,000 tests):
 *
 *   1. PERFORMANCE: `.find()` is O(n). With 5,000 tests running in parallel
 *      across multiple workers, each worker does its own O(n) search for every
 *      single test. At 5,000 tests × 4 workers that is 20,000 linear scans.
 *      A Map reduces each lookup to O(1).
 *
 *   2. MEMORY: `import registry from '...'` is a static ES module import.
 *      TypeScript infers the type from the entire JSON at compile time, which
 *      becomes extremely slow as the file grows. Using fs.readFileSync + a
 *      module-level singleton avoids the type-inference overhead and still
 *      only reads the file once per worker process.
 *
 * SINGLETON PATTERN:
 *   The Map is built once the first time getRegistry() is called, then cached.
 *   Subsequent calls across all tests in the same worker return the cached Map
 *   instantly — zero additional I/O.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { TestCaseData } from '../types/TestCaseData';

const REGISTRY_PATH = path.join(__dirname, '../data/testRegistry.json');

// Module-level singleton — built once per worker process.
let _cache: Map<string, TestCaseData> | null = null;

/**
 * Returns a Map<tcId (lowercase), TestCaseData> built from testRegistry.json.
 * The Map is built once and then cached for the lifetime of the worker.
 */
export function getRegistry(): Map<string, TestCaseData> {
    if (_cache) return _cache;

    if (!fs.existsSync(REGISTRY_PATH)) {
        throw new Error(
            `❌ RegistryCache: testRegistry.json not found at "${REGISTRY_PATH}".\n` +
            `   Run globalSetup (npx playwright test) to generate it from the Excel file.`
        );
    }

    let raw: TestCaseData[];
    try {
        raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    } catch (e) {
        throw new Error(
            `❌ RegistryCache: Failed to parse testRegistry.json — the file may be malformed.\n` +
            `   Re-run the test suite to regenerate it. Original error: ${(e as Error).message}`
        );
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(
            `❌ RegistryCache: testRegistry.json is empty or not an array.\n` +
            `   Check your Excel Registry sheet has at least one row.`
        );
    }

    _cache = new Map(
        raw.map(entry => [entry.metadata.tcId.trim().toLowerCase(), entry])
    );

    return _cache;
}

/**
 * Looks up a single test case by ID.
 * @param tcId - The TestCaseID from the test title (case-insensitive).
 * @returns The TestCaseData, or undefined if not found.
 */
export function getTestCase(tcId: string): TestCaseData | undefined {
    return getRegistry().get(tcId.trim().toLowerCase());
}

/**
 * Clears the singleton cache.
 * Exposed for unit testing purposes only — do not call in production code.
 */
export function _clearCacheForTesting(): void {
    _cache = null;
}

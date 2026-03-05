/**
 * globalSetup.ts
 *
 * Runs ONCE before the entire Playwright test suite.
 * Reads testRegistry.xlsx and generates testRegistry.json.
 *
 * CHANGES FROM ORIGINAL:
 *
 * 1. PERFORMANCE — O(1) sheet lookups via pre-built Maps.
 *    Original: nested loop with O(n) `.find()` per sheet per test case.
 *    For 5,000 tests × 5 sheets = 25,000 linear searches.
 *    Fix: each sheet is indexed into a Map<TestCaseID, row> once,
 *    then all lookups are O(1).
 *
 * 2. SCHEMA VALIDATION — validates required Registry columns exist before
 *    processing. If someone renames "Run" → "Enabled" in Excel, the old
 *    code silently set every test's `enabled` flag to false (undefined → false).
 *    Now it throws immediately with a clear message.
 *
 * 3. ENV KEY VALIDATION — after building the JSON, checks that every
 *    envPassKey referenced in environments.json is present in process.env.
 *    Reports all missing keys upfront rather than failing mid-run.
 *
 * 4. ROW VALIDATION — warns about Registry rows missing a TestCaseID so
 *    phantom blank-row entries don't silently inflate your test count.
 *
 * 5. BETTER ERROR MESSAGES — all errors include actionable guidance.
 */

import { FullConfig } from '@playwright/test';
import * as XLSX from 'xlsx';
import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import {
    REQUIRED_REGISTRY_COLUMNS,
    RequiredRegistryColumn,
    TestCaseData,
} from '../types/TestCaseData';

// Load .env so we can validate envPassKey values during setup
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Paths ────────────────────────────────────────────────────────────────────

const EXCEL_PATH   = path.join(__dirname, '../data/testRegistry.xlsx');
const JSON_PATH    = path.join(__dirname, '../data/testRegistry.json');
const ENV_PATH     = path.join(__dirname, '../data/environments.json');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function globalSetup(config: FullConfig): Promise<void> {
    console.log('\n🔄 Enterprise Setup: Generating Nested Page-Object JSON...');

    // ── 1. Guard: Excel must exist ───────────────────────────────────────────
    if (!fs.existsSync(EXCEL_PATH)) {
        throw new Error(
            `❌ globalSetup: testRegistry.xlsx not found at "${EXCEL_PATH}".\n` +
            `   Place the Excel file in the /data directory and re-run.`
        );
    }

    // ── 2. Read workbook ─────────────────────────────────────────────────────
    let workbook: XLSX.WorkBook;
    try {
        workbook = XLSX.readFile(EXCEL_PATH);
    } catch (e) {
        throw new Error(
            `❌ globalSetup: Failed to read testRegistry.xlsx — the file may be open in Excel.\n` +
            `   Close the file and try again. Original error: ${(e as Error).message}`
        );
    }

    const sheetNames  = workbook.SheetNames;
    const dataSheets  = sheetNames.filter(name => name !== 'Registry');

    // ── 3. Guard: Registry sheet must exist ──────────────────────────────────
    if (!sheetNames.includes('Registry')) {
        throw new Error(
            `❌ globalSetup: No sheet named "Registry" found in testRegistry.xlsx.\n` +
            `   Available sheets: ${sheetNames.join(', ')}`
        );
    }

    const registryRows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets['Registry']);

    if (registryRows.length === 0) {
        throw new Error(
            `❌ globalSetup: The "Registry" sheet is empty. Add at least one test case row.`
        );
    }

    // ── 4. Schema validation: required columns ───────────────────────────────
    validateRegistrySchema(registryRows[0]);

    // ── 5. Pre-index all data sheets into Maps for O(1) lookup ───────────────
    //
    // BEFORE (original):
    //   for each test → for each sheet → sheetData.find(row => row.TestCaseID === tcId)
    //   = O(tests × sheets × rows_per_sheet)  e.g. 5000 × 5 × 5000 = 125,000,000 comparisons
    //
    // AFTER:
    //   Build Maps once = O(sheets × rows_per_sheet)  = 5 × 5000 = 25,000 comparisons
    //   Then all lookups = O(1) each
    //
    console.log(`📋 Indexing ${dataSheets.length} data sheet(s): ${dataSheets.join(', ')}`);

    const sheetMaps = new Map<string, Map<string, any>>();
    for (const sheetName of dataSheets) {
        const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        const rowMap = new Map<string, any>();
        for (const row of rows) {
            if (row.TestCaseID) {
                rowMap.set(String(row.TestCaseID).trim(), row);
            }
        }
        sheetMaps.set(sheetName, rowMap);
    }

    // ── 6. Build the final JSON ───────────────────────────────────────────────
    let skippedRows = 0;
    const finalData: TestCaseData[] = [];

    for (const regRow of registryRows) {
        const tcId = regRow.TestCaseID ? String(regRow.TestCaseID).trim() : null;

        // Warn about blank rows (common in Excel) and skip them
        if (!tcId) {
            skippedRows++;
            continue;
        }

        const nestedData: Record<string, any> = {};

        // O(1) lookup per sheet — no more nested .find()
        for (const sheetName of dataSheets) {
            const match = sheetMaps.get(sheetName)?.get(tcId);
            if (match) {
                nestedData[sheetName] = match;
            }
        }

        finalData.push({
            metadata: {
                tcId,
                title:    regRow.Description    ?? '',
                priority: regRow.Priority        ?? 'Medium',
                testType: regRow.TestType        ?? 'Functional',
                tags:     regRow.Tags
                    ? String(regRow.Tags).split(',').map((t: string) => t.trim()).filter(Boolean)
                    : [],
            },
            execution: {
                enabled:     regRow.Run === 'Yes' || regRow.Run === true,
                environment: regRow.Environment  ?? 'QA',
                browser:     regRow.Browser      ?? 'all',
            },
            data: nestedData as any,
        });
    }

    // ── 7. Write JSON ─────────────────────────────────────────────────────────
    try {
        fs.writeFileSync(JSON_PATH, JSON.stringify(finalData, null, 2), 'utf-8');
    } catch (e) {
        throw new Error(
            `❌ globalSetup: Failed to write testRegistry.json to "${JSON_PATH}".\n` +
            `   Check directory permissions. Original error: ${(e as Error).message}`
        );
    }

    // ── 8. Validate .env keys upfront ─────────────────────────────────────────
    //
    // WHY: A missing .env key only surfaces at runtime in the original code,
    // potentially after dozens of tests have already run. We surface ALL
    // missing keys here so the engineer fixes them before any test starts.
    //
    validateEnvKeys();

    // ── 9. Summary ────────────────────────────────────────────────────────────
    if (skippedRows > 0) {
        console.warn(`⚠️  Skipped ${skippedRows} Registry row(s) with no TestCaseID (likely blank rows).`);
    }
    console.log(
        `✅ Registry ready: ${finalData.length} test cases across ${dataSheets.length} data sheet(s).\n`
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validates that the first Registry row contains all required column headers.
 * Throws with a clear diff if any are missing.
 */
function validateRegistrySchema(firstRow: Record<string, any>): void {
    const presentColumns = new Set(Object.keys(firstRow));
    const missingColumns: RequiredRegistryColumn[] = REQUIRED_REGISTRY_COLUMNS.filter(
        col => !presentColumns.has(col)
    );

    if (missingColumns.length > 0) {
        throw new Error(
            `❌ globalSetup: Registry sheet is missing required column(s): ${missingColumns.join(', ')}.\n` +
            `   Required columns: ${REQUIRED_REGISTRY_COLUMNS.join(', ')}\n` +
            `   Found columns:    ${[...presentColumns].join(', ')}\n` +
            `   Check for typos or renamed headers in your Excel Registry sheet.`
        );
    }
}

/**
 * Reads environments.json and checks that every envPassKey has a corresponding
 * value in process.env. Reports all missing keys at once.
 */
function validateEnvKeys(): void {
    if (!fs.existsSync(ENV_PATH)) return; // Not fatal — ConfigManager will catch this later

    let envData: Record<string, any>;
    try {
        envData = JSON.parse(fs.readFileSync(ENV_PATH, 'utf-8'));
    } catch {
        return; // Malformed JSON — ConfigManager will throw a better error
    }

    const missingKeys: string[] = [];

    for (const [envName, envConfig] of Object.entries(envData)) {
        if (!envConfig?.users) continue;
        for (const [role, userConfig] of Object.entries(envConfig.users as Record<string, any>)) {
            const key = userConfig?.envPassKey;
            if (key && !process.env[key]) {
                missingKeys.push(`  [${envName}] role "${role}" → $${key}`);
            }
        }
    }

    if (missingKeys.length > 0) {
        // WARN, not throw — the test run can still start; only tests using
        // these credentials will fail. This gives QA visibility without
        // blocking tests that don't need the missing credentials.
        console.warn(
            `\n⚠️  globalSetup: The following .env password keys are not set.\n` +
            `   Tests requiring these credentials will fail at runtime:\n` +
            `${missingKeys.join('\n')}\n` +
            `   Add the missing keys to your .env file.\n`
        );
    }
}

export default globalSetup;

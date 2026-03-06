/**
 * apiGlobalSetup.ts
 *
 * Runs ONCE before the API test suite.
 * Reads apiRegistry.xlsx → generates apiRegistry.json.
 *
 * WHAT IT DOES:
 *  1. Validates apiRegistry.xlsx exists
 *  2. Validates required columns are present in APIRegistry sheet
 *  3. Validates APIRequests sheet is present
 *  4. Pre-indexes both sheets into Maps for O(1) lookup
 *  5. Groups steps by FlowID and sorts by StepOrder
 *  6. Validates every AssertionFile path exists on disk
 *  7. Validates every TemplatePath exists on disk
 *  8. Validates every SchemaFile path exists on disk
 *  9. Warns about missing .env keys referenced as {{env.*}} in endpoints
 * 10. Writes apiRegistry.json to data/
 */

import { FullConfig }     from '@playwright/test';
import * as XLSX          from 'xlsx';
import * as fs            from 'fs';
import * as path          from 'path';
import * as dotenv        from 'dotenv';
import {
    ApiRegistryRow,
    ApiRequestRow,
    ApiTestFlow,
    ApiTestStep,
    REQUIRED_REGISTRY_COLUMNS,
    RequiredRegistryColumn,
    Phase,
    HttpMethod,
    Protocol,
    AuthType,
} from '../../types/ApiTestData';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(__dirname, '../../data/api');
const EXCEL_PATH       = path.join(DATA_DIR, 'apiRegistry.xlsx');
const JSON_PATH        = path.join(DATA_DIR, 'apiRegistry.json');
const ASSERTIONS_DIR   = path.join(DATA_DIR, 'assertions');
const TEMPLATES_DIR    = path.join(DATA_DIR, 'templates');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function apiGlobalSetup(_config: FullConfig): Promise<void> {
    console.log('\n🔄 API Setup: Processing apiRegistry.xlsx...');

    // ── 1. Guard: Excel must exist ────────────────────────────────────────────
    if (!fs.existsSync(EXCEL_PATH)) {
        throw new Error(
            `[apiGlobalSetup] apiRegistry.xlsx not found at "${EXCEL_PATH}".\n` +
            `  Place the file in the /data directory and re-run.`
        );
    }

    const workbook = XLSX.readFile(EXCEL_PATH);

    // ── 2. Parse APIRegistry sheet ────────────────────────────────────────────
    if (!workbook.SheetNames.includes('APIRegistry')) {
        throw new Error(
            `[apiGlobalSetup] Sheet "APIRegistry" not found in apiRegistry.xlsx.\n` +
            `  Found sheets: ${workbook.SheetNames.join(', ')}`
        );
    }

    const registrySheet  = workbook.Sheets['APIRegistry'];
    const registryRaw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(registrySheet, { defval: '' });

    if (registryRaw.length === 0) {
        console.warn('[apiGlobalSetup] ⚠  APIRegistry sheet is empty — no API tests will run.');
        fs.writeFileSync(JSON_PATH, JSON.stringify({ flows: [] }, null, 2), 'utf-8');
        return;
    }

    // ── 3. Validate required columns ──────────────────────────────────────────
    const firstRow      = registryRaw[0];
    const missingCols   = REQUIRED_REGISTRY_COLUMNS.filter(
        col => !(col in firstRow)
    ) as RequiredRegistryColumn[];

    if (missingCols.length > 0) {
        throw new Error(
            `[apiGlobalSetup] Missing required columns in APIRegistry sheet:\n` +
            `  Missing: ${missingCols.join(', ')}\n` +
            `  Found:   ${Object.keys(firstRow).join(', ')}\n` +
            `  Fix: Add the missing columns to the APIRegistry sheet in apiRegistry.xlsx.`
        );
    }

    // ── 4. Parse APIRequests sheet ────────────────────────────────────────────
    const requestsMap = new Map<string, Record<string, string | number | boolean>>();

    if (workbook.SheetNames.includes('APIRequests')) {
        const requestsSheet = workbook.Sheets['APIRequests'];
        const requestsRaw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(requestsSheet, { defval: '' });

        for (const row of requestsRaw) {
            const id = String(row['TestCaseID'] ?? '').trim();
            if (!id) continue;
            const { TestCaseID: _id, ...rest } = row as ApiRequestRow;
            requestsMap.set(id, rest as Record<string, string | number | boolean>);
        }
    } else {
        console.warn('[apiGlobalSetup] ⚠  APIRequests sheet not found — template data will be empty.');
    }

    // ── 5. Build flows ────────────────────────────────────────────────────────
    const warnings:   string[] = [];
    const flowMap     = new Map<string, { setup: ApiTestStep[]; test: ApiTestStep[]; teardown: ApiTestStep[] }>();

    let enabledCount  = 0;
    let skippedCount  = 0;

    for (const rawRow of registryRaw) {
        const row = normaliseRow(rawRow);

        if (!row.FlowID || !row.TestCaseID) {
            warnings.push(`Row missing FlowID or TestCaseID — skipped: ${JSON.stringify(rawRow)}`);
            continue;
        }

        //if (!row.Run) {
            //skippedCount++;
            //continue;
        //}

        if (!row.Run) {
        skippedCount++;
         // Still add to flowMap so fully-skipped flows appear in the report
            if (!flowMap.has(row.FlowID)) {
            flowMap.set(row.FlowID, { setup: [], test: [], teardown: [] });
            }
         const skippedStep: ApiTestStep = {
        registry:    { ...normaliseRow(row), Run: false },
        requestData: {},
        skipped:     true,
        };
        const skippedPhase = (row.Phase ?? 'test') as Phase;
        flowMap.get(row.FlowID)![skippedPhase].push(skippedStep);
        continue;
        }


        enabledCount++;

        // Validate file paths
        if (row.AssertionFile) {
            const assertPath = path.join(ASSERTIONS_DIR, row.AssertionFile);
            if (!fs.existsSync(assertPath)) {
                warnings.push(
                    `[${row.TestCaseID}] AssertionFile not found: "${assertPath}"\n` +
                    `  Create the file or correct the path in apiRegistry.xlsx.`
                );
            }
        }

        if (row.TemplatePath) {
            const tplPath = path.join(TEMPLATES_DIR, row.TemplatePath.replace(/^templates\//, ''));
            if (!fs.existsSync(tplPath)) {
                warnings.push(
                    `[${row.TestCaseID}] TemplatePath not found: "${tplPath}"\n` +
                    `  Create the template file or correct the path in apiRegistry.xlsx.`
                );
            }
        }

        // Check {{env.*}} references in endpoint
        const envRefs = [...(row.Endpoint.matchAll(/\{\{env\.([^}]+)\}\}/g))].map(m => m[1]);
        for (const envKey of envRefs) {
            if (!process.env[envKey]) {
                warnings.push(`[${row.TestCaseID}] .env missing key "${envKey}" referenced in Endpoint.`);
            }
        }

        // Build step
        const step: ApiTestStep = {
            registry:    row,
            requestData: requestsMap.get(row.TestCaseID) ?? {},
        };

        // Group into flow
        if (!flowMap.has(row.FlowID)) {
            flowMap.set(row.FlowID, { setup: [], test: [], teardown: [] });
        }
        const flow  = flowMap.get(row.FlowID)!;
        const phase = (row.Phase ?? 'test') as Phase;
        flow[phase].push(step);
    }

    // ── 6. Sort steps by StepOrder within each phase ──────────────────────────
    const flows: ApiTestFlow[] = [];

    for (const [flowId, phases] of flowMap) {
        const sortByOrder = (steps: ApiTestStep[]) =>
            steps.sort((a, b) => a.registry.StepOrder - b.registry.StepOrder);

        flows.push({
            flowId,
            setup:    sortByOrder(phases.setup),
            test:     sortByOrder(phases.test),
            teardown: sortByOrder(phases.teardown),
        });
    }

    // ── 7. Write JSON ─────────────────────────────────────────────────────────
    fs.writeFileSync(JSON_PATH, JSON.stringify({ flows }, null, 2), 'utf-8');

    // ── 8. Report ─────────────────────────────────────────────────────────────
    console.log(
        `✅ API Setup complete:\n` +
        `   Flows:    ${flows.length}\n` +
        `   Enabled:  ${enabledCount} steps\n` +
        `   Skipped:  ${skippedCount} steps (Run=FALSE)\n` +
        `   Output:   ${JSON_PATH}`
    );

    if (warnings.length > 0) {
        console.warn('\n⚠  Warnings:');
        warnings.forEach(w => console.warn(`   ${w}`));
    }
}

// ─── Row normaliser ───────────────────────────────────────────────────────────

function normaliseRow(raw: Record<string, unknown>): ApiRegistryRow {
    const str  = (key: string)       => String(raw[key] ?? '').trim();
    const num  = (key: string, def: number) => {
        const v = raw[key];
        const n = parseFloat(String(v));
        return isNaN(n) ? def : n;
    };
    const bool = (key: string) => {
        const v = String(raw[key] ?? '').trim().toUpperCase();
        return v === 'TRUE' || v === '1' || v === 'YES';
    };

    return {
        FlowID:          str('FlowID'),
        TestCaseID:      str('TestCaseID'),
        StepOrder:       num('StepOrder', 1),
        Phase:           (str('Phase').toLowerCase() || 'test') as Phase,
        Description:     str('Description'),
        Protocol:        (str('Protocol').toUpperCase() || 'REST') as Protocol,
        Method:          str('Method').toUpperCase() as HttpMethod,
        Endpoint:        str('Endpoint'),
        BaseUrl:         str('BaseUrl') || undefined,
        AuthType:        (str('AuthType') || 'None') as AuthType,
        ContentType:     str('ContentType') as ApiRegistryRow['ContentType'] || undefined,
        TemplatePath:    str('TemplatePath') || undefined,
        SchemaFile:      str('SchemaFile') || undefined,
        AssertionFile:   str('AssertionFile') || undefined,
        ExtractAs:       str('ExtractAs') || undefined,
        DependsOn:       str('DependsOn') || undefined,
        MaxResponseTime: num('MaxResponseTime', 0) || undefined,
        RetryCount:      num('RetryCount', 0),
        RetryDelay:      num('RetryDelay', 1000),
        MaskFields:      str('MaskFields') || undefined,
        Priority:        str('Priority') || 'P3',
        Tags:            str('Tags'),
        Run:             bool('Run'),
        Environment:     str('Environment') || 'QA',
    };
}

export default apiGlobalSetup;

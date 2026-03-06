/**
 * masterSetup.ts
 *
 * Single entry point for globalSetup in playwright.config.ts.
 * Orchestrates both UI and API setup in the correct order.
 *
 * BEHAVIOUR:
 *  - UI setup always runs if testRegistry.xlsx exists
 *  - API setup only runs if apiRegistry.xlsx exists
 *  - Both setups are independent — failure in one does not skip the other
 *  - Safe to use when running UI-only or API-only suites
 */

import { FullConfig } from '@playwright/test';
import * as fs        from 'fs';
import * as path      from 'path';

const DATA_DIR          = path.join(__dirname, '../../data');
const UI_REGISTRY_PATH  = path.join(DATA_DIR, 'ui/testRegistry.xlsx');
const API_REGISTRY_PATH = path.join(DATA_DIR, 'api/apiRegistry.xlsx');

export default async function masterSetup(config: FullConfig): Promise<void> {
    console.log('\n══════════════════════════════════════════');
    console.log('  Framework Setup');
    console.log('══════════════════════════════════════════');

    // ── UI setup ──────────────────────────────────────────────────────────────
    if (fs.existsSync(UI_REGISTRY_PATH)) {
        //const { default: uiSetup } = await import('./globalSetup');
        const uiSetup = require('./globalSetup').default;
        await uiSetup(config);
    } else {
        console.log('ℹ  UI setup skipped — testRegistry.xlsx not found');
    }

    // ── API setup ─────────────────────────────────────────────────────────────
    if (fs.existsSync(API_REGISTRY_PATH)) {
        //const { default: apiSetup } = await import('../api/setup/apiGlobalSetup');
        const apiSetup = require('./apiGlobalSetup').default;
        await apiSetup(config);
    } else {
        console.log('ℹ  API setup skipped — apiRegistry.xlsx not found');
    }

    console.log('\n══════════════════════════════════════════\n');
}

/**
 * apiTest.ts
 *
 * Custom Playwright fixture for API tests.
 * Equivalent of baseTest.ts for the UI layer.
 *
 * INJECTS:
 *  - apiFlow:       The resolved ApiTestFlow for the current test (from apiRegistry.json)
 *  - store:         A fresh ResponseStore scoped to this flow
 *  - httpClient:    A ready HttpClient wrapping Playwright's APIRequestContext
 *  - requestBuilder: Configured RequestBuilder with environments + auth
 *  - runFlow():     Helper that executes setup → test → teardown automatically
 *
 * USAGE:
 *   import { test, expect } from '../fixtures/apiTest';
 *
 *   test('USER-01: Login and get profile', async ({ runFlow }) => {
 *       const results = await runFlow('USER-01');
 *       results.forEach(r => expect(r.assertions.allPassed).toBeTruthy());
 *   });
 */

import { test as base, expect, APIRequestContext } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

import { HttpClient }      from '../clients/HttpClient';
import { RequestBuilder }  from '../core/RequestBuilder';
import { AssertionParser } from '../core/AssertionParser';
import { AssertionEngine } from '../core/AssertionEngine';
import { ResponseStore }   from '../core/ResponseStore';
import { AuthManager }     from '../core/AuthManager';
import { TemplateEngine }  from '../core/TemplateEngine';
import {
    ApiTestFlow,
    ApiTestStep,
    ApiResponse,
    AssertionResult,
//} from '../types/ApiTestData';
} from '../../types/ApiTestData';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(__dirname, '../../data/api');
const REGISTRY_JSON  = path.join(DATA_DIR, 'apiRegistry.json');
const ASSERTIONS_DIR = path.join(DATA_DIR, 'assertions');
const ENV_PATH       = path.join(DATA_DIR, 'apiEnvironments.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepResult {
    stepId:       string;
    description:  string;
    phase:        string;
    response:     ApiResponse;
    assertions:   AssertionResult;
    skipped:      boolean;
    skipReason?:  string;
}

export interface FlowResult {
    flowId:     string;
    steps:      StepResult[];
    allPassed:  boolean;
}

// ─── Fixture types ────────────────────────────────────────────────────────────

type ApiFixtures = {
    runFlow: (flowId: string) => Promise<FlowResult>;
};

// ─── Registry loader (cached per worker) ─────────────────────────────────────

let _flowCache: Map<string, ApiTestFlow> | null = null;
let _envConfig: Record<string, Record<string, string>> | null = null;

function getFlowCache(): Map<string, ApiTestFlow> {
    if (_flowCache) return _flowCache;

    if (!fs.existsSync(REGISTRY_JSON)) {
        throw new Error(
            `[apiTest] apiRegistry.json not found at "${REGISTRY_JSON}".\n` +
            `  Run npx playwright test once to trigger apiGlobalSetup.`
        );
    }

    const { flows } = JSON.parse(fs.readFileSync(REGISTRY_JSON, 'utf-8')) as { flows: ApiTestFlow[] };
    _flowCache = new Map(flows.map(f => [f.flowId, f]));
    return _flowCache;
}

function getEnvConfig(): Record<string, Record<string, string>> {
    if (_envConfig) return _envConfig;
    if (!fs.existsSync(ENV_PATH)) return (_envConfig = {});
    _envConfig = JSON.parse(fs.readFileSync(ENV_PATH, 'utf-8'));
    return _envConfig!;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

export const test = base.extend<ApiFixtures>({

    runFlow: async ({ request }: { request: APIRequestContext }, use: (fn: (flowId: string) => Promise<FlowResult>) => Promise<void>) => {

        const flowCache = getFlowCache();
        const envConfig = getEnvConfig();

        const runFlow = async (flowId: string): Promise<FlowResult> => {
            const flow = flowCache.get(flowId);

            if (!flow) {
                throw new Error(
                    `[apiTest] Flow "${flowId}" not found in apiRegistry.json.\n` +
                    `  Available flows: ${[...flowCache.keys()].join(', ')}\n` +
                    `  Ensure FlowID "${flowId}" exists in apiRegistry.xlsx with Run=TRUE.`
                );
            }

            const store          = new ResponseStore(flowId);
            const currentEnv     = process.env.ENV ?? 'QA';
            const authManager    = new AuthManager(envConfig, currentEnv);
            const httpClient     = new HttpClient(request, 3000);
            const requestBuilder = new RequestBuilder(DATA_DIR, envConfig as Record<string, { baseUrl: string; apiBaseUrl?: string }>, authManager);
            const assertParser   = new AssertionParser(ASSERTIONS_DIR);
            const assertEngine   = new AssertionEngine();

            const allResults: StepResult[] = [];
            const failedStepIds            = new Set<string>();

            // Helper: run a single step
            const runStep = async (step: ApiTestStep): Promise<StepResult> => {
                const { registry } = step;

                // Dependency check — skip if prerequisite failed
                if (registry.DependsOn && failedStepIds.has(registry.DependsOn)) {
                    return {
                        stepId:      registry.TestCaseID,
                        description: registry.Description,
                        phase:       registry.Phase,
                        response:    { status: 0, headers: {}, body: null, responseTime: 0, rawBody: '' },
                        assertions:  { passed: [], failed: [], total: 0, allPassed: true },
                        skipped:     true,
                        skipReason:  `Prerequisite step "${registry.DependsOn}" failed`,
                    };
                }

                // Build and send request
                const resolvedRequest = requestBuilder.build(
                    registry,
                    { TestCaseID: registry.TestCaseID, ...step.requestData },
                    store,
                );
                const response = await httpClient.send(resolvedRequest);

                // Auto-extract for chaining
                if (registry.ExtractAs && response.body) {
                    store.autoExtract(registry.TestCaseID, registry.ExtractAs, response.body);
                }

                // Run assertions
                let assertionResult: AssertionResult = { passed: [], failed: [], total: 0, allPassed: true };

                if (registry.AssertionFile) {
                    const assertions   = assertParser.parse(registry.AssertionFile);
                    assertionResult    = assertEngine.run(assertions, response);
                }

                const stepPassed = assertionResult.allPassed;
                if (!stepPassed) failedStepIds.add(registry.TestCaseID);

                return {
                    stepId:      registry.TestCaseID,
                    description: registry.Description,
                    phase:       registry.Phase,
                    response,
                    assertions:  assertionResult,
                    skipped:     false,
                };
            };

            // ── Execute: setup → test → teardown ──────────────────────────────

            // Setup steps
            for (const step of flow.setup) {
                const result = await runStep(step);
                allResults.push(result);
            }

            // Test steps
            for (const step of flow.test) {
                const result = await runStep(step);
                allResults.push(result);
            }

            // Teardown steps — always run even if tests failed
            for (const step of flow.teardown) {
                try {
                    const result = await runStep(step);
                    allResults.push(result);
                } catch (err) {
                    console.warn(`[apiTest] Teardown step ${step.registry.TestCaseID} failed: ${(err as Error).message}`);
                }
            }

            const allPassed = allResults.every(r => r.skipped || r.assertions.allPassed);

            // Print failure summary to console
            if (!allPassed) {
                const failedSteps = allResults.filter(r => !r.skipped && !r.assertions.allPassed);
                console.error(`\n[apiTest] Flow "${flowId}" FAILED — ${failedSteps.length} step(s) with assertion failures:`);

                for (const step of failedSteps) {
                    console.error(`\n  ✕ ${step.stepId}: ${step.description}`);
                    console.error(`    Status: ${step.response.status}  Time: ${step.response.responseTime}ms`);
                    for (const failure of step.assertions.failed) {
                        console.error(`    ✗ ${failure.rule}`);
                        if (failure.message) console.error(`      ${failure.message}`);
                    }
                }
            }

            return { flowId, steps: allResults, allPassed };
        };

        await use(runFlow);
    },
});

export { expect };

/**
 * apiTest.ts
 *
 * Custom Playwright fixture for API tests.
 * Equivalent of baseTest.ts for the UI layer.
 *
 * INJECTS:
 *  - runFlow() — executes setup → test → teardown for a given FlowID
 *
 * FEATURES:
 *  - Request logging    : every step's resolved request saved to data/api/request-logs/<run>/
 *  - Response logging   : every step's response saved to data/api/response-logs/<run>/
 *  - Same filename      : <FlowID>_<StepID>.json in both folders — easy to compare side by side
 *  - MaskFields         : sensitive values replaced with ***MASKED*** in both request and response
 *  - Global RT check    : defaultMaxResponseTime from apiEnvironments.json auto-applied
 *  - Assertion counts   : assertionsPassed / assertionsTotal available per step
 *  - Log paths on fail  : console prints both request and response log paths
 *  - Run pruning        : keeps last 5 run folders in both log dirs, deletes older ones
 *
 * USAGE:
 *   import { test, expect } from '../fixtures/apiTest';
 *
 *   test('USER-01: Login and get profile', async ({ runFlow }) => {
 *       const result = await runFlow('USER-01');
 *       expect(result.allPassed).toBeTruthy();
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
const RESPONSE_LOGS  = path.join(DATA_DIR, 'response-logs');
const REQUEST_LOGS   = path.join(DATA_DIR, 'request-logs');

// One timestamped folder shared across all steps in this run
const RUN_TIMESTAMP = (() => {
    const n = new Date();
    const p = (v: number) => String(v).padStart(2, '0');
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}-${p(n.getHours())}-${p(n.getMinutes())}`;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepResult {
    stepId:           string;
    description:      string;
    phase:            string;
    response:         ApiResponse;
    assertions:       AssertionResult;
    assertionsPassed: number;   // passed assertion count — shown in report
    assertionsTotal:  number;   // total assertion count — shown in report
    skipped:          boolean;
    skipReason?:      string;
    logFile?:         string;   // absolute path to saved response JSON
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
let _envConfig: Record<string, Record<string, string | number>> | null = null;

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

function getEnvConfig(): Record<string, Record<string, string | number>> {
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

        // ── Create run log folders, prune old runs (keep last 5) ─────────────
        const runLogDir     = path.join(RESPONSE_LOGS, RUN_TIMESTAMP);
        const runReqLogDir  = path.join(REQUEST_LOGS,  RUN_TIMESTAMP);
        if (!fs.existsSync(runLogDir))    fs.mkdirSync(runLogDir,    { recursive: true });
        if (!fs.existsSync(runReqLogDir)) fs.mkdirSync(runReqLogDir, { recursive: true });

        try {
            for (const root of [RESPONSE_LOGS, REQUEST_LOGS]) {
                const allRuns = fs.readdirSync(root)
                    .filter(d => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(d))
                    .sort();
                if (allRuns.length > 5) {
                    for (const old of allRuns.slice(0, allRuns.length - 5)) {
                        fs.rmSync(path.join(root, old), { recursive: true, force: true });
                    }
                }
            }
        } catch { /* non-fatal — never block test execution */ }

        const runFlow = async (flowId: string): Promise<FlowResult> => {
            const flow = flowCache.get(flowId);

            if (!flow) {
                throw new Error(
                    `[apiTest] Flow "${flowId}" not found in apiRegistry.json.\n` +
                    `  Available flows: ${[...flowCache.keys()].join(', ')}\n` +
                    `  Ensure FlowID "${flowId}" exists in apiRegistry.xlsx with Run=TRUE.`
                );
            }

            // ── Global response time threshold from apiEnvironments.json ──────
            const currentEnv            = process.env.ENV ?? 'QA';
            const envBlock              = envConfig[currentEnv] ?? {};
            const globalMaxResponseTime = typeof envBlock['defaultMaxResponseTime'] === 'number'
                ? (envBlock['defaultMaxResponseTime'] as number)
                : null;

            const store          = new ResponseStore(flowId);
            const authManager    = new AuthManager(envConfig as Record<string, Record<string, string>>, currentEnv);
            const httpClient     = new HttpClient(request, 3000);
            const requestBuilder = new RequestBuilder(DATA_DIR, envConfig as Record<string, { baseUrl: string; apiBaseUrl?: string }>, authManager);
            const assertParser   = new AssertionParser(ASSERTIONS_DIR);
            const assertEngine   = new AssertionEngine();

            const allResults: StepResult[] = [];
            const failedStepIds            = new Set<string>();

            // ── Mask sensitive fields in a response body ──────────────────────
            const maskBody = (body: unknown, maskFields?: string): unknown => {
                if (!maskFields || !body || typeof body !== 'object') return body;
                const fields = maskFields.split(',').map(f => f.trim()).filter(Boolean);
                const clone  = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
                const maskObj = (obj: Record<string, unknown>) => {
                    for (const key of Object.keys(obj)) {
                        if (fields.includes(key)) {
                            obj[key] = '***MASKED***';
                        } else if (obj[key] && typeof obj[key] === 'object') {
                            maskObj(obj[key] as Record<string, unknown>);
                        }
                    }
                };
                maskObj(clone);
                return clone;
            };

            // ── Write request log → data/api/request-logs/<run>/<FlowID>_<StepID>.json
            const writeRequestLog = (
                step:    ApiTestStep,
                reqMeta: { method: string; url: string; headers: Record<string, string>; body: unknown },
            ): void => {
                const { registry } = step;
                const fileName     = `${registry.FlowID}_${registry.TestCaseID}.json`;
                const filePath     = path.join(runReqLogDir, fileName);

                const logEntry = {
                    meta: {
                        flowId:      registry.FlowID,
                        stepId:      registry.TestCaseID,
                        description: registry.Description,
                        phase:       registry.Phase,
                        timestamp:   new Date().toISOString(),
                    },
                    request: {
                        method:  reqMeta.method,
                        url:     reqMeta.url,
                        headers: reqMeta.headers,
                        body:    maskBody(reqMeta.body, registry.MaskFields),
                    },
                };

                try {
                    fs.writeFileSync(filePath, JSON.stringify(logEntry, null, 2), 'utf-8');
                } catch (err) {
                    console.warn(`[apiTest] Could not write request log: ${(err as Error).message}`);
                }
            };

            // ── Write response log → data/api/response-logs/<run>/<FlowID>_<StepID>.json
            const writeResponseLog = (
                step:       ApiTestStep,
                response:   ApiResponse,
                assertions: AssertionResult,
                passed:     boolean,
            ): string => {
                const { registry } = step;
                const fileName     = `${registry.FlowID}_${registry.TestCaseID}.json`;
                const filePath     = path.join(runLogDir, fileName);

                const logEntry = {
                    meta: {
                        flowId:      registry.FlowID,
                        stepId:      registry.TestCaseID,
                        description: registry.Description,
                        phase:       registry.Phase,
                        timestamp:   new Date().toISOString(),
                        passed,
                    },
                    response: {
                        status:       response.status,
                        responseTime: response.responseTime,
                        headers:      response.headers,
                        body:         maskBody(response.body, registry.MaskFields),
                    },
                    assertions: {
                        total:  assertions.total,
                        passed: assertions.passed.length,
                        failed: assertions.failed.map(f => ({ rule: f.rule, message: f.message })),
                    },
                };

                try {
                    fs.writeFileSync(filePath, JSON.stringify(logEntry, null, 2), 'utf-8');
                } catch (err) {
                    console.warn(`[apiTest] Could not write response log: ${(err as Error).message}`);
                }

                return filePath;
            };

            // ── Run a single step ─────────────────────────────────────────────
            const runStep = async (step: ApiTestStep): Promise<StepResult> => {
                const { registry } = step;

                // Dependency check — skip if prerequisite failed
                if (registry.DependsOn && failedStepIds.has(registry.DependsOn)) {
                    return {
                        stepId:           registry.TestCaseID,
                        description:      registry.Description,
                        phase:            registry.Phase,
                        response:         { status: 0, headers: {}, body: null, responseTime: 0, rawBody: '' },
                        assertions:       { passed: [], failed: [], total: 0, allPassed: true },
                        assertionsPassed: 0,
                        assertionsTotal:  0,
                        skipped:          true,
                        skipReason:       `Prerequisite step "${registry.DependsOn}" failed`,
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

                // ── Run assertion file ────────────────────────────────────────
                let assertionResult: AssertionResult = { passed: [], failed: [], total: 0, allPassed: true };

                if (registry.AssertionFile) {
                    const assertions = assertParser.parse(registry.AssertionFile);
                    assertionResult  = assertEngine.run(assertions, response);
                }

                // ── Global response time check ────────────────────────────────
                // Applied when: global threshold is set, step has no MaxResponseTime
                // override, and no responseTime assertion already in the assert file
                if (globalMaxResponseTime && !registry.MaxResponseTime) {
                    const alreadyChecked = [...assertionResult.passed, ...assertionResult.failed]
                        .some(a => a.rule.startsWith('responseTime'));

                    if (!alreadyChecked && response.responseTime > globalMaxResponseTime) {
                        const rtFailure = {
                            rule:     `responseTime < ${globalMaxResponseTime}ms (global threshold)`,
                            passed:   false,
                            actual:   response.responseTime,
                            expected: globalMaxResponseTime,
                            message:  `Response time ${response.responseTime}ms exceeded global threshold of ${globalMaxResponseTime}ms`,
                        };
                        assertionResult.failed.push(rtFailure);
                        assertionResult.total++;
                        assertionResult.allPassed = false;
                    }
                }

                const stepPassed = assertionResult.allPassed;
                if (!stepPassed) failedStepIds.add(registry.TestCaseID);

                // ── Save request log (before response — captures what was sent) ──
                writeRequestLog(step, {
                    method:  resolvedRequest.method,
                    url:     resolvedRequest.url,
                    headers: resolvedRequest.headers ?? {},
                    body:    resolvedRequest.body,
                });

                // ── Save response log ─────────────────────────────────────────
                const logFile = writeResponseLog(
                    step,
                    response,
                    assertionResult,
                    stepPassed,
                );

                return {
                    stepId:           registry.TestCaseID,
                    description:      registry.Description,
                    phase:            registry.Phase,
                    response,
                    assertions:       assertionResult,
                    assertionsPassed: assertionResult.passed.length,
                    assertionsTotal:  assertionResult.total,
                    skipped:          false,
                    logFile,
                };
            };

            // ── Execute: setup → test → teardown ──────────────────────────────

            for (const step of flow.setup) {
                allResults.push(await runStep(step));
            }

            for (const step of flow.test) {
                allResults.push(await runStep(step));
            }

            // Teardown always runs even if test steps failed
            for (const step of flow.teardown) {
                try {
                    allResults.push(await runStep(step));
                } catch (err) {
                    console.warn(`[apiTest] Teardown step ${step.registry.TestCaseID} failed: ${(err as Error).message}`);
                }
            }

            const allPassed = allResults.every(r => r.skipped || r.assertions.allPassed);

            // ── Console failure summary ───────────────────────────────────────
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
                    if (step.logFile) {
                        const reqFile = step.logFile.replace('response-logs', 'request-logs');
                        console.error(`    📤 Request log:  ${reqFile}`);
                        console.error(`    📥 Response log: ${step.logFile}`);
                    }
                }
            }

            // ── Assertion summary line — parsed by CustomReporter ─────────────
            const totalPassed = allResults.reduce((s, r) => s + r.assertionsPassed, 0);
            const totalAssert = allResults.reduce((s, r) => s + r.assertionsTotal,  0);
            console.log(`[apiTest:assertions] ${flowId} ${totalPassed}/${totalAssert}`);

            return { flowId, steps: allResults, allPassed };
        };

        await use(runFlow);
    },
});

export { expect };

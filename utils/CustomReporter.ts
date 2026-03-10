/**
 * CustomReporter.ts
 *
 * Unified UI + API test execution report.
 *
 * ── WHAT'S NEW ────────────────────────────────────────────────────────────────
 *
 * 1. UI / API SPLIT — tests automatically detected by project name.
 *    UI tests  → project = chromium / firefox / webkit
 *    API tests → project = api
 *    Each layer has its own KPI row, charts, and results table.
 *
 * 2. SMART SECTION VISIBILITY — if only API tests ran, UI section and charts
 *    are hidden. If only UI tests ran, API section is hidden. Both show when
 *    running the full suite.
 *
 * 3. UI / API FILTER TABS — top-level tabs switch between All / UI / API views.
 *    Each view has its own search + status filter bar.
 *
 * 4. API-SPECIFIC CHARTS — response time distribution, HTTP method breakdown,
 *    flow pass/fail rate. None shown when only UI tests ran.
 *
 * 5. API TABLE — FlowID, description, steps passed/total, avg response time,
 *    tags, status. No browser columns (irrelevant for API).
 *
 * 6. PRIORITY BUG FIXED — priority badge now shows correctly for both UI
 *    and API tests. API rows read Priority from apiRegistry Tags column.
 *
 * 7. ALL EXISTING UI FIXES PRESERVED from previous version.
 */

import {
    Reporter,
    TestCase,
    TestResult,
    FullResult,
    FullConfig,
} from '@playwright/test/reporter';
import * as fs   from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

type BrowserKey    = 'chromium' | 'firefox' | 'webkit';
type BrowserStatus = 'passed' | 'failed' | 'skipped' | '-';

interface UiTestEntry {
    kind:          'ui';
    title:         string;
    tcId:          string;
    priority:      string;
    testType:      string;
    environment:   string;
    userRole:      string;
    tags:          string;
    browsers:      Record<BrowserKey, BrowserStatus>;
    duration:      Record<BrowserKey, number>;   // ms per browser — max shown in report
    errorSummary:  string;   // e.g. "Assertion failed: toHaveText()"
    errorExpected: string;   // e.g. "2"
    errorReceived: string;   // e.g. "3"
    isFlaky:       boolean;
    // Expand panel (failed rows only)
    screenshotPath: string;  // relative path from report file → data/<ts>/<file>.png
    failedSteps:    Array<{ title: string; error: string; file: string; line: number }>;
}

interface ApiTestEntry {
    kind:             'api';
    title:            string;
    flowId:           string;
    testType:         string;
    tags:             string;
    priority:         string;
    status:           'passed' | 'failed' | 'skipped';
    error:            string;
    duration:         number;   // ms
    isFlaky:          boolean;
    assertionsPassed: number;   // e.g. 7
    assertionsTotal:  number;   // e.g. 8
}

type TestEntry = UiTestEntry | ApiTestEntry;

// ─── HTML escape ──────────────────────────────────────────────────────────────

function h(str: string | undefined | null): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

// ─── Defect category classifier ───────────────────────────────────────────────

function classifyDefect(errorMsg: string): string {
    if (!errorMsg)                                                   return 'Unknown';
    const m = errorMsg.toLowerCase();
    if (/timed? ?out|timeout|navigation|net::/i.test(m))            return 'Timeout / Network';
    if (/status.*==|status code|got 4\d\d|got 5\d\d/i.test(m))     return 'Wrong Status Code';
    if (/tohavetext|tocontain|expect\.\w+\(\) failed/i.test(m))     return 'Assertion Error';
    if (/no element|locator|not visible|not found|selector/i.test(m)) return 'Element Not Found';
    if (/schema|required|additional prop|must be/i.test(m))         return 'Schema Violation';
    if (/unauthori[sz]ed|forbidden|401|403/i.test(m))               return 'Auth Failure';
    return 'Other Failure';
}

// ─── Reporter ─────────────────────────────────────────────────────────────────

class CustomHTMLReporter implements Reporter {
    private uiResults     = new Map<string, UiTestEntry>();
    private apiResults    = new Map<string, ApiTestEntry>();
    private startTime     = 0;
    private projectName   = 'Project';
    private envInfo: { name: string } | null = null;
    private screenshotDir = '';   // set in onEnd: custom-reports/data/<timestamp>/

    onBegin(config: FullConfig): void {
        this.startTime   = Date.now();
        this.projectName = config.metadata?.projectName ?? 'Project';

        // ── Load active environment from apiEnvironments.json ─────────────────
        try {
            const envFile = path.join(process.cwd(), 'data', 'api', 'apiEnvironments.json');
            if (fs.existsSync(envFile)) {
                const envData = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
                if (Array.isArray(envData)) {
                    // Array format: [{ name, baseUrl, active? }]
                    const active = envData.find((e: any) => e.active === true) ?? envData[0];
                    if (active) this.envInfo = {
                        name: active.name ?? active.environment ?? 'Unknown',
                    };
                } else {
                    // Keyed object format: { "QA": { apiBaseUrl: "..." }, "PROD": { ... } }
                    const firstName = Object.keys(envData)[0];
                    if (firstName) {
                        this.envInfo = { name: firstName };
                    }
                }
            }
        } catch {
            // Non-fatal — env bar simply won't render
        }
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        const rawProject = test.parent.project()?.name?.toLowerCase() ?? '';
        const isApi      = rawProject === 'api';

        if (isApi) {
            this.recordApi(test, result);
        } else {
            this.recordUi(test, result);
        }
    }

    // ── Record UI test ────────────────────────────────────────────────────────

    private recordUi(test: TestCase, result: TestResult): void {
        const getMeta = (type: string) =>
            test.annotations.find(a => a.type === type)?.description ?? 'N/A';

        const tcId   = getMeta('TcId');
        const rowKey = tcId !== 'N/A' ? tcId : test.title;

        const rawTitle   = test.title;
        const colonIdx   = rawTitle.indexOf(':');
        const displayTitle =
            colonIdx !== -1 && rawTitle.substring(0, colonIdx).trim() === tcId
                ? rawTitle.substring(colonIdx + 1).trim()
                : rawTitle;

        const rawProject = test.parent.project()?.name?.toLowerCase() ?? 'unknown';
        let browserKey: BrowserKey = 'chromium';
        if (rawProject.includes('firefox'))                                       browserKey = 'firefox';
        else if (rawProject.includes('webkit') || rawProject.includes('safari')) browserKey = 'webkit';

        const isBrowserMismatch = test.annotations.some(a => a.type === 'BrowserMismatch');

        if (!this.uiResults.has(rowKey)) {
            this.uiResults.set(rowKey, {
                kind:          'ui',
                title:         displayTitle,
                tcId,
                priority:      getMeta('Priority'),
                testType:      getMeta('TestType'),
                environment:   getMeta('Environment'),
                userRole:      getMeta('UserRole'),
                tags:          getMeta('Tags'),
                browsers:      { chromium: '-', firefox: '-', webkit: '-' },
                duration:      { chromium: 0,   firefox: 0,   webkit: 0   },
                errorSummary:  '',
                errorExpected: '',
                errorReceived: '',
                isFlaky:       false,
                screenshotPath: '',
                failedSteps:    [],
            });
        }

        const entry         = this.uiResults.get(rowKey)!;
        const isWorkerError = (result.error?.message ?? '').includes('found in the worker process');

        // Strip ANSI terminal colour codes
        const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

        // Parse Playwright error into three structured fields
        const parseError = (msg: string): { summary: string; expected: string; received: string } => {
            const text  = stripAnsi(msg);
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            const first = lines[0] ?? 'Test failed';

            // Shorten verbose expect() to readable assertion name
            const summary = first
                .replace(/Error: expect\([^)]+\)\.(\w+)\([^)]*\) failed/, 'expect.$1() failed')
                .replace(/Error: expect\([^)]+\)\.(\w+)\([^)]*\)/,        'expect.$1() failed')
                .replace(/Error: page\.(\w+):.+?(\d+ms).*/,               'page.$1() timed out after $2')
                .replace(/^Error: /,                                        '');

            // Extract Expected / Received values — strip label prefix and surrounding quotes
            const expLine = lines.find(l => /^Expected/.test(l));
            const recLine = lines.find(l => /^Received/.test(l));
            const stripQuotes = (s: string) => s.replace(/^["']|["']$/g, '').trim();
            const expected = expLine ? stripQuotes(expLine.replace(/^Expected\s*[:\w]*\s*:?\s*/, '').trim()) : '';
            const received = recLine ? stripQuotes(recLine.replace(/^Received\s*[:\w]*\s*:?\s*/, '').trim()) : '';

            return { summary, expected, received };
        };

        if (isBrowserMismatch || isWorkerError || result.status === 'skipped') {
            entry.browsers[browserKey] = isBrowserMismatch ? '-' : 'skipped';
        } else {
            entry.browsers[browserKey] = result.status as BrowserStatus;
            if (result.duration > 0) entry.duration[browserKey] = result.duration;
            if (result.status === 'failed' && !entry.errorSummary) {
                const parsed = parseError(result.error?.message ?? 'Test failed');
                entry.errorSummary  = parsed.summary;
                entry.errorExpected = parsed.expected;
                entry.errorReceived = parsed.received;

                // ── Screenshot: grab first screenshot attachment ──────────────
                if (!entry.screenshotPath) {
                    const shot = result.attachments.find(
                        a => a.name === 'screenshot' && a.path && a.contentType === 'image/png'
                    );
                    // Store src path AND browser key so onEnd can build a unique dest filename
                    if (shot?.path) entry.screenshotPath = shot.path + '|' + browserKey;
                }

                // ── Failed steps: walk result.steps recursively ───────────────
                if (entry.failedSteps.length === 0) {
                    const collectFailed = (steps: typeof result.steps): void => {
                        for (const step of steps) {
                            if (step.error) {
                                const stripped = stripAnsi(step.error.message ?? '');
                                // Shorten absolute file path to project-relative breadcrumb
                                // e.g. /Users/x/LearnPlaywright/tests/ui/login.test.ts:42 → tests › ui › login.test.ts : 42
                                const loc      = step.error.location;
                                let filePath   = '';
                                let lineNum    = 0;
                                if (loc?.file) {
                                    const cwd      = process.cwd().replace(/\\/g, '/');
                                    const absFile  = loc.file.replace(/\\/g, '/');
                                    const rel      = absFile.startsWith(cwd)
                                        ? absFile.slice(cwd.length).replace(/^\//, '')
                                        : absFile;
                                    filePath = rel;
                                    lineNum  = loc.line ?? 0;
                                }
                                entry.failedSteps.push({
                                    title:    step.title,
                                    error:    stripped.split('\n')[0] ?? stripped,
                                    file:     filePath,
                                    line:     lineNum,
                                });
                            }
                            if (step.steps?.length) collectFailed(step.steps);
                        }
                    };
                    collectFailed(result.steps);
                }
            }
        }
        if (test.outcome() === 'flaky') entry.isFlaky = true;
    }

    // ── Record API test ───────────────────────────────────────────────────────

    private recordApi(test: TestCase, result: TestResult): void {
        // Title format: "FLOW-01: Description @tag1 @tag2"
        const rawTitle = test.title;
        const colonIdx = rawTitle.indexOf(':');
        const flowId   = colonIdx !== -1 ? rawTitle.substring(0, colonIdx).trim() : rawTitle;
        const rest     = colonIdx !== -1 ? rawTitle.substring(colonIdx + 1).trim() : rawTitle;

        // Separate tags from description
        const tagMatch   = rest.match(/(@\S+\s*)+$/);
        const tags       = tagMatch ? tagMatch[0].trim() : '';
        const title      = tagMatch ? rest.substring(0, rest.length - tags.length).trim() : rest;

        // Extract priority from tags if present (e.g. @P1)
        const prioMatch  = tags.match(/@(P[0-3])/i);
        const priority   = prioMatch ? prioMatch[1].toUpperCase() : 'N/A';

        // Test type from annotation (e.g. @type.description = "REST")
        const getMeta    = (type: string) => test.annotations.find(a => a.type === type)?.description ?? 'N/A';
        const testType   = getMeta('TestType') !== 'N/A' ? getMeta('TestType') : 'API';

        // Parse assertion counts from stdout: "[apiTest:assertions] FLOW-01 7/8"
        let assertionsPassed = 0;
        let assertionsTotal  = 0;
        for (const chunk of result.stdout) {
            const text  = typeof chunk === 'string' ? chunk : chunk.toString();
            const match = text.match(/\[apiTest:assertions\]\s+\S+\s+(\d+)\/(\d+)/);
            if (match) {
                assertionsPassed = parseInt(match[1], 10);
                assertionsTotal  = parseInt(match[2], 10);
                break;
            }
        }

        let status: 'passed' | 'failed' | 'skipped' = 'passed';
        if      (result.status === 'failed')  status = 'failed';
        else if (result.status === 'skipped') status = 'skipped';

        const existing = this.apiResults.get(flowId);

        // Build a meaningful error summary from the structured failure message.
        // apiRunner.test.ts throws with format:
        //   Flow "POSTS-02" failed:\n  ✕ [POSTS-02-S2] ...\n    ✗ status == 200\n      expected 200...
        // We extract: first failed step ID + first failed rule + overflow count
        const buildErrorSummary = (msg: string): string => {
            const lines     = msg.split('\n').map(l => l.trim()).filter(Boolean);
            const stepLine  = lines.find(l => l.startsWith('✕'));
            const stepId    = stepLine ? stepLine.match(/\[([^\]]+)\]/)?.[1] ?? '' : '';
            const ruleLines = lines.filter(l => l.startsWith('✗'));
            if (!ruleLines.length) return lines[0] ?? 'Flow failed';
            const first     = ruleLines[0].replace(/^✗\s*/, '');
            // Extract actual value from message line that follows the rule
            const ruleIdx   = lines.indexOf('✗ ' + ruleLines[0].replace(/^✗\s*/, ''));
            const msgLine   = lines[ruleIdx + 1] ?? '';
            const actual    = msgLine.match(/actual[:\s]+(.+)/i)?.[1]
                           ?? msgLine.match(/got[:\s]+(.+)/i)?.[1]
                           ?? '';
            const extra     = ruleLines.length > 1 ? ` (+${ruleLines.length - 1} more)` : '';
            const arrow     = actual ? ` → got ${actual}` : '';
            return stepId ? `${stepId}: ${first}${arrow}${extra}` : `${first}${arrow}${extra}`;
        };

        if (!existing) {
            this.apiResults.set(flowId, {
                kind:             'api',
                title,
                flowId,
                testType,
                tags,
                priority,
                status,
                error:    result.status === 'failed'
                              ? buildErrorSummary(result.error?.message ?? 'Flow failed')
                              : '',
                duration:         result.duration,
                isFlaky:          test.outcome() === 'flaky',
                assertionsPassed,
                assertionsTotal,
            });
        } else {
            // Worst status wins
            if (status === 'failed') existing.status = 'failed';
            if (result.status === 'failed' && !existing.error) {
                existing.error = buildErrorSummary(result.error?.message ?? 'Flow failed');
            }
            if (test.outcome() === 'flaky') existing.isFlaky = true;
            // Accumulate assertion counts if re-run
            if (assertionsTotal > 0) {
                existing.assertionsPassed = assertionsPassed;
                existing.assertionsTotal  = assertionsTotal;
            }
        }
    }

    // ── onEnd ─────────────────────────────────────────────────────────────────

    async onEnd(_result: FullResult): Promise<void> {
        const reportDir = path.join(process.cwd(), 'custom-reports');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        const now     = new Date(this.startTime);
        const pad     = (n: number) => String(n).padStart(2, '0');
        const day     = pad(now.getDate());
        const month   = pad(now.getMonth() + 1);
        const year    = now.getFullYear();
        const hours   = pad(now.getHours());
        const minutes = pad(now.getMinutes());

        const timestamp = `${year}-${month}-${day}-${hours}-${minutes}`;
        const fileName  = `${this.projectName}-${timestamp}.html`;
        const filePath  = path.join(reportDir, fileName);

        // ── Screenshot data folder ────────────────────────────────────────────
        // Mirrors playwright-report/data/ but scoped per run timestamp so
        // multiple runs don't overwrite each other's screenshots.
        // Path is relative to the HTML report file: data/<timestamp>/
        this.screenshotDir = path.join(reportDir, 'data', timestamp);
        if (!fs.existsSync(this.screenshotDir)) {
            fs.mkdirSync(this.screenshotDir, { recursive: true });
        }

        // Copy failure screenshots into the data folder and update entry paths
        for (const entry of this.uiResults.values()) {
            if (entry.screenshotPath) {
                // screenshotPath stored as "absPath|browserKey" to build unique dest name
                const [srcPath, browserKey] = entry.screenshotPath.split('|');
                if (srcPath && fs.existsSync(srcPath)) {
                    // Use tcId + browser as filename to avoid collisions when multiple
                    // tests fail and Playwright gives them all 'test-failed-1.png'
                    const safeName = entry.tcId.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
                    const destName = `${safeName}-${browserKey ?? 'unknown'}.png`;
                    const destPath = path.join(this.screenshotDir, destName);
                    try {
                        fs.copyFileSync(srcPath, destPath);
                        entry.screenshotPath = path.join('data', timestamp, destName);
                    } catch {
                        entry.screenshotPath = '';
                    }
                } else {
                    entry.screenshotPath = '';
                }
            }
        }

        const date     = `${day}/${month}/${year}`;
        const startStr = `${hours}:${minutes}`;
        const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);

        fs.writeFileSync(filePath, this.generateHTML(date, startStr, duration), 'utf-8');
        console.log('\n✨ Custom report: ' + filePath);
    }

    // ── HTML Generation ───────────────────────────────────────────────────────

    private generateHTML(date: string, start: string, duration: string): string {
        const uiTests  = Array.from(this.uiResults.values());
        const apiTests = Array.from(this.apiResults.values());
        const hasUi    = uiTests.length > 0;
        const hasApi   = apiTests.length > 0;

        // UI environment — first non-N/A Environment annotation across UI tests
        const uiEnvName = uiTests.map(t => t.environment).find(e => e && e !== 'N/A') ?? null;

        // ── Overall KPIs ──────────────────────────────────────────────────────
        const allTotal   = uiTests.length + apiTests.length;
        const allPassed  = this.uiPassed(uiTests)  + apiTests.filter(t => t.status === 'passed').length;
        const allFailed  = this.uiFailed(uiTests)  + apiTests.filter(t => t.status === 'failed').length;
        const allSkipped = this.uiSkipped(uiTests) + apiTests.filter(t => t.status === 'skipped').length;
        const allFlaky   = uiTests.filter(t => t.isFlaky).length + apiTests.filter(t => t.isFlaky).length;
        const passRate   = allTotal > 0 ? Math.round((allPassed / allTotal) * 100) : 0;

        // ── UI stats ──────────────────────────────────────────────────────────
        const uiTotal   = uiTests.length;
        const uiPassed  = this.uiPassed(uiTests);
        const uiFailed  = this.uiFailed(uiTests);
        const uiSkipped = this.uiSkipped(uiTests);
        const uiFlaky   = uiTests.filter(t => t.isFlaky).length;
        const uiPassRate = uiTotal > 0 ? Math.round((uiPassed / uiTotal) * 100) : 0;

        const browsers: BrowserKey[] = ['chromium', 'firefox', 'webkit'];
        const bStats: Record<BrowserKey, { passed: number; skipped: number; failed: number }> = {
            chromium: { passed: 0, skipped: 0, failed: 0 },
            firefox:  { passed: 0, skipped: 0, failed: 0 },
            webkit:   { passed: 0, skipped: 0, failed: 0 },
        };
        uiTests.forEach(t => {
            browsers.forEach(b => {
                if (t.browsers[b] === 'passed')  bStats[b].passed++;
                if (t.browsers[b] === 'skipped') bStats[b].skipped++;
                if (t.browsers[b] === 'failed')  bStats[b].failed++;
            });
        });

        // Priority stats — UI
        const uiPriorityStats: Record<string, number> = {};
        uiTests.forEach(t => {
            const p = t.priority !== 'N/A' ? t.priority : 'Unknown';
            uiPriorityStats[p] = (uiPriorityStats[p] ?? 0) + 1;
        });

        // Tag stats — UI
        const uiTagStats: Record<string, number> = {};
        uiTests.forEach(t => {
            if (t.tags && t.tags !== 'N/A') {
                t.tags.split(',').forEach(tag => {
                    const c = tag.trim();
                    if (c) uiTagStats[c] = (uiTagStats[c] ?? 0) + 1;
                });
            }
        });

        // ── API stats ─────────────────────────────────────────────────────────
        const apiTotal   = apiTests.length;
        const apiPassed  = apiTests.filter(t => t.status === 'passed').length;
        const apiFailed  = apiTests.filter(t => t.status === 'failed').length;
        const apiSkipped = apiTests.filter(t => t.status === 'skipped').length;
        const apiFlaky   = apiTests.filter(t => t.isFlaky).length;
        const apiPassRate = apiTotal > 0 ? Math.round((apiPassed / apiTotal) * 100) : 0;

        // Response time buckets
        const rtBuckets = { fast: 0, ok: 0, slow: 0, verySlow: 0 };
        apiTests.forEach(t => {
            if      (t.duration < 200)  rtBuckets.fast++;
            else if (t.duration < 500)  rtBuckets.ok++;
            else if (t.duration < 1000) rtBuckets.slow++;
            else                        rtBuckets.verySlow++;
        });

        // Tag stats — API
        const apiTagStats: Record<string, number> = {};
        apiTests.forEach(t => {
            if (t.tags) {
                t.tags.split(/\s+/).forEach(tag => {
                    const c = tag.trim().replace(/^@/, '');
                    if (c && !c.match(/^P[0-3]$/i)) apiTagStats[c] = (apiTagStats[c] ?? 0) + 1;
                });
            }
        });

        // Priority stats — API
        const apiPriorityStats: Record<string, number> = {};
        apiTests.forEach(t => {
            const p = t.priority !== 'N/A' ? t.priority : 'Unknown';
            apiPriorityStats[p] = (apiPriorityStats[p] ?? 0) + 1;
        });

        // ── Headline ──────────────────────────────────────────────────────────
        let statusText: string, statusClass: string;
        if      (allFailed > 0)  { statusText = allFailed + ' Failed';          statusClass = 'hl-fail'; }
        else if (allSkipped > 0) { statusText = 'Passed with Skips';            statusClass = 'hl-warn'; }
        else                     { statusText = 'All Tests Passed';             statusClass = 'hl-pass'; }

        // ── Chart data ────────────────────────────────────────────────────────
        const priorityOrder = ['P0', 'P1', 'P2', 'P3'];
        const sortPriority  = (stats: Record<string, number>) => {
            return Object.keys(stats).sort((a, b) => {
                const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1; if (bi !== -1) return 1;
                return a.localeCompare(b);
            });
        };

        const uiPKeys = sortPriority(uiPriorityStats);
        const apiPKeys = sortPriority(apiPriorityStats);
        const uiTagEntries  = Object.entries(uiTagStats).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const apiTagEntries = Object.entries(apiTagStats).sort((a, b) => b[1] - a[1]).slice(0, 8);

        const cBPass   = JSON.stringify(browsers.map(b => bStats[b].passed));
        const cBSkip   = JSON.stringify(browsers.map(b => bStats[b].skipped));
        const cBFail   = JSON.stringify(browsers.map(b => bStats[b].failed));
        const cUIPLabels = JSON.stringify(uiPKeys);
        const cUIPData   = JSON.stringify(uiPKeys.map(k => uiPriorityStats[k]));
        const cUITLabels = JSON.stringify(uiTagEntries.map(([k]) => k));
        const cUITData   = JSON.stringify(uiTagEntries.map(([, v]) => v));
        const cAPIPLabels = JSON.stringify(apiPKeys);
        const cAPIPData   = JSON.stringify(apiPKeys.map(k => apiPriorityStats[k]));
        const cAPITLabels = JSON.stringify(apiTagEntries.map(([k]) => k));
        const cAPITData   = JSON.stringify(apiTagEntries.map(([, v]) => v));
        const cRTData    = JSON.stringify([rtBuckets.fast, rtBuckets.ok, rtBuckets.slow, rtBuckets.verySlow]);

        // ── Rows ──────────────────────────────────────────────────────────────
        const uiRows  = uiTests.map(r  => this.buildUiRow(r)).join('');
        const apiRows = apiTests.map(r => this.buildApiRow(r)).join('');

        // ── Defect categories ─────────────────────────────────────────────────
        const defectBuckets: Record<string, number> = {};
        uiTests.forEach(t => {
            if (Object.values(t.browsers).includes('failed')) {
                const cat = classifyDefect(t.errorSummary);
                defectBuckets[cat] = (defectBuckets[cat] ?? 0) + 1;
            }
        });
        apiTests.forEach(t => {
            if (t.status === 'failed') {
                const cat = classifyDefect(t.error);
                defectBuckets[cat] = (defectBuckets[cat] ?? 0) + 1;
            }
        });
        const totalDefects = Object.values(defectBuckets).reduce((s, v) => s + v, 0);

        const catIcon: Record<string, string> = {
            'Assertion Error':   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            'Wrong Status Code': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>',
            'Timeout / Network': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
            'Element Not Found': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
            'Schema Violation':  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
            'Auth Failure':      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
            'Other Failure':     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
            'Unknown':           '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        };

        const defectPanelHtml = totalDefects === 0 ? '' : (() => {
            const sorted = Object.entries(defectBuckets).sort((a, b) => b[1] - a[1]);
            const cards  = sorted.map(([cat, count]) => {
                const pct  = Math.round((count / totalDefects) * 100);
                const icon = catIcon[cat] ?? catIcon['Other Failure'];
                return '<div class="defect-card">'
                    + '<div class="defect-icon">' + icon + '</div>'
                    + '<div class="defect-body">'
                    + '<div class="defect-name">' + h(cat) + '</div>'
                    + '<div class="defect-bar-wrap"><div class="defect-bar" style="width:' + pct + '%"></div></div>'
                    + '</div>'
                    + '<div class="defect-count">' + count + '</div>'
                    + '</div>';
            }).join('');
            return '<div class="defect-panel" style="animation:fadeUp .4s .1s ease both;">'
                + '<div class="defect-panel-header">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
                + '<span>Defect Categories</span>'
                + '<span class="defect-total-badge">' + totalDefects + ' failure' + (totalDefects !== 1 ? 's' : '') + '</span>'
                + '</div>'
                + '<div class="defect-cards">' + cards + '</div>'
                + '</div>';
        })();

        const showBoth = hasUi && hasApi;

        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
            '<title>' + h(this.projectName) + ' \u2014 Test Report</title>',
            '<link rel="preconnect" href="https://fonts.googleapis.com">',
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
            '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
            this.buildCSS(),
            '</head>',
            '<body>',

            // ── Topbar ────────────────────────────────────────────────────────
            '<div class="topbar">',
            '<div class="topbar-inner">',
            '<div class="topbar-brand">',
            '<svg class="topbar-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
            h(this.projectName),
            '</div>',
            '<div class="topbar-meta">',
            '<span><strong>Date</strong> ' + date + '</span>',
            '<span class="sep">\u00b7</span>',
            '<span><strong>Start</strong> ' + start + '</span>',
            '<span class="sep">\u00b7</span>',
            '<span><strong>Duration</strong> ' + duration + 's</span>',
            showBoth ? '<span class="sep">\u00b7</span><span class="layer-pill ui-pill">UI</span><span class="layer-pill api-pill">API</span>' : '',
            hasUi  && !hasApi ? '<span class="sep">\u00b7</span><span class="layer-pill ui-pill">UI only</span>'  : '',
            hasApi && !hasUi  ? '<span class="sep">\u00b7</span><span class="layer-pill api-pill">API only</span>' : '',
            '</div>',
            '</div>',
            '</div>',

            // ── Environment Info Bar — single line, UI + API ──────────────────
            (hasUi && uiEnvName || hasApi && this.envInfo) ? '<div class="env-bar">'
                + '<div class="env-bar-inner">'
                // UI segment
                + (hasUi && uiEnvName
                    ? '<span class="env-layer-badge env-layer-ui">UI</span>'
                    + '<div class="env-item">'
                    + '<svg class="env-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>'
                    + '<span class="env-item-label">Environment</span>'
                    + '<span class="env-item-value env-name-badge">' + h(uiEnvName) + '</span>'
                    + '</div>'
                    : '')
                // Divider between segments
                + (hasUi && uiEnvName && hasApi && this.envInfo ? '<span class="env-divider"></span>' : '')
                // API segment
                + (hasApi && this.envInfo
                    ? '<span class="env-layer-badge env-layer-api">API</span>'
                    + '<div class="env-item">'
                    + '<svg class="env-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>'
                    + '<span class="env-item-label">Environment</span>'
                    + '<span class="env-item-value env-name-badge">' + h(this.envInfo.name) + '</span>'
                    + '</div>'
                    : '')
                + '</div>'
                + '</div>'
            : '',
            '<div class="shell">',

            // Page header
            '<header class="page-header" style="animation:fadeDown .4s ease both;">',
            '<div>',
            '<p class="report-eyebrow">Execution Report</p>',
            '<h1 class="report-title">' + h(this.projectName) + '</h1>',
            '</div>',
            '<div class="status-pill ' + statusClass + '">',
            '<span class="status-dot"></span>',
            statusText,
            '</div>',
            '</header>',

            // Overall KPI row
            '<div class="kpi-row" style="animation:fadeUp .4s .08s ease both;">',
            this.kpi('Total Run', allTotal,   'total', passRate + '% pass rate'),
            this.kpi('Passed',    allPassed,  'pass',  allPassed === allTotal ? 'clean run' : allPassed + ' of ' + allTotal),
            this.kpi('Failed',    allFailed,  'fail',  allFailed > 0 ? 'needs attention' : 'none'),
            this.kpi('Skipped',   allSkipped, 'skip',  'filtered or disabled'),
            this.kpi('Flaky',     allFlaky,   'flaky', allFlaky > 0 ? 'intermittent' : 'stable'),
            '</div>',

            // ── Defect Categories (only when failures exist) ──────────────────
            defectPanelHtml,
            showBoth ? [
                '<div class="tab-bar" style="animation:fadeUp .4s .12s ease both;">',
                '<button class="tab active" data-tab="all"  onclick="switchTab(this)">All Results <span class="tab-count">' + allTotal + '</span></button>',
                '<button class="tab"        data-tab="ui"   onclick="switchTab(this)">',
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
                ' UI Tests <span class="tab-count">' + uiTotal + '</span></button>',
                '<button class="tab"        data-tab="api" onclick="switchTab(this)">',
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>',
                ' API Tests <span class="tab-count">' + apiTotal + '</span></button>',
                '</div>',
            ].join('') : '',

            // ── UI SECTION ────────────────────────────────────────────────────
            hasUi ? [
                '<div class="layer-section" id="section-ui" style="animation:fadeUp .4s .15s ease both;">',

                // UI section heading (only show if both layers present)
                showBoth ? '<div class="layer-heading"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> UI Tests</div>' : '',

                // UI KPI row (only when both layers shown)
                showBoth ? [
                    '<div class="kpi-row kpi-sub-row">',
                    this.kpi('UI Total',   uiTotal,   'total', uiPassRate + '% pass rate'),
                    this.kpi('Passed',     uiPassed,  'pass',  uiPassed + ' of ' + uiTotal),
                    this.kpi('Failed',     uiFailed,  'fail',  uiFailed > 0 ? 'needs attention' : 'none'),
                    this.kpi('Skipped',    uiSkipped, 'skip',  'browser-filtered'),
                    this.kpi('Flaky',      uiFlaky,   'flaky', uiFlaky > 0 ? 'intermittent' : 'stable'),
                    '</div>',
                ].join('') : '',

                // UI Charts
                '<div class="charts-grid">',
                '<div class="chart-card"><p class="chart-label">Pass Rate</p>',
                '<div class="chart-wrap"><canvas id="uiDonut"></canvas>',
                '<div class="donut-center"><div class="donut-val">' + uiPassRate + '%</div><div class="donut-sub">passed</div></div>',
                '</div></div>',
                '<div class="chart-card"><p class="chart-label">Browser Breakdown</p>',
                '<div class="chart-wrap"><canvas id="uiBrowser"></canvas></div></div>',
                '<div class="chart-card"><p class="chart-label">Priority Distribution</p>',
                '<div class="chart-wrap"><canvas id="uiPriority"></canvas></div></div>',
                '<div class="chart-card"><p class="chart-label">Tag Coverage</p>',
                '<div class="chart-wrap"><canvas id="uiTags"></canvas></div></div>',
                '</div>',

                // UI Table
                this.buildTableSection('ui', uiTests.length, uiPassed, uiFailed, uiSkipped, uiFlaky, uiRows, true),
                '</div>',
            ].join('') : '',

            // ── API SECTION ───────────────────────────────────────────────────
            hasApi ? [
                '<div class="layer-section" id="section-api" style="animation:fadeUp .4s .2s ease both;">',

                showBoth ? '<div class="layer-heading api-heading"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg> API Tests</div>' : '',

                showBoth ? [
                    '<div class="kpi-row kpi-sub-row">',
                    this.kpi('API Total',  apiTotal,   'total', apiPassRate + '% pass rate'),
                    this.kpi('Passed',     apiPassed,  'pass',  apiPassed + ' of ' + apiTotal),
                    this.kpi('Failed',     apiFailed,  'fail',  apiFailed > 0 ? 'needs attention' : 'none'),
                    this.kpi('Skipped',    apiSkipped, 'skip',  'disabled flows'),
                    this.kpi('Flaky',      apiFlaky,   'flaky', apiFlaky > 0 ? 'intermittent' : 'stable'),
                    '</div>',
                ].join('') : '',

                // API Charts
                '<div class="charts-grid">',
                '<div class="chart-card"><p class="chart-label">Pass Rate</p>',
                '<div class="chart-wrap"><canvas id="apiDonut"></canvas>',
                '<div class="donut-center"><div class="donut-val">' + apiPassRate + '%</div><div class="donut-sub">passed</div></div>',
                '</div></div>',
                '<div class="chart-card"><p class="chart-label">Response Time</p>',
                '<div class="chart-wrap"><canvas id="apiRT"></canvas></div></div>',
                '<div class="chart-card"><p class="chart-label">Priority Distribution</p>',
                '<div class="chart-wrap"><canvas id="apiPriority"></canvas></div></div>',
                '<div class="chart-card"><p class="chart-label">Tag Coverage</p>',
                '<div class="chart-wrap"><canvas id="apiTags"></canvas></div></div>',
                '</div>',

                // API Table
                this.buildTableSection('api', apiTests.length, apiPassed, apiFailed, apiSkipped, apiFlaky, apiRows, false),
                '</div>',
            ].join('') : '',

            // Footer
            '<footer class="page-footer">',
            '<span>' + h(this.projectName) + ' \u00b7 QA Automation Framework</span>',
            '<span>Generated ' + date + ' at ' + start + '</span>',
            '</footer>',

            '</div>', // .shell

            // ── Scripts ───────────────────────────────────────────────────────
            '<script>',
            'Chart.defaults.font.family="\'Inter\',system-ui,sans-serif";',
            'Chart.defaults.font.size=11;',
            'Chart.defaults.color="#6B7280";',

            // UI charts (only if UI ran)
            hasUi ? [
                'new Chart(document.getElementById("uiDonut"),{type:"doughnut",data:{labels:["Passed","Failed","Skipped"],datasets:[{data:[' + uiPassed + ',' + uiFailed + ',' + uiSkipped + '],backgroundColor:["#16A34A","#DC2626","#2563EB"],borderWidth:2,borderColor:"#fff",hoverOffset:3}]},options:{cutout:"74%",plugins:{legend:{display:false}}}});',
                'new Chart(document.getElementById("uiBrowser"),{type:"bar",data:{labels:["Chromium","Firefox","Webkit"],datasets:[{label:"Passed",data:' + cBPass + ',backgroundColor:"#BBF7D0",borderColor:"#16A34A",borderWidth:1,borderRadius:3,stack:"s"},{label:"Skipped",data:' + cBSkip + ',backgroundColor:"#DBEAFE",borderColor:"#2563EB",borderWidth:1,borderRadius:3,stack:"s"},{label:"Failed",data:' + cBFail + ',backgroundColor:"#FEE2E2",borderColor:"#DC2626",borderWidth:1,borderRadius:3,stack:"s"}]},options:{plugins:{legend:{position:"bottom",labels:{boxWidth:10,padding:10,usePointStyle:true}}},scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true,ticks:{stepSize:1},grid:{color:"#F3F4F6"}}}}});',
                'new Chart(document.getElementById("uiPriority"),{type:"doughnut",data:{labels:' + cUIPLabels + ',datasets:[{data:' + cUIPData + ',backgroundColor:["#FEE2E2","#FEF3C7","#DBEAFE","#F3F4F6","#D1FAE5"],borderColor:["#DC2626","#D97706","#2563EB","#9CA3AF","#16A34A"],borderWidth:1.5,hoverOffset:3}]},options:{cutout:"58%",plugins:{legend:{position:"right",labels:{boxWidth:10,padding:8,usePointStyle:true}}}}});',
                'new Chart(document.getElementById("uiTags"),{type:"bar",data:{labels:' + cUITLabels + ',datasets:[{label:"Tests",data:' + cUITData + ',backgroundColor:"#DBEAFE",borderColor:"#2563EB",borderWidth:1.5,borderRadius:3}]},options:{indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{stepSize:1},grid:{color:"#F3F4F6"}},y:{grid:{display:false}}}}});',
            ].join('') : '',

            // API charts (only if API ran)
            hasApi ? [
                'new Chart(document.getElementById("apiDonut"),{type:"doughnut",data:{labels:["Passed","Failed","Skipped"],datasets:[{data:[' + apiPassed + ',' + apiFailed + ',' + apiSkipped + '],backgroundColor:["#16A34A","#DC2626","#2563EB"],borderWidth:2,borderColor:"#fff",hoverOffset:3}]},options:{cutout:"74%",plugins:{legend:{display:false}}}});',
                'new Chart(document.getElementById("apiRT"),{type:"doughnut",data:{labels:["<200ms","200-500ms","500ms-1s",">1s"],datasets:[{data:' + cRTData + ',backgroundColor:["#D1FAE5","#FEF3C7","#FEE2E2","#DC2626"],borderColor:["#16A34A","#D97706","#F87171","#991B1B"],borderWidth:1.5,hoverOffset:3}]},options:{cutout:"58%",plugins:{legend:{position:"right",labels:{boxWidth:10,padding:8,usePointStyle:true}}}}});',
                'new Chart(document.getElementById("apiPriority"),{type:"doughnut",data:{labels:' + cAPIPLabels + ',datasets:[{data:' + cAPIPData + ',backgroundColor:["#FEE2E2","#FEF3C7","#DBEAFE","#F3F4F6","#D1FAE5"],borderColor:["#DC2626","#D97706","#2563EB","#9CA3AF","#16A34A"],borderWidth:1.5,hoverOffset:3}]},options:{cutout:"58%",plugins:{legend:{position:"right",labels:{boxWidth:10,padding:8,usePointStyle:true}}}}});',
                'new Chart(document.getElementById("apiTags"),{type:"bar",data:{labels:' + cAPITLabels + ',datasets:[{label:"Flows",data:' + cAPITData + ',backgroundColor:"#D1FAE5",borderColor:"#16A34A",borderWidth:1.5,borderRadius:3}]},options:{indexAxis:"y",plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{stepSize:1},grid:{color:"#F3F4F6"}},y:{grid:{display:false}}}}});',
            ].join('') : '',

            // Tab switching
            showBoth ? [
                'function switchTab(btn){',
                'var tab=btn.getAttribute("data-tab");',
                'document.querySelectorAll(".tab").forEach(function(b){b.classList.remove("active");});',
                'btn.classList.add("active");',
                'var uiSec=document.getElementById("section-ui");',
                'var apiSec=document.getElementById("section-api");',
                'if(tab==="all"){if(uiSec)uiSec.style.display="";if(apiSec)apiSec.style.display="";}',
                'else if(tab==="ui"){if(uiSec)uiSec.style.display="";if(apiSec)apiSec.style.display="none";}',
                'else if(tab==="api"){if(uiSec)uiSec.style.display="none";if(apiSec)apiSec.style.display="";}',
                '}',
            ].join('') : 'function switchTab(){}',

            // Filter functions (scoped per table)
            'var _filterUI="all";var _filterAPI="all";',
            'function setFilter(btn,scope){',
            'var f=btn.getAttribute("data-filter");',
            'if(scope==="ui")_filterUI=f; else _filterAPI=f;',
            'document.querySelectorAll(".fbtn-"+scope).forEach(function(b){b.classList.remove("active");});',
            'btn.classList.add("active");applyFilters(scope);}',
            'function applyFilters(scope){',
            'var inputId=scope==="ui"?"searchUI":"searchAPI";',
            'var q=(document.getElementById(inputId)||{value:""}).value.toUpperCase();',
            'var rows=document.querySelectorAll(".row-"+scope);',
            'var visible=0;',
            'var f=scope==="ui"?_filterUI:_filterAPI;',
            'rows.forEach(function(row){',
            'var search=row.getAttribute("data-search").toUpperCase();',
            'var status=row.getAttribute("data-status");',
            'var matchQ=!q||search.indexOf(q)>-1;',
            'var matchS=f==="all"||status===f;',
            'var show=matchQ&&matchS;',
            'row.style.display=show?"":"none";',
            // Sync expand row visibility with parent: hidden when parent hidden,
            // restored to open/closed state when parent shown
            'var expandId=row.getAttribute("data-expand-id");',
            'if(expandId){',
            'var er=document.getElementById(expandId);',
            'if(er){',
            'if(!show){er.style.display="none";}',
            'else{var isOpen=row.classList.contains("row-expanded");er.style.display=isOpen?"table-row":"none";}',
            '}}',
            'if(show)visible++;});',
            'var es=document.getElementById("empty-"+scope);',
            'if(es)es.style.display=visible===0?"flex":"none";}',

            // Expand / collapse detail panel for failed UI rows
            'function toggleExpand(id,row){',
            'var panel=document.getElementById(id);',
            'if(!panel)return;',
            'var open=panel.style.display!=="none"&&panel.style.display!=="";',
            'panel.style.display=open?"none":"table-row";',
            'row.classList.toggle("row-expanded",!open);}',
            '</script>',

            '</body></html>',
        ].join('\n');
    }

    // ── Table section builder ─────────────────────────────────────────────────

    private buildTableSection(
        scope: string,
        total: number,
        passed: number,
        failed: number,
        skipped: number,
        flaky: number,
        rows: string,
        hasUiBrowserCols: boolean,
    ): string {
        const label = scope === 'ui' ? 'UI Test Results' : 'API Flow Results';
        const searchId = scope === 'ui' ? 'searchUI' : 'searchAPI';

        const tableHeader = hasUiBrowserCols ? [
            '<th style="width:24%">Test Case</th>',
            '<th style="width:10%">Type</th>',
            '<th style="width:7%">Priority</th>',
            '<th class="c" style="width:6%">Role</th>',
            '<th class="c" style="width:7%">Chromium</th>',
            '<th class="c" style="width:7%">Firefox</th>',
            '<th class="c" style="width:6%">Webkit</th>',
            '<th class="c" style="width:7%">Status</th>',
            '<th class="c" style="width:7%" title="Maximum duration across all browsers for this test">Duration ⓘ</th>',
            '<th style="width:19%">Error / Expected vs Received</th>',
        ].join('') : [
            '<th style="width:28%">Test Case</th>',
            '<th style="width:9%">Type</th>',
            '<th style="width:8%">Priority</th>',
            '<th class="c" style="width:8%">Duration</th>',
            '<th class="c" style="width:9%">Assertions</th>',
            '<th class="c" style="width:7%">Status</th>',
            '<th style="width:31%">Error</th>',
        ].join('');

        return [
            '<div class="section-header" style="margin-top:24px;">',
            '<div class="section-title-row">',
            '<h2 class="section-title">' + label + '</h2>',
            '<span class="section-count">' + total + ' test' + (total !== 1 ? 's' : '') + '</span>',
            '</div>',
            '<div class="toolbar">',
            '<div class="search-wrap">',
            '<svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            '<input type="text" id="' + searchId + '" class="search-input" placeholder="Search by ID, title, tag\u2026" oninput="applyFilters(\'' + scope + '\')">',
            '</div>',
            '<div class="filter-group">',
            '<button class="fbtn fbtn-' + scope + ' active" data-filter="all"   onclick="setFilter(this,\'' + scope + '\')">All <span class="fbtn-count">' + total   + '</span></button>',
            '<button class="fbtn fbtn-' + scope + ' fbtn-pass" data-filter="pass" onclick="setFilter(this,\'' + scope + '\')">Pass <span class="fbtn-count">' + passed  + '</span></button>',
            '<button class="fbtn fbtn-' + scope + ' fbtn-fail" data-filter="fail" onclick="setFilter(this,\'' + scope + '\')">Fail <span class="fbtn-count">' + failed  + '</span></button>',
            '<button class="fbtn fbtn-' + scope + ' fbtn-skip" data-filter="skip" onclick="setFilter(this,\'' + scope + '\')">Skip <span class="fbtn-count">' + skipped + '</span></button>',
            flaky > 0 ? '<button class="fbtn fbtn-' + scope + ' fbtn-flaky" data-filter="flaky" onclick="setFilter(this,\'' + scope + '\')">\u26a0 Flaky <span class="fbtn-count">' + flaky + '</span></button>' : '',
            '</div>',
            '</div>',
            '</div>',
            '<div class="table-card">',
            '<table><thead><tr>' + tableHeader + '</tr></thead>',
            '<tbody id="tbody-' + scope + '">' + rows + '</tbody>',
            '</table>',
            '<div class="empty-state" id="empty-' + scope + '">',
            '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            '<p>No results match your filter.</p>',
            '</div>',
            '</div>',
        ].join('');
    }

    // ── UI row ────────────────────────────────────────────────────────────────

    private buildUiRow(r: UiTestEntry): string {
        const vals    = Object.values(r.browsers);
        const active  = vals.filter(s => s !== '-');
        const hasFail = active.includes('failed');
        const hasPass = active.includes('passed');

        const flakySearch = r.isFlaky ? ' flaky' : '';
        const flakyBadge  = r.isFlaky ? '<span class="badge badge-flaky">Flaky</span>' : '';
        const tagsSearch  = r.tags !== 'N/A' ? r.tags.replace(/@/g, '').replace(/,/g, ' ') : '';
        const tagPills    = r.tags !== 'N/A'
            ? r.tags.split(',').map(t => { const c = t.trim(); return c ? '<span class="tag">' + h(c) + '</span>' : ''; }).join('')
            : '';

        const prioClass    = 'badge-' + (r.priority ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const browserNames: Record<BrowserKey, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
        const bCells       = (['chromium', 'firefox', 'webkit'] as BrowserKey[])
            .map(b => {
                const s     = r.browsers[b];
                const label = browserNames[b];
                const tip   = s === 'passed'  ? `title="Passed on ${label}"`
                            : s === 'failed'  ? `title="Failed on ${label}"`
                            : s === 'skipped' ? `title="Skipped on ${label}"`
                            : '';
                return '<td class="c">' + this.iconTipped(s, tip) + '</td>';
            }).join('');

        // Which browsers actually ran (not '-')
        const ranBrowsers    = (['chromium', 'firefox', 'webkit'] as BrowserKey[]).filter(b => r.browsers[b] !== '-');
        const failedBrowsers = ranBrowsers.filter(b => r.browsers[b] === 'failed').map(b => browserNames[b]);
        const ranCount       = ranBrowsers.length;

        // Status badge — append scope note when failure is browser-specific
        let statusHtml: string, dataStatus: string;
        if (hasFail) {
            dataStatus  = 'fail';
            const scope = (ranCount === 1 && failedBrowsers.length === 1)
                ? ' <span class="browser-scope">' + failedBrowsers[0] + ' only</span>'
                : failedBrowsers.length < ranCount
                    ? ' <span class="browser-scope">' + failedBrowsers.join(', ') + '</span>'
                    : '';
            statusHtml  = '<span class="st st-fail"><span class="sd"></span>Fail</span>' + scope;
        } else if (hasPass) {
            statusHtml = '<span class="st st-pass"><span class="sd"></span>Pass</span>'; dataStatus = 'pass';
        } else if (active.some(s => s === 'skipped')) {
            statusHtml = '<span class="st st-skip"><span class="sd"></span>Skip</span>'; dataStatus = 'skip';
        } else {
            statusHtml = '<span class="st st-na"><span class="sd"></span>N/A</span>';    dataStatus = 'na';
        }

        // Max duration across browsers that actually ran
        const maxDur = Math.max(
            ...(['chromium', 'firefox', 'webkit'] as BrowserKey[])
                .filter(b => r.duration[b] > 0)
                .map(b => r.duration[b])
        );
        let durClass = 'dur-fast';
        if      (maxDur >= 10000) durClass = 'dur-slow';
        else if (maxDur >= 5000)  durClass = 'dur-ok';
        const durLabel = maxDur > 0
            ? '<span class="mono-label ' + durClass + '">' + (maxDur >= 1000 ? (maxDur / 1000).toFixed(1) + 's' : maxDur + 'ms') + '</span>'
            : '<span class="na-dash">\u2014</span>';

        // Error cell — assertion name + Expected / Received stacked
        let errorHtml = '';
        if (r.errorSummary) {
            errorHtml = '<div class="err-block">';
            errorHtml += '<div class="err-summary">' + h(r.errorSummary) + '</div>';
            if (r.errorExpected || r.errorReceived) {
                errorHtml += '<div class="err-diff">';
                if (r.errorExpected) errorHtml += '<div class="err-row"><span class="err-label exp">Expected</span><span class="err-val exp-val">' + h(r.errorExpected) + '</span></div>';
                if (r.errorReceived) errorHtml += '<div class="err-row"><span class="err-label rec">Received</span><span class="err-val rec-val">' + h(r.errorReceived) + '</span></div>';
                errorHtml += '</div>';
            }
            errorHtml += '</div>';
        }

        const searchStr = [r.tcId, r.title, tagsSearch, r.tags, r.testType, r.priority, r.environment, r.userRole, dataStatus, flakySearch].join(' ');

        const colCount = 10; // total <td> columns in UI table
        const rowId    = 'expand-' + r.tcId.replace(/[^a-z0-9]/gi, '-');
        const isExpandable = hasFail;

        // Main row — clicking anywhere on a failed row toggles the detail panel
        const mainRow = [
            '<tr class="test-row row-ui' + (isExpandable ? ' row-expandable' : '') + '"'
                + ' data-search="' + h(searchStr) + '"'
                + ' data-status="' + dataStatus + '"'
                + (isExpandable ? ' data-expand-id="' + rowId + '"' : '')
                + (isExpandable ? ' onclick="toggleExpand(\'' + rowId + '\',this)"' : '') + '>',
            '<td><div class="tc-id">' + h(r.tcId) + (flakyBadge ? ' ' + flakyBadge : '') + '</div>',
            '<div class="tc-title">' + h(r.title) + '</div>',
            tagPills ? '<div class="tc-tags">' + tagPills + '</div>' : '',
            '</td>',
            '<td><span class="badge badge-type">' + h(r.testType) + '</span></td>',
            '<td><span class="badge ' + prioClass + '">' + h(r.priority) + '</span></td>',
            '<td class="c"><span class="mono-label">' + h(r.userRole) + '</span></td>',
            bCells,
            '<td class="c">' + statusHtml + '</td>',
            '<td class="c">' + durLabel + '</td>',
            '<td>' + errorHtml + (isExpandable ? '<span class="expand-hint">Click row to expand ▾</span>' : '') + '</td>',
            '</tr>',
        ].join('');

        if (!isExpandable) return mainRow;

        // ── Detail panel row ─────────────────────────────────────────────────
        let detailHtml = '<div class="expand-panel">';

        // Failed steps log
        if (r.failedSteps.length > 0) {
            detailHtml += '<div class="expand-section">';
            detailHtml += '<div class="expand-section-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Failed Steps</div>';
            detailHtml += '<div class="expand-steps">';
            for (const step of r.failedSteps) {
                // Build breadcrumb from file path: "tests/ui/login.test.ts" → "tests › ui › login.test.ts"
                const breadcrumb = step.file
                    ? step.file.replace(/\\/g, '/').split('/').join(' › ')
                    : '';
                const lineLabel = step.line ? ' : ' + step.line : '';

                detailHtml += '<div class="expand-step">';
                detailHtml += '<span class="expand-step-icon">✕</span>';
                detailHtml += '<div class="expand-step-body">';
                detailHtml += '<div class="expand-step-title">' + h(step.title) + '</div>';
                if (step.error) detailHtml += '<div class="expand-step-error">' + h(step.error) + '</div>';
                if (breadcrumb) detailHtml += '<div class="expand-step-loc"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="expand-step-loc-path">' + h(breadcrumb) + '</span>' + (lineLabel ? '<span class="expand-step-loc-line">' + h(lineLabel) + '</span>' : '') + '</div>';
                detailHtml += '</div></div>';
            }
            detailHtml += '</div></div>';
        }

        // Screenshot
        if (r.screenshotPath) {
            detailHtml += '<div class="expand-section">';
            detailHtml += '<div class="expand-section-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Screenshot</div>';
            detailHtml += '<div class="expand-screenshot-wrap">';
            detailHtml += '<img class="expand-screenshot" src="' + h(r.screenshotPath) + '" alt="Failure screenshot" onclick="this.classList.toggle(\'zoomed\')" title="Click to zoom">';
            detailHtml += '</div></div>';
        }

        detailHtml += '</div>';

        const detailRow = [
            '<tr class="expand-row" id="' + rowId + '" style="display:none;">',
            '<td colspan="' + colCount + '" class="expand-td">',
            detailHtml,
            '</td></tr>',
        ].join('');

        return mainRow + detailRow;
    }

    // ── API row ───────────────────────────────────────────────────────────────

    private buildApiRow(r: ApiTestEntry): string {
        let statusHtml: string, dataStatus: string;
        if      (r.status === 'failed')  { statusHtml = '<span class="st st-fail"><span class="sd"></span>Fail</span>'; dataStatus = 'fail'; }
        else if (r.status === 'skipped') { statusHtml = '<span class="st st-skip"><span class="sd"></span>Skip</span>'; dataStatus = 'skip'; }
        else                             { statusHtml = '<span class="st st-pass"><span class="sd"></span>Pass</span>'; dataStatus = 'pass'; }

        const flakyBadge = r.isFlaky ? '<span class="badge badge-flaky">Flaky</span>' : '';
        const prioClass  = 'badge-' + (r.priority ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

        // Duration colour
        let durClass = 'dur-fast';
        if      (r.duration >= 1000) durClass = 'dur-slow';
        else if (r.duration >= 500)  durClass = 'dur-ok';

        const durMs = r.duration >= 1000
            ? (r.duration / 1000).toFixed(1) + 's'
            : r.duration + 'ms';

        // Assertion pill
        const assertHtml = r.assertionsTotal > 0
            ? '<span class="assert-pill assert-pill-' + (r.assertionsPassed === r.assertionsTotal ? 'pass' : 'fail') + '">'
              + r.assertionsPassed + ' / ' + r.assertionsTotal + '</span>'
            : '<span class="na-dash">\u2014</span>';

        // Tags — filter out priority tags, render as pills (same as UI)
        const tagPills = r.tags
            ? r.tags.split(/\s+/)
                .filter(t => t.startsWith('@') && !t.match(/@P[0-3]/i))
                .map(t => '<span class="tag">' + h(t) + '</span>').join('')
            : '';

        const searchStr = [r.flowId, r.title, r.tags, r.testType, r.priority, dataStatus, r.isFlaky ? 'flaky' : ''].join(' ');

        return [
            '<tr class="test-row row-api" data-search="' + h(searchStr) + '" data-status="' + dataStatus + '">',
            // Test Case cell — id + title + tags (mirrors UI)
            '<td>',
            '<div class="tc-id">' + h(r.flowId) + (flakyBadge ? ' ' + flakyBadge : '') + '</div>',
            '<div class="tc-title">' + h(r.title) + '</div>',
            tagPills ? '<div class="tc-tags">' + tagPills + '</div>' : '',
            '</td>',
            '<td><span class="badge badge-type">' + h(r.testType) + '</span></td>',
            '<td><span class="badge ' + prioClass + '">' + h(r.priority) + '</span></td>',
            '<td class="c"><span class="mono-label ' + durClass + '">' + durMs + '</span></td>',
            '<td class="c">' + assertHtml + '</td>',
            '<td class="c">' + statusHtml + '</td>',
            '<td>' + (r.error ? '<span class="err-msg" title="' + h(r.error) + '">' + h(r.error) + '</span>' : '') + '</td>',
            '</tr>',
        ].join('');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private uiPassed(tests: UiTestEntry[])  { return tests.filter(t => { const v = Object.values(t.browsers); return v.includes('passed') && !v.includes('failed'); }).length; }
    private uiFailed(tests: UiTestEntry[])  { return tests.filter(t => Object.values(t.browsers).includes('failed')).length; }
    private uiSkipped(tests: UiTestEntry[]) { return tests.filter(t => { const v = Object.values(t.browsers); return v.includes('skipped') && !v.includes('passed') && !v.includes('failed'); }).length; }

    private kpi(label: string, value: number, mod: string, sub: string): string {
        return [
            '<div class="kpi kpi-' + mod + '">',
            '<div class="kpi-icon kpi-icon-' + mod + '">' + this.kpiIcon(mod) + '</div>',
            '<div class="kpi-body">',
            '<div class="kpi-value">' + value + '</div>',
            '<div class="kpi-label">' + label + '</div>',
            '</div>',
            '<div class="kpi-sub">' + sub + '</div>',
            '</div>',
        ].join('');
    }

    private kpiIcon(mod: string): string {
        const icons: Record<string, string> = {
            total: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
            pass:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>',
            fail:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
            skip:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
            flaky: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        };
        return icons[mod] ?? '';
    }

    private icon(status: BrowserStatus): string {
        return this.iconTipped(status, '');
    }

    private iconTipped(status: BrowserStatus, tipAttr: string): string {
        const tip = tipAttr ? ' ' + tipAttr : '';
        switch (status) {
            case 'passed':  return `<span class="br br-pass"${tip}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>`;
            case 'failed':  return `<span class="br br-fail"${tip}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
            case 'skipped': return `<span class="br br-skip"${tip}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></span>`;
            default:        return `<span class="br br-none"${tip}>\u2014</span>`;
        }
    }

    // ── CSS ───────────────────────────────────────────────────────────────────

    private buildCSS(): string {
        return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --white:#FFFFFF;--page-bg:#F4F4F5;--border:#E8E8EE;--border-md:#D8D8E4;
  --ink:#1A1A22;--ink-2:#2D2D3A;--ink-3:#6B6B80;--ink-4:#9999B0;
  --blue:#7B61FF;--blue-lt:#F2EFFF;--blue-bd:#D4CCFF;
  --pass:#30BF6E;--pass-lt:#EDFAF3;--pass-bd:#B3EECF;
  --fail:#E6394B;--fail-lt:#FEF0F1;--fail-bd:#FACCD0;
  --skip:#9747FF;--skip-lt:#F7F0FF;--skip-bd:#DFC2FF;
  --warn:#FF8800;--warn-lt:#FFF4E6;--warn-bd:#FFD199;
  --api:#00B4D8;--api-lt:#E6F9FC;--api-bd:#99E5F2;
  --topbar:#FFFFFF;
  --font-ui:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono','Menlo',monospace;
  --font-head:'Inter',system-ui,sans-serif;
  --r:8px;--r-lg:12px;
  --shadow:0 1px 4px rgba(26,26,34,.06),0 1px 2px rgba(26,26,34,.04);
  --shadow-md:0 4px 16px rgba(26,26,34,.08),0 2px 4px rgba(26,26,34,.04);
}
body{background:var(--page-bg);color:var(--ink-2);font-family:var(--font-ui);font-size:13.5px;line-height:1.5;-webkit-font-smoothing:antialiased;letter-spacing:-.01em;}

/* Topbar */
.topbar{background:var(--topbar);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;box-shadow:0 1px 0 var(--border);}
.topbar-inner{max-width:1440px;margin:0 auto;padding:0 28px;height:46px;display:flex;align-items:center;justify-content:space-between;}
.topbar-brand{display:flex;align-items:center;gap:9px;color:var(--ink);font-size:13px;font-weight:600;}
.topbar-logo{color:var(--blue);}
.topbar-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-4);}
.topbar-meta strong{color:var(--ink-3);font-weight:500;}
.sep{color:var(--border-md);font-size:14px;}
.layer-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;}
.ui-pill{background:var(--blue-lt);color:var(--blue);}
.api-pill{background:var(--api-lt);color:var(--api);}

/* Shell */
.shell{max-width:1440px;margin:0 auto;padding:32px 28px 56px;}

/* Page header */
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:22px;border-bottom:2px solid var(--border);}
.report-eyebrow{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--blue);margin-bottom:5px;}
.report-title{font-family:var(--font-head);font-size:28px;font-weight:700;color:var(--ink);letter-spacing:-.02em;line-height:1.2;}
.status-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;font-size:12.5px;font-weight:600;border:1.5px solid;}
.status-pill .status-dot{width:7px;height:7px;border-radius:50%;animation:pulse 2.4s ease-in-out infinite;}
.hl-pass{background:var(--pass-lt);color:var(--pass);border-color:var(--pass-bd);}
.hl-pass .status-dot{background:var(--pass);}
.hl-fail{background:var(--fail-lt);color:var(--fail);border-color:var(--fail-bd);}
.hl-fail .status-dot{background:var(--fail);}
.hl-warn{background:var(--warn-lt);color:var(--warn);border-color:var(--warn-bd);}
.hl-warn .status-dot{background:var(--warn);}

/* Tab bar */
.tab-bar{display:flex;gap:4px;margin-bottom:24px;border-bottom:2px solid var(--border);padding-bottom:0;}
.tab{display:inline-flex;align-items:center;gap:7px;padding:10px 18px;font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--ink-3);background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;cursor:pointer;transition:all .15s;}
.tab:hover{color:var(--ink-2);}
.tab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:600;}
.tab-count{display:inline-flex;align-items:center;justify-content:center;background:#F1F5F9;border-radius:999px;min-width:20px;height:20px;padding:0 6px;font-size:11px;font-weight:700;color:var(--ink-3);}
.tab.active .tab-count{background:var(--blue);color:#fff;}

/* Layer section */
.layer-section{margin-bottom:40px;}
.layer-heading{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;padding:8px 14px;background:var(--blue-lt);border:1px solid var(--blue-bd);border-radius:var(--r);border-left:3px solid var(--blue);}
.api-heading{color:var(--api);background:var(--api-lt);border-color:var(--api-bd);border-left-color:var(--api);}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px;}
.kpi-sub-row{margin-bottom:20px;}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px 18px 14px;display:grid;grid-template-columns:44px 1fr;grid-template-rows:auto auto;gap:0 14px;align-items:center;box-shadow:var(--shadow);transition:box-shadow .2s,transform .2s;position:relative;overflow:hidden;}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--r-lg) var(--r-lg) 0 0;}
.kpi-total::before{background:var(--ink);}
.kpi-pass::before{background:var(--pass);}
.kpi-fail::before{background:var(--fail);}
.kpi-skip::before{background:var(--skip);}
.kpi-flaky::before{background:var(--warn);}
.kpi:hover{box-shadow:var(--shadow-md);transform:translateY(-2px);}
.kpi-icon{grid-row:1/3;width:44px;height:44px;border-radius:var(--r);display:flex;align-items:center;justify-content:center;}
.kpi-icon-total{background:#F1F5F9;color:var(--ink);}
.kpi-icon-pass{background:var(--pass-lt);color:var(--pass);}
.kpi-icon-fail{background:var(--fail-lt);color:var(--fail);}
.kpi-icon-skip{background:var(--skip-lt);color:var(--skip);}
.kpi-icon-flaky{background:var(--warn-lt);color:var(--warn);}
.kpi-body{align-self:end;}
.kpi-value{font-family:var(--font-head);font-size:32px;font-weight:700;line-height:1;letter-spacing:-.03em;}
.kpi-total .kpi-value{color:var(--ink);}
.kpi-pass  .kpi-value{color:var(--pass);}
.kpi-fail  .kpi-value{color:var(--fail);}
.kpi-skip  .kpi-value{color:var(--skip);}
.kpi-flaky .kpi-value{color:var(--warn);}
.kpi-label{font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.07em;margin-top:3px;}
.kpi-sub{grid-column:2;font-size:11px;color:var(--ink-4);align-self:start;padding-top:2px;}

/* Charts */
.charts-grid{display:grid;grid-template-columns:200px 1fr 1fr 1fr;gap:12px;margin-bottom:24px;}
.chart-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px;box-shadow:var(--shadow);}
.chart-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);margin-bottom:14px;}
.chart-wrap{position:relative;height:148px;display:flex;align-items:center;justify-content:center;}
.donut-center{position:absolute;text-align:center;pointer-events:none;}
.donut-val{font-family:var(--font-head);font-size:24px;font-weight:700;color:var(--pass);line-height:1;}
.donut-sub{font-size:9px;font-weight:700;color:var(--ink-4);text-transform:uppercase;letter-spacing:.1em;margin-top:2px;}

/* Section header */
.section-header{margin-bottom:10px;}
.section-title-row{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;}
.section-title{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-.01em;}
.section-count{font-size:12px;color:var(--ink-4);}

/* Toolbar */
.toolbar{display:flex;align-items:center;gap:10px;}
.search-wrap{flex:1;position:relative;}
.search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--ink-4);pointer-events:none;}
.search-input{width:100%;background:var(--white);border:1px solid var(--border-md);border-radius:var(--r);padding:9px 12px 9px 34px;font-family:var(--font-ui);font-size:13px;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s;}
.search-input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.1);}
.filter-group{display:flex;gap:5px;flex-shrink:0;}
.fbtn{display:inline-flex;align-items:center;gap:6px;background:var(--white);border:1px solid var(--border-md);border-radius:var(--r);padding:7px 12px;font-family:var(--font-ui);font-size:12px;font-weight:500;color:var(--ink-3);cursor:pointer;transition:all .15s;white-space:nowrap;}
.fbtn:hover{background:var(--page-bg);color:var(--ink-2);}
.fbtn.active{background:var(--blue);border-color:var(--blue);color:#fff;}
.fbtn-pass.active{background:var(--pass);border-color:var(--pass);}
.fbtn-fail.active{background:var(--fail);border-color:var(--fail);}
.fbtn-skip.active{background:var(--skip);border-color:var(--skip);}
.fbtn-flaky.active{background:var(--warn);border-color:var(--warn);}
.fbtn-count{display:inline-flex;align-items:center;justify-content:center;background:rgba(0,0,0,.07);border-radius:999px;min-width:18px;height:18px;padding:0 5px;font-size:10px;font-weight:700;}
.fbtn.active .fbtn-count{background:rgba(255,255,255,.25);}

/* Table */
.table-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow);}
table{width:100%;border-collapse:collapse;table-layout:fixed;}
thead tr{border-bottom:1px solid var(--border);}
th{padding:10px 14px;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-4);text-align:left;background:#F8F8FB;}
th.c{text-align:center;}
tbody tr{border-bottom:1px solid var(--border);transition:background .12s;}
tbody tr:last-child{border-bottom:none;}
tbody tr:hover{background:#F8F7FF;}
td{padding:12px 14px;vertical-align:middle;font-size:13px;color:var(--ink-2);}
td.c{text-align:center;}
.tc-id{font-family:var(--font-mono);font-size:12px;font-weight:500;color:var(--ink);display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.tc-title{color:var(--ink-3);font-size:11.5px;margin-top:3px;line-height:1.4;}
.tc-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.tag{font-size:11px;padding:2px 9px;border-radius:999px;background:var(--blue-lt);color:var(--blue);font-weight:500;border:1px solid var(--blue-bd);}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10.5px;font-weight:500;white-space:nowrap;}
.badge-type{background:#F5F5FA;color:#5C5C80;border:1px solid #E4E4F0;}
.badge-flaky{background:var(--warn-lt);color:var(--warn);border:1px solid var(--warn-bd);}
.badge-p0{background:var(--fail-lt);color:var(--fail);border:1px solid var(--fail-bd);}
.badge-p1{background:var(--warn-lt);color:var(--warn);border:1px solid var(--warn-bd);}
.badge-p2{background:var(--blue-lt);color:var(--blue);border:1px solid var(--blue-bd);}
.badge-p3{background:#F5F5FA;color:var(--ink-3);border:1px solid var(--border);}
.badge-na,.badge-unknown{background:#F5F5FA;color:var(--ink-4);border:1px solid var(--border);}
.mono-label{font-family:var(--font-mono);font-size:11px;color:var(--ink-3);}
.dur-fast{color:var(--pass);}
.dur-ok{color:var(--warn);}
.dur-slow{color:var(--fail);}
.assert-pill{display:inline-block;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.assert-pill-pass{background:var(--pass-lt);color:#1A7A42;border:1px solid var(--pass-bd);}
.assert-pill-fail{background:var(--fail-lt);color:var(--fail);border:1px solid var(--fail-bd);}

/* Browser icon */
.br{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:1px solid;}
.br-pass{background:var(--pass-lt);border-color:var(--pass-bd);color:var(--pass);}
.br-fail{background:var(--fail-lt);border-color:var(--fail-bd);color:var(--fail);}
.br-skip{background:var(--skip-lt);border-color:var(--skip-bd);color:var(--skip);}
.br-none{color:var(--ink-4);font-size:13px;border:none;background:none;}
.br[title],.br-pass[title],.br-fail[title],.br-skip[title],.br-none[title]{cursor:help;}
.browser-scope{font-size:9.5px;font-weight:600;color:var(--fail);background:var(--fail-lt);border:1px solid var(--fail-bd);border-radius:4px;padding:1px 5px;white-space:nowrap;vertical-align:middle;margin-left:3px;}

/* Status pill */
.st{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:10.5px;font-weight:600;white-space:nowrap;border:1px solid;}
.sd{width:5px;height:5px;border-radius:50%;flex-shrink:0;}
.st-pass{background:var(--pass-lt);color:#1A7A42;border-color:var(--pass-bd);}
.st-pass .sd{background:var(--pass);}
.st-fail{background:var(--fail-lt);color:var(--fail);border-color:var(--fail-bd);}
.st-fail .sd{background:var(--fail);}
.st-skip{background:var(--skip-lt);color:var(--skip);border-color:var(--skip-bd);}
.st-skip .sd{background:var(--skip);}
.st-na{background:#F5F5FA;color:var(--ink-4);border-color:var(--border);}
.st-na .sd{background:var(--ink-4);}

/* Error & misc */
.err-msg{display:block;font-family:var(--font-mono);font-size:10.5px;color:var(--fail);background:var(--fail-lt);padding:4px 8px;border-radius:6px;border-left:2.5px solid var(--fail);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help;}
.err-block{display:flex;flex-direction:column;gap:4px;}
.err-summary{font-family:var(--font-mono);font-size:10.5px;color:var(--fail);background:var(--fail-lt);padding:3px 7px;border-radius:6px;border-left:2.5px solid var(--fail);line-height:1.5;word-break:break-word;}
.err-diff{display:flex;flex-direction:column;gap:2px;margin-top:1px;}
.err-row{display:flex;align-items:baseline;gap:5px;}
.err-label{font-family:var(--font-mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:4px;white-space:nowrap;flex-shrink:0;}
.err-label.exp{background:var(--pass-lt);color:#1A7A42;}
.err-label.rec{background:var(--fail-lt);color:var(--fail);}
.err-val{font-family:var(--font-mono);font-size:10.5px;word-break:break-all;line-height:1.4;}
.exp-val{color:#1A7A42;}
.rec-val{color:var(--fail);}
th[title]{cursor:help;border-bottom:1px dashed var(--ink-4);}

.na-dash{color:var(--ink-4);}
.empty-state{display:none;flex-direction:column;align-items:center;gap:10px;padding:52px 24px;color:var(--ink-4);font-size:13px;}
.page-footer{margin-top:36px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:11px;color:var(--ink-4);}

/* ── Environment Info Bar ─────────────────────────────────────────────────── */
.env-bar{background:var(--white);border-bottom:1px solid var(--border);}
.env-bar-inner{max-width:1440px;margin:0 auto;padding:0 28px;height:34px;display:flex;align-items:center;gap:10px;}
.env-layer-badge{display:inline-flex;align-items:center;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;flex-shrink:0;}
.env-layer-ui{background:var(--blue-lt);color:var(--blue);border:1px solid var(--blue-bd);}
.env-layer-api{background:var(--api-lt);color:var(--api);border:1px solid var(--api-bd);}
.env-divider{width:1px;height:18px;background:var(--border-md);margin:0 6px;flex-shrink:0;}
.env-item{display:flex;align-items:center;gap:5px;}
.env-item-icon{color:var(--ink-4);flex-shrink:0;}
.env-item-label{font-size:11px;font-weight:500;color:var(--ink-4);}
.env-item-value{font-size:11.5px;font-weight:500;color:var(--ink-2);}
.env-sep{color:var(--border-md);font-size:14px;user-select:none;}
.env-name-badge{display:inline-flex;align-items:center;background:var(--blue-lt);color:var(--blue);border:1px solid var(--blue-bd);border-radius:5px;padding:1px 8px;font-size:11px;font-weight:600;}
.env-url{font-family:var(--font-mono);font-size:11px;color:var(--ink-3);}

/* ── Defect Categories Panel ──────────────────────────────────────────────── */
.defect-panel{background:var(--white);border:1px solid var(--border);border-left:3px solid var(--fail);border-radius:var(--r-lg);padding:14px 18px;margin-bottom:16px;box-shadow:var(--shadow);}
.defect-panel-header{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--ink);margin-bottom:12px;}
.defect-panel-header svg{color:var(--fail);}
.defect-total-badge{margin-left:auto;font-size:11px;font-weight:600;background:var(--fail-lt);color:var(--fail);border:1px solid var(--fail-bd);border-radius:999px;padding:1px 9px;}
.defect-cards{display:flex;flex-direction:column;gap:6px;}
.defect-card{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--r);background:var(--page-bg);border:1px solid var(--border);}
.defect-icon{flex-shrink:0;color:var(--fail);width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:var(--fail-lt);border-radius:5px;border:1px solid var(--fail-bd);}
.defect-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.defect-name{font-size:12px;font-weight:500;color:var(--ink);}
.defect-bar-wrap{height:4px;background:var(--border);border-radius:999px;overflow:hidden;}
.defect-bar{height:4px;background:var(--fail);border-radius:999px;}
.defect-count{font-size:13px;font-weight:700;color:var(--fail);min-width:20px;text-align:right;}

/* Animations */
@keyframes fadeDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
tbody tr{animation:fadeUp .3s ease both;}
tbody tr:nth-child(1){animation-delay:.30s}tbody tr:nth-child(2){animation-delay:.36s}
tbody tr:nth-child(3){animation-delay:.42s}tbody tr:nth-child(4){animation-delay:.48s}
tbody tr:nth-child(n+5){animation-delay:.52s}

/* ── Expandable failure rows ──────────────────────────────────────────────── */
.row-expandable{cursor:pointer;}
.row-expandable:hover td{background:var(--fail-lt) !important;}
.row-expanded td{background:var(--fail-lt) !important;border-bottom:none !important;}
.expand-hint{display:block;font-size:10px;color:var(--ink-4);margin-top:3px;user-select:none;}
.row-expanded .expand-hint{visibility:hidden;}
.expand-row td{padding:0 !important;border-top:none !important;}
.expand-td{padding:0 !important;}
.expand-panel{background:var(--fail-lt);border-bottom:2px solid var(--fail-bd);padding:14px 20px 18px 28px;display:flex;flex-direction:column;gap:16px;}
.expand-section{display:flex;flex-direction:column;gap:8px;}
.expand-section-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--fail);text-transform:uppercase;letter-spacing:.06em;}
.expand-steps{display:flex;flex-direction:column;gap:6px;}
.expand-step{display:flex;align-items:flex-start;gap:8px;background:var(--white);border:1px solid var(--fail-bd);border-radius:var(--r);padding:8px 12px;}
.expand-step-icon{color:var(--fail);font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px;}
.expand-step-body{display:flex;flex-direction:column;gap:3px;min-width:0;}
.expand-step-title{font-size:12px;font-weight:500;color:var(--ink);}
.expand-step-error{font-family:var(--font-mono);font-size:11px;color:var(--fail);word-break:break-word;line-height:1.5;}
.expand-step-loc{display:flex;align-items:center;gap:4px;margin-top:3px;}
.expand-step-loc svg{color:var(--ink-4);flex-shrink:0;}
.expand-step-loc-path{font-family:var(--font-mono);font-size:10.5px;color:var(--ink-3);}
.expand-step-loc-line{font-family:var(--font-mono);font-size:10.5px;color:var(--blue);font-weight:600;}
.expand-screenshot-wrap{display:flex;}
.expand-screenshot{max-width:720px;width:100%;border:1px solid var(--fail-bd);border-radius:var(--r);box-shadow:0 2px 8px rgba(0,0,0,.10);cursor:zoom-in;transition:max-width .2s ease;}
.expand-screenshot.zoomed{max-width:100%;cursor:zoom-out;}
</style>`;
    }
}

export default CustomHTMLReporter;

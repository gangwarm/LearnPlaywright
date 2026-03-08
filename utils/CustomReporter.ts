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
    kind:        'ui';
    title:       string;
    tcId:        string;
    priority:    string;
    testType:    string;
    environment: string;
    userRole:    string;
    tags:        string;
    browsers:    Record<BrowserKey, BrowserStatus>;
    error:       string;
    isFlaky:     boolean;
    trace:       string;
}

interface ApiTestEntry {
    kind:             'api';
    title:            string;
    flowId:           string;
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

class CustomHTMLReporter implements Reporter {
    private uiResults  = new Map<string, UiTestEntry>();
    private apiResults = new Map<string, ApiTestEntry>();
    private startTime  = 0;
    private projectName = 'Project';

    onBegin(config: FullConfig): void {
        this.startTime   = Date.now();
        this.projectName = config.metadata?.projectName ?? 'Project';
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
                kind:        'ui',
                title:       displayTitle,
                tcId,
                priority:    getMeta('Priority'),
                testType:    getMeta('TestType'),
                environment: getMeta('Environment'),
                userRole:    getMeta('UserRole'),
                tags:        getMeta('Tags'),
                browsers:    { chromium: '-', firefox: '-', webkit: '-' },
                error:       '',
                isFlaky:     false,
                trace:       '',
            });
        }

        const entry         = this.uiResults.get(rowKey)!;
        const isWorkerError = (result.error?.message ?? '').includes('found in the worker process');

        if (isBrowserMismatch || isWorkerError || result.status === 'skipped') {
            entry.browsers[browserKey] = isBrowserMismatch ? '-' : 'skipped';
        } else {
            entry.browsers[browserKey] = result.status as BrowserStatus;
            if (result.status === 'failed') {
                if (!entry.error) entry.error = result.error?.message?.split('\n')[0] ?? 'Test failed';
                const tracePath = result.attachments.find(a => a.name === 'trace')?.path;
                if (tracePath) entry.trace = tracePath;
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

        const showBoth = hasUi && hasApi;

        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width,initial-scale=1.0">',
            '<title>' + h(this.projectName) + ' \u2014 Test Report</title>',
            '<link rel="preconnect" href="https://fonts.googleapis.com">',
            '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Playfair+Display:wght@700;900&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">',
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

            // ── Shell ─────────────────────────────────────────────────────────
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

            // ── Tab switcher (only when both layers present) ──────────────────
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
            'Chart.defaults.font.family="\'DM Sans\',system-ui,sans-serif";',
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
            'if(show)visible++;});',
            'var es=document.getElementById("empty-"+scope);',
            'if(es)es.style.display=visible===0?"flex":"none";}',
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
            '<th style="width:27%">Test Case</th>',
            '<th style="width:10%">Type</th>',
            '<th style="width:7%">Priority</th>',
            '<th class="c" style="width:5%">Env</th>',
            '<th class="c" style="width:7%">Role</th>',
            '<th class="c" style="width:7%">Chromium</th>',
            '<th class="c" style="width:7%">Firefox</th>',
            '<th class="c" style="width:6%">Webkit</th>',
            '<th class="c" style="width:8%">Status</th>',
            '<th style="width:11%">Error</th>',
            '<th class="c" style="width:7%">Trace</th>',
        ].join('') : [
            '<th style="width:13%">Flow ID</th>',
            '<th style="width:27%">Description</th>',
            '<th style="width:8%">Priority</th>',
            '<th style="width:10%">Tags</th>',
            '<th class="c" style="width:8%">Duration</th>',
            '<th class="c" style="width:9%">Assertions</th>',
            '<th class="c" style="width:7%">Status</th>',
            '<th style="width:18%">Error</th>',
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

        let statusHtml: string, dataStatus: string;
        if      (hasFail)                          { statusHtml = '<span class="st st-fail"><span class="sd"></span>Fail</span>'; dataStatus = 'fail'; }
        else if (hasPass)                          { statusHtml = '<span class="st st-pass"><span class="sd"></span>Pass</span>'; dataStatus = 'pass'; }
        else if (active.some(s => s === 'skipped')){ statusHtml = '<span class="st st-skip"><span class="sd"></span>Skip</span>'; dataStatus = 'skip'; }
        else                                       { statusHtml = '<span class="st st-na"><span class="sd"></span>N/A</span>';    dataStatus = 'na'; }

        const flakySearch = r.isFlaky ? ' flaky' : '';
        const flakyBadge  = r.isFlaky ? '<span class="badge badge-flaky">Flaky</span>' : '';
        const tagsSearch  = r.tags !== 'N/A' ? r.tags.replace(/@/g, '').replace(/,/g, ' ') : '';
        const tagPills    = r.tags !== 'N/A'
            ? r.tags.split(',').map(t => { const c = t.trim(); return c ? '<span class="tag">' + h(c) + '</span>' : ''; }).join('')
            : '';

        const prioClass = 'badge-' + (r.priority ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const bCells    = (['chromium', 'firefox', 'webkit'] as BrowserKey[])
            .map(b => '<td class="c">' + this.icon(r.browsers[b]) + '</td>').join('');

        const searchStr = [r.tcId, r.title, tagsSearch, r.tags, r.testType, r.priority, r.environment, r.userRole, dataStatus, flakySearch].join(' ');

        return [
            '<tr class="test-row row-ui" data-search="' + h(searchStr) + '" data-status="' + dataStatus + '">',
            '<td><div class="tc-id">' + h(r.tcId) + (flakyBadge ? ' ' + flakyBadge : '') + '</div>',
            '<div class="tc-title">' + h(r.title) + '</div>',
            tagPills ? '<div class="tc-tags">' + tagPills + '</div>' : '',
            '</td>',
            '<td><span class="badge badge-type">' + h(r.testType) + '</span></td>',
            '<td><span class="badge ' + prioClass + '">' + h(r.priority) + '</span></td>',
            '<td class="c"><span class="mono-label">' + h(r.environment) + '</span></td>',
            '<td class="c"><span class="mono-label">' + h(r.userRole) + '</span></td>',
            bCells,
            '<td class="c">' + statusHtml + '</td>',
            '<td>' + (r.error ? '<span class="err-msg">' + h(r.error) + '</span>' : '') + '</td>',
            '<td class="c">' + (r.trace ? '<a href="' + h(r.trace) + '" target="_blank" class="trace-link"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Trace</a>' : '<span class="na-dash">\u2014</span>') + '</td>',
            '</tr>',
        ].join('');
    }

    // ── API row ───────────────────────────────────────────────────────────────

    private buildApiRow(r: ApiTestEntry): string {
        let statusHtml: string, dataStatus: string;
        if      (r.status === 'failed')  { statusHtml = '<span class="st st-fail"><span class="sd"></span>Fail</span>'; dataStatus = 'fail'; }
        else if (r.status === 'skipped') { statusHtml = '<span class="st st-skip"><span class="sd"></span>Skip</span>'; dataStatus = 'skip'; }
        else                             { statusHtml = '<span class="st st-pass"><span class="sd"></span>Pass</span>'; dataStatus = 'pass'; }

        const flakyBadge = r.isFlaky ? '<span class="badge badge-flaky">Flaky</span>' : '';
        const prioClass  = 'badge-' + (r.priority ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

        // Duration color
        let durClass = 'dur-fast';
        if      (r.duration >= 1000) durClass = 'dur-slow';
        else if (r.duration >= 500)  durClass = 'dur-ok';

        // Assertion count pill: "7 / 8" — red if any failed, green if all passed
        const assertHtml = r.assertionsTotal > 0
            ? '<span class="assert-pill assert-pill-' + (r.assertionsPassed === r.assertionsTotal ? 'pass' : 'fail') + '">'
              + r.assertionsPassed + ' / ' + r.assertionsTotal + '</span>'
            : '<span class="na-dash">\u2014</span>';

        const tagPills = r.tags
            ? r.tags.split(/\s+/).filter(t => t.startsWith('@') && !t.match(/@P[0-3]/i))
                .map(t => '<span class="tag">' + h(t) + '</span>').join('')
            : '';

        const searchStr = [r.flowId, r.title, r.tags, r.priority, dataStatus, r.isFlaky ? 'flaky' : ''].join(' ');

        return [
            '<tr class="test-row row-api" data-search="' + h(searchStr) + '" data-status="' + dataStatus + '">',
            '<td><div class="tc-id">' + h(r.flowId) + (flakyBadge ? ' ' + flakyBadge : '') + '</div></td>',
            '<td><div class="tc-title">' + h(r.title) + '</div></td>',
            '<td><span class="badge ' + prioClass + '">' + h(r.priority) + '</span></td>',
            '<td>' + (tagPills || '<span class="na-dash">\u2014</span>') + '</td>',
            '<td class="c"><span class="mono-label ' + durClass + '">' + r.duration + 'ms</span></td>',
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
        switch (status) {
            case 'passed':  return '<span class="br br-pass"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>';
            case 'failed':  return '<span class="br br-fail"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';
            case 'skipped': return '<span class="br br-skip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></span>';
            default:        return '<span class="br br-none">\u2014</span>';
        }
    }

    // ── CSS ───────────────────────────────────────────────────────────────────

    private buildCSS(): string {
        return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --white:#FFFFFF;--page-bg:#F4F6F9;--border:#E5E7EB;--border-md:#D1D5DB;
  --ink:#0F1B35;--ink-2:#1F2937;--ink-3:#6B7280;--ink-4:#9CA3AF;
  --blue:#2563EB;--blue-lt:#EFF6FF;--blue-bd:#BFDBFE;
  --pass:#16A34A;--pass-lt:#F0FDF4;--pass-bd:#BBF7D0;
  --fail:#DC2626;--fail-lt:#FFF5F5;--fail-bd:#FEE2E2;
  --skip:#2563EB;--skip-lt:#EFF6FF;--skip-bd:#BFDBFE;
  --warn:#D97706;--warn-lt:#FFFBEB;--warn-bd:#FDE68A;
  --api:#059669;--api-lt:#ECFDF5;--api-bd:#A7F3D0;
  --topbar:#0F1B35;
  --font-ui:'DM Sans',system-ui,sans-serif;
  --font-mono:'DM Mono','Menlo',monospace;
  --font-head:'Playfair Display',Georgia,serif;
  --r:6px;--r-lg:10px;
  --shadow:0 1px 3px rgba(15,27,53,.07),0 1px 2px rgba(15,27,53,.04);
  --shadow-md:0 4px 12px rgba(15,27,53,.09),0 2px 4px rgba(15,27,53,.05);
}
body{background:var(--page-bg);color:var(--ink-2);font-family:var(--font-ui);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;}

/* Topbar */
.topbar{background:var(--topbar);border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;z-index:100;}
.topbar-inner{max-width:1440px;margin:0 auto;padding:0 28px;height:46px;display:flex;align-items:center;justify-content:space-between;}
.topbar-brand{display:flex;align-items:center;gap:9px;color:#fff;font-size:13px;font-weight:600;}
.topbar-logo{color:#60A5FA;}
.topbar-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:rgba(255,255,255,.4);}
.topbar-meta strong{color:rgba(255,255,255,.65);font-weight:500;}
.sep{color:rgba(255,255,255,.18);font-size:14px;}
.layer-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;}
.ui-pill{background:rgba(37,99,235,.25);color:#93C5FD;}
.api-pill{background:rgba(5,150,105,.25);color:#6EE7B7;}

/* Shell */
.shell{max-width:1440px;margin:0 auto;padding:32px 28px 56px;}

/* Page header */
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding-bottom:22px;border-bottom:2px solid var(--border);}
.report-eyebrow{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);margin-bottom:5px;}
.report-title{font-family:var(--font-head);font-size:32px;font-weight:900;color:var(--ink);letter-spacing:-.02em;line-height:1.1;}
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
.tab.active{color:var(--ink);border-bottom-color:var(--ink);font-weight:600;}
.tab-count{display:inline-flex;align-items:center;justify-content:center;background:#F1F5F9;border-radius:999px;min-width:20px;height:20px;padding:0 6px;font-size:11px;font-weight:700;color:var(--ink-3);}
.tab.active .tab-count{background:var(--ink);color:#fff;}

/* Layer section */
.layer-section{margin-bottom:40px;}
.layer-heading{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;padding:10px 14px;background:var(--blue-lt);border:1px solid var(--blue-bd);border-radius:var(--r);border-left:3px solid var(--blue);}
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
.kpi-value{font-family:var(--font-head);font-size:34px;font-weight:700;line-height:1;letter-spacing:-.02em;}
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
.donut-val{font-family:var(--font-head);font-size:26px;font-weight:700;color:var(--pass);line-height:1;}
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
.fbtn{display:inline-flex;align-items:center;gap:6px;background:var(--white);border:1px solid var(--border-md);border-radius:var(--r);padding:8px 12px;font-family:var(--font-ui);font-size:12px;font-weight:500;color:var(--ink-3);cursor:pointer;transition:all .15s;white-space:nowrap;}
.fbtn:hover{background:var(--page-bg);color:var(--ink-2);}
.fbtn.active{background:var(--ink);border-color:var(--ink);color:#fff;}
.fbtn-pass.active{background:var(--pass);border-color:var(--pass);}
.fbtn-fail.active{background:var(--fail);border-color:var(--fail);}
.fbtn-skip.active{background:var(--skip);border-color:var(--skip);}
.fbtn-flaky.active{background:var(--warn);border-color:var(--warn);}
.fbtn-count{display:inline-flex;align-items:center;justify-content:center;background:rgba(0,0,0,.07);border-radius:999px;min-width:18px;height:18px;padding:0 5px;font-size:10px;font-weight:700;}
.fbtn.active .fbtn-count{background:rgba(255,255,255,.22);}

/* Table */
.table-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow);}
table{width:100%;border-collapse:collapse;table-layout:fixed;}
thead tr{border-bottom:2px solid var(--border);}
th{padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);text-align:left;background:#FAFBFC;}
th.c{text-align:center;}
tbody tr{border-bottom:1px solid var(--border);transition:background .12s;}
tbody tr:last-child{border-bottom:none;}
tbody tr:hover{background:#F8FAFF;}
td{padding:12px 14px;vertical-align:middle;font-size:12.5px;color:var(--ink-2);}
td.c{text-align:center;}
.tc-id{font-family:var(--font-mono);font-size:12px;font-weight:500;color:var(--ink);display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.tc-title{color:var(--ink-3);font-size:11.5px;margin-top:3px;line-height:1.4;}
.tc-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.tag{font-size:10px;padding:2px 9px;border-radius:999px;background:var(--blue-lt);color:var(--blue);font-weight:500;border:1px solid var(--blue-bd);}

/* Badges */
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;}
.badge-type{background:#F1F5F9;color:#475569;border:1px solid #E2E8F0;}
.badge-flaky{background:var(--warn-lt);color:var(--warn);border:1px solid var(--warn-bd);}
.badge-p0{background:var(--fail-lt);color:var(--fail);border:1px solid var(--fail-bd);}
.badge-p1{background:var(--warn-lt);color:var(--warn);border:1px solid var(--warn-bd);}
.badge-p2{background:var(--blue-lt);color:var(--blue);border:1px solid var(--blue-bd);}
.badge-p3{background:#F9FAFB;color:var(--ink-3);border:1px solid var(--border);}
.badge-na,.badge-unknown{background:#F9FAFB;color:var(--ink-4);border:1px solid var(--border);}
.mono-label{font-family:var(--font-mono);font-size:11px;color:var(--ink-3);}
.dur-fast{color:var(--pass);}
.dur-ok{color:var(--warn);}
.dur-slow{color:var(--fail);}
.assert-pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}
.assert-pill-pass{background:#D1FAE5;color:#065F46;}
.assert-pill-fail{background:#FEE2E2;color:#991B1B;}

/* Browser icon */
.br{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:5px;border:1px solid;}
.br-pass{background:var(--pass-lt);border-color:var(--pass-bd);color:var(--pass);}
.br-fail{background:var(--fail-lt);border-color:var(--fail-bd);color:var(--fail);}
.br-skip{background:var(--skip-lt);border-color:var(--skip-bd);color:var(--skip);}
.br-none{color:var(--ink-4);font-size:13px;border:none;background:none;}

/* Status pill */
.st{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;border:1px solid;}
.sd{width:5px;height:5px;border-radius:50%;flex-shrink:0;}
.st-pass{background:var(--pass-lt);color:var(--pass);border-color:var(--pass-bd);}
.st-pass .sd{background:var(--pass);}
.st-fail{background:var(--fail-lt);color:var(--fail);border-color:var(--fail-bd);}
.st-fail .sd{background:var(--fail);}
.st-skip{background:var(--skip-lt);color:var(--skip);border-color:var(--skip-bd);}
.st-skip .sd{background:var(--skip);}
.st-na{background:#F9FAFB;color:var(--ink-4);border-color:var(--border);}
.st-na .sd{background:var(--ink-4);}

/* Error & misc */
.err-msg{display:block;font-family:var(--font-mono);font-size:10.5px;color:var(--fail);background:var(--fail-lt);padding:4px 8px;border-radius:4px;border-left:2.5px solid var(--fail);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help;}
.trace-link{display:inline-flex;align-items:center;gap:4px;color:var(--blue);font-size:11px;font-weight:600;text-decoration:none;}
.trace-link:hover{color:#1D4ED8;text-decoration:underline;}
.na-dash{color:var(--ink-4);}
.empty-state{display:none;flex-direction:column;align-items:center;gap:10px;padding:52px 24px;color:var(--ink-4);font-size:13px;}
.page-footer{margin-top:36px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:11px;color:var(--ink-4);}

/* Animations */
@keyframes fadeDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
tbody tr{animation:fadeUp .3s ease both;}
tbody tr:nth-child(1){animation-delay:.30s}tbody tr:nth-child(2){animation-delay:.36s}
tbody tr:nth-child(3){animation-delay:.42s}tbody tr:nth-child(4){animation-delay:.48s}
tbody tr:nth-child(n+5){animation-delay:.52s}
</style>`;
    }
}

export default CustomHTMLReporter;

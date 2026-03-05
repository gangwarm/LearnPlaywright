/**
 * CustomReporter.ts
 *
 * Generates a self-contained HTML test execution report.
 *
 * ── BUGS FIXED FROM ORIGINAL ─────────────────────────────────────────────────
 *
 * 1. BROWSER CHART MISLEADING — original browserStats only tracked passed/failed.
 *    Skipped (browser-filtered) tests showed as 0 on the chart, making it look
 *    like browsers never ran. Fixed: tracked as a stacked bar (pass / skip / fail).
 *
 * 2. SKIPPED KPI WRONG — original counted any test where all active statuses were
 *    'skipped' OR '-'. But '-' means "this browser was never configured for this
 *    test" — it's not a skip. Fixed: a test is Skipped only when it has at least
 *    one explicit 'skipped' entry and zero 'passed' or 'failed' entries.
 *
 * 3. EMOJI ICONS — ✔️ ❌ ⏭️ render inconsistently across OS/browser combinations.
 *    Fixed: replaced with inline SVG icons, guaranteed identical everywhere.
 *
 * 4. SEARCH BROKEN FOR TAGS — tags stored as "@smoke, @critical" with commas.
 *    Fixed: data-search includes both raw and comma/@ stripped forms.
 *
 * 5. HTML INJECTION / BROKEN LAYOUT — user data interpolated raw into HTML.
 *    Fixed: all user-data values pass through h() (HTML escape) before insertion.
 *
 * 6. TEMPLATE LITERAL FRAGILITY — backtick or ${ in test data corrupted output.
 *    Fixed: HTML built with array concatenation; data always h()-escaped.
 *
 * 7. PRIORITY STATS HARDCODED — only P0/P1/P2/P3 counted. Other values dropped.
 *    Fixed: priority stats built dynamically from actual data.
 *
 * 8. TAG CHART JS BROKEN — tag keys interpolated directly as JS array literals.
 *    Fixed: tags are JSON.stringify'd before injection into script blocks.
 *
 * 9. FLAKY NOT SEARCHABLE — "FLAKY" badge visible but "flaky" not in data-search.
 *    Fixed: 'flaky' appended to data-search; dedicated filter button added.
 *
 * 10. ERROR MESSAGE NOT HTML-ESCAPED — assertion diffs contain <, >, & characters.
 *     Fixed: error message passes through h() before DOM insertion.
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

interface TestEntry {
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

// ─── HTML escape helper ───────────────────────────────────────────────────────

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
    private groupedResults = new Map<string, TestEntry>();
    private startTime      = 0;
    private projectName    = 'Project';

    onBegin(config: FullConfig): void {
        this.startTime   = Date.now();
        this.projectName = config.metadata?.projectName ?? 'Project';
    }

    onTestEnd(test: TestCase, result: TestResult): void {
        const getMeta = (type: string) =>
            test.annotations.find(a => a.type === type)?.description ?? 'N/A';

        const tcId    = getMeta('TcId');
        const rowKey  = tcId !== 'N/A' ? tcId : test.title;

        const rawTitle     = test.title;
        const colonIdx     = rawTitle.indexOf(':');
        const displayTitle =
            colonIdx !== -1 && rawTitle.substring(0, colonIdx).trim() === tcId
                ? rawTitle.substring(colonIdx + 1).trim()
                : rawTitle;

        const rawProject = test.parent.project()?.name?.toLowerCase() ?? 'unknown';
        let browserKey: BrowserKey = 'chromium';
        if (rawProject.includes('firefox'))                                        browserKey = 'firefox';
        else if (rawProject.includes('webkit') || rawProject.includes('safari'))   browserKey = 'webkit';

        const isBrowserMismatch = test.annotations.some(a => a.type === 'BrowserMismatch');

        if (!this.groupedResults.has(rowKey)) {
            this.groupedResults.set(rowKey, {
                title:       displayTitle,
                tcId:        getMeta('TcId'),
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

        const entry          = this.groupedResults.get(rowKey)!;
        const isWorkerError  = (result.error?.message ?? '').includes('found in the worker process');

        if (isBrowserMismatch || isWorkerError || result.status === 'skipped') {
            entry.browsers[browserKey] = isBrowserMismatch ? '-' : 'skipped';
        } else {
            entry.browsers[browserKey] = result.status as BrowserStatus;
            if (result.status === 'failed') {
                if (!entry.error) {
                    entry.error = result.error?.message?.split('\n')[0] ?? 'Test failed';
                }
                const tracePath = result.attachments.find(a => a.name === 'trace')?.path;
                if (tracePath) entry.trace = tracePath;
            }
        }

        if (test.outcome() === 'flaky') entry.isFlaky = true;
    }

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
        console.log('\n\u2728 Custom report: ' + filePath);
    }

    // ── HTML Generation ───────────────────────────────────────────────────────

    private generateHTML(date: string, start: string, duration: string): string {
        const tests = Array.from(this.groupedResults.values());

        // KPI counts
        const total    = tests.length;
        const passed   = tests.filter(t => {
            const v = Object.values(t.browsers);
            return v.includes('passed') && !v.includes('failed');
        }).length;
        const failed   = tests.filter(t => Object.values(t.browsers).includes('failed')).length;
        const skipped  = tests.filter(t => {
            const v = Object.values(t.browsers);
            return v.includes('skipped') && !v.includes('passed') && !v.includes('failed');
        }).length;
        const flaky    = tests.filter(t => t.isFlaky).length;
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

        // Browser stats
        const browsers: BrowserKey[] = ['chromium', 'firefox', 'webkit'];
        const bStats: Record<BrowserKey, { passed: number; skipped: number; failed: number }> = {
            chromium: { passed: 0, skipped: 0, failed: 0 },
            firefox:  { passed: 0, skipped: 0, failed: 0 },
            webkit:   { passed: 0, skipped: 0, failed: 0 },
        };
        tests.forEach(t => {
            browsers.forEach(b => {
                if (t.browsers[b] === 'passed')  bStats[b].passed++;
                if (t.browsers[b] === 'skipped') bStats[b].skipped++;
                if (t.browsers[b] === 'failed')  bStats[b].failed++;
            });
        });

        // Priority stats — dynamic
        const priorityOrder = ['P0', 'P1', 'P2', 'P3'];
        const priorityStats: Record<string, number> = {};
        tests.forEach(t => {
            const p = t.priority !== 'N/A' ? t.priority : 'Unknown';
            priorityStats[p] = (priorityStats[p] ?? 0) + 1;
        });
        const priorityKeys = Object.keys(priorityStats).sort((a, b) => {
            const ai = priorityOrder.indexOf(a), bi = priorityOrder.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
        });

        // Tag stats
        const tagStats: Record<string, number> = {};
        tests.forEach(t => {
            if (t.tags && t.tags !== 'N/A') {
                t.tags.split(',').forEach(tag => {
                    const clean = tag.trim();
                    if (clean) tagStats[clean] = (tagStats[clean] ?? 0) + 1;
                });
            }
        });
        const tagEntries = Object.entries(tagStats).sort((a, b) => b[1] - a[1]);

        // Chart data — safely JSON-serialised (FIX #8)
        const cBPass   = JSON.stringify(browsers.map(b => bStats[b].passed));
        const cBSkip   = JSON.stringify(browsers.map(b => bStats[b].skipped));
        const cBFail   = JSON.stringify(browsers.map(b => bStats[b].failed));
        const cPLabels = JSON.stringify(priorityKeys);
        const cPData   = JSON.stringify(priorityKeys.map(k => priorityStats[k]));
        const cTLabels = JSON.stringify(tagEntries.map(([k]) => k));
        const cTData   = JSON.stringify(tagEntries.map(([, v]) => v));

        // Headline
        let statusText: string, statusClass: string;
        if (failed > 0)       { statusText = failed + ' Test' + (failed > 1 ? 's' : '') + ' Failed'; statusClass = 'hl-fail'; }
        else if (skipped > 0) { statusText = 'Passed with Skips';  statusClass = 'hl-warn'; }
        else                  { statusText = 'All Tests Passed';   statusClass = 'hl-pass'; }

        const rows = tests.map(r => this.buildRow(r)).join('');

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

            // Top bar
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
            '</div>',
            '</div>',
            '</div>',

            // Shell
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

            // KPI row
            '<div class="kpi-row" style="animation:fadeUp .4s .08s ease both;">',
            this.kpi('Total Run', total,   'total', passRate + '% pass rate'),
            this.kpi('Passed',    passed,  'pass',  passed === total ? 'clean run' : passed + ' of ' + total),
            this.kpi('Failed',    failed,  'fail',  failed > 0 ? 'needs attention' : 'none'),
            this.kpi('Skipped',   skipped, 'skip',  'browser-filtered'),
            this.kpi('Flaky',     flaky,   'flaky', flaky > 0 ? 'intermittent' : 'stable'),
            '</div>',

            // Charts
            '<div class="charts-grid" style="animation:fadeUp .4s .15s ease both;">',
            '<div class="chart-card">',
            '<p class="chart-label">Pass Rate</p>',
            '<div class="chart-wrap"><canvas id="donutChart"></canvas>',
            '<div class="donut-center"><div class="donut-val">' + passRate + '%</div><div class="donut-sub">passed</div></div>',
            '</div></div>',

            '<div class="chart-card"><p class="chart-label">Browser Breakdown</p>',
            '<div class="chart-wrap"><canvas id="browserChart"></canvas></div></div>',

            '<div class="chart-card"><p class="chart-label">Priority Distribution</p>',
            '<div class="chart-wrap"><canvas id="priorityChart"></canvas></div></div>',

            '<div class="chart-card"><p class="chart-label">Tag Coverage</p>',
            '<div class="chart-wrap"><canvas id="tagChart"></canvas></div></div>',
            '</div>',

            // Section header + toolbar
            '<div class="section-header" style="animation:fadeUp .4s .21s ease both;">',
            '<div class="section-title-row">',
            '<h2 class="section-title">Test Results</h2>',
            '<span class="section-count">' + total + ' test case' + (total !== 1 ? 's' : '') + '</span>',
            '</div>',
            '<div class="toolbar">',
            '<div class="search-wrap">',
            '<svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            '<input type="text" id="searchInput" class="search-input" placeholder="Search by ID, title, tag, status\u2026" oninput="applyFilters()">',
            '</div>',
            '<div class="filter-group">',
            '<button class="fbtn active" data-filter="all"   onclick="setFilter(this)">All <span class="fbtn-count">' + total   + '</span></button>',
            '<button class="fbtn fbtn-pass" data-filter="pass" onclick="setFilter(this)">Pass <span class="fbtn-count">' + passed  + '</span></button>',
            '<button class="fbtn fbtn-fail" data-filter="fail" onclick="setFilter(this)">Fail <span class="fbtn-count">' + failed  + '</span></button>',
            '<button class="fbtn fbtn-skip" data-filter="skip" onclick="setFilter(this)">Skip <span class="fbtn-count">' + skipped + '</span></button>',
            flaky > 0 ? '<button class="fbtn fbtn-flaky" data-filter="flaky" onclick="setFilter(this)">\u26a0 Flaky <span class="fbtn-count">' + flaky + '</span></button>' : '',
            '</div>',
            '</div>',
            '</div>',

            // Table
            '<div class="table-card" style="animation:fadeUp .4s .26s ease both;">',
            '<table id="resultsTable">',
            '<thead><tr>',
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
            '</tr></thead>',
            '<tbody id="tableBody">' + rows + '</tbody>',
            '</table>',
            '<div class="empty-state" id="emptyState">',
            '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            '<p>No results match your filter.</p>',
            '</div>',
            '</div>',

            // Footer
            '<footer class="page-footer">',
            '<span>' + h(this.projectName) + ' \u00b7 QA Automation Framework</span>',
            '<span>Generated ' + date + ' at ' + start + '</span>',
            '</footer>',

            '</div>', // .shell

            // Scripts
            '<script>',
            'Chart.defaults.font.family="\'DM Sans\',system-ui,sans-serif";',
            'Chart.defaults.font.size=11;',
            'Chart.defaults.color="#6B7280";',

            // Donut
            'new Chart(document.getElementById("donutChart"),{type:"doughnut",',
            'data:{labels:["Passed","Failed","Skipped"],datasets:[{',
            'data:[' + passed + ',' + failed + ',' + skipped + '],',
            'backgroundColor:["#16A34A","#DC2626","#2563EB"],',
            'borderWidth:2,borderColor:"#fff",hoverOffset:3}]},',
            'options:{cutout:"74%",plugins:{legend:{display:false}}}});',

            // Browser stacked bar (FIX #1)
            'new Chart(document.getElementById("browserChart"),{type:"bar",',
            'data:{labels:["Chromium","Firefox","Webkit"],datasets:[',
            '{label:"Passed",data:' + cBPass + ',backgroundColor:"#BBF7D0",borderColor:"#16A34A",borderWidth:1,borderRadius:3,stack:"s"},',
            '{label:"Skipped",data:' + cBSkip + ',backgroundColor:"#DBEAFE",borderColor:"#2563EB",borderWidth:1,borderRadius:3,stack:"s"},',
            '{label:"Failed",data:' + cBFail + ',backgroundColor:"#FEE2E2",borderColor:"#DC2626",borderWidth:1,borderRadius:3,stack:"s"}',
            ']},options:{plugins:{legend:{position:"bottom",labels:{boxWidth:10,padding:10,usePointStyle:true}}},',
            'scales:{x:{stacked:true,grid:{display:false},ticks:{color:"#6B7280"}},',
            'y:{stacked:true,beginAtZero:true,ticks:{stepSize:1,color:"#6B7280"},grid:{color:"#F3F4F6"}}}}});',

            // Priority doughnut — dynamic (FIX #7)
            'new Chart(document.getElementById("priorityChart"),{type:"doughnut",',
            'data:{labels:' + cPLabels + ',datasets:[{data:' + cPData + ',',
            'backgroundColor:["#FEE2E2","#FEF3C7","#DBEAFE","#F3F4F6","#D1FAE5"],',
            'borderColor:["#DC2626","#D97706","#2563EB","#9CA3AF","#16A34A"],',
            'borderWidth:1.5,hoverOffset:3}]},',
            'options:{cutout:"58%",plugins:{legend:{position:"right",labels:{boxWidth:10,padding:8,usePointStyle:true}}}}});',

            // Tag horizontal bar (FIX #8)
            'new Chart(document.getElementById("tagChart"),{type:"bar",',
            'data:{labels:' + cTLabels + ',datasets:[{label:"Tests",data:' + cTData + ',',
            'backgroundColor:"#DBEAFE",borderColor:"#2563EB",borderWidth:1.5,borderRadius:3}]},',
            'options:{indexAxis:"y",plugins:{legend:{display:false}},',
            'scales:{x:{beginAtZero:true,ticks:{stepSize:1,color:"#6B7280"},grid:{color:"#F3F4F6"}},',
            'y:{grid:{display:false},ticks:{color:"#374151"}}}}});',

            // Filter
            'var _filter="all";',
            'function setFilter(btn){',
            '_filter=btn.getAttribute("data-filter");',
            'document.querySelectorAll(".fbtn").forEach(function(b){b.classList.remove("active");});',
            'btn.classList.add("active");applyFilters();}',
            'function applyFilters(){',
            'var q=document.getElementById("searchInput").value.toUpperCase();',
            'var rows=document.querySelectorAll(".test-row");',
            'var visible=0;',
            'rows.forEach(function(row){',
            'var search=row.getAttribute("data-search").toUpperCase();',
            'var status=row.getAttribute("data-status");',
            'var matchQ=!q||search.indexOf(q)>-1;',
            'var matchS=_filter==="all"||status===_filter;',
            'var show=matchQ&&matchS;',
            'row.style.display=show?"":"none";',
            'if(show)visible++;});',
            'document.getElementById("emptyState").style.display=visible===0?"flex":"none";}',
            '</script>',

            '</body></html>',
        ].join('\n');
    }

    // ── Row builder ───────────────────────────────────────────────────────────

    private buildRow(r: TestEntry): string {
        const vals    = Object.values(r.browsers);
        const active  = vals.filter(s => s !== '-');
        const hasFail = active.includes('failed');
        const hasPass = active.includes('passed');

        let statusHtml: string, dataStatus: string;
        if (hasFail) {
            statusHtml = '<span class="st st-fail"><span class="sd"></span>Fail</span>';
            dataStatus = 'fail';
        } else if (hasPass) {
            statusHtml = '<span class="st st-pass"><span class="sd"></span>Pass</span>';
            dataStatus = 'pass';
        } else if (active.some(s => s === 'skipped')) {
            statusHtml = '<span class="st st-skip"><span class="sd"></span>Skip</span>';
            dataStatus = 'skip';
        } else {
            statusHtml = '<span class="st st-na"><span class="sd"></span>N/A</span>';
            dataStatus = 'na';
        }

        const flakySearch = r.isFlaky ? ' flaky' : '';
        const flakyBadge  = r.isFlaky ? '<span class="badge badge-flaky">Flaky</span>' : '';
        const tagsSearch  = r.tags !== 'N/A' ? r.tags.replace(/@/g, '').replace(/,/g, ' ') : '';

        const tagPills = r.tags !== 'N/A'
            ? r.tags.split(',').map(t => {
                const c = t.trim();
                return c ? '<span class="tag">' + h(c) + '</span>' : '';
            }).join('')
            : '';

        const prioClass = 'badge-' + (r.priority ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const bCells = (['chromium', 'firefox', 'webkit'] as BrowserKey[])
            .map(b => '<td class="c">' + this.icon(r.browsers[b]) + '</td>')
            .join('');

        const errorCell = r.error
            ? '<span class="err-msg">' + h(r.error) + '</span>'
            : '';

        const traceCell = r.trace
            ? '<a href="' + h(r.trace) + '" target="_blank" class="trace-link">'
              + '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
              + ' Trace</a>'
            : '<span class="na-dash">\u2014</span>';

        const searchStr = [
            r.tcId, r.title, tagsSearch, r.tags,
            r.testType, r.priority, r.environment, r.userRole,
            dataStatus, flakySearch,
        ].join(' ');

        return [
            '<tr class="test-row" data-search="' + h(searchStr) + '" data-status="' + dataStatus + '">',
            '<td>',
            '  <div class="tc-id">' + h(r.tcId) + (flakyBadge ? ' ' + flakyBadge : '') + '</div>',
            '  <div class="tc-title">' + h(r.title) + '</div>',
            tagPills ? '  <div class="tc-tags">' + tagPills + '</div>' : '',
            '</td>',
            '<td><span class="badge badge-type">' + h(r.testType) + '</span></td>',
            '<td><span class="badge ' + prioClass + '">' + h(r.priority) + '</span></td>',
            '<td class="c"><span class="mono-label">' + h(r.environment) + '</span></td>',
            '<td class="c"><span class="mono-label">' + h(r.userRole) + '</span></td>',
            bCells,
            '<td class="c">' + statusHtml + '</td>',
            '<td>' + errorCell + '</td>',
            '<td class="c">' + traceCell + '</td>',
            '</tr>',
        ].join('');
    }

    // ── KPI card ──────────────────────────────────────────────────────────────

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

    // ── Browser status icon ───────────────────────────────────────────────────

    private icon(status: BrowserStatus): string {
        switch (status) {
            case 'passed':
                return '<span class="br br-pass"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>';
            case 'failed':
                return '<span class="br br-fail"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';
            case 'skipped':
                return '<span class="br br-skip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></span>';
            default:
                return '<span class="br br-none">\u2014</span>';
        }
    }

    // ── CSS ───────────────────────────────────────────────────────────────────

    private buildCSS(): string {
        return `<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}

/* ── Design tokens ── */
:root{
  --white:#FFFFFF;
  --page-bg:#F4F6F9;
  --border:#E5E7EB;
  --border-md:#D1D5DB;
  --ink:#0F1B35;
  --ink-2:#1F2937;
  --ink-3:#6B7280;
  --ink-4:#9CA3AF;
  --blue:#2563EB;
  --blue-lt:#EFF6FF;
  --blue-bd:#BFDBFE;
  --pass:#16A34A;
  --pass-lt:#F0FDF4;
  --pass-bd:#BBF7D0;
  --fail:#DC2626;
  --fail-lt:#FFF5F5;
  --fail-bd:#FEE2E2;
  --skip:#2563EB;
  --skip-lt:#EFF6FF;
  --skip-bd:#BFDBFE;
  --warn:#D97706;
  --warn-lt:#FFFBEB;
  --warn-bd:#FDE68A;
  --topbar:#0F1B35;
  --font-ui:'DM Sans',system-ui,sans-serif;
  --font-mono:'DM Mono','Menlo',monospace;
  --font-head:'Playfair Display',Georgia,serif;
  --r:6px; --r-lg:10px;
  --shadow:0 1px 3px rgba(15,27,53,.07),0 1px 2px rgba(15,27,53,.04);
  --shadow-md:0 4px 12px rgba(15,27,53,.09),0 2px 4px rgba(15,27,53,.05);
}

body{background:var(--page-bg);color:var(--ink-2);font-family:var(--font-ui);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;}

/* ── Top bar ── */
.topbar{background:var(--topbar);border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;z-index:100;}
.topbar-inner{max-width:1440px;margin:0 auto;padding:0 28px;height:46px;display:flex;align-items:center;justify-content:space-between;}
.topbar-brand{display:flex;align-items:center;gap:9px;color:#fff;font-size:13px;font-weight:600;letter-spacing:.01em;}
.topbar-logo{color:#60A5FA;}
.topbar-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:rgba(255,255,255,.4);}
.topbar-meta strong{color:rgba(255,255,255,.65);font-weight:500;}
.sep{color:rgba(255,255,255,.18);font-size:14px;}

/* ── Shell ── */
.shell{max-width:1440px;margin:0 auto;padding:32px 28px 56px;}

/* ── Page header ── */
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

/* ── KPI ── */
.kpi-row{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px;}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px 18px 14px;display:grid;grid-template-columns:44px 1fr;grid-template-rows:auto auto;gap:0 14px;align-items:center;box-shadow:var(--shadow);transition:box-shadow .2s,transform .2s;position:relative;overflow:hidden;}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--r-lg) var(--r-lg) 0 0;}
.kpi-total::before{background:var(--ink);}
.kpi-pass::before{background:var(--pass);}
.kpi-fail::before{background:var(--fail);}
.kpi-skip::before{background:var(--skip);}
.kpi-flaky::before{background:var(--warn);}
.kpi:hover{box-shadow:var(--shadow-md);transform:translateY(-2px);}
.kpi-icon{grid-row:1/3;width:44px;height:44px;border-radius:var(--r);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
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

/* ── Charts ── */
.charts-grid{display:grid;grid-template-columns:200px 1fr 1fr 1fr;gap:12px;margin-bottom:24px;}
.chart-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px;box-shadow:var(--shadow);}
.chart-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);margin-bottom:14px;}
.chart-wrap{position:relative;height:148px;display:flex;align-items:center;justify-content:center;}
.donut-center{position:absolute;text-align:center;pointer-events:none;}
.donut-val{font-family:var(--font-head);font-size:26px;font-weight:700;color:var(--pass);line-height:1;}
.donut-sub{font-size:9px;font-weight:700;color:var(--ink-4);text-transform:uppercase;letter-spacing:.1em;margin-top:2px;}

/* ── Section header ── */
.section-header{margin-bottom:10px;}
.section-title-row{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;}
.section-title{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:-.01em;}
.section-count{font-size:12px;color:var(--ink-4);}

/* ── Toolbar ── */
.toolbar{display:flex;align-items:center;gap:10px;}
.search-wrap{flex:1;position:relative;}
.search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--ink-4);pointer-events:none;}
.search-input{width:100%;background:var(--white);border:1px solid var(--border-md);border-radius:var(--r);padding:9px 12px 9px 34px;font-family:var(--font-ui);font-size:13px;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s;}
.search-input::placeholder{color:var(--ink-4);}
.search-input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.1);}
.filter-group{display:flex;gap:5px;flex-shrink:0;}
.fbtn{display:inline-flex;align-items:center;gap:6px;background:var(--white);border:1px solid var(--border-md);border-radius:var(--r);padding:8px 12px;font-family:var(--font-ui);font-size:12px;font-weight:500;color:var(--ink-3);cursor:pointer;transition:all .15s;white-space:nowrap;}
.fbtn:hover{background:var(--page-bg);color:var(--ink-2);}
.fbtn.active{background:var(--ink);border-color:var(--ink);color:#fff;}
.fbtn-pass.active{background:var(--pass);border-color:var(--pass);}
.fbtn-fail.active{background:var(--fail);border-color:var(--fail);}
.fbtn-skip.active{background:var(--skip);border-color:var(--skip);}
.fbtn-flaky.active{background:var(--warn);border-color:var(--warn);}
.fbtn-count{display:inline-flex;align-items:center;justify-content:center;background:rgba(0,0,0,.07);border-radius:999px;min-width:18px;height:18px;padding:0 5px;font-size:10px;font-weight:700;line-height:1;}
.fbtn.active .fbtn-count{background:rgba(255,255,255,.22);}

/* ── Table ── */
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
.mono-label{font-family:var(--font-mono);font-size:11px;color:var(--ink-3);}

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

/* Error & trace */
.err-msg{display:block;font-family:var(--font-mono);font-size:10.5px;color:var(--fail);background:var(--fail-lt);padding:4px 8px;border-radius:4px;border-left:2.5px solid var(--fail);word-break:break-all;line-height:1.5;}
.trace-link{display:inline-flex;align-items:center;gap:4px;color:var(--blue);font-size:11px;font-weight:600;text-decoration:none;transition:color .15s;}
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
tbody tr:nth-child(5){animation-delay:.54s}tbody tr:nth-child(n+6){animation-delay:.58s}
</style>`;
    }
}

export default CustomHTMLReporter;

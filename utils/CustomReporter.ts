import { Reporter, TestCase, TestResult, FullResult, FullConfig } from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

class CustomHTMLReporter implements Reporter {
    private groupedResults = new Map<string, any>();
    private startTime: number = 0;
    private projectName: string = 'Project';

    onBegin(config: FullConfig) {
        this.startTime = Date.now();
        if (config.metadata?.projectName) {
            this.projectName = config.metadata.projectName;
        }
    }

    onTestEnd(test: TestCase, result: TestResult) {
        const title = test.title;
        const browserName = test.parent.project()?.name || 'unknown';
        const getMeta = (type: string) => test.annotations.find(a => a.type === type)?.description || 'N/A';

        // Extract trace path if exists
        const tracePath = result.attachments.find(a => a.name === 'trace')?.path;

        if (!this.groupedResults.has(title)) {
            this.groupedResults.set(title, {
                title: title,
                tcId: getMeta('TcId'),
                priority: getMeta('Priority'),
                testType: getMeta('TestType'),
                environment: getMeta('Environment'),
                userRole: getMeta('UserRole'),
                tags: getMeta('Tags'),
                browsers: {},
                error: '',
                isFlaky: false,
                trace: ''
            });
        }

        const currentEntry = this.groupedResults.get(title);
        currentEntry.browsers[browserName] = result.status;
        
        // Store trace for failed tests
        if (result.status === 'failed' && tracePath) {
            currentEntry.trace = tracePath;
        }

        if (test.outcome() === 'flaky') {
            currentEntry.isFlaky = true;
        }

        if (!currentEntry.error && result.status === 'failed') {
            currentEntry.error = result.error?.message?.split('\n')[0].replace(/"/g, "'") || 'Failed';
        }
    }

    async onEnd(result: FullResult) {
        const reportDir = path.join(process.cwd(), 'custom-reports');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

        const executionDate = new Date().toLocaleDateString();
        const startTimeStr = new Date(this.startTime).toLocaleTimeString();
        const totalDuration = ((Date.now() - this.startTime) / 1000).toFixed(2);

        const reportTitle = `${this.projectName} - Test Execution Summary`;
        const filePath = path.join(reportDir, `execution-report.html`);
        
        fs.writeFileSync(filePath, this.generateHTML(reportTitle, executionDate, startTimeStr, totalDuration), 'utf-8');
        console.log(`\n✨ Enterprise Report generated: ${filePath}`);
    }

    private generateHTML(reportTitle: string, date: string, start: string, duration: string) {
        const tests = Array.from(this.groupedResults.values());
        
        const total = tests.length;
        const passed = tests.filter(t => Object.values(t.browsers).includes('passed')).length;
        const failed = tests.filter(t => Object.values(t.browsers).includes('failed')).length;
        const skipped = tests.filter(t => Object.values(t.browsers).every(s => s === 'skipped')).length;
        const flaky = tests.filter(t => t.isFlaky).length;

        const rows = tests.map(r => `
            <tr class="test-row" data-search="${r.tcId} ${r.title} ${r.tags} ${r.testType} ${r.priority}">
                <td>
                    <b>${r.tcId}</b>: ${r.title}
                    ${r.isFlaky ? ' <span class="flaky-label">FLAKY</span>' : ''}
                    <br><small class="tags">${r.tags}</small>
                </td>
                <td><span class="badge type-badge">${r.testType}</span></td>
                <td><span class="badge priority-badge">${r.priority}</span></td>
                <td class="center">${r.environment}</td>
                <td class="center">${r.userRole}</td>
                <td class="icon browser-col">${this.getIcon(r.browsers['chromium'])}</td>
                <td class="icon browser-col">${this.getIcon(r.browsers['firefox'])}</td>
                <td class="icon browser-col">${this.getIcon(r.browsers['webkit'])}</td>
                <td class="error">${r.error}</td>
                <td class="center">${r.trace ? `<a href="${r.trace}" target="_blank" class="trace-link">View Trace</a>` : '-'}</td>
            </tr>
        `).join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>${reportTitle}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 30px; background: #f0f2f5; color: #1c1e21; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                h2 { color: #2c3e50; margin: 0; }
                .summary-container { display: grid; grid-template-columns: repeat(5, 1fr); gap: 15px; margin-bottom: 30px; }
                .summary-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); text-align: center; border-top: 4px solid #2c3e50; }
                .summary-card h3 { margin: 0; font-size: 11px; color: #6a737d; text-transform: uppercase; }
                .summary-card p { margin: 10px 0 0; font-size: 24px; font-weight: bold; }
                .pass { color: #28a745; } .fail { color: #d73a49; } .skip { color: #6a737d; } .flaky { color: #f2994a; }
                
                .search-box { width: 100%; padding: 10px; margin-bottom: 20px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
                
                table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; table-layout: fixed; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                th { background: #24292e; color: white; padding: 15px; font-size: 11px; text-transform: uppercase; text-align: left; }
                .center { text-align: center; }
                td { padding: 12px; border-bottom: 1px solid #e1e4e8; font-size: 13px; vertical-align: middle; word-wrap: break-word; }
                .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; text-transform: uppercase; }
                .priority-badge { background: #ffdce0; color: #af2c2c; }
                .type-badge { background: #dbedff; color: #0366d6; }
                .flaky-label { background: #fff5b1; color: #856404; font-size: 9px; padding: 2px 5px; border-radius: 3px; margin-left: 5px; vertical-align: middle; }
                .browser-col { width: 80px; text-align: center; }
                .icon { font-size: 18px; text-align: center; }
                .error { color: #d73a49; font-size: 11px; font-family: monospace; }
                .tags { color: #6a737d; font-style: italic; }
                .trace-link { color: #0366d6; text-decoration: none; font-weight: bold; font-size: 12px; }
                .legend { margin-top: 20px; font-size: 12px; color: #586069; background: white; padding: 10px; border-radius: 8px; }
            </style>
        </head>
        <body>
            <div class="header-flex">
                <h2>${reportTitle}</h2>
                <div style="text-align: right; font-size: 13px; color: #586069;">
                    <b>Date:</b> ${date} | <b>Start:</b> ${start} | <b>Duration:</b> ${duration}s
                </div>
            </div>

            <div class="summary-container">
                <div class="summary-card"><h3>Total Executed</h3><p>${total}</p></div>
                <div class="summary-card"><h3>Passed</h3><p class="pass">${passed}</p></div>
                <div class="summary-card"><h3>Failed</h3><p class="fail">${failed}</p></div>
                <div class="summary-card"><h3>Skipped</h3><p class="skip">${skipped}</p></div>
                <div class="summary-card"><h3>Flaky</h3><p class="flaky">${flaky}</p></div>
            </div>

            <input type="text" id="searchInput" class="search-box" placeholder="Search by Test Type, Priority or Tags..." onkeyup="filterTable()">

            <table id="resultsTable">
                <thead>
                    <tr>
                        <th style="width: 25%">Test Case ID: Test Case Title</th>
                        <th style="width: 8%">Type</th>
                        <th style="width: 7%">Priority</th>
                        <th class="center" style="width: 5%">Env</th>
                        <th class="center" style="width: 7%">Role</th>
                        <th class="center browser-col">Chrome</th>
                        <th class="center browser-col">Firefox</th>
                        <th class="center browser-col">Webkit</th>
                        <th style="width: 15%">Error (First Failure)</th>
                        <th style="width: 8%">Trace</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            
            <div class="legend">
                <strong>Legend:</strong> 
                <span style="color: #28a745;">✔️ Passed</span> | 
                <span style="color: #d73a49;">❌ Failed</span> | 
                <span style="color: #6a737d;">⏭️ Skipped</span> | 
                - Not Scheduled
            </div>

            <script>
                function filterTable() {
                    var input, filter, table, tr, td, i, txtValue;
                    input = document.getElementById("searchInput");
                    filter = input.value.toUpperCase();
                    table = document.getElementById("resultsTable");
                    tr = table.getElementsByClassName("test-row");

                    for (i = 0; i < tr.length; i++) {
                        // Search within data-search attribute for better performance
                        txtValue = tr[i].getAttribute('data-search');
                        if (txtValue.toUpperCase().indexOf(filter) > -1) {
                            tr[i].style.display = "";
                        } else {
                            tr[i].style.display = "none";
                        }
                    }
                }
            </script>
        </body>
        </html>`;
    }

    private getIcon(status: string) {
        if (status === 'passed') return '<span style="color: #28a745;">✔️</span>'; // Green
        if (status === 'failed') return '<span style="color: #d73a49;">❌</span>'; // Red
        if (status === 'skipped') return '<span style="color: #6a737d;">⏭️</span>'; // Gray
        return '-';
    }
}
export default CustomHTMLReporter;
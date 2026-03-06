/**
 * TemplateEngine.ts
 *
 * Merges a JSON skeleton file with data from Excel + runtime sources.
 *
 * PLACEHOLDER RESOLUTION ORDER (highest priority first):
 *  1. ResponseStore  →  {{USER-01-S1.authToken}}  (values from previous steps)
 *  2. Dynamic        →  {{uuid}}, {{timestamp}}, {{randomEmail}}, {{randomInt}}
 *  3. Environment    →  {{env.API_KEY}}, {{env.QA_ADMIN_TOKEN}}
 *  4. Excel data     →  {{username}}, {{email}}, {{role}}  (from APIRequests sheet)
 *
 * If a placeholder is not resolved by any source, the framework throws a clear
 * error identifying exactly which placeholder failed and in which template.
 *
 * SUPPORTS:
 *  - JSON template files (request bodies)
 *  - Inline strings (endpoint URLs, header values)
 *  - Nested objects and arrays in templates
 *  - Boolean and number types preserved ({{notifications}} → true, not "true")
 */

import * as fs   from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ResponseStore } from './ResponseStore';

export class TemplateEngine {
    private dataDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Load a template file and merge it with all data sources.
     * Returns a fully resolved object ready to use as a request body.
     *
     * @param templatePath  Relative path from data/: 'templates/auth/login.json'
     * @param excelData     Key-value pairs from the APIRequests sheet row
     * @param store         ResponseStore for the current flow (inter-step values)
     */
    mergeTemplate(
        templatePath: string,
        excelData: Record<string, string | number | boolean>,
        store: ResponseStore,
    ): unknown {
        const fullPath = path.join(this.dataDir, templatePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(
                `[TemplateEngine] Template file not found: "${fullPath}"\n` +
                `  Check the TemplatePath column in apiRegistry.xlsx for this row.`
            );
        }

        const raw = fs.readFileSync(fullPath, 'utf-8');
        const resolved = this.resolvePlaceholders(raw, excelData, store, templatePath);

        try {
            return JSON.parse(resolved);
        } catch {
            throw new Error(
                `[TemplateEngine] Template "${templatePath}" is not valid JSON after placeholder resolution.\n` +
                `  Resolved content:\n${resolved}\n` +
                `  Tip: Check that boolean/number placeholders are not wrapped in quotes in your template.`
            );
        }
    }

    /**
     * Resolve placeholders in a plain string — used for endpoint URLs, headers.
     *
     * @example
     *   resolveString('/users/{{USER-01-S2.userId}}', data, store, 'endpoint')
     *   → '/users/42'
     */
    resolveString(
        template: string,
        excelData: Record<string, string | number | boolean>,
        store: ResponseStore,
        context = 'string',
    ): string {
        return this.resolvePlaceholders(template, excelData, store, context);
    }

    // ── Resolution engine ─────────────────────────────────────────────────────

    private resolvePlaceholders(
        template: string,
        excelData: Record<string, string | number | boolean>,
        store: ResponseStore,
        context: string,
    ): string {
        const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

        return template.replace(PLACEHOLDER_REGEX, (match, key: string) => {
            const trimmed = key.trim();

            // 1 — ResponseStore: keys containing a dot with a step-like prefix
            //     e.g. {{USER-01-S1.authToken}}, {{step1.userId}}
            if (trimmed.includes('.') && !trimmed.startsWith('env.')) {
                if (store.has(trimmed)) {
                    return String(store.get(trimmed));
                }
                // Try case-insensitive lookup
                const snapshot = store.snapshot();
                const ciKey = Object.keys(snapshot).find(
                    k => k.toLowerCase() === trimmed.toLowerCase()
                );
                if (ciKey) return String(snapshot[ciKey]);

                throw new Error(
                    `[TemplateEngine] Unresolved ResponseStore placeholder: {{${trimmed}}}\n` +
                    `  Context: ${context}\n` +
                    `  Available store keys: ${Object.keys(store.snapshot()).join(', ') || '(empty)'}\n` +
                    `  Tip: Ensure the step that sets ExtractAs="${trimmed.split('.')[1]}" ran successfully ` +
                    `and its DependsOn chain is configured.`
                );
            }

            // 2 — Dynamic runtime values
            const dynamic = this.resolveDynamic(trimmed);
            if (dynamic !== null) return dynamic;

            // 3 — Environment variables: {{env.VAR_NAME}}
            if (trimmed.startsWith('env.')) {
                const envKey = trimmed.slice(4);
                const envVal = process.env[envKey];
                if (envVal !== undefined) return envVal;
                throw new Error(
                    `[TemplateEngine] Unresolved env placeholder: {{${trimmed}}}\n` +
                    `  Context: ${context}\n` +
                    `  Ensure ${envKey} is set in your .env file.`
                );
            }

            // 4 — Excel data from APIRequests sheet
            if (trimmed in excelData) {
                return String(excelData[trimmed]);
            }

            // Nothing resolved — fail loudly
            throw new Error(
                `[TemplateEngine] Unresolved placeholder: {{${trimmed}}}\n` +
                `  Context: ${context}\n` +
                `  Available Excel keys: ${Object.keys(excelData).join(', ') || '(none)'}\n` +
                `  Tip: Add a "${trimmed}" column to the APIRequests sheet for this TestCaseID.`
            );
        });
    }

    private resolveDynamic(key: string): string | null {
        switch (key.toLowerCase()) {
            case 'uuid':
            case 'guid':
                return uuidv4();

            case 'timestamp':
                return Date.now().toString();

            case 'isodate':
            case 'now':
                return new Date().toISOString();

            case 'date':
                return new Date().toISOString().split('T')[0];

            case 'randomemail':
            case 'random_email': {
                const rand = Math.random().toString(36).substring(2, 8);
                return `test_${rand}@qa.example.com`;
            }

            case 'randomint':
            case 'random_int':
                return Math.floor(Math.random() * 100000).toString();

            case 'randomstring':
            case 'random_string':
                return Math.random().toString(36).substring(2, 12);

            default:
                return null;
        }
    }
}

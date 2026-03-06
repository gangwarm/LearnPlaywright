/**
 * RequestBuilder.ts
 *
 * Assembles a fully-resolved ResolvedRequest from:
 *   - An APIRegistry row (step metadata)
 *   - An APIRequests row (Excel placeholder values)
 *   - TemplateEngine (merges skeleton + data)
 *   - AuthManager (builds auth headers)
 *   - ResponseStore (provides inter-step values)
 *   - Environment config (base URL resolution)
 *
 * OUTPUT: A ResolvedRequest ready to hand to HttpClient.
 * Everything is resolved — no placeholders remain.
 */

import * as path from 'path';
import { ApiRegistryRow, ApiRequestRow, ResolvedRequest } from '../../types/ApiTestData';
import { TemplateEngine } from './TemplateEngine';
import { AuthManager }    from './AuthManager';
import { ResponseStore }  from './ResponseStore';

export class RequestBuilder {
    private templateEngine: TemplateEngine;
    private authManager:    AuthManager;
    private dataDir:        string;
    private environments:   Record<string, { baseUrl: string; apiBaseUrl?: string }>;
    private defaultTimeout: number;

    constructor(
        dataDir: string,
        environments: Record<string, { baseUrl: string; apiBaseUrl?: string }>,
        authManager: AuthManager,
        defaultTimeout = 3000,
    ) {
        this.dataDir        = dataDir;
        this.environments   = environments;
        this.authManager    = authManager;
        this.templateEngine = new TemplateEngine(dataDir);
        this.defaultTimeout = defaultTimeout;
    }

    /**
     * Build a fully resolved request from a registry step + its Excel data row.
     */
    build(
        step: ApiRegistryRow,
        requestData: ApiRequestRow,
        store: ResponseStore,
    ): ResolvedRequest {
        const excelData = this.extractExcelData(requestData);

        // ── 1. Resolve endpoint URL ──────────────────────────────────────────
        const baseUrl   = this.resolveBaseUrl(step);
        const endpoint  = this.templateEngine.resolveString(
            step.Endpoint, excelData, store, `Endpoint for ${step.TestCaseID}`
        );
        const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

        // ── 2. Build auth headers ────────────────────────────────────────────
        const authHeaders = this.authManager.buildHeaders(step.AuthType, store, step.TestCaseID);

        // ── 3. Base headers ──────────────────────────────────────────────────
        const contentType = step.ContentType ?? 'application/json';
        const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Accept': 'application/json',
            ...authHeaders,
        };

        // ── 4. Build request body ────────────────────────────────────────────
        let body: unknown;

        if (['POST', 'PUT', 'PATCH'].includes(step.Method)) {
            if (step.TemplatePath) {
                // Template file + Excel data merge
                body = this.templateEngine.mergeTemplate(
                    step.TemplatePath, excelData, store
                );
            } else if (Object.keys(excelData).length > 0) {
                // No template — use Excel data directly as the body
                body = this.resolveBodyFromExcelData(excelData, store, step.TestCaseID);
            }
            // If neither — body is empty (valid for some endpoints)
        }

        // ── 5. GraphQL special handling ──────────────────────────────────────
        if (step.Protocol === 'GraphQL' && body && typeof body === 'object') {
            // GraphQL bodies must have a 'query' field
            // Template should define: { "query": "{{query}}", "variables": { ... } }
            const gqlBody = body as Record<string, unknown>;
            if (!gqlBody.query) {
                throw new Error(
                    `[RequestBuilder] GraphQL step ${step.TestCaseID}: ` +
                    `body must contain a "query" field.\n` +
                    `  Ensure your template file includes: { "query": "{{query}}", ... }`
                );
            }
        }

        return {
            method:     step.Method,
            url,
            headers,
            body,
            retryCount: step.RetryCount  ?? 0,
            retryDelay: step.RetryDelay  ?? 1000,
            stepMeta: {
                TestCaseID:      step.TestCaseID,
                Description:     step.Description,
                MaskFields:      step.MaskFields,
                MaxResponseTime: step.MaxResponseTime ?? this.defaultTimeout,
            },
        };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private resolveBaseUrl(step: ApiRegistryRow): string {
        // Explicit BaseUrl in the registry row always wins (external APIs)
        if (step.BaseUrl) return step.BaseUrl.replace(/\/$/, '');

        const envConfig = this.environments[step.Environment];
        if (!envConfig) {
            throw new Error(
                `[RequestBuilder] Unknown environment "${step.Environment}" for step ${step.TestCaseID}.\n` +
                `  Available environments: ${Object.keys(this.environments).join(', ')}`
            );
        }

        // Prefer apiBaseUrl if defined, fall back to baseUrl
        const base = envConfig.apiBaseUrl ?? envConfig.baseUrl;
        return base.replace(/\/$/, '');
    }

    /**
     * Strip TestCaseID from the request row and return only the placeholder data.
     */
    private extractExcelData(
        row: ApiRequestRow,
    ): Record<string, string | number | boolean> {
        const { TestCaseID: _id, ...data } = row;
        // Filter out empty/undefined values
        return Object.fromEntries(
            Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '')
        ) as Record<string, string | number | boolean>;
    }

    /**
     * When there's no template, use Excel columns directly as the body.
     * Resolve any {{placeholder}} values within the column values themselves.
     */
    private resolveBodyFromExcelData(
        excelData: Record<string, string | number | boolean>,
        store: ResponseStore,
        stepId: string,
    ): Record<string, unknown> {
        const resolved: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(excelData)) {
            if (typeof value === 'string' && value.includes('{{')) {
                resolved[key] = this.templateEngine.resolveString(
                    value, excelData, store, `body.${key} for ${stepId}`
                );
            } else {
                resolved[key] = value;
            }
        }

        return resolved;
    }
}

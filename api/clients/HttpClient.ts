/**
 * HttpClient.ts
 *
 * Sends HTTP requests using Playwright's APIRequestContext.
 *
 * FEATURES:
 *  - REST and GraphQL (same client — GraphQL is just a structured POST)
 *  - Configurable retry with exponential back-off
 *  - Auto back-off on 429 Too Many Requests (reads Retry-After header)
 *  - Sensitive field masking in request/response logs
 *  - Structured logging: full request + response on failure, summary on pass
 *  - Returns normalised ApiResponse including responseTime
 */

import { APIRequestContext } from '@playwright/test';
import { ResolvedRequest, ApiResponse } from '../../types/ApiTestData';

export class HttpClient {
    private context: APIRequestContext;
    private globalMaxResponseTime: number;

    constructor(context: APIRequestContext, globalMaxResponseTime = 3000) {
        this.context               = context;
        this.globalMaxResponseTime = globalMaxResponseTime;
    }

    /**
     * Send a request. Applies retry logic and rate-limit back-off automatically.
     */
    async send(request: ResolvedRequest): Promise<ApiResponse> {
        const maxAttempts = request.retryCount + 1;
        let lastResponse: ApiResponse | undefined;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                lastResponse = await this.sendOnce(request);

                // 429 — rate limited: back off and retry
                if (lastResponse.status === 429) {
                    const retryAfter = this.parseRetryAfter(lastResponse);
                    const wait       = retryAfter ?? Math.min(1000 * attempt, 10000);

                    console.warn(
                        `[HttpClient] 429 Too Many Requests for ${request.url}. ` +
                        `Waiting ${wait}ms before attempt ${attempt + 1}/${maxAttempts}.`
                    );

                    if (attempt < maxAttempts) {
                        await this.sleep(wait);
                        continue;
                    }
                }

                // Non-2xx on last attempt — log full details
                if (!this.isSuccess(lastResponse.status) && attempt === maxAttempts) {
                    this.logFailure(request, lastResponse, attempt, maxAttempts);
                }

                return lastResponse;

            } catch (err) {
                lastError = err as Error;

                if (attempt < maxAttempts) {
                    const delay = request.retryDelay * attempt;
                    console.warn(
                        `[HttpClient] Attempt ${attempt}/${maxAttempts} failed for ${request.url}: ` +
                        `${lastError.message}. Retrying in ${delay}ms...`
                    );
                    await this.sleep(delay);
                } else {
                    this.logNetworkError(request, lastError, attempt);
                    throw lastError;
                }
            }
        }

        // Should not reach here — TypeScript requires it
        throw lastError ?? new Error(`[HttpClient] All ${maxAttempts} attempts failed for ${request.url}`);
    }

    // ── Core request ──────────────────────────────────────────────────────────

    private async sendOnce(request: ResolvedRequest): Promise<ApiResponse> {
        const startTime = Date.now();

        const options: Parameters<APIRequestContext['fetch']>[1] = {
            method:  request.method,
            headers: request.headers,
        };

        // Attach body for mutating methods
        if (request.body !== undefined && ['POST', 'PUT', 'PATCH'].includes(request.method)) {
            options.data = request.body;
        }

        const response     = await this.context.fetch(request.url, options);
        const responseTime = Date.now() - startTime;

        // Parse body — try JSON first, fall back to text
        let body: unknown;
        let rawBody: string;

        try {
            rawBody = await response.text();
            body    = rawBody ? JSON.parse(rawBody) : null;
        } catch {
            body = rawBody!;
        }

        // Normalise headers to plain object
        const headers: Record<string, string> = {};
        response.headers().forEach ? Object.assign(headers, response.headers())
            : Object.assign(headers, response.headers());

        const apiResponse: ApiResponse = {
            status:  response.status(),
            headers,
            body,
            responseTime,
            rawBody: rawBody!,
        };

        // Performance threshold check
        const maxTime = request.stepMeta.MaxResponseTime ?? this.globalMaxResponseTime;
        if (responseTime > maxTime) {
            console.warn(
                `[HttpClient] ⚠ Performance: ${request.stepMeta.TestCaseID} responded in ` +
                `${responseTime}ms — exceeds threshold of ${maxTime}ms.`
            );
        }

        return apiResponse;
    }

    // ── Logging ───────────────────────────────────────────────────────────────

    private logFailure(
        request: ResolvedRequest,
        response: ApiResponse,
        attempt: number,
        maxAttempts: number,
    ): void {
        const maskedBody    = this.maskSensitiveFields(request.body, request.stepMeta.MaskFields);
        const maskedHeaders = this.maskSensitiveHeaders(request.headers);

        console.error(
            `\n[HttpClient] ✕ ${request.stepMeta.TestCaseID} — ${request.method} ${request.url}\n` +
            `  Attempt:         ${attempt}/${maxAttempts}\n` +
            `  Status:          ${response.status}\n` +
            `  Response time:   ${response.responseTime}ms\n` +
            `  Request headers: ${JSON.stringify(maskedHeaders, null, 2)}\n` +
            `  Request body:    ${JSON.stringify(maskedBody, null, 2)}\n` +
            `  Response body:   ${response.rawBody.substring(0, 2000)}\n`
        );
    }

    private logNetworkError(request: ResolvedRequest, error: Error, attempt: number): void {
        console.error(
            `\n[HttpClient] ✕ Network error: ${request.stepMeta.TestCaseID} — ` +
            `${request.method} ${request.url}\n` +
            `  Attempt: ${attempt}\n` +
            `  Error:   ${error.message}\n`
        );
    }

    // ── Sensitive field masking ───────────────────────────────────────────────

    private maskSensitiveFields(body: unknown, maskFields?: string): unknown {
        if (!maskFields || !body || typeof body !== 'object') return body;

        const fields  = maskFields.split(',').map(f => f.trim());
        const masked  = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

        for (const field of fields) {
            const parts = field.split('.');
            this.maskNestedField(masked, parts);
        }

        return masked;
    }

    private maskNestedField(obj: Record<string, unknown>, path: string[]): void {
        if (path.length === 1) {
            if (path[0] in obj) obj[path[0]] = '[MASKED]';
            return;
        }
        const next = obj[path[0]];
        if (next && typeof next === 'object') {
            this.maskNestedField(next as Record<string, unknown>, path.slice(1));
        }
    }

    private maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
        const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie', 'set-cookie'];
        const masked: Record<string, string> = {};

        for (const [key, value] of Object.entries(headers)) {
            masked[key] = sensitiveHeaders.includes(key.toLowerCase())
                ? '[MASKED]'
                : value;
        }

        return masked;
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private parseRetryAfter(response: ApiResponse): number | null {
        const header = response.headers['retry-after'] ?? response.headers['Retry-After'];
        if (!header) return null;

        const seconds = parseInt(header, 10);
        if (!isNaN(seconds)) return seconds * 1000;

        // Could be an HTTP date string
        const date = new Date(header).getTime();
        if (!isNaN(date)) return Math.max(date - Date.now(), 0);

        return null;
    }

    private isSuccess(status: number): boolean {
        return status >= 200 && status < 300;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

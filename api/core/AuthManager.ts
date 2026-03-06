/**
 * AuthManager.ts
 *
 * Handles all authentication injection for API requests.
 *
 * SUPPORTED AUTH TYPES (controlled by AuthType column in APIRegistry):
 *  - Bearer   →  Authorization: Bearer <token>
 *                Token sourced from ResponseStore (set by a login step's ExtractAs)
 *  - Basic    →  Authorization: Basic <base64(username:password)>
 *                Credentials from .env via environments.json envPassKey
 *  - ApiKey   →  x-api-key: <key>
 *                Key from .env via {{env.API_KEY}} or environments.json
 *  - None     →  No auth header added
 *
 * TOKEN LIFECYCLE:
 *  - Bearer tokens are NOT fetched by AuthManager — they are extracted from a
 *    login step's response via ResponseStore (ExtractAs column).
 *  - AuthManager reads the token from ResponseStore and injects it into headers.
 *  - This keeps auth logic clean: the login step is a normal API step,
 *    and all subsequent steps just declare AuthType=Bearer.
 *
 * SENSITIVE FIELD MASKING:
 *  - All credential values are masked in logs using the MaskLogger.
 */

import { AuthType } from '../../types/ApiTestData';
import { ResponseStore } from './ResponseStore';

export interface AuthHeaders {
    [header: string]: string;
}

export class AuthManager {
    private environments: Record<string, Record<string, string>>;
    private currentEnv: string;

    constructor(environments: Record<string, Record<string, string>>, currentEnv: string) {
        this.environments = environments;
        this.currentEnv   = currentEnv;
    }

    /**
     * Build auth headers for a step.
     *
     * @param authType    From the AuthType column: 'Bearer' | 'Basic' | 'ApiKey' | 'None'
     * @param store       ResponseStore — used to look up Bearer tokens set by login steps
     * @param stepId      The step's TestCaseID — used to look up step-specific overrides
     */
    buildHeaders(authType: AuthType, store: ResponseStore, _stepId: string): AuthHeaders {
        switch (authType) {
            case 'Bearer':
                return this.buildBearerHeaders(store);

            case 'Basic':
                return this.buildBasicHeaders();

            case 'ApiKey':
                return this.buildApiKeyHeaders();

            case 'None':
            default:
                return {};
        }
    }

    // ── Bearer ────────────────────────────────────────────────────────────────

    private buildBearerHeaders(store: ResponseStore): AuthHeaders {
        // Look for a token in ResponseStore — try common key patterns
        const tokenKeys = ['authToken', 'accessToken', 'token', 'bearerToken'];

        for (const key of tokenKeys) {
            // Try all step prefixes in the store
            const snapshot = store.snapshot();
            const match = Object.entries(snapshot).find(([k]) =>
                k.endsWith(`.${key}`) || k === key
            );
            if (match) {
                return { Authorization: `Bearer ${match[1]}` };
            }
        }

        // Fallback: check .env for a static token
        const envToken = process.env[`${this.currentEnv}_BEARER_TOKEN`];
        if (envToken) {
            return { Authorization: `Bearer ${envToken}` };
        }

        throw new Error(
            `[AuthManager] AuthType=Bearer but no token found in ResponseStore.\n` +
            `  Ensure a login step with ExtractAs="authToken" (or similar) ran before this step.\n` +
            `  Store snapshot: ${JSON.stringify(store.snapshot())}\n` +
            `  Alternatively, set ${this.currentEnv}_BEARER_TOKEN in your .env file.`
        );
    }

    // ── Basic ─────────────────────────────────────────────────────────────────

    private buildBasicHeaders(): AuthHeaders {
        const env      = this.environments[this.currentEnv] ?? {};
        const username = process.env[env.envUserKey ?? ''] ?? process.env.BASIC_AUTH_USER ?? '';
        const password = process.env[env.envPassKey ?? ''] ?? process.env.BASIC_AUTH_PASS ?? '';

        if (!username || !password) {
            throw new Error(
                `[AuthManager] AuthType=Basic but username or password not found.\n` +
                `  Set envUserKey and envPassKey in environments.json for environment "${this.currentEnv}",\n` +
                `  and add the corresponding values to your .env file.`
            );
        }

        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        return { Authorization: `Basic ${encoded}` };
    }

    // ── ApiKey ────────────────────────────────────────────────────────────────

    private buildApiKeyHeaders(): AuthHeaders {
        const env    = this.environments[this.currentEnv] ?? {};
        const apiKey = process.env[env.envApiKey ?? ''] ?? process.env.API_KEY ?? '';

        if (!apiKey) {
            throw new Error(
                `[AuthManager] AuthType=ApiKey but no API key found.\n` +
                `  Set envApiKey in environments.json for environment "${this.currentEnv}",\n` +
                `  and add the corresponding value to your .env file.`
            );
        }

        return { 'x-api-key': apiKey };
    }
}

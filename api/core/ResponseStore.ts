/**
 * ResponseStore.ts
 *
 * Runtime key-value store that holds extracted values between steps in a flow.
 *
 * HOW IT WORKS:
 *  - Step N specifies  ExtractAs: "authToken"  in the registry
 *  - The framework extracts body.accessToken from the response and stores it as:
 *      store.set('stepN.authToken', value)   where N is the step's TestCaseID
 *  - Step N+1 references  {{stepN.authToken}}  in its template or endpoint URL
 *  - TemplateEngine resolves the placeholder by calling store.get('stepN.authToken')
 *
 * SCOPE:
 *  - One ResponseStore instance is created per test flow (FlowID)
 *  - Stores are not shared between flows — values cannot leak between test cases
 *
 * STEP REFERENCE FORMAT:
 *  - Keys are stored as  "STEP_ID.VARIABLE_NAME"
 *    e.g. "USER-01-S1.authToken", "USER-01-S2.userId"
 *  - This makes the origin of every value explicit in templates
 */

export class ResponseStore {
    private store = new Map<string, unknown>();
    private flowId: string;

    constructor(flowId: string) {
        this.flowId = flowId;
    }

    /**
     * Store a value extracted from a step's response.
     * @param stepId   The TestCaseID of the step (e.g. 'USER-01-S1')
     * @param varName  The ExtractAs column value (e.g. 'authToken')
     * @param value    The extracted value
     */
    set(stepId: string, varName: string, value: unknown): void {
        const key = `${stepId}.${varName}`;
        this.store.set(key, value);
    }

    /**
     * Retrieve a stored value by its full key (e.g. 'USER-01-S1.authToken').
     * Returns undefined if not found — caller is responsible for handling missing values.
     */
    get(key: string): unknown {
        return this.store.get(key);
    }

    /**
     * Check whether a key exists in the store.
     */
    has(key: string): boolean {
        return this.store.has(key);
    }

    /**
     * Extract a value from a response body using a dot-notation path.
     * Called automatically by the framework after each step that has ExtractAs set.
     *
     * @param body     The parsed response body
     * @param path     Dot-notation path into the body: 'accessToken', 'data.user.id'
     * @returns        The extracted value, or undefined if path not found
     *
     * @example
     *   extractFromBody({ data: { user: { id: 42 } } }, 'data.user.id') → 42
     *   extractFromBody({ accessToken: 'abc123' }, 'accessToken') → 'abc123'
     */
    extractFromBody(body: unknown, path: string): unknown {
        if (body === null || body === undefined) return undefined;

        const parts = path.split('.');
        let current: unknown = body;

        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            if (typeof current !== 'object') return undefined;
            current = (current as Record<string, unknown>)[part];
        }

        return current;
    }

    /**
     * Auto-extract and store a value from a response.
     * Called by the framework after each step that has ExtractAs set.
     *
     * @param stepId      TestCaseID of the completed step
     * @param extractAs   The ExtractAs column value — can be:
     *                      'authToken'            → stores body.accessToken (common JWT pattern)
     *                      'userId=body.data.id'  → explicit path mapping
     *                      'orderId'              → tries body.id, body.orderId, body.data.id
     * @param body        The parsed response body
     */
    autoExtract(stepId: string, extractAs: string, body: unknown): void {
        if (!extractAs || !body) return;

        // Explicit path: "varName=body.path.to.value"
        if (extractAs.includes('=')) {
            const [varName, bodyPath] = extractAs.split('=').map(s => s.trim());
            const path = bodyPath.replace(/^body\./, '');
            const value = this.extractFromBody(body, path);
            if (value !== undefined) {
                this.set(stepId, varName, value);
            }
            return;
        }

        // Simple name: try common patterns
        // e.g. ExtractAs: "authToken" → looks for body.accessToken, body.token, body.authToken
        const commonPaths: Record<string, string[]> = {
            authToken:    ['accessToken', 'token', 'authToken', 'access_token'],
            refreshToken: ['refreshToken', 'refresh_token'],
            userId:       ['id', 'userId', 'user_id', 'data.id'],
            orderId:      ['id', 'orderId', 'order_id', 'data.id'],
            productId:    ['id', 'productId', 'product_id', 'data.id'],
            postId:       ['id', 'postId', 'post_id', 'data.id'],
        };

        const paths = commonPaths[extractAs] ?? [extractAs, `data.${extractAs}`];

        for (const path of paths) {
            const value = this.extractFromBody(body, path);
            if (value !== undefined) {
                this.set(stepId, extractAs, value);
                return;
            }
        }

        // Warn if nothing was found — don't throw, let downstream placeholder resolution handle it
        console.warn(
            `[ResponseStore] Could not extract "${extractAs}" from step ${stepId} response body. ` +
            `Add an explicit path mapping: ExtractAs="${extractAs}=body.your.path"`
        );
    }

    /**
     * Return all stored values as a flat object — useful for debugging.
     */
    snapshot(): Record<string, unknown> {
        return Object.fromEntries(this.store);
    }

    /**
     * Clear the store — used between isolated test flows.
     */
    clear(): void {
        this.store.clear();
    }

    get flowID(): string {
        return this.flowId;
    }
}

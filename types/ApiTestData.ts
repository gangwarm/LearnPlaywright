/**
 * ApiTestData.ts
 *
 * Single source of truth for every data shape the API framework touches.
 * Maps exactly to the columns in apiRegistry.xlsx — APIRegistry + APIRequests sheets.
 *
 * DESIGN RULES:
 *  - All fields optional where the Excel cell may be blank
 *  - Enums for constrained columns so TypeScript catches invalid values at compile time
 *  - No `any` — every shape is fully typed
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type HttpMethod   = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Protocol     = 'REST' | 'GraphQL';
export type AuthType     = 'Bearer' | 'Basic' | 'ApiKey' | 'None';
export type Phase        = 'setup' | 'test' | 'teardown';
export type ContentType  = 'application/json' | 'multipart/form-data' | 'application/x-www-form-urlencoded';

// ─── APIRegistry row ──────────────────────────────────────────────────────────

/**
 * One row in the APIRegistry sheet.
 * FlowID groups steps belonging to the same test flow.
 * StepOrder controls execution sequence within the flow.
 */
export interface ApiRegistryRow {
    // Identity
    FlowID:          string;        // Groups steps: 'USER-01', 'ORDER-01'
    TestCaseID:      string;        // Unique step ID: 'USER-01-S1', 'USER-01-S2'
    StepOrder:       number;        // Execution order within a flow
    Phase:           Phase;         // setup | test | teardown
    Description:     string;        // Human-readable step title

    // Request
    Protocol:        Protocol;      // REST | GraphQL
    Method:          HttpMethod;    // GET | POST | PUT | PATCH | DELETE
    Endpoint:        string;        // '/auth/login' or full URL — supports {{placeholders}}
    BaseUrl?:        string;        // Overrides environment base URL for external APIs
    AuthType:        AuthType;      // Bearer | Basic | ApiKey | None
    ContentType?:    ContentType;   // Defaults to application/json

    // Data
    TemplatePath?:   string;        // 'templates/auth/login.json'
    SchemaFile?:     string;        // 'schemas/users/get-user.schema.json'
    AssertionFile?:  string;        // 'assertions/users/get-users.assert.txt'
    ExtractAs?:      string;        // Variable name to store from response: 'authToken'
    DependsOn?:      string;        // TestCaseID this step requires to have passed first

    // Performance & reliability
    MaxResponseTime?: number;       // ms — overrides global threshold if set
    RetryCount?:      number;       // How many times to retry on failure (default: 0)
    RetryDelay?:      number;       // ms between retries (default: 1000)
    MaskFields?:      string;       // Comma-separated paths to mask: 'password,token'

    // Registry control
    Priority:        string;        // P0 | P1 | P2 | P3
    Tags:            string;        // '@smoke, @regression'
    Run:             boolean;       // Master on/off switch
    Environment:     string;        // QA | PROD
}

// ─── APIRequests row ──────────────────────────────────────────────────────────

/**
 * One row in the APIRequests sheet.
 * TestCaseID links this row to a step in APIRegistry.
 * All remaining columns are template placeholder key-value pairs.
 *
 * Example row:
 *   TestCaseID | username | password | expiresInMins
 *   USER-01-S1 | emilys   | emilyspass | 30
 */
export interface ApiRequestRow {
    TestCaseID: string;
    [placeholder: string]: string | number | boolean;   // dynamic columns → {{key}} values
}

// ─── Runtime types ────────────────────────────────────────────────────────────

/**
 * A fully resolved step — registry row merged with its request data,
 * placeholders not yet substituted (that happens at runtime via TemplateEngine).
 */
export interface ApiTestStep {
    registry:    ApiRegistryRow;
    requestData: Record<string, string | number | boolean>;
}

/**
 * A test flow — one or more steps grouped by FlowID,
 * sorted by StepOrder, split into phases.
 */
export interface ApiTestFlow {
    flowId:    string;
    setup:     ApiTestStep[];
    test:      ApiTestStep[];
    teardown:  ApiTestStep[];
}

/**
 * The fully built request object passed to HttpClient.
 * All placeholders are resolved. Ready to send.
 */
export interface ResolvedRequest {
    method:      HttpMethod;
    url:         string;
    headers:     Record<string, string>;
    body?:       unknown;
    retryCount:  number;
    retryDelay:  number;
    stepMeta:    Pick<ApiRegistryRow, 'TestCaseID' | 'Description' | 'MaskFields' | 'MaxResponseTime'>;
}

/**
 * The normalised response returned by HttpClient back to the framework.
 */
export interface ApiResponse {
    status:       number;
    headers:      Record<string, string>;
    body:         unknown;
    responseTime: number;   // ms
    rawBody:      string;
}

/**
 * Result of running AssertionEngine against a response.
 */
export interface AssertionResult {
    passed:   AssertionOutcome[];
    failed:   AssertionOutcome[];
    total:    number;
    allPassed: boolean;
}

export interface AssertionOutcome {
    rule:     string;           // The original assertion line: 'body.user.name == John'
    passed:   boolean;
    actual?:  unknown;          // What the response actually had
    expected?: unknown;         // What the assertion expected
    message?: string;           // Human-readable explanation on failure
}

// ─── Required columns — used by apiGlobalSetup for validation ─────────────────

export const REQUIRED_REGISTRY_COLUMNS = [
    'FlowID',
    'TestCaseID',
    'StepOrder',
    'Phase',
    'Description',
    'Protocol',
    'Method',
    'Endpoint',
    'AuthType',
    'Priority',
    'Run',
    'Environment',
] as const;

export type RequiredRegistryColumn = typeof REQUIRED_REGISTRY_COLUMNS[number];

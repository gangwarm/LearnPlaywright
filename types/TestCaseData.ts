/**
 * Explicit type definitions for the test registry.
 *
 * WHY: The original `typeof registry[0]` derived its type from the shape of
 * the JSON file at compile time. This meant:
 *   1. An empty JSON file would collapse all types to `never`.
 *   2. Renaming a column in Excel silently broke type safety.
 *   3. TypeScript had to parse the entire JSON to infer types — slow at scale.
 *
 * This explicit interface is the single source of truth for the data contract
 * between your Excel registry and your tests.
 */

// ─── Page-Data Sheets ────────────────────────────────────────────────────────
// Add a new interface here whenever you add a new sheet to testRegistry.xlsx.

export interface LoginData {
    TestCaseID: string;
    UserRole: string;
}

export interface ProductPageData {
    TestCaseID: string;
    AddProduct1?: string;
    AddProduct2?: string;
    AddProduct3?: string;
    ItemsInCart?: number;
}

// Extend with additional sheet interfaces as your framework grows:
// export interface CheckoutData { ... }
// export interface ProfileData  { ... }

// ─── Top-level Registry Shape ────────────────────────────────────────────────

export interface TestCaseMetadata {
    tcId:      string;
    title:     string;
    priority:  string;
    testType:  string;
    tags:      string[];
}

export interface TestCaseExecution {
    enabled:     boolean;
    environment: string;
    browser:     string;
}

/**
 * The `data` block is keyed by sheet name (e.g. "Login", "ProductPage").
 * All sheets are optional because not every test touches every page.
 */
export interface TestCasePageData {
    Login?:       LoginData;
    ProductPage?: ProductPageData;
    // Add additional sheet interfaces here as you expand:
    // Checkout?: CheckoutData;
}

export interface TestCaseData {
    metadata:  TestCaseMetadata;
    execution: TestCaseExecution;
    data:      TestCasePageData;
}

// ─── Registry Schema — used by globalSetup for validation ────────────────────

/** Required columns in the Registry sheet. globalSetup validates these exist. */
export const REQUIRED_REGISTRY_COLUMNS = [
    'TestCaseID',
    'Description',
    'Priority',
    'TestType',
    'Run',
    'Environment',
    'Browser',
] as const;

export type RequiredRegistryColumn = typeof REQUIRED_REGISTRY_COLUMNS[number];

/**
 * AssertionEngine.ts
 *
 * Executes parsed assertion rules against an API response.
 *
 * SOFT-FAIL BEHAVIOUR:
 *   All rules are evaluated even if earlier ones fail.
 *   The full list of passed + failed assertions is returned.
 *   The test fails only after ALL assertions have been checked,
 *   giving the tester a complete picture of what passed and what failed.
 *
 * SUPPORTED PATHS:
 *   status              → response.status (number)
 *   responseTime        → response.responseTime (ms)
 *   header.X-Name       → response.headers['x-name'] (case-insensitive)
 *   body.user.name      → response.body.user.name (dot-notation traversal)
 *   body.results[0].id  → indexed array access
 *   body.results[*].price → wildcard: ALL items must satisfy the rule
 *   body.results contains id=42 → any item has field id with value 42
 *
 * TYPE ASSERTION SYNTAX:
 *   body.id         type integer   → whole number (no decimals)
 *   body.score      type number    → any number including decimals
 *   body.name       type string    → any string
 *   body.active     type boolean   → true or false
 *   body.tags       type array     → array
 *   body.address    type object    → object (not array, not null)
 *   body.email      type email     → valid email format
 *   body.site       type url       → valid URL format
 *   body.dob        type date      → valid date string (YYYY-MM-DD or ISO)
 *   body.ref        type uuid      → valid UUID format
 *   body.deleted    type null      → value is null
 */

import { ApiResponse, AssertionResult, AssertionOutcome } from '../../types/ApiTestData';
import { ParsedAssertion, Operator, ValueType } from './AssertionParser';

export class AssertionEngine {

    /**
     * Run all assertions against a response. Returns full pass/fail breakdown.
     * Never throws — all failures are collected into the result.
     */
    run(assertions: ParsedAssertion[], response: ApiResponse): AssertionResult {
        const passed: AssertionOutcome[] = [];
        const failed: AssertionOutcome[] = [];

        for (const assertion of assertions) {
            try {
                const outcome = this.evaluate(assertion, response);
                if (outcome.passed) {
                    passed.push(outcome);
                } else {
                    failed.push(outcome);
                }
            } catch (err) {
                failed.push({
                    rule:    assertion.raw,
                    passed:  false,
                    message: `Assertion evaluation error: ${(err as Error).message}`,
                });
            }
        }

        return {
            passed,
            failed,
            total:     assertions.length,
            allPassed: failed.length === 0,
        };
    }

    // ── Evaluator ─────────────────────────────────────────────────────────────

    private evaluate(assertion: ParsedAssertion, response: ApiResponse): AssertionOutcome {
        const { path, operator, value, isWildcard } = assertion;

        // ── Wildcard: body.results[*].price > 0 ──────────────────────────────
        if (isWildcard) {
            return this.evaluateWildcard(assertion, response);
        }

        // ── Contains: body.results contains id=42 ────────────────────────────
        if (operator === 'contains' && path.startsWith('body.') && value?.includes('=')) {
            return this.evaluateContains(assertion, response);
        }

        // ── Resolve path to actual value ──────────────────────────────────────
        const actual = this.resolvePath(path, response);

        // ── Performance assertion: responseTime < 2000ms ──────────────────────
        if (path === 'responseTime') {
            const ms = value ? parseInt(value.replace('ms', ''), 10) : NaN;
            return this.compare(assertion, actual, ms, operator);
        }

        // ── Type assertion: body.user.id type integer ─────────────────────────
        if (operator === 'type') {
            return this.evaluateType(assertion, actual, (value ?? '') as ValueType);
        }

        // ── Exists / notExists ────────────────────────────────────────────────
        if (operator === 'exists') {
            const ok = actual !== undefined && actual !== null;
            return {
                rule:    assertion.raw,
                passed:  ok,
                actual,
                message: ok ? undefined : `Expected "${path}" to exist but it was ${actual === null ? 'null' : 'undefined'}`,
            };
        }

        if (operator === 'notExists') {
            const ok = actual === undefined || actual === null;
            return {
                rule:    assertion.raw,
                passed:  ok,
                actual,
                message: ok ? undefined : `Expected "${path}" to not exist but got: ${JSON.stringify(actual)}`,
            };
        }

        // ── Length operators ──────────────────────────────────────────────────
        if (['lengthEquals', 'lengthGreaterThan', 'lengthLessThan'].includes(operator)) {
            return this.evaluateLength(assertion, actual);
        }

        // ── Standard comparison ───────────────────────────────────────────────
        const expected = this.coerce(value, actual);
        return this.compare(assertion, actual, expected, operator);
    }

    // ── Path resolution ───────────────────────────────────────────────────────

    private resolvePath(path: string, response: ApiResponse): unknown {
        if (path === 'status')       return response.status;
        if (path === 'responseTime') return response.responseTime;

        if (path.startsWith('header.')) {
            const headerName = path.slice(7).toLowerCase();
            const headers    = Object.fromEntries(
                Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v])
            );
            return headers[headerName];
        }

        if (path.startsWith('body.')) {
            const bodyPath = path.slice(5);
            return this.traversePath(response.body, bodyPath);
        }

        return this.traversePath(response.body, path);
    }

    private traversePath(obj: unknown, path: string): unknown {
        if (obj === null || obj === undefined) return undefined;

        const parts = path.split('.').flatMap(part => {
            const indexMatch = part.match(/^(.+?)\[(\d+)\]$/);
            if (indexMatch) return [indexMatch[1], `[${indexMatch[2]}]`];
            return [part];
        });

        let current: unknown = obj;

        for (const part of parts) {
            if (current === null || current === undefined) return undefined;

            if (part.startsWith('[') && part.endsWith(']')) {
                const idx = parseInt(part.slice(1, -1), 10);
                current = (current as unknown[])[idx];
            } else if (part === 'length' && Array.isArray(current)) {
                current = current.length;
            } else {
                current = (current as Record<string, unknown>)[part];
            }
        }

        return current;
    }

    // ── Wildcard evaluator (supports nested wildcards) ────────────────────────
    //
    // Handles:
    //   body.orders[*].id                         → single wildcard
    //   body.orders[*].items[*].productId         → nested wildcard
    //   body.orders[*].items[*].tags[*] exists    → triple wildcard
    //
    // Works by splitting on the FIRST [*] only, then recursing if the
    // remaining itemPath still contains another [*].

    private evaluateWildcard(assertion: ParsedAssertion, response: ApiResponse): AssertionOutcome {
        // Split on FIRST [*] only
        const firstWildcard = assertion.path.indexOf('[*]');
        const arraySegment  = assertion.path.substring(0, firstWildcard);          // e.g. 'body.orders'
        const afterWildcard = assertion.path.substring(firstWildcard + 3);         // e.g. '.items[*].productId'
        const itemPath      = afterWildcard.startsWith('.') ? afterWildcard.slice(1) : afterWildcard; // e.g. 'items[*].productId'

        // Resolve the array at arraySegment
        const resolveKey = arraySegment.startsWith('body.') ? arraySegment : `body.${arraySegment}`;
        const array      = this.resolvePath(resolveKey, response);

        if (!Array.isArray(array)) {
            return {
                rule:    assertion.raw,
                passed:  false,
                actual:  array,
                message: `Expected "${arraySegment}" to be an array for wildcard assertion, got: ${typeof array}`,
            };
        }

        const failures: string[] = [];

        for (let i = 0; i < array.length; i++) {
            const item = array[i];

            // ── If itemPath still contains [*] → recurse ──────────────────────
            if (itemPath.includes('[*]')) {
                // Build a synthetic assertion with the remaining path
                // prefixed with 'body.' so resolvePath works correctly
                const nestedAssertion: ParsedAssertion = {
                    ...assertion,
                    path:       `body.${itemPath}`,
                    isWildcard: true,
                };

                // Wrap item in a fake response so resolvePath can traverse it
                const fakeResponse = {
                    ...response,
                    body: item,
                };

                const nestedResult = this.evaluateWildcard(nestedAssertion, fakeResponse);
                if (!nestedResult.passed) {
                    failures.push(`  [${i}]: ${nestedResult.message ?? 'nested assertion failed'}`);
                }
                continue;
            }

            // ── No more wildcards — resolve final value ────────────────────────
            const itemActual = itemPath ? this.traversePath(item, itemPath) : item;

            // exists
            if (assertion.operator === 'exists') {
                if (itemActual === undefined || itemActual === null) {
                    failures.push(`  [${i}]: actual=${JSON.stringify(itemActual)}, expected=to exist`);
                }
                continue;
            }

            // notExists
            if (assertion.operator === 'notExists') {
                if (itemActual !== undefined && itemActual !== null) {
                    failures.push(`  [${i}]: actual=${JSON.stringify(itemActual)}, expected=to not exist`);
                }
                continue;
            }

            // type
            if (assertion.operator === 'type') {
                const typeResult = this.evaluateType(assertion, itemActual, (assertion.value ?? '') as ValueType);
                if (!typeResult.passed) {
                    failures.push(`  [${i}]: actual type=${this.describeType(itemActual)}, expected type=${assertion.value}`);
                }
                continue;
            }

            // standard comparison
            const expected  = this.coerce(assertion.value, itemActual);
            const subResult = this.compare(assertion, itemActual, expected, assertion.operator);
            if (!subResult.passed) {
                failures.push(`  [${i}]: actual=${JSON.stringify(itemActual)}, expected=${JSON.stringify(expected)}`);
            }
        }

        const passed = failures.length === 0;
        return {
            rule:    assertion.raw,
            passed,
            message: passed
                ? undefined
                : `Wildcard assertion failed for ${failures.length}/${array.length} items:\n${failures.join('\n')}`,
        };
    }

    // ── Contains evaluator ────────────────────────────────────────────────────

    private evaluateContains(assertion: ParsedAssertion, response: ApiResponse): AssertionOutcome {
        const arrayPath    = assertion.path.replace(/^body\./, '');
        const array        = this.traversePath(response.body, arrayPath);
        const [field, val] = (assertion.value ?? '').split('=');

        if (!Array.isArray(array)) {
            return {
                rule:    assertion.raw,
                passed:  false,
                message: `Expected "${assertion.path}" to be an array, got: ${typeof array}`,
            };
        }

        const found = array.some(item => {
            const itemVal = (item as Record<string, unknown>)[field];
            return String(itemVal) === val;
        });

        return {
            rule:     assertion.raw,
            passed:   found,
            expected: `array contains item where ${field}=${val}`,
            message:  found ? undefined : `No item in "${assertion.path}" has ${field}=${val}`,
        };
    }

    // ── Length evaluator ──────────────────────────────────────────────────────

    private evaluateLength(assertion: ParsedAssertion, actual: unknown): AssertionOutcome {
        const length   = typeof actual === 'number' ? actual : -1;
        const expected = parseInt(assertion.value ?? '0', 10);

        let passed: boolean;
        switch (assertion.operator) {
            case 'lengthEquals':       passed = length === expected; break;
            case 'lengthGreaterThan':  passed = length > expected;   break;
            case 'lengthLessThan':     passed = length < expected;   break;
            default:                   passed = false;
        }

        return {
            rule:     assertion.raw,
            passed,
            actual:   length,
            expected,
            message:  passed ? undefined
                : `Length assertion failed: actual length=${length}, expected ${assertion.operator} ${expected}`,
        };
    }

    // ── Type evaluator ────────────────────────────────────────────────────────

    /**
     * Supported type keywords:
     *
     *  Primitive types:
     *   string   — typeof === 'string'
     *   number   — typeof === 'number' (includes decimals)
     *   integer  — typeof === 'number' AND Number.isInteger()
     *   boolean  — typeof === 'boolean'
     *   array    — Array.isArray()
     *   object   — typeof === 'object', not null, not array
     *   null     — value is exactly null
     *
     *  Format types (string must match format):
     *   email    — valid email address
     *   url      — valid URL (http/https)
     *   date     — valid date string (YYYY-MM-DD or ISO 8601)
     *   uuid     — valid UUID (v1-v5)
     */
    private evaluateType(assertion: ParsedAssertion, actual: unknown, expectedType: ValueType): AssertionOutcome {
        const { passed, reason } = this.checkType(actual, expectedType);

        return {
            rule:     assertion.raw,
            passed,
            actual:   this.describeType(actual),
            expected: expectedType,
            message:  passed ? undefined : reason,
        };
    }

    private checkType(actual: unknown, expectedType: string): { passed: boolean; reason: string } {
        const fail = (msg: string) => ({ passed: false, reason: msg });
        const ok   = { passed: true, reason: '' };

        switch (expectedType) {

            // ── Primitive types ───────────────────────────────────────────────

            case 'string':
                return typeof actual === 'string'
                    ? ok
                    : fail(`Expected type "string" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            case 'number':
                return typeof actual === 'number' && !isNaN(actual)
                    ? ok
                    : fail(`Expected type "number" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            case 'integer':
                if (typeof actual !== 'number' || isNaN(actual)) {
                    return fail(`Expected type "integer" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);
                }
                return Number.isInteger(actual)
                    ? ok
                    : fail(`Expected type "integer" but got decimal number ${actual}`);

            case 'boolean':
                return typeof actual === 'boolean'
                    ? ok
                    : fail(`Expected type "boolean" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            case 'array':
                return Array.isArray(actual)
                    ? ok
                    : fail(`Expected type "array" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            case 'object':
                return typeof actual === 'object' && actual !== null && !Array.isArray(actual)
                    ? ok
                    : fail(`Expected type "object" but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            case 'null':
                return actual === null
                    ? ok
                    : fail(`Expected null but got "${this.describeType(actual)}" (value: ${JSON.stringify(actual)})`);

            // ── Format types ──────────────────────────────────────────────────

            case 'email': {
                if (typeof actual !== 'string') {
                    return fail(`Expected email (string) but got "${this.describeType(actual)}"`);
                }
                // RFC 5322 simplified — covers all practical email formats
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                return emailRegex.test(actual)
                    ? ok
                    : fail(`"${actual}" is not a valid email address`);
            }

            case 'url': {
                if (typeof actual !== 'string') {
                    return fail(`Expected url (string) but got "${this.describeType(actual)}"`);
                }
                try {
                    const u = new URL(actual);
                    return u.protocol === 'http:' || u.protocol === 'https:'
                        ? ok
                        : fail(`"${actual}" is not a valid http/https URL`);
                } catch {
                    return fail(`"${actual}" is not a valid URL`);
                }
            }

            case 'date': {
                if (typeof actual !== 'string') {
                    return fail(`Expected date (string) but got "${this.describeType(actual)}"`);
                }
                // Accepts: YYYY-MM-DD, ISO 8601 with time, common date strings
                const dateRegex = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;
                if (!dateRegex.test(actual)) {
                    return fail(`"${actual}" is not a valid date string (expected YYYY-MM-DD or ISO 8601)`);
                }
                const d = new Date(actual);
                return isNaN(d.getTime())
                    ? fail(`"${actual}" is not a valid date`)
                    : ok;
            }

            case 'uuid': {
                if (typeof actual !== 'string') {
                    return fail(`Expected uuid (string) but got "${this.describeType(actual)}"`);
                }
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                return uuidRegex.test(actual)
                    ? ok
                    : fail(`"${actual}" is not a valid UUID`);
            }

            default:
                return fail(`Unknown type keyword "${expectedType}". Supported: string, number, integer, boolean, array, object, null, email, url, date, uuid`);
        }
    }

    // ── Describe actual type (for error messages) ─────────────────────────────

    private describeType(value: unknown): string {
        if (value === null)          return 'null';
        if (Array.isArray(value))    return 'array';
        if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
        return typeof value;
    }

    // ── Comparison ────────────────────────────────────────────────────────────

    private compare(
        assertion: ParsedAssertion,
        actual: unknown,
        expected: unknown,
        operator: Operator,
    ): AssertionOutcome {
        let passed: boolean;
        const a = actual   as number | string;
        const e = expected as number | string;

        switch (operator) {
            case '==': passed = actual == expected || String(actual) === String(expected); break; // eslint-disable-line eqeqeq
            case '!=': passed = actual != expected && String(actual) !== String(expected); break; // eslint-disable-line eqeqeq
            case '>':  passed = Number(a) > Number(e);  break;
            case '>=': passed = Number(a) >= Number(e); break;
            case '<':  passed = Number(a) < Number(e);  break;
            case '<=': passed = Number(a) <= Number(e); break;
            case 'contains':
                passed = typeof actual === 'string'
                    ? actual.toLowerCase().includes(String(expected).toLowerCase())
                    : false;
                break;
            default:
                passed = false;
        }

        return {
            rule:     assertion.raw,
            passed,
            actual,
            expected,
            message:  passed ? undefined
                : `Assertion failed: "${assertion.path}" ${operator} ${JSON.stringify(expected)} — actual: ${JSON.stringify(actual)}`,
        };
    }

    // ── Type coercion ─────────────────────────────────────────────────────────

    private coerce(rawValue: string | undefined, actual: unknown): unknown {
        if (rawValue === undefined) return undefined;
        if (rawValue === 'null')    return null;
        if (rawValue === 'true')    return true;
        if (rawValue === 'false')   return false;

        if (typeof actual === 'number') {
            const n = parseFloat(rawValue);
            if (!isNaN(n)) return n;
        }

        return rawValue;
    }
}

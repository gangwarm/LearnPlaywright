/**
 * AssertionParser.ts
 *
 * Reads a .assert.txt file, resolves import directives, and tokenises
 * each assertion rule into a structured ParsedAssertion object.
 *
 * SYNTAX (three tokens per line: path operator value):
 *
 *   # Comment lines are ignored
 *   status == 200
 *   status != 404
 *   responseTime < 2000ms
 *   header.Content-Type contains application/json
 *   body.user.name == John
 *   body.user.email exists
 *   body.user.deletedAt notExists
 *   body.user.age > 18
 *   body.user.age >= 18
 *   body.results.length > 0
 *   body.results.length == 25
 *   body.results[0].id == 101
 *   body.results[*].price > 0          ← every item rule
 *   body.results[*].status exists      ← every item field check
 *   body.results contains id=42        ← specific item exists by field=value
 *
 * TYPE ASSERTIONS:
 *   body.id       type integer          ← whole number, no decimals
 *   body.score    type number           ← any number including decimals
 *   body.name     type string           ← any string
 *   body.active   type boolean          ← true or false
 *   body.tags     type array            ← array
 *   body.address  type object           ← object (not array, not null)
 *   body.deleted  type null             ← value is null
 *   body.email    type email            ← valid email address
 *   body.site     type url              ← valid http/https URL
 *   body.dob      type date             ← valid date (YYYY-MM-DD or ISO 8601)
 *   body.ref      type uuid             ← valid UUID
 *
 *   All type assertions work with wildcards:
 *   body.users[*].id     type integer
 *   body.users[*].email  type email
 *
 * IMPORT DIRECTIVE:
 *   import base/api-common.assert.txt
 *
 *   Imports are resolved relative to the assertions/ directory.
 *   Circular imports are detected and prevented.
 */

import * as fs   from 'fs';
import * as path from 'path';

export type Operator =
    | '=='  | '!='
    | '>'   | '>='
    | '<'   | '<='
    | 'exists'    | 'notExists'
    | 'contains'
    | 'type'
    | 'lengthEquals' | 'lengthGreaterThan' | 'lengthLessThan';

// ── Primitive types ───────────────────────────────────────────────────────────
// string   → typeof === 'string'
// number   → any number (including decimals)
// integer  → whole number only (Number.isInteger)
// boolean  → true / false
// array    → Array.isArray
// object   → plain object (not array, not null)
// null     → exactly null
//
// ── Format types (value must be a string matching the format) ─────────────────
// email    → valid email address
// url      → valid http/https URL
// date     → YYYY-MM-DD or ISO 8601 datetime
// uuid     → UUID v1–v5

export type ValueType =
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array'
    | 'object'
    | 'null'
    | 'email'
    | 'url'
    | 'date'
    | 'uuid';

export interface ParsedAssertion {
    raw:         string;        // The original rule line (for reporting)
    path:        string;        // 'status', 'body.user.name', 'header.Content-Type'
    operator:    Operator;
    value?:      string;        // Raw expected value (stringified)
    isWildcard:  boolean;       // true when path contains [*]
    arrayIndex?: number;        // parsed index when path contains [N]
    sourceFile:  string;        // Which .assert.txt file this came from
}

export class AssertionParser {
    private assertionsDir: string;

    constructor(assertionsDir: string) {
        this.assertionsDir = assertionsDir;
    }

    /**
     * Parse an assertion file and return all rules — including imported ones.
     *
     * @param filePath  Relative to assertionsDir: 'users/get-users.assert.txt'
     */
    parse(filePath: string, _visited = new Set<string>()): ParsedAssertion[] {
        const fullPath = path.join(this.assertionsDir, filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(
                `[AssertionParser] Assertion file not found: "${fullPath}"\n` +
                `  Check the AssertionFile column in apiRegistry.xlsx for this step.`
            );
        }

        if (_visited.has(fullPath)) {
            throw new Error(
                `[AssertionParser] Circular import detected: "${filePath}" imports itself (directly or indirectly).`
            );
        }
        _visited.add(fullPath);

        const lines   = fs.readFileSync(fullPath, 'utf-8').split('\n');
        const results: ParsedAssertion[] = [];

        for (const rawLine of lines) {
            const line = rawLine.trim();

            // Skip blank lines and comments
            if (!line || line.startsWith('#')) continue;

            // Import directive
            if (line.startsWith('import ')) {
                const importPath = line.slice(7).trim();
                const imported   = this.parse(importPath, _visited);
                results.push(...imported);
                continue;
            }

            // Parse assertion rule
            const parsed = this.parseLine(line, filePath);
            if (parsed) results.push(parsed);
        }

        return results;
    }

    // ── Line parser ───────────────────────────────────────────────────────────

    private parseLine(line: string, sourceFile: string): ParsedAssertion | null {
        const tokens = line.split(/\s+/);
        if (tokens.length < 2) {
            console.warn(`[AssertionParser] Skipping malformed line in ${sourceFile}: "${line}"`);
            return null;
        }

        const rawPath  = tokens[0];
        const rawOp    = tokens[1].toLowerCase();
        const rawValue = tokens.slice(2).join(' ');

        const operator = this.normaliseOperator(rawOp, rawPath);
        if (!operator) {
            console.warn(`[AssertionParser] Unknown operator "${rawOp}" in ${sourceFile}: "${line}"`);
            return null;
        }

        // Validate type keyword if operator is 'type'
        if (operator === 'type' && rawValue) {
            const validTypes: ValueType[] = [
                'string', 'number', 'integer', 'boolean',
                'array', 'object', 'null',
                'email', 'url', 'date', 'uuid',
            ];
            if (!validTypes.includes(rawValue as ValueType)) {
                console.warn(
                    `[AssertionParser] Unknown type "${rawValue}" in ${sourceFile}: "${line}"\n` +
                    `  Valid types: ${validTypes.join(', ')}`
                );
                return null;
            }
        }

        const isWildcard = rawPath.includes('[*]');
        const indexMatch = rawPath.match(/\[(\d+)\]/);
        const arrayIndex = indexMatch ? parseInt(indexMatch[1], 10) : undefined;

        const normPath = rawPath === 'responseTime' ? 'responseTime'
            : rawPath.replace(/\[(\d+)\]/g, '[$1]');

        return {
            raw:        line,
            path:       normPath,
            operator,
            value:      rawValue || undefined,
            isWildcard,
            arrayIndex,
            sourceFile,
        };
    }

    private normaliseOperator(op: string, path: string): Operator | null {
        // length.* sugar
        if (path.endsWith('.length')) {
            switch (op) {
                case '>':  return 'lengthGreaterThan';
                case '<':  return 'lengthLessThan';
                case '==': return 'lengthEquals';
                default: break;
            }
        }

        switch (op) {
            case '==':           return '==';
            case '!=':           return '!=';
            case '>':            return '>';
            case '>=':           return '>=';
            case '<':            return '<';
            case '<=':           return '<=';
            case 'exists':       return 'exists';
            case 'notexists':
            case 'not_exists':   return 'notExists';
            case 'contains':     return 'contains';
            case 'type':         return 'type';
            default:             return null;
        }
    }
}

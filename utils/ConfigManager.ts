/**
 * ConfigManager.ts
 *
 * Resolves environment configuration (base URLs, user credentials) for tests.
 *
 * CHANGES FROM ORIGINAL:
 *
 * 1. ENV FALLBACK WARNING — the original silently fell back to 'QA' if the
 *    ENV variable was unset or set to 'all'. This meant a tester who typo'd
 *    their env var name (e.g. `EENV=PROD`) would run all tests against QA
 *    and see them pass, falsely believing they'd tested PROD.
 *    Fix: a console.warn() is emitted whenever the fallback activates,
 *    so the engineer knows what environment is actually being used.
 *
 * 2. CONSISTENT INDENTATION & VISIBILITY — static methods now consistently
 *    have the `static` keyword aligned with the class body for readability.
 *
 * 3. NO LOGIC CHANGES — all existing error handling and priority rules
 *    (terminal override → registry setting → default 'QA') are preserved.
 */

import * as envData from '../data/environments.json';
import dotenv from 'dotenv';
import path   from 'path';

// Load .env — safe to call multiple times (dotenv is idempotent)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export class ConfigManager {

    /**
     * Resolves the target environment name.
     *
     * Priority:
     *   1. Terminal override:  ENV=PROD npx playwright test
     *   2. Registry setting:   the `environment` column in testRegistry.xlsx
     *   3. Default:            'QA'
     *
     * FIX: logs a warning whenever the fallback activates so engineers know
     * which environment is actually being targeted.
     */
    private static getTargetEnv(envName?: string): string {
        const raw = process.env.ENV || envName;

        // If no env was specified, or it was explicitly set to 'all' (a valid
        // Registry value meaning "run in any env"), fall back to QA.
        if (!raw || raw.toLowerCase() === 'all') {
            if (!raw) {
                console.warn(
                    `⚠️  ConfigManager: No environment specified. Defaulting to "QA".\n` +
                    `   To override: set ENV=<name> in your terminal or .env file.`
                );
            }
            return 'QA';
        }

        return raw.toUpperCase();
    }

    /**
     * Returns the base URL for the given environment.
     *
     * @param envName - Environment name from the test registry (e.g. "QA", "PROD").
     *                  Overridden by the ENV environment variable if set.
     * @throws If the environment is not defined in environments.json.
     */
    static getBaseUrl(envName?: string): string {
        const targetEnv = this.getTargetEnv(envName);
        const envConfig = (envData as any)[targetEnv];

        if (!envConfig) {
            throw new Error(
                `❌ ConfigManager: Environment "${targetEnv}" not found in environments.json.\n` +
                `   Available environments: ${Object.keys(envData).join(', ')}\n` +
                `   Check your ENV variable or the Registry "Environment" column.`
            );
        }

        return envConfig.baseUrl;
    }

    /**
     * Returns the username and password for the given role in the given environment.
     *
     * @param role    - User role name from the test registry (e.g. "standard", "admin").
     * @param envName - Environment name. Overridden by ENV variable if set.
     * @throws If the environment, role, or password key is missing.
     */
    static getUser(role: string, envName?: string): { username: string; password: string } {
        const targetEnv = this.getTargetEnv(envName);
        const envConfig = (envData as any)[targetEnv];

        if (!envConfig) {
            throw new Error(
                `❌ ConfigManager: Environment "${targetEnv}" not found in environments.json.`
            );
        }

        const userConfig = envConfig.users?.[role];
        if (!userConfig) {
            throw new Error(
                `❌ ConfigManager: Role "${role}" not found in "${targetEnv}" configuration.\n` +
                `   Available roles: ${Object.keys(envConfig.users ?? {}).join(', ')}\n` +
                `   Check the "UserRole" column in your test registry.`
            );
        }

        const username = userConfig.id;
        if (!username) {
            throw new Error(
                `❌ ConfigManager: Username ("id") is missing for role "${role}" in "${targetEnv}".`
            );
        }

        const password = process.env[userConfig.envPassKey];
        if (!password) {
            throw new Error(
                `❌ ConfigManager: Password key "${userConfig.envPassKey}" is not set in your .env file.\n` +
                `   Add: ${userConfig.envPassKey}=<your_password> to your .env file.\n` +
                `   Never commit real passwords to source control.`
            );
        }

        return { username, password };
    }
}

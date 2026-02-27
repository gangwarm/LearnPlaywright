import * as envData from '../data/environments.json';
import dotenv from 'dotenv';
import path from 'path';

// Initialize dotenv to read your hidden .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export class ConfigManager {
    /**
     * Priority Logic:
     * 1. Terminal Override (process.env.ENV)
     * 2. Registry Setting (envName)
     * 3. Default to 'QA'
     */
    private static getTargetEnv(envName?: string): string {
        let target = process.env.ENV || envName || 'QA';
        
        // Handle "all" by defaulting to QA for data lookup
        if (target.toLowerCase() === 'all') {
            target = 'QA';
        }
        return target.toUpperCase();
    }

static getBaseUrl(envName?: string): string {
        const targetEnv = this.getTargetEnv(envName);
        
        // Use type assertion (any) so TS allows the dynamic string lookup
        const envConfig = (envData as any)[targetEnv];
        
        if (!envConfig) {
            throw new Error(`❌ Environment "${targetEnv}" not found in environments.json. Available: ${Object.keys(envData).join(', ')}`);
        }
        return envConfig.baseUrl;
    }

static getUser(role: string, envName?: string) {
        const targetEnv = this.getTargetEnv(envName);
        const envConfig = (envData as any)[targetEnv];

        if (!envConfig) {
            throw new Error(`❌ Environment "${targetEnv}" not found.`);
        }

        const userConfig = envConfig.users[role];
        
        if (!userConfig) {
            // This is where your earlier error came from because 'role' was undefined from Excel
            throw new Error(`❌ Role "${role}" not found in ${targetEnv} configuration.`);
        }

        const username = userConfig.id;
        const password = process.env[userConfig.envPassKey];

        if (!password) {
            throw new Error(`❌ Password key "${userConfig.envPassKey}" found in JSON, but value is missing in .env file.`);
        }

        return { username, password };
    }
}
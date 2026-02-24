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
        if (!envData[targetEnv]) {
            throw new Error(`❌ Environment ${targetEnv} not found in environments.json`);
        }
        return envData[targetEnv].baseUrl;
    }

    static getUser(role: string, envName?: string) {
        const targetEnv = this.getTargetEnv(envName);
        const userConfig = envData[targetEnv].users[role];
        
        if (!userConfig) {
            throw new Error(`❌ Role "${role}" not found in ${targetEnv} environment.`);
        }

        const username = userConfig.id;
        // Look up the password in the .env file using the key from JSON
        const password = process.env[userConfig.envPassKey];

        if (!password) {
            throw new Error(`❌ Secret "${userConfig.envPassKey}" not found in .env file.`);
        }

        return { username, password };
    }
}
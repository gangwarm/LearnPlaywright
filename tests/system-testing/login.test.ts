import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import { ConfigManager } from '../../utils/ConfigManager';
import registry from '../../data/testRegistry.json';

// Find the specific login metadata
const tcData = registry.find(t => t.metadata.tcId === 'AppLogin');

test.describe('Authentication', () => {
    
    // Check if the test is enabled in the registry before running
    test.skip(!tcData?.execution.enabled, 'Test disabled in Registry');

    // 2. BROWSER FILTER LOGIC
    // This ensures that since Registry says 'firefox', this test skips 'chromium' and 'webkit'
    test.beforeEach(async ({ browserName},testInfo) => {
        const targetBrowser = tcData?.execution.browser.toLowerCase();
        if (targetBrowser !== 'all' && targetBrowser !== browserName) {
            test.skip(true, `Registry restricted to ${targetBrowser}. Skipping ${browserName}`);
        }

        // 2. Feed all Registry metadata to the Reporter
        if (tcData) {
        testInfo.annotations.push({ type: 'TcId', description: tcData.metadata.tcId });
        testInfo.annotations.push({ type: 'Title', description: tcData.metadata.title });
        testInfo.annotations.push({ type: 'Priority', description: tcData.metadata.priority });
        testInfo.annotations.push({ type: 'TestType', description: tcData.metadata.testType });
        testInfo.annotations.push({ type: 'Environment', description: tcData.execution.environment });
        testInfo.annotations.push({ type: 'UserRole', description: tcData.data.Login.UserRole });
        
        // Handle tags array (join with commas)
        if (tcData.metadata.tags) {
            testInfo.annotations.push({ type: 'Tags', description: tcData.metadata.tags.join(', ') });
        }
    }
    });

    //test(`${tcData?.metadata.tcId}: ${tcData?.metadata.title}`, async ({ page, browserName  }) => {
    test(`${tcData?.metadata.tcId}: ${tcData?.metadata.title}`, async ({ page }) => {

                // 1. BROWSER FILTER LOGIC
        //const targetBrowser = tcData?.execution.browser.toLowerCase();
        
        // If the registry doesn't say "all", and the current browser 
        // doesn't match the registry, skip this run.
        //if (targetBrowser !== 'all' && targetBrowser !== browserName) {
            //test.skip(true, `Skipping ${browserName} because Registry specifies ${targetBrowser}`);
        //}

        const loginPage = new LoginPage(page);

        // 1. Determine Environment and URL
        // If terminal has ENV=PROD, it overrides the 'QA' in the registry
        const url = ConfigManager.getBaseUrl(tcData?.execution.environment);
        
        // 2. Fetch Credentials
        // Maps 'standard' role to the secret in .env via ConfigManager
        console.log('Test Data:', tcData?.data);
        //const user = ConfigManager.getUser(tcData!.data.UserRole, tcData?.execution.environment);
        const user = ConfigManager.getUser(tcData.data.Login.UserRole, tcData.execution.environment);

        // 3. Execution
        await loginPage.navigate(url); // Passing URL directly since config baseURL is off
        await loginPage.login(user.username, user.password);

        // 4. Assertion
        await expect(page).toHaveURL(/inventory.html/);
    });
});
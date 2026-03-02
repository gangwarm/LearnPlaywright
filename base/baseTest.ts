import { test as base, expect } from '@playwright/test';
import registry from '../data/testRegistry.json';
// Import your pages and config manager
import { LoginPage } from '../pages/LoginPage';
import { ProductPage } from '../pages/ProductPage';
import { NavigationPage } from '../pages/components/NavigationPage';
import { ConfigManager } from '../utils/ConfigManager';

// 1. Define types for fixtures
type MyFixtures = {
    tcData: any;
    loginPage: LoginPage;
    productPage: ProductPage;
    menuNav: NavigationPage;
    loggedInPage: void; // Fixture that just runs login
};

// 2. Extend base test
export const test = base.extend<MyFixtures>({
    // Your existing data lookup
    tcData: async ({}, use, testInfo) => {
        const data = registry.find(t => t.metadata.tcId === testInfo.title);
        await use(data);
    },

    // Add Page Objects
    loginPage: async ({ page }, use) => await use(new LoginPage(page)),
    productPage: async ({ page }, use) => await use(new ProductPage(page)),
    menuNav: async ({ page }, use) => await use(new NavigationPage(page)),

    // 3. Automated Login Hook
    loggedInPage: async ({ page, loginPage, tcData }, use) => {
        if (!tcData) await use();
        
        const env = tcData.execution.environment;
        const url = ConfigManager.getBaseUrl(env);
        const user = ConfigManager.getUser(tcData.data.Login.UserRole, env);

        await loginPage.navigate(url);
        await loginPage.login(user.username, user.password);
        await expect(page).toHaveURL(/inventory.html/);
        
        await use();
    },
});

// 4. Your existing Reusable Logic (beforeEach)
test.beforeEach(async ({ tcData }, testInfo) => {
    if (!tcData) return;

    if (!tcData.execution.enabled) {
        test.skip(true, 'Test disabled in Registry');
    }

    const targetBrowser = tcData.execution.browser.toLowerCase();
    if (targetBrowser !== 'all' && targetBrowser !== testInfo.project.name.toLowerCase()) {
        test.skip(true, `Registry restricted to ${targetBrowser}. Skipping ${testInfo.project.name}`);
    }
});
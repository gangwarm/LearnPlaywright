/**
 * LoginPage.ts
 * No logic changes from original — this file was correct.
 * Moved to pages/ to match the updated directory structure.
 */

import { Page, Locator } from '@playwright/test';

export class LoginPage {
    readonly page:          Page;
    readonly usernameInput: Locator;
    readonly passwordInput: Locator;
    readonly loginButton:   Locator;

    constructor(page: Page) {
        this.page          = page;
        this.usernameInput = page.locator('[data-test="username"]');
        this.passwordInput = page.locator('[data-test="password"]');
        this.loginButton   = page.locator('[data-test="login-button"]');
    }

    /**
     * Navigates to the URL provided by the test registry.
     * @throws If no URL is provided.
     */
    async navigate(url: string): Promise<void> {
        if (!url) throw new Error('❌ LoginPage.navigate: No URL provided.');
        await this.page.goto(url);
    }

    async login(user: string, pass: string): Promise<void> {
        await this.usernameInput.fill(user);
        await this.passwordInput.fill(pass);
        await this.loginButton.click();
    }
}

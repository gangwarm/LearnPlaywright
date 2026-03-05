/**
 * NavigationPage.ts
 * No logic changes from original — this file was correct.
 * Moved to pages/components/ to match the updated directory structure.
 */

import { Page, Locator } from '@playwright/test';

export class NavigationPage {
    readonly page:       Page;
    readonly menuButton: Locator;

    constructor(page: Page) {
        this.page       = page;
        this.menuButton = page.locator('#react-burger-menu-btn');
    }

    /**
     * Opens the side navigation menu and clicks the specified link.
     * Waits for the slide-in animation to complete before clicking.
     */
    private async openMenuAndClick(linkName: string): Promise<void> {
        await this.menuButton.click();
        const link = this.page.getByRole('link', { name: linkName });
        await link.waitFor({ state: 'visible' });
        await link.click();
    }

    async logout():       Promise<void> { await this.openMenuAndClick('Logout'); }
    async goToInventory():Promise<void> { await this.openMenuAndClick('All Items'); }
    async goToAbout():    Promise<void> { await this.openMenuAndClick('About'); }
}

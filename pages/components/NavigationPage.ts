import { Page, Locator } from '@playwright/test';

export class NavigationPage {
    readonly page: Page;
    readonly menuButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.menuButton = page.locator('#react-burger-menu-btn');
    }

    /**
     * PRIVATE HELPER: Handles the common logic for ALL menu items
     * This is the only place we write the code to open the menu.
     */
    private async openMenuAndClick(linkName: string) {
        // 1. Open the menu
        await this.menuButton.click();
        
        // 2. Locate the link dynamically
        const link = this.page.getByRole('link', { name: linkName });
        
        // 3. IMPORTANT: Wait for the slide-in animation to finish
        // Without this, the test might fail on faster machines/browsers
        await link.waitFor({ state: 'visible' });
        
        // 4. Click the link
        await link.click();
    }

    // Now, your 50 methods become tiny "one-liners"
    async logout() {
        await this.openMenuAndClick('Logout');
    }

    async goToInventory() {
        await this.openMenuAndClick('All Items');
    }

    async goToAbout() {
        await this.openMenuAndClick('About');
    }
}
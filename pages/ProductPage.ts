/**
 * ProductPage.ts
 * No logic changes from original — this file was correct.
 * Moved to pages/ to match the updated directory structure.
 */

import { Page, Locator } from '@playwright/test';

export class ProductPage {
    readonly page:               Page;
    readonly inventoryItems:     Locator;
    readonly shoppingCartBadge:  Locator;

    constructor(page: Page) {
        this.page              = page;
        this.inventoryItems    = page.locator('.inventory_item');
        this.shoppingCartBadge = page.locator('.shopping_cart_badge');
    }

    /**
     * Finds the inventory item containing the given product name and clicks
     * its "Add to cart" button.
     *
     * @param productName - Must match the product name as displayed on the page.
     */
    async addItemToCart(productName: string): Promise<void> {
        const item = this.page
            .locator('.inventory_item')
            .filter({ hasText: productName });

        await item.getByRole('button', { name: 'Add to cart' }).click();
    }
}

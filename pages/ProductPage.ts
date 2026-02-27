import { Page, Locator } from '@playwright/test';

export class ProductPage {
    readonly page: Page;
    readonly inventoryItems: Locator;
    readonly shoppingCartBadge: Locator;

    constructor(page: Page) {
        this.page = page;
        // Selects the "Add to cart" button for a specific product (e.g., Backpack)
        this.inventoryItems = page.locator('.inventory_item');
        this.shoppingCartBadge = page.locator('.shopping_cart_badge');
    }

    async addItemToCart(productName: string) {
        // Find the specific item by text and click its "Add to cart" button
        const item = this.page.locator('.inventory_item').filter({ hasText: productName });
        await item.getByRole('button', { name: 'Add to cart' }).click();
    }
}
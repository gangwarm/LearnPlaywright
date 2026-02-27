import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import { ProductPage } from '../../pages/ProductPage';
import { NavigationPage } from '../../pages/components/NavigationPage';
import { ConfigManager } from '../../utils/ConfigManager';
import registry from '../../data/testRegistry.json';

// Find the data for this specific test case
const tcData = registry.find(t => t.metadata.tcId === 'CartCheck-TC01');

test.describe('Add products to cart', () => {

    // 1. GLOBAL ENABLE/DISABLE CHECK
    test.skip(!tcData?.execution.enabled, 'Test disabled in Registry');

    // 2. BROWSER FILTER LOGIC
    // This ensures that if the registry says 'all', it runs on everything.
    // If you change 'all' to 'webkit' in the JSON, it will skip Chrome/Firefox.
    test.beforeEach(async ({ browserName }) => {
        const targetBrowser = tcData?.execution.browser.toLowerCase();
        if (targetBrowser !== 'all' && targetBrowser !== browserName) {
            test.skip(true, `Registry restricted to ${targetBrowser}. Skipping ${browserName}`);
        }
    });

    test('Login, add item to cart, and logout', async ({ page }) => {
        const loginPage = new LoginPage(page);
        const productPage = new ProductPage(page);
        const menuNav = new NavigationPage(page);

        // 1. Setup Data
        const env = tcData?.execution.environment;
        const url = ConfigManager.getBaseUrl(env);
        //const user = ConfigManager.getUser(tcData!.data.UserRole, env);
        const user = ConfigManager.getUser(
        tcData.data.Login.UserRole, 
        tcData.execution.environment
        );

        // 2. STEP: Login
        await loginPage.navigate(url);
        await loginPage.login(user.username, user.password);
        await expect(page).toHaveURL(/inventory.html/);

// 3. Add Products from the 'Cart' sheet nest (as seen in your image)
        // Accessing data.Cart.[ColumnName]
        const products = tcData?.data.ProductPage;
        
    // Only attempt to add if the value exists in Excel
    if (products.AddProduct1) await productPage.addItemToCart(products.AddProduct1);
    if (products.AddProduct2) await productPage.addItemToCart(products.AddProduct2);
    if (products.AddProduct3) await productPage.addItemToCart(products.AddProduct3);

    // 4. Verify count - NEW ROBUST WAY
    const cartBadge = page.locator('.shopping_cart_badge');

    // Wait for it to be visible so we don't timeout
    await expect(cartBadge).toBeVisible({ timeout: 10000 });
        
        // Ensure we compare strings to strings
        const actualCount = await cartBadge.textContent();

        expect(actualCount).toBe(products.ItemsInCart.toString());
        
        console.log(`✅ Verified ${actualCount} items added to cart.`);

        // 4. STEP: Logout
        await menuNav.logout();

        // 5. Final Verification: Back at login screen
        await expect(page).toHaveURL(url);
        await expect(loginPage.loginButton).toBeVisible();
    });
});
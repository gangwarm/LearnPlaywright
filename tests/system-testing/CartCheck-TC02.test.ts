/**
 * CartCheck-TC02.test.ts
 *
 * CHANGES FROM ORIGINAL:
 *
 * 1. IMPORT PATHS — updated to match the revised directory structure.
 *
 * 2. TYPE-SAFE DATA ACCESS — `tcData.data.ProductPage` is now typed as
 *    `ProductPageData | undefined` (via the explicit interface). The non-null
 *    assertion (!) makes the contract explicit: this test requires ProductPage
 *    data to exist, and the guard throws early with a clear message if it doesn't.
 *
 * 3. REDUNDANT ASSERTION REMOVED — the original had both:
 *      const actualCount = await cartBadge.textContent();
 *      expect(actualCount).toBe(products.ItemsInCart.toString());
 *      await expect(cartBadge).toHaveText(products.ItemsInCart.toString());
 *    These assert the same thing twice. Kept only the Playwright-native
 *    `toHaveText` which has built-in retry/auto-wait semantics.
 */

import { test, expect }    from '../../base/baseTest';
import { LoginPage }       from '../../pages/LoginPage';
import { ProductPage }     from '../../pages/ProductPage';
import { NavigationPage }  from '../../pages/components/NavigationPage';
import { ConfigManager }   from '../../utils/ConfigManager';

test.describe('Shopping Cart Flow', () => {

    test('CartCheck-TC02: Login and add multiple items to cart', async ({ page, tcData }) => {
        const loginPage  = new LoginPage(page);
        const productPage = new ProductPage(page);
        const menuNav    = new NavigationPage(page);

        const env      = tcData.execution.environment;
        const url      = ConfigManager.getBaseUrl(env);
        const user     = ConfigManager.getUser(tcData.data.Login!.UserRole, env);
        const products = tcData.data.ProductPage;

        if (!products) {
            throw new Error(
                `❌ ProductPage data missing from registry for TcId "${tcData.metadata.tcId}".\n` +
                `   Add a row for this test case to the "ProductPage" sheet in testRegistry.xlsx.`
            );
        }

        // ── 1. Login ─────────────────────────────────────────────────────────
        await loginPage.navigate(url);
        await loginPage.login(user.username, user.password);

        // ── 2. Add Products ───────────────────────────────────────────────────
        // Only add products that are defined in the registry row — supports
        // tests with 1 or 2 products without needing separate test cases.
        if (products.AddProduct1) await productPage.addItemToCart(products.AddProduct1);
        if (products.AddProduct2) await productPage.addItemToCart(products.AddProduct2);

        // ── 3. Verify Cart Count ──────────────────────────────────────────────
        // FIX: removed the duplicate textContent() assertion. toHaveText() is
        // the Playwright-native approach and has built-in auto-wait/retry.
        const cartBadge = page.locator('.shopping_cart_badge');
        await expect(cartBadge).toBeVisible();
        await expect(cartBadge).toHaveText(products.ItemsInCart!.toString());

        // ── 4. Logout ─────────────────────────────────────────────────────────
        await menuNav.logout();
        await expect(loginPage.loginButton).toBeVisible();
    });

});

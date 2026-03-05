/**
 * login.test.ts
 *
 * CHANGES FROM ORIGINAL:
 * - Import paths updated to match the revised directory structure.
 * - No logic changes — the test itself was already correct.
 */

import { test, expect } from '../../base/baseTest';
import { LoginPage }    from '../../pages/LoginPage';
import { ConfigManager } from '../../utils/ConfigManager';

test.describe('Authentication', () => {

    // ⚠️  Convention: test title MUST start with the TcId from the Registry.
    // The fixture uses the prefix before ":" to look up test data.
    test('AppLogin: User should be able to login successfully', async ({ page, tcData }) => {
        const loginPage = new LoginPage(page);

        // 1. Setup — resolve environment and credentials from registry data
        const url  = ConfigManager.getBaseUrl(tcData.execution.environment);
        const user = ConfigManager.getUser(tcData.data.Login!.UserRole, tcData.execution.environment);

        // 2. Execution
        await loginPage.navigate(url);
        await loginPage.login(user.username, user.password);

        // 3. Assertion
        await expect(page).toHaveURL(/inventory\.html/);
    });

});

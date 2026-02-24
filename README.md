# Playwright Automation Framework

A scalable, professional-grade E2E testing framework built with Playwright and TypeScript.

## 🛠 Setup & Infrastructure
- **Node Version Manager (NVM):** Used for managing multiple Node.js environments.
- **Node.js Versions:** Utilizing **LTS** (Long Term Support) for stability and **Current** for latest features.
- **Playwright:** Installed and configured with TypeScript support.
- **CI/CD:** Integrated with GitHub Actions for automated cloud test execution.

## 🏗 Framework Architecture
This project follows the **Page Object Model (POM)** and **Data-Driven Testing (DDT)** patterns:

- **`pages/`**: Contains Page Objects (e.g., `LoginPage.ts`) defining UI selectors and actions.
- **`pages/components/`**: Reusable UI elements like Navbars and Footers.
- **`fixtures/`**: Dependency injection layer to keep tests clean and boilerplate-free.
- **`data/`**: 
    - `testRegistry.json`: The "Command Center" for test execution (enabling/disabling tests, setting environments and many other things).
    - `environments.json`: Maps environment keys (QA, PROD) to Base URLs and user roles. 
- **`utils/`**: 
    - `ConfigManager.ts`: Core logic for resolving URLs and fetching secrets from `.env` based on the Registry.
- **`tests/`**: Organized into a 4-tier testing strategy:
    - `system/`: Isolated component testing.
    - `integration/`: Testing interactions between modules.
    - `e2e/`: Full end-to-end user journeys.
    - `regression/`: Stability checks for existing features.

## 🔒 Security & Environment
- **`.env`**: Stores local environment variables (Base URL, Credentials).
- **`.gitignore`**: Strictly configured to exclude sensitive data (`.env`) and heavy dependencies (`node_modules`).
- **Registry** defines the `userRole` (e.g., "standard").
- **Environments JSON** defines the `envPassKey` (e.g., "QA_STANDARD_PASS").
- **ConfigManager** fetches the actual password from the local `.env` file using that key.

## 🚀 Getting Started
1. Clone the repository.
2. Run `npm install`.
3. Create a `.env` file in the root directory.
4. Run `npx playwright test` to execute the suite.
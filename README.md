Playwright Automation Setup
This repository contains a professional Playwright automation project.

🛠 Setup & Infrastructure
Node Version Manager (NVM): Used for managing multiple Node.js environments.

Node.js Versions:

LTS (Long Term Support) for stability.

Current for latest features.

Playwright: Installed and configured with TypeScript.

CI/CD: Integrated with GitHub Actions for automated cloud test execution.

🏗 Project Structure
I have implemented a professional 4-tier testing architecture:

tests/system-testing: Isolated component testing.

tests/integration-testing: Testing interactions between modules.

tests/e2e-testing: Full end-to-end user journeys.

tests/regression: Stability checks for existing features.

🚀 How to Run
Install dependencies: npm install

Install browsers: npx playwright install

Run tests: npx playwright test
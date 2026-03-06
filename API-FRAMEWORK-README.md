# API Testing Framework

> **Zero-code API testing for technical and non-technical testers.**
> Define your tests in Excel. Write assertions in plain text. Run with one command.

---

## Table of Contents

1. [Overview](#overview)
2. [How It Works](#how-it-works)
3. [Project Structure](#project-structure)
4. [Quick Start](#quick-start)
5. [Run Commands](#run-commands)
6. [The Registry — apiRegistry.xlsx](#the-registry--apiregistryxlsx)
   - [APIRegistry Sheet](#apiregistry-sheet)
   - [APIRequests Sheet](#apirequests-sheet)
   - [Column Reference](#column-reference)
7. [Assertion Files](#assertion-files)
   - [File Location](#file-location)
   - [Syntax Overview](#syntax-overview)
   - [Status and Performance](#status-and-performance)
   - [Existence Checks](#existence-checks)
   - [Value Checks](#value-checks)
   - [Type Checks](#type-checks)
   - [Array and Wildcard Assertions](#array-and-wildcard-assertions)
   - [Nested Array Assertions](#nested-array-assertions)
   - [Header Assertions](#header-assertions)
   - [Importing Shared Assertions](#importing-shared-assertions)
8. [Request Templates](#request-templates)
9. [Response Chaining](#response-chaining)
10. [Authentication](#authentication)
11. [Test Phases — Setup, Test, Teardown](#test-phases--setup-test-teardown)
12. [Environments](#environments)
13. [Tags and Filtering](#tags-and-filtering)
14. [Reports](#reports)
15. [Adding a New Test — Step by Step](#adding-a-new-test--step-by-step)
16. [Troubleshooting](#troubleshooting)
17. [Assertion Quick Reference](#assertion-quick-reference)

---

## Overview

This framework allows anyone — technical or non-technical — to write and run API tests without writing any code.

**A tester's complete workflow:**

1. Add a row to `apiRegistry.xlsx` describing the request
2. Create a `.assert.txt` file describing what the response should look like
3. Run `npx playwright test --project=api`

That's it. No TypeScript. No JavaScript. No programming knowledge required.

---

## How It Works

```
apiRegistry.xlsx
      │
      ▼
apiGlobalSetup.ts          ← runs once before all tests
  reads Excel
  validates columns
  generates apiRegistry.json
      │
      ▼
apiRunner.test.ts          ← one generic runner, never edited
  reads apiRegistry.json
  generates one test per flow automatically
      │
      ▼
apiTest.ts (fixture)       ← orchestrates each flow
  builds HTTP request
  sends request
  extracts values for chaining
  runs assertion file
  returns pass/fail
      │
      ▼
CustomReporter.ts          ← generates HTML report
```

---

## Project Structure

```
project-root/
│
├── api/                           ← Framework engine (do not edit)
│   ├── clients/
│   │   └── HttpClient.ts          ← Sends HTTP requests
│   ├── core/
│   │   ├── AssertionEngine.ts     ← Evaluates assertion rules
│   │   ├── AssertionParser.ts     ← Reads .assert.txt files
│   │   ├── AuthManager.ts         ← Handles Bearer/Basic/ApiKey auth
│   │   ├── RequestBuilder.ts      ← Builds requests from registry + templates
│   │   ├── ResponseStore.ts       ← Stores values between chained steps
│   │   └── TemplateEngine.ts      ← Resolves {{placeholders}} in requests
│   └── fixtures/
│       └── apiTest.ts             ← Playwright fixture (runFlow)
│
├── data/
│   └── api/
│       ├── apiRegistry.xlsx       ← ✏️  TESTER EDITS THIS
│       ├── apiEnvironments.json   ← Environment base URLs
│       ├── assertions/            ← ✏️  TESTER CREATES THESE
│       │   ├── base/
│       │   │   └── api-common.assert.txt
│       │   ├── users/
│       │   │   └── get-users.assert.txt
│       │   └── posts/
│       │       └── get-posts.assert.txt
│       └── templates/             ← ✏️  TESTER CREATES THESE
│           └── auth/
│               └── login.json
│
├── tests/
│   └── api-testing/
│       └── apiRunner.test.ts      ← Generic runner (do not edit)
│
├── types/
│   └── ApiTestData.ts             ← TypeScript types (do not edit)
│
└── utils/
    └── setup/
        ├── masterSetup.ts         ← Orchestrates setup (do not edit)
        └── apiGlobalSetup.ts      ← Processes Excel registry (do not edit)
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Install dependencies
npm install

# Install Playwright browsers (if not already installed)
npx playwright install
```

### First Run

```bash
npx playwright test --project=api
```

On the first run:
- `apiGlobalSetup` reads `apiRegistry.xlsx` and generates `apiRegistry.json`
- All enabled flows are discovered and run automatically
- An HTML report is generated in `custom-reports/`

---

## Run Commands

```bash
# Run all API tests
npx playwright test --project=api

# Run all UI tests
npx playwright test --project=chromium --project=firefox --project=webkit

# Run everything (UI + API)
npx playwright test

# Run a specific flow by ID
npx playwright test --project=api --grep "USERS-01"

# Run all flows tagged @smoke
npx playwright test --project=api --grep "@smoke"

# Run all flows tagged @smoke AND @regression
npx playwright test --project=api --grep "@smoke" --grep "@regression"

# Run against a specific environment
ENV=PROD npx playwright test --project=api

# Run with verbose console output
npx playwright test --project=api --reporter=list

# Show the last HTML report
npx playwright show-report

# Dry run — list tests without running them
npx playwright test --project=api --list
```

### npm Scripts (shorthand)

Add these to `package.json` for convenience:

```json
"scripts": {
  "test:api":  "playwright test --project=api",
  "test:ui":   "playwright test --project=chromium --project=firefox --project=webkit",
  "test:all":  "playwright test",
  "test:smoke": "playwright test --project=api --grep @smoke"
}
```

Then run:

```bash
npm run test:api
npm run test:smoke
```

---

## The Registry — apiRegistry.xlsx

The Excel file is the single source of truth for all API tests. It has two sheets.

### APIRegistry Sheet

Each row is one **step** in a flow. Steps with the same `FlowID` belong to the same test.

| FlowID | TestCaseID | StepOrder | Phase | Description | Method | Endpoint | ... |
|---|---|---|---|---|---|---|---|
| USERS-01 | USERS-01-S1 | 1 | test | Get all users | GET | /users | ... |
| AUTH-01 | AUTH-01-S1 | 1 | setup | Login | POST | /auth/login | ... |
| AUTH-01 | AUTH-01-S2 | 2 | test | Get profile | GET | /auth/me | ... |

### APIRequests Sheet

Each row provides the placeholder values for a step's request body or URL.

| TestCaseID | username | password | expiresInMins |
|---|---|---|---|
| AUTH-01-S1 | emilys | emilyspass | 30 |

### Column Reference

#### Identity Columns

| Column | Required | Description | Example |
|---|---|---|---|
| `FlowID` | ✅ | Groups steps into one test | `USERS-01` |
| `TestCaseID` | ✅ | Unique step identifier | `USERS-01-S1` |
| `StepOrder` | ✅ | Execution order within flow | `1`, `2`, `3` |
| `Phase` | ✅ | When the step runs | `setup`, `test`, `teardown` |
| `Description` | ✅ | Human-readable step name | `Get all users` |
| `Priority` | ✅ | Test priority | `P0`, `P1`, `P2`, `P3` |
| `Tags` | ✅ | Filter tags | `@smoke @regression` |
| `Run` | ✅ | Enable/disable this step | `TRUE`, `FALSE` |
| `Environment` | ✅ | Target environment | `QA`, `PROD` |

#### Request Columns

| Column | Required | Description | Example |
|---|---|---|---|
| `Protocol` | ✅ | API protocol | `REST`, `GraphQL` |
| `Method` | ✅ | HTTP method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `Endpoint` | ✅ | Path or full URL | `/users`, `/posts/{{postId}}` |
| `BaseUrl` | ❌ | Overrides environment base URL | `https://api.external.com` |
| `AuthType` | ✅ | Authentication type | `Bearer`, `Basic`, `ApiKey`, `None` |
| `ContentType` | ❌ | Request content type | `application/json` (default) |

#### Data Columns

| Column | Required | Description | Example |
|---|---|---|---|
| `TemplatePath` | ❌ | JSON body template file | `templates/auth/login.json` |
| `AssertionFile` | ❌ | Assertion rules file | `users/get-users.assert.txt` |
| `ExtractAs` | ❌ | Store a response value for later steps | `authToken` |
| `DependsOn` | ❌ | Skip this step if prerequisite failed | `AUTH-01-S1` |

#### Reliability Columns

| Column | Required | Description | Example |
|---|---|---|---|
| `MaxResponseTime` | ❌ | Override global response time limit (ms) | `3000` |
| `RetryCount` | ❌ | Retry on failure | `2` |
| `RetryDelay` | ❌ | Milliseconds between retries | `1000` |
| `MaskFields` | ❌ | Hide values in logs | `password,token` |

---

## Assertion Files

Assertion files are plain text files that describe what a response should look like. No code required.

### File Location

```
data/api/assertions/<domain>/<name>.assert.txt
```

Examples:
```
data/api/assertions/users/get-users.assert.txt
data/api/assertions/auth/login.assert.txt
data/api/assertions/posts/create-post.assert.txt
data/api/assertions/base/api-common.assert.txt
```

Reference the file in `apiRegistry.xlsx` under the `AssertionFile` column:
```
users/get-users.assert.txt
```

### Syntax Overview

```
# Lines starting with # are comments — ignored by the engine

path  operator  value
```

Three parts per line:
- **path** — where to look in the response
- **operator** — what check to perform
- **value** — what to compare against (not needed for `exists`, `type` needs a type keyword)

---

### Status and Performance

```
# HTTP status code
status == 200
status != 404
status < 500
status >= 200

# Response time in milliseconds
responseTime < 2000ms
responseTime < 500ms
```

---

### Existence Checks

```
# Field must exist (not null, not undefined)
body.user.id exists
body.accessToken exists
body.results exists

# Field must not exist
body.user.deletedAt notExists
body.error notExists
```

---

### Value Checks

```
# Equals
body.user.firstName == Emily
body.status == active
body.total == 100

# Not equals
body.status != inactive
body.error != null

# Numeric comparisons
body.total > 0
body.total >= 1
body.limit <= 100
body.price < 999.99

# String contains (case-insensitive)
body.message contains success
header.content-type contains application/json
```

---

### Type Checks

Type checks validate the data type of a field — not its value.

#### Primitive Types

```
# Integer — whole number only (1, 42) — fails on 1.5 or "1"
body.id type integer
body.total type integer
body.users[*].age type integer

# Number — any number including decimals
body.price type number
body.rating type number

# String — any text value
body.firstName type string
body.title type string

# Boolean — true or false only
body.active type boolean
body.verified type boolean

# Array — a list of items
body.users type array
body.tags type array
body.results type array

# Object — a key-value object
body.address type object
body.metadata type object

# Null — value is exactly null
body.deletedAt type null
```

#### Format Types

```
# Email address — must be valid format (user@domain.com)
body.email type email
body.users[*].email type email

# URL — must be valid http or https URL
body.avatar type url
body.profileUrl type url

# Date — YYYY-MM-DD or ISO 8601 format
body.birthDate type date
body.createdAt type date

# UUID — valid UUID v1-v5 format
body.id type uuid
body.sessionId type uuid
```

---

### Array and Wildcard Assertions

Use `[*]` to check **every item** in an array.

```
# Every item in the array must have id as integer
body.users[*].id type integer

# Every item must have email as valid email
body.users[*].email type email

# Every item's price must be greater than 0
body.products[*].price > 0

# Every item must have a title field
body.posts[*].title exists

# Every item's status must equal active
body.users[*].status == active

# Array length checks
body.users.length > 0
body.users.length == 10
body.results.length >= 1

# Check specific index
body.users[0].firstName == Emily
body.results[0].id == 101

# Array contains an item where field=value
body.tags contains name=admin
body.permissions contains type=read
```

---

### Nested Array Assertions

Use multiple `[*]` for arrays inside arrays.

```
# Example response:
# {
#   "orders": [
#     {
#       "id": 1,
#       "items": [
#         { "productId": 10, "qty": 2, "price": 29.99 },
#         { "productId": 11, "qty": 1, "price": 49.99 }
#       ]
#     }
#   ]
# }

# Check every item inside every order
body.orders[*].items[*].productId type integer
body.orders[*].items[*].qty type integer
body.orders[*].items[*].price type number
body.orders[*].items[*].productId exists
body.orders[*].items[*].qty > 0
body.orders[*].items[*].price > 0

# Triple nesting
body.orders[*].items[*].tags[*] type string
body.categories[*].products[*].images[*].url type url
```

---

### Header Assertions

```
# Header exists and contains value
header.content-type contains application/json
header.content-type == application/json; charset=utf-8

# Header must be present
header.authorization exists

# Cache control
header.cache-control == no-cache
```

Header names are **case-insensitive** — `header.Content-Type` and `header.content-type` both work.

---

### Importing Shared Assertions

Avoid repeating the same rules in every file by using `import`.

```
# data/api/assertions/base/api-common.assert.txt
# Apply this to every test
status < 500
responseTime < 5000ms
header.content-type contains application/json
```

```
# data/api/assertions/users/get-users.assert.txt
import base/api-common.assert.txt    ← pulls in the 3 rules above

status == 200
body.users type array
body.users[*].id type integer
```

Import paths are relative to the `assertions/` folder. Circular imports are detected and blocked automatically.

---

## Request Templates

When an API requires a request body, create a JSON template file.

### File Location

```
data/api/templates/<domain>/<name>.json
```

### Example Template

```json
{
  "username": "{{username}}",
  "password": "{{password}}",
  "expiresInMins": "{{expiresInMins}}"
}
```

### Placeholder Values

Provide the values in the `APIRequests` sheet:

| TestCaseID | username | password | expiresInMins |
|---|---|---|---|
| AUTH-01-S1 | emilys | emilyspass | 30 |

### Supported Placeholder Formats

```
{{fieldName}}              ← value from APIRequests sheet
{{env.ENV_VAR_NAME}}       ← value from .env file
{{STEP-ID.extractedKey}}   ← value extracted from a previous step
```

---

## Response Chaining

Extract a value from one step's response and use it in a later step.

### Step 1 — Extract the token

In `apiRegistry.xlsx`:

| TestCaseID | ExtractAs |
|---|---|
| AUTH-01-S1 | authToken |

This stores `response.body.accessToken` under the key `authToken`.

### Step 2 — Use the token

In the endpoint or template of a later step:

```
Endpoint: /auth/me
AuthType: Bearer
```

The framework automatically attaches the stored token as a Bearer header. No extra configuration needed.

### Using extracted values in endpoints

```
# In the Endpoint column:
/posts/{{AUTH-01-S1.postId}}
/users/{{AUTH-01-S1.userId}}/orders
```

### DependsOn — Skip if prerequisite failed

If Step 2 depends on Step 1 succeeding:

| TestCaseID | DependsOn |
|---|---|
| AUTH-01-S2 | AUTH-01-S1 |

If `AUTH-01-S1` fails, `AUTH-01-S2` is automatically skipped rather than failing with a confusing error.

---

## Authentication

Set `AuthType` in the registry for each step that requires authentication.

| AuthType | What it does |
|---|---|
| `None` | No authentication header added |
| `Bearer` | Adds `Authorization: Bearer <token>` using the stored token |
| `Basic` | Adds `Authorization: Basic <base64>` using username/password from environment |
| `ApiKey` | Adds the API key header as configured in `apiEnvironments.json` |

### Storing credentials

Never put real passwords in Excel. Use `.env`:

```bash
# .env
QA_API_KEY=your-api-key-here
QA_USERNAME=testuser
QA_PASSWORD=testpass
```

Reference in templates:
```json
{
  "username": "{{env.QA_USERNAME}}",
  "password": "{{env.QA_PASSWORD}}"
}
```

---

## Test Phases — Setup, Test, Teardown

Every flow can have three phases. Set the `Phase` column in the registry.

| Phase | Purpose | Runs when |
|---|---|---|
| `setup` | Prepare data before the test — e.g. login, create a record | Always, before test steps |
| `test` | The actual test steps being validated | Always |
| `teardown` | Clean up after the test — e.g. delete created records | Always, even if test steps fail |

### Example — Full CRUD flow

| FlowID | TestCaseID | StepOrder | Phase | Description |
|---|---|---|---|---|
| POSTS-02 | POSTS-02-S1 | 1 | setup | Login and get token |
| POSTS-02 | POSTS-02-S2 | 2 | test | Create a new post |
| POSTS-02 | POSTS-02-S3 | 3 | test | Update the post |
| POSTS-02 | POSTS-02-S4 | 4 | teardown | Delete the post |

Teardown always runs — if the test step fails, the created post is still deleted. This prevents test data pollution.

---

## Environments

Configure base URLs per environment in `data/api/apiEnvironments.json`:

```json
{
  "QA": {
    "apiBaseUrl": "https://dummyjson.com"
  },
  "PROD": {
    "apiBaseUrl": "https://api.yourapp.com"
  }
}
```

### Switch environments at runtime

```bash
# Run against QA (default)
npx playwright test --project=api

# Run against PROD
ENV=PROD npx playwright test --project=api
```

The `Environment` column in the registry filters which rows are active for a given environment.

---

## Tags and Filtering

Add tags to the `Tags` column in `apiRegistry.xlsx`:

```
@smoke @regression
@smoke @auth
@regression @negative
```

### Filter by tag when running

```bash
# Only smoke tests
npx playwright test --project=api --grep "@smoke"

# Only auth tests
npx playwright test --project=api --grep "@auth"

# Exclude negative tests
npx playwright test --project=api --grep-invert "@negative"
```

### Recommended tag conventions

| Tag | Use for |
|---|---|
| `@smoke` | Critical path — run on every deployment |
| `@regression` | Full regression suite |
| `@negative` | Negative / error scenario tests |
| `@auth` | Authentication flows |
| `@crud` | Create/Read/Update/Delete flows |

---

## Reports

An HTML report is automatically generated after every run.

```
custom-reports/
└── LearnPlaywright-2026-03-06-10-01.html
```

### Open the last report

```bash
npx playwright show-report
```

### Report contents

**Overall summary** — total, passed, failed, skipped, flaky counts with pass rate.

**Tab switcher** — when running both UI and API tests, switch between All / UI / API views.

**API section includes:**
- Pass rate donut chart
- Response time distribution chart (fast / ok / slow / very slow)
- Priority distribution chart
- Tag coverage chart
- Flow results table with Flow ID, description, priority, tags, duration, status, error

**Filters** — filter by pass / fail / skip / flaky status. Search by flow ID, tag, or description.

---

## Adding a New Test — Step by Step

Here is the complete process for adding a new API test from scratch.

### Example — Test `GET /products`

**Step 1 — Add a row to `APIRegistry` sheet in `apiRegistry.xlsx`**

| FlowID | TestCaseID | StepOrder | Phase | Description | Protocol | Method | Endpoint | AuthType | AssertionFile | Priority | Tags | Run | Environment |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PRODUCTS-01 | PRODUCTS-01-S1 | 1 | test | Get all products | REST | GET | /products | None | products/get-products.assert.txt | P2 | @smoke @regression | TRUE | QA |

**Step 2 — Create the assertion file**

Create `data/api/assertions/products/get-products.assert.txt`:

```
import base/api-common.assert.txt

# Status
status == 200

# Structure
body.products type array
body.total type integer
body.skip type integer
body.limit type integer

# Every product must have these fields with correct types
body.products[*].id type integer
body.products[*].title type string
body.products[*].price type number
body.products[*].stock type integer

# Values
body.total > 0
body.products.length > 0
body.products[*].id exists
body.products[*].title exists
body.products[*].price > 0
```

**Step 3 — Run**

```bash
npx playwright test --project=api --grep "PRODUCTS-01"
```

The test appears automatically. No code changes required.

---

## Troubleshooting

### `apiRegistry.json not found`

```
[apiRunner] apiRegistry.json not found
```

The setup hasn't run yet. Run the full suite once to generate it:

```bash
npx playwright test --project=api
```

### `Flow not found in apiRegistry.json`

```
[apiTest] Flow "PRODUCTS-01" not found
```

Either:
- The `FlowID` is misspelled in `apiRunner` or Excel
- `Run=FALSE` for all steps in that flow
- The Excel file hasn't been re-processed — delete `apiRegistry.json` and re-run

### `Assertion file not found`

```
[AssertionParser] Assertion file not found: ".../products/get-products.assert.txt"
```

The file path in the `AssertionFile` column doesn't match the actual file. Check:
- Spelling of folder and filename
- The path is relative to `data/api/assertions/` — do not include that prefix

### `Type assertion failed — got "string" expected "integer"`

The API is returning a string where you expect a number:
```
body.id type integer  →  FAIL: Expected type "integer" but got "string" (value: "42")
```

Either the API has a bug (field type changed) or your assertion is wrong. Check the actual response to confirm.

### `Schema/assertion failure on [*] wildcard — 0 items`

```
Expected "body.users" to be an array, got: undefined
```

The path is wrong. Check the actual response structure — the array might be at `body.data.users` not `body.users`.

### `TemplatePath not found`

```
[PRODUCTS-02-S1] TemplatePath not found: ".../templates/products/create.json"
```

Create the template file at the path specified in the Excel `TemplatePath` column.

### Passwords not loading from `.env`

```
⚠️  The following .env password keys are not set
```

Add the missing keys to your `.env` file at the project root:

```bash
QA_STANDARD_PASS=yourpassword
QA_API_KEY=yourapikey
```

---

## Assertion Quick Reference

```
# ── Status ────────────────────────────────────────────────────
status == 200
status != 404
status < 500
status >= 200

# ── Performance ───────────────────────────────────────────────
responseTime < 2000ms

# ── Headers ───────────────────────────────────────────────────
header.content-type contains application/json
header.authorization exists

# ── Existence ─────────────────────────────────────────────────
body.id exists
body.deletedAt notExists

# ── Values ────────────────────────────────────────────────────
body.name == John
body.status != inactive
body.total > 0
body.total >= 1
body.limit <= 100
body.message contains success

# ── Primitive Types ───────────────────────────────────────────
body.id type integer          ← whole number only
body.price type number        ← any number inc. decimals
body.name type string
body.active type boolean
body.tags type array
body.address type object
body.deletedAt type null

# ── Format Types ──────────────────────────────────────────────
body.email type email
body.website type url
body.birthDate type date
body.sessionId type uuid

# ── Arrays ────────────────────────────────────────────────────
body.users.length > 0
body.users.length == 10
body.users[0].name == Emily
body.users[*].id type integer
body.users[*].email type email
body.users[*].price > 0
body.users[*].name exists
body.tags contains name=admin

# ── Nested Arrays ─────────────────────────────────────────────
body.orders[*].items[*].productId type integer
body.orders[*].items[*].price > 0
body.orders[*].items[*].name exists
body.categories[*].products[*].images[*].url type url

# ── Import shared rules ───────────────────────────────────────
import base/api-common.assert.txt
```

---

*Generated for LearnPlaywright API Testing Framework*

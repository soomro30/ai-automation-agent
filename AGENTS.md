# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

This is a **production-ready Electron desktop application** for browser automation, built with TypeScript using the Stagehand framework (https://docs.stagehand.dev). The application provides a modern GUI for non-technical users to run automation agents for UAE government portals (TAMM, Dari).

**Key Features:**
- Cross-platform desktop app (Windows, macOS, Linux)
- Modern UI with IMKAN branding, powered by SAAL.AI
- Zero configuration for end users (auto .env creation)
- Native file upload for Excel files
- Downloads organized by agent type and date
- Live console output and error handling
- Settings management (basic + advanced)
- Mobile number input in UI

### Current Agents (2 Active)

1. **Dari Title Deed Agent**: Fully automated title deed generation and download system for Dari platform using Excel-based plot data
2. **Dari Affection Plan Agent**: Fully automated verification certificate (unit) purchase and download system with batch payment validation

## Technology Stack

### Core Technologies
- **Desktop Framework**: Electron 39.0+ (cross-platform desktop apps)
- **Automation Framework**: Stagehand 2.0+ (@browserbasehq/stagehand)
- **Language**: TypeScript 5.7+
- **Runtime**: Node.js (ES Modules with .js imports)
- **Browser Mode**: LOCAL (local Chromium with stealth features)
- **Build Tool**: electron-builder 26.0+ (packaging for Windows/macOS/Linux)

### Additional Libraries
- **dotenv**: Environment variable management
- **zod**: Schema validation
- **xlsx**: Excel file parsing
- **electron**: Desktop application framework
- **fsevents** (optional): macOS file system events

## Architecture

The project follows a **dual-mode architecture**: Electron desktop app + standalone CLI agents.

### Electron Desktop App (Primary Mode)

**Main Process** (`electron/main.cjs`):
- Backend logic running in Node.js
- IPC communication with renderer
- File system operations (settings, .env, downloads)
- Agent process spawning and management
- Auto .env creation with bundled credentials

**Preload Script** (`electron/preload/preload.cjs`):
- Secure IPC bridge between main and renderer
- Exposes limited API to renderer via contextBridge

**Renderer Process** (`electron/renderer/`):
- Frontend UI (HTML, CSS, JavaScript)
- Agent selection cards (Title Deed, Affection Plan)
- File upload interface
- Settings management
- Live console output
- No direct Node.js access (security)

**Assets** (`electron/assets/`):
- Application icons (default Electron icon currently used)

### Agent Core (Shared Between Modes)

1. **Agent Registry** (`src/agents/agent-registry.ts`):
   - Central registry for 2 active agents
   - Metadata: id, name, description, icon

2. **Agent Implementations**:
   - `src/agents/dari-title-deed-agent.ts`: Title deed automation
   - `src/agents/dari-affection-plan-agent.ts`: Verification certificate (unit) automation

3. **Configuration Management** (`src/config.ts`):
   - Environment-based config using dotenv
   - Electron bridge integration for UI settings
   - Mobile number from UI (not .env)
   - Config validation with detailed errors

4. **Electron Bridge** (`src/electron-bridge.ts`):
   - Loads config from Electron IPC (JSON file)
   - Merges with default agent config
   - Provides mobile number from UI
   - Falls back to CLI defaults if not in Electron mode

5. **Utility Functions**:
   - `src/utils/retry.ts`: Exponential backoff retry mechanism
   - `src/utils/excel-reader.ts`: Excel file parsing for plot data

### Agent Implementation Pattern

Each agent follows this structure:
- `initialize()`: Sets up Stagehand instance with stealth features
- `executeWorkflow()`: Main workflow orchestration
- `close()`: Cleanup and browser session termination
- Individual step methods with retry logic and error handling
- Constructor: Checks for Electron config and merges with defaults

### Dari Title Deed Agent Workflow

**Complete 21-step automation process:**

1. Navigate to https://www.dari.ae/en/
2. Click Login button (top right)
3. Click "Login with UAE Pass"
4. Enter mobile number and handle captcha (20-second window)
5. Click Login/Authorize button
6. **Automatic UAE Pass Detection**: Agent continuously monitors URL and page state using Stagehand's observe() API, detects login completion without user input (up to 3 minutes timeout)
7. Verify successful login with page observation
8. Navigate to Services menu
9. Select Title Deed (Unit) Service
10. Load plot numbers from `data/units.xlsx`
11. For each plot: Enter plot number in search filter
12. Click Show Results to filter units
13. Click filtered unit and Proceed button
14. Extract generated Application ID
15. Repeat for all plots in Excel file
16. Navigate to Applications menu
17. Search each application by Application ID
18. Click View Application for each
19. Check if title deed is ready (or "in progress")
20. Download ready title deeds (with automatic retry for pending ones)
21. Track all downloads with 5-minute retry intervals until complete

**Key Features:**
- Reads Excel file with plot data from `data/units.xlsx`
- **Smart Loop Processing**: Repeats Title Deed service for each plot from Excel
- **Memory Tracking**: Saves all Application IDs in browser memory (ApplicationRecord interface)
- **Intelligent Observation**: Uses `observe()` API at each critical step to verify page state
- **Search & Filter**: Filters applications by Application ID on left side panel
- **Status Detection**: Observes top right corner for Download button and title deed readiness
- **Smart Retry**: Checks every 5 minutes if title deed is ready, refreshes and re-observes
- **Automatic Download**: Only downloads when observe() detects Download button is present
- **Max 5 retries** with 5-minute intervals between attempts
- **Comprehensive Logging**: Shows observation results at each stage for transparency
- **Final Summary**: Complete report of all applications generated and downloaded

### Dari Site Plan Agent Workflow

**Complete 10-step automation process:**

1. Navigate to https://www.dari.ae/en/ (configurable)
2. Observe page load and click Login button (top right)
3. Click "Login with UAE Pass"
4. Enter mobile number (971559419961), enable Remember me, handle captcha (configurable timeout)
5. **Automatic UAE Pass Detection**: Agent monitors URL and page state, detects login completion automatically (configurable timeout, default 3 minutes)
6. **Switch Account** (optional - can be disabled):
   - Click user menu in top header
   - Select "Switch Account" from dropdown
   - Navigate to account selection page
   - Select configured account profile (e.g., "Al Jurf Hospitality Service")
   - Return to Dari homepage with correct account
7. Navigate to Services menu in top navigation bar (configurable menu name)
8. Select Site Plan service from services page (configurable service name)
9. Load plot numbers from Excel file (configurable path and column)
10. **For each plot** (smart loop processing):
   - Enter Plot Number in left side filter
   - Click Show Results to search
   - **Observe** search results - skip if "You don't own any property" message appears
   - Click matched property and Proceed button
   - **Extract** Application ID from left side
   - **Select** Dari Wallet payment option (right side)
   - **Observe** wallet balance and payment amount using regex patterns
   - **Verify** sufficient balance (balance >= payment amount)
   - Click Pay Now if balance is sufficient (respects config.payment.enabled flag)
   - **Attempt** certificate download after payment
   - Navigate back to Site Plan service for next plot

**Key Features:**
- **Fully Configurable**: All settings in `src/config/dari-site-plan-config.ts`
- Reads Excel file with plot data (configurable path and column)
- **Account Management**: Optional account switching with configurable target account
- **Smart Captcha Detection**: Only waits for captcha if actually present on page
- **Configurable Wait Times**: Page load, clicks, captcha, UAE Pass timeout
- **Smart Ownership Check**: Automatically skips plots not owned by user
- **Intelligent Payment**: Verifies Dari Wallet balance before attempting payment
- **Balance Validation**: Uses regex patterns to extract wallet balance vs payment amount
- **Payment Safety**: Payment disabled by default (config.payment.enabled = false)
- **Comprehensive Observation**: Uses `observe()` at each step for state verification
- **Intelligent Navigation**: Always ensures on correct Site Plan service page before processing
- **Error Handling**: Tracks failures (no property, insufficient balance, extraction errors)
- **Final Summary**: Complete report showing paid/downloaded/failed status for all plots
- **Application ID Tracking**: Stores Application IDs for successful transactions

**Configuration System:**

The agent uses a comprehensive configuration file at `src/config/dari-site-plan-config.ts`:

```typescript
export const defaultDariSitePlanConfig = {
  baseUrl: 'https://www.dari.ae/en/',
  excelFilePath: 'data/siteplan.xlsx',
  plotColumnIndex: 2,  // 3rd column (0-based)

  navigation: {
    servicesMenuText: 'Services',
    sitePlanServiceText: 'Site Plan',
  },

  accountSwitching: {
    enabled: true,  // Set false to skip account switching
    targetAccountName: 'Al Jurf Hospitality Service',
  },

  payment: {
    enabled: false,  // Set true to enable real payments
    walletBalancePattern: /Balance\s*:?\s*ß\s*(\d+(?:\.\d+)?)/i,
    totalAmountPattern: /Total\s+to\s+be\s+paid\s*ß\s*(\d+(?:\.\d+)?)/i,
  },

  waitTimes: {
    pageLoad: 3000,
    captcha: 20000,
    uaePassTimeout: 180000,
  },
};
```

**Customizing the Agent:**

1. **Change service name**: Update `navigation.sitePlanServiceText`
2. **Use different account**: Update `accountSwitching.targetAccountName`
3. **Disable account switching**: Set `accountSwitching.enabled = false`
4. **Enable payments**: Set `payment.enabled = true` ⚠️ Use with caution!
5. **Different Excel column**: Update `plotColumnIndex` (0=1st, 1=2nd, 2=3rd, etc.)
6. **Adjust timeouts**: Modify values in `waitTimes`

See `src/config/dari-site-plan-config.example.ts` for detailed examples.

### Dari Affection Plan Agent Workflow

**Complete 17-step automation process:**

1. Navigate to https://www.dari.ae/en/ (configurable)
2. Observe page load and click Login button (top right)
3. Click "Login with UAE Pass"
4. Enter mobile number, enable Remember me, handle captcha (configurable timeout)
5. Click Login/Authorize button
6. **Automatic UAE Pass Detection**: Agent monitors URL and page state, detects login completion automatically (configurable timeout, default 3 minutes)
7. **Switch Account** (optional - can be disabled):
   - Click user menu in top header
   - Select "Switch Account" from dropdown
   - Navigate to account selection modal/popup
   - Select configured account profile (e.g., "Al Jurf Hospitality Service")
   - Wait for page reload with new account
8. Navigate to Services menu in top navigation bar (configurable menu name)
9. Select Verification Certificate (Unit) service from services page (configurable service name)
10. Load plot numbers from Excel file (configurable path and column)
11. **For each plot** (smart loop processing with batch payment validation):
   - Navigate to Verification Certificate service page
   - Enter Plot Number in left side filter
   - Click Show Results to search
   - **Observe** search results
   - Click matched property and Proceed button
   - **Extract** Application ID from page
   - **ON FIRST PLOT ONLY**: Perform batch payment validation
     - Calculate total required amount: `plots × payment_amount`
     - Compare total required vs wallet balance
     - **If insufficient**: Stop BEFORE any payment, show detailed breakdown
     - **If sufficient**: Proceed with confidence all plots will complete
   - **Select** Dari Wallet payment option
   - **Observe** wallet balance and payment amount
   - **Verify** sufficient balance (for current plot after batch check passed)
   - Click Pay Now to complete payment
   - **Attempt** certificate download after payment
   - Navigate back to Verification Certificate service for next plot
12. Track all results with payment and download status

**Key Features:**
- **Fully Configurable**: All settings in `src/config/dari-affection-plan-config.ts`
- Reads Excel file with plot data (configurable path and column)
- **Account Management**: Optional account switching with configurable target account (same as Site Plan)
- **Production-Grade Batch Payment Validation**:
  - On first plot, validates total balance for ALL plots
  - Prevents partial payments and wasted money
  - Shows exact calculation: `plots × payment_amount` vs wallet balance
  - If insufficient: stops immediately with clear guidance on amount needed
  - If sufficient: proceeds with confidence entire batch will complete
- **Smart Captcha Detection**: Only waits for captcha if actually present on page
- **Configurable Wait Times**: Page load, clicks, captcha, UAE Pass timeout
- **Intelligent Payment**: Verifies Dari Wallet balance before attempting payment
- **Balance Validation**: Extracts and compares wallet balance vs payment amount
- **Comprehensive Observation**: Uses `observe()` at each step for state verification
- **Intelligent Navigation**: Always ensures on correct service page before processing
- **Application ID Tracking**: Extracts and stores Application IDs for all processed plots
- **Error Handling**: Tracks failures (no property, insufficient balance, extraction errors)
- **Final Summary**: Complete report showing paid/downloaded/failed status for all plots
- **Financial Safety**: Batch validation ensures no money wasted on incomplete batches

**Configuration System:**

The agent uses a comprehensive configuration file at `src/config/dari-affection-plan-config.ts`:

```typescript
export const defaultDariAffectionPlanConfig = {
  baseUrl: 'https://www.dari.ae/en/',
  mobileNumber: '0559419961',
  excelFilePath: 'data/siteplan_imkan.xlsx',
  plotColumnIndex: 2,  // 3rd column (0-based)

  navigation: {
    servicesMenuText: 'Services',
    affectionPlanServiceText: 'Verification Certificate (Unit)',
  },

  accountSwitching: {
    enabled: false,  // Set true to enable account switching
    targetAccountName: 'Al Jurf Hospitality Service',
  },

  waitTimes: {
    pageLoad: 3000,
    afterClick: 1500,
    captcha: 20000,        // 20 seconds for manual CAPTCHA solving
    uaePassTimeout: 180000, // 3 minutes for UAE Pass 2FA
    domSettle: 3000,
  },

  detection: {
    loginSuccessIndicators: [
      'logout',
      'profile',
      'dashboard',
      'my account',
    ],
    uaePassUrlPattern: /uaepass|staging-id\.uae/i,
  },
};
```

**Customizing the Agent:**

1. **Change service name**: Update `navigation.affectionPlanServiceText`
2. **Use different account**: Update `accountSwitching.targetAccountName`
3. **Enable account switching**: Set `accountSwitching.enabled = true`
4. **Different Excel file**: Update `excelFilePath`
5. **Different Excel column**: Update `plotColumnIndex` (0=1st, 1=2nd, 2=3rd, etc.)
6. **Adjust timeouts**: Modify values in `waitTimes`

**Batch Payment Validation Logic:**

The agent's most critical production-grade feature:

```typescript
// On FIRST plot only
const totalPlots = this.plots.length;
const totalRequired = amount * totalPlots;

if (balance < totalRequired) {
  // Calculate shortage
  const shortage = totalRequired - balance;

  // Stop BEFORE any payment
  // Show detailed calculation
  // Inform user exactly how much to add
  throw new Error(`Need ${totalRequired.toFixed(2)} AED for ${totalPlots} plots, have ${balance.toFixed(2)} AED. Add ${shortage.toFixed(2)} AED and restart.`);
}

// If sufficient, proceed with all plots
console.log(`✅ SUFFICIENT BALANCE FOR ALL PLOTS!`);
```

**Benefits:**
- **No Partial Payments**: Either all plots succeed or none are attempted
- **Clear Guidance**: User knows exactly how much money to add
- **Financial Safety**: No money wasted on incomplete batches
- **Production-Grade**: Validates upfront before any transactions

## Project Structure

```
ai-automation-agent/
├── electron/                         # Electron desktop app
│   ├── main.cjs                     # Main process (backend, CommonJS)
│   ├── preload/
│   │   └── preload.cjs              # IPC bridge (CommonJS)
│   ├── renderer/
│   │   ├── index.html               # UI markup with IMKAN branding
│   │   ├── styles.css               # Modern blue theme styling
│   │   └── app.js                   # Frontend logic
│   └── assets/
│       └── icon.png                 # App icon (default Electron icon)
├── src/                              # Automation agents (ES Modules)
│   ├── index.ts                     # CLI entry point
│   ├── config.ts                    # Environment configuration
│   ├── electron-bridge.ts           # Electron ↔ Agent config bridge
│   ├── config/
│   │   └── dari-affection-plan-config.ts
│   ├── agents/
│   │   ├── agent-registry.ts              # 2 agents registered
│   │   ├── dari-title-deed-agent.ts       # Title deed automation
│   │   └── dari-affection-plan-agent.ts   # Verification certificate automation
│   ├── ui/
│   │   └── agent-selector.ts        # CLI agent selector (unused in Electron)
│   └── utils/
│       ├── retry.ts                 # Retry logic
│       └── excel-reader.ts          # Excel parsing
├── data/                             # Sample Excel files (CLI mode only)
│   ├── siteplan.xlsx
│   └── units.xlsx
├── dist/                             # Compiled JavaScript (TypeScript output)
│   ├── index.js                     # Agent entry point
│   └── ...
├── release/                          # Built installers (created by electron-builder)
│   ├── IMKAN Agents-1.0.0-arm64.dmg         # macOS installer
│   ├── IMKAN Agents-1.0.0-arm64-mac.zip     # macOS ZIP
│   ├── IMKAN Agents Setup 1.0.0.exe         # Windows installer (build on Windows)
│   └── mac-arm64/
│       └── IMKAN Agents.app                 # macOS app bundle
├── package.json                      # Dependencies and build config
├── tsconfig.json                     # TypeScript configuration
└── AGENTS.md                         # This file (complete documentation)
```

### User Data Directories (Runtime)

**Windows:**
```
C:\Users\[Name]\AppData\Roaming\imkan-agents\
├── .env                    # Auto-created with API keys
├── settings.json           # User preferences
├── temp-upload.xlsx        # Temporary Excel copy
├── temp-config.json        # Temporary agent config
└── Downloads/
    ├── TitleDeeds/
    │   └── 2025-11-01/     # Date-based folders
    └── AffectionPlans/
        └── 2025-11-01/
```

**macOS:**
```
~/Library/Application Support/imkan-agents/
├── .env                    # Auto-created with API keys
├── settings.json           # User preferences
├── temp-upload.xlsx        # Temporary Excel copy
├── temp-config.json        # Temporary agent config
└── Downloads/
    ├── TitleDeeds/
    │   └── 2025-11-01/
    └── AffectionPlans/
        └── 2025-11-01/
```

**Linux:**
```
~/.config/imkan-agents/
├── .env
├── settings.json
└── Downloads/
    ├── TitleDeeds/
    └── AffectionPlans/
```

## Development Commands

### Electron Desktop App (Primary)

```bash
# Development
npm install                   # Install all dependencies
npm run build                 # Compile TypeScript to dist/
npm run electron              # Build + run Electron app

# Fast development workflow (recommended)
tsc --watch                   # Terminal 1: Auto-compile on save
npm run electron:quick        # Terminal 2: Quick launch (no rebuild)
npm run electron:dev          # Alternative: Watch + auto-reload

# Packaging for distribution
npm run package:mac           # Build macOS installer (DMG + ZIP)
npm run package:win           # Build Windows installer (EXE) - requires Windows PC
npm run package:linux         # Build Linux installer (AppImage + DEB)
npm run package               # Build all platforms

# Type checking
npm run typecheck             # TypeScript validation (no emit)
npm run lint                  # ESLint validation
```

### CLI Agents (Legacy/Development)

```bash
npm run dev                      # Interactive agent selector (CLI)
npm run dev:dari-title-deed      # Run Title Deed agent directly (CLI)
npm run dev:dari-affection-plan  # Run Affection Plan agent directly (CLI)
npm start                        # Run compiled code from dist/ (CLI)
```

**Note:** End users only use the packaged Electron app, not CLI commands.

## Environment Variables

Required environment variables (see `.env.example`):

```env
BROWSERBASE_API_KEY=bb_live_...           # Browserbase API key
BROWSERBASE_PROJECT_ID=3c72e446-...       # Browserbase project ID
TAMM_MOBILE_NUMBER=+971559419961          # Mobile number for UAE Pass
ANTHROPIC_API_KEY=sk-ant-...              # (Optional) For advanced AI features
```

**Note**: OPENAI_API_KEY is defined in config but currently unused in agents.

**Important:** In Electron mode, the .env file is auto-created with bundled credentials on first run. Users never need to manually create or edit it.

---

## Electron Desktop Application

### Overview

The desktop app provides a production-ready GUI for non-technical users to run automation agents without any command-line knowledge or technical setup.

### Key Features

1. **Zero Configuration**:
   - .env file auto-created on first run with bundled API keys
   - No manual file editing required
   - Settings persist between runs

2. **User-Friendly File Management**:
   - Native OS file picker for Excel uploads (each run)
   - Files can be stored anywhere on user's computer
   - Automatic organization of downloads by agent type and date

3. **Modern UI**:
   - IMKAN branding with SAAL.AI attribution
   - Blue theme (#2563eb primary color)
   - SVG icons for agents
   - Live console output
   - Success/failure screens

4. **Settings Management**:
   - Mobile number input in UI (not .env)
   - Basic settings: mobile number
   - Advanced settings: plot column, wait times, account switching, payment options
   - Settings saved to `settings.json` automatically

5. **Download Organization**:
   - Base: `~/Library/Application Support/imkan-agents/Downloads/` (macOS)
   - Base: `C:\Users\[Name]\AppData\Roaming\imkan-agents\Downloads\` (Windows)
   - Structure: `{AgentType}/{YYYY-MM-DD}/files`
   - "Open Downloads" button in UI

### Architecture Details

#### Main Process (`electron/main.cjs`)

**Why CommonJS (.cjs)?**
- Electron's main process requires CommonJS
- Package.json has `"type": "module"` for TypeScript sources
- Using .cjs extension allows CommonJS in ES module project

**Key Responsibilities:**
```javascript
// 1. Auto .env creation
function ensureEnvFile() {
  const envPath = path.join(APP_DATA_PATH, '.env');
  if (!fs.existsSync(envPath)) {
    // Create with bundled credentials
    const envContent = `BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
OPENAI_API_KEY=...
TAMM_MOBILE_NUMBER=...`;
    fs.writeFileSync(envPath, envContent);
  }
  return envPath;
}

// 2. Settings management
function loadOrCreateSettings() {
  // Creates default settings.json if doesn't exist
  const defaultSettings = {
    general: { mobileNumber: '+971559419961' },
    sitePlan: { plotColumnIndex: 2, accountSwitching: {...}, payment: {...}, waitTimes: {...} },
    titleDeed: { plotColumnIndex: 2, waitTimes: {...} },
  };
}

// 3. Agent spawning (fixed for packaged apps)
const isDev = !app.isPackaged;
const agentScriptPath = isDev
  ? path.join(__dirname, '..', 'dist', 'index.js')  // Development
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'index.js');  // Production

const nodePath = isDev
  ? 'node'  // Development: system node
  : process.execPath;  // Production: Electron's bundled node

const workingDir = isDev
  ? path.join(__dirname, '..')  // Development: project root
  : APP_DATA_PATH;  // Production: app data directory

agentProcess = spawn(nodePath, [agentScriptPath, agentId], {
  env: {
    ...process.env,
    AGENT_CONFIG_PATH: configPath,
    DOWNLOAD_PATH: downloadDir,
    DOTENV_CONFIG_PATH: envFilePath,
    ELECTRON_RUN_AS_NODE: '1',  // Run Electron as Node.js
  },
  cwd: workingDir,
});
```

**IPC Handlers:**
- `select-excel-file`: Opens native file dialog
- `get-settings`: Loads settings.json
- `save-settings`: Persists settings to JSON
- `run-agent`: Spawns agent process with config
- `stop-agent`: Kills running agent
- `open-downloads`: Opens downloads folder in OS file manager
- `get-downloads-path`: Returns downloads path for display

**Critical Fixes for Packaged Apps:**

1. **ASAR Unpacking** (package.json):
   - `dist/` and `node_modules/` must be unpacked from asar archive
   - Node.js cannot execute files directly from asar
   - Configuration: `"asarUnpack": ["dist/**/*", "node_modules/**/*"]`
   - Script path: `process.resourcesPath/app.asar.unpacked/dist/index.js`

2. **Node Executable Path**:
   - Development: Use `'node'` from system PATH
   - Production: Use `process.execPath` (Electron's bundled Node)
   - Environment variable: `ELECTRON_RUN_AS_NODE: '1'` (run Electron as Node.js)
   - **Error before fix:** `spawn node ENOENT` (node not found in packaged app)

3. **Working Directory**:
   - Development: Project root directory
   - Production: App data directory (for file write access)
   - **Error before fix:** `spawn ENOTDIR` (couldn't find agent script)

#### Preload Script (`electron/preload/preload.cjs`)

**Security Bridge:**
```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  selectExcelFile: () => ipcRenderer.invoke('select-excel-file'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  runAgent: (agentId, excelFilePath) => ipcRenderer.invoke('run-agent', agentId, excelFilePath),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  onAgentOutput: (callback) => ipcRenderer.on('agent-output', (event, data) => callback(data)),
  onAgentError: (callback) => ipcRenderer.on('agent-error', (event, data) => callback(data)),
  onAgentFinished: (callback) => ipcRenderer.on('agent-finished', (event, data) => callback(data)),
});
```

**Why needed?**
- Renderer process has no direct Node.js access (security)
- contextBridge safely exposes limited API
- Prevents malicious code in renderer from accessing system

#### Renderer Process (`electron/renderer/`)

**index.html:**
- Agent selection cards (Title Deed, Affection Plan)
- Mobile number input field
- File upload button
- Settings form (basic + collapsible advanced)
- Console output area
- Success/failure screens

**styles.css:**
- CSS custom properties for theming
- Modern card-based layout
- Blue primary color (#2563eb)
- Responsive design
- Smooth animations

**app.js:**
- Loads settings on startup
- Handles agent selection
- File upload via electronAPI.selectExcelFile()
- Validates mobile number
- Saves settings before running agent
- Shows live console output
- Handles success/failure states

### Electron Bridge Integration

**How Electron config reaches agents:**

1. **User interacts with UI** → enters mobile number, selects Excel file, clicks "Run Agent"
2. **app.js** → saves settings to `settings.json` via IPC
3. **main.cjs** → creates temp config JSON:
   ```javascript
   const agentConfig = {
     excelFilePath: tempExcelPath,
     downloadPath: downloadDir,
     plotColumnIndex: settings.sitePlan.plotColumnIndex,
     mobileNumber: settings.general.mobileNumber,
     accountSwitching: settings.sitePlan.accountSwitching,
     payment: settings.sitePlan.payment,
     waitTimes: settings.sitePlan.waitTimes,
   };
   fs.writeFileSync(configPath, JSON.stringify(agentConfig));
   ```
4. **main.cjs** → spawns agent with env var `AGENT_CONFIG_PATH=configPath`
5. **src/electron-bridge.ts** → loads config from path:
   ```typescript
   export function loadElectronConfig(): ElectronAgentConfig | null {
     const configPath = process.env.AGENT_CONFIG_PATH;
     if (!configPath) return null;
     return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
   }
   ```
6. **Agent constructor** → merges Electron config with defaults:
   ```typescript
   constructor() {
     const electronConfig = loadElectronConfig();
     if (electronConfig) {
       this.config = createDariSitePlanConfig({
         excelFilePath: electronConfig.excelFilePath,
         plotColumnIndex: electronConfig.plotColumnIndex,
         // ... merge other settings
       });
     } else {
       this.config = loadDariSitePlanConfig();  // CLI defaults
     }
   }
   ```

### Building and Distribution

#### macOS Build

**Requirements:**
- macOS 10.13+ (High Sierra or later)
- Node.js 18+
- Xcode Command Line Tools (optional, for code signing)

**Build Steps:**
```bash
npm install
npm run build
npm run package:mac
```

**Output:**
```
release/
├── IMKAN Agents-1.0.0-arm64.dmg          (120MB) - Installer
├── IMKAN Agents-1.0.0-arm64-mac.zip      (116MB) - ZIP archive
└── mac-arm64/
    └── IMKAN Agents.app                  - App bundle
```

**Architecture:**
- Current: Apple Silicon (M1/M2/M3) ARM64
- To support Intel: Update package.json target to `["x64", "arm64"]`

**Code Signing (Optional):**
- Without: Users see "unidentified developer" warning (right-click to open first time)
- With: No warnings, professional appearance
- Requires: Apple Developer account ($99/year)

#### Windows Build

**Requirements:**
- Windows 10 or 11 (64-bit)
- Node.js 18+

**Build Steps:**
```cmd
npm install
npm run build
npm run package:win
```

**Output:**
```
release/
├── IMKAN Agents Setup 1.0.0.exe    (140MB) - NSIS Installer
└── IMKAN Agents 1.0.0.exe          (140MB) - Portable version
```

**Important:** Cannot cross-compile from Mac to Windows reliably. Must build on Windows PC, Windows VM, or use GitHub Actions.

#### What's Bundled in Installers

**Included automatically:**
- ✅ Node.js runtime (v18+)
- ✅ Chromium browser (Electron's built-in)
- ✅ All TypeScript code (compiled to dist/)
- ✅ Electron framework
- ✅ All node_modules
- ✅ UI files (HTML/CSS/JS)
- ✅ Auto .env credentials (bundled in code)

**NOT included (created at runtime):**
- User settings (settings.json)
- Downloaded files
- User's Excel files
- Temporary files

#### File Sizes

**macOS:**
- DMG Installer: 120MB (compressed)
- ZIP Archive: 116MB (compressed)
- Installed .app: ~300MB (uncompressed)

**Windows:**
- Setup EXE: 140MB
- Portable EXE: 140MB
- Installed: ~300MB

### End User Installation

#### macOS Installation

1. Download `IMKAN Agents-1.0.0-arm64.dmg`
2. Double-click to mount
3. Drag "IMKAN Agents.app" to Applications folder
4. **First run:** Right-click → Open → Open (security warning)
5. Subsequent runs: Open normally from Applications or Launchpad

**Why right-click first time?**
- App is not code-signed with Apple Developer certificate
- macOS Gatekeeper blocks unsigned apps
- Right-click bypasses this (only needed once)

#### Windows Installation

1. Download `IMKAN Agents Setup 1.0.0.exe`
2. Double-click installer
3. Follow wizard (Next → Install → Finish)
4. Open from Start Menu: "IMKAN Agents"

**No security warnings if:**
- Built on Windows (not cross-compiled)
- Optional: Code-signed with certificate

### End User Workflow

1. **Launch app** from Applications (macOS) or Start Menu (Windows)
2. **Enter mobile number** (e.g., +971559419961) - saved automatically
3. **Select agent** (Title Deed or Affection Plan)
4. **Upload Excel file** via "Upload Excel File" button
5. **Click "Run Agent"**
6. **Browser opens** - solve captcha when prompted
7. **Approve UAE Pass** on mobile (2FA)
8. **Agent completes automatically**
9. **Downloads saved** to organized folders
10. **View downloads** via "Open Downloads" button

**No technical knowledge required:**
- ❌ No Node.js installation
- ❌ No Chrome browser
- ❌ No command line
- ❌ No .env file editing
- ❌ No programming

## Important Considerations

### Code Conventions
- **ES Modules vs CommonJS**:
  - TypeScript sources (`src/`): ES Modules with `.js` extensions in imports
  - Electron files (`electron/`): CommonJS with `.cjs` extensions
  - Package.json: `"type": "module"` for TypeScript, .cjs for Electron compatibility
- **Error Handling**: All agent methods use try-catch with detailed error messages and troubleshooting tips
- **Retry Logic**: Network operations wrapped in retry() with configurable attempts and backoff
- **Automatic State Detection**: Uses Stagehand's observe() API to automatically detect page state changes (login completion, navigation, etc.) without manual user input
- **Stealth Mode**: Agents run with anti-detection features (non-headless, WebDriver hidden)
- **Dev vs Production Paths**: Always check `app.isPackaged` when working with file paths in Electron

### Browser Automation Best Practices
- Use `page.act()` for natural language actions instead of direct selectors
- Use `page.observe()` to detect page state changes and verify navigation/authentication completion
- Include generous `domSettleTimeoutMs` (3000ms) for dynamic content
- Implement manual intervention windows for captchas (15-20 second delays)
- Verify outcomes with URL checks, networkidle states, and page observation
- Always close Stagehand instances in finally blocks
- Use `page.extract()` for AI-powered data extraction from pages
- Implement fallback extraction methods for reliability
- **Automatic Login Detection**: Monitor URL changes and observe page elements (logout, profile, dashboard) to detect successful authentication without user prompts

### Excel Data Processing
- Place Excel files in `data/` directory
- Excel reader looks for columns containing "Plot Id" (case-insensitive)
- Empty rows and cells are automatically skipped
- Progress tracking with row indices for debugging

### Adding New Agents
1. Create new agent class in `src/agents/` extending the agent pattern
2. Register in `agent-registry.ts` with metadata (id, name, description, icon)
3. Update main switch statement in `src/index.ts` for workflow routing
4. Add npm script in `package.json` for direct execution (e.g., `dev:agent-name`)

### Security
- All credentials managed via environment variables
- `.env` excluded from git via `.gitignore`
- No hardcoded API keys or secrets in source code
- Sensitive data (mobile number) loaded from config at runtime

## Stagehand Framework Usage

- **Documentation**: https://docs.stagehand.dev
- **Current Version**: @browserbasehq/stagehand ^2.0.0
- **Mode**: LOCAL (using local Chromium instead of Browserbase cloud)

### Core Configuration

```typescript
new Stagehand({
  env: 'LOCAL',
  verbose: 1,
  enableCaching: false,
  domSettleTimeoutMs: 3000,
  modelName: 'gpt-4o',  // When OPENAI_API_KEY is set
  modelClientOptions: {
    apiKey: process.env.OPENAI_API_KEY
  }
})
```

### Best Practices (Implemented in Agents)

#### 1. **Act** - Natural Language Actions
```typescript
// ✅ Good: Single-step, specific action
await page.act("click the Login button in the top right corner");

// ✅ Better: Observe first, then act
const actions = await page.observe("find the Login button");
await page.act("click the Login button");

// ❌ Avoid: Multi-step or vague actions
await page.act("login and navigate to dashboard");
```

#### 2. **Observe** - Validate Before Acting
```typescript
// Discover available actions
const elements = await page.observe({
  instruction: "find payment options on this page"
});

// Validate element exists and is clickable
const hasButton = elements.some(e =>
  e.method === 'click' &&
  e.description.includes('Proceed')
);
```

#### 3. **Extract** - AI-Powered Data Extraction
```typescript
// ✅ Detailed prompt with context
const result = await page.extract(
  'Extract the Application ID or Reference Number from this page. ' +
  'Look for labels like "Application ID", "Reference Number", or "Request ID". ' +
  'Return only the alphanumeric ID value.'
);

// ✅ Always validate extraction result
if (result.extraction) {
  const id = String(result.extraction).trim();
  // Validate format
  if (id.match(/^[A-Z0-9-]{6,}$/i)) {
    return id;
  }
}

// ✅ Implement fallback strategies
// Try AI extraction → Regex patterns → Manual parsing
```

#### 4. **Reliability Patterns**

**Cache Management:**
```typescript
// Clear all caches before critical operations
await context.clearCookies();
await page.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await page.reload({ waitUntil: 'networkidle' });
```

**Wait for Page Load:**
```typescript
// Follow proper loading sequence
await page.waitForLoadState('domcontentloaded');
await sleep(2000);
await page.waitForLoadState('networkidle');
await sleep(3000);
```

**Retry with Exponential Backoff:**
```typescript
await retry(
  async () => await page.act("click button"),
  {
    maxAttempts: 3,
    delayMs: 2000,
    onRetry: (attempt, error) => {
      console.log(`Retry ${attempt}: ${error.message}`);
    }
  }
);
```

**Smart Fallbacks:**
```typescript
try {
  // Primary: AI-powered extraction
  const data = await page.extract("find application ID");
  return data.extraction;
} catch {
  // Fallback: Regex pattern matching
  const text = await page.textContent('body');
  const match = text.match(/Application ID:\s*([A-Z0-9-]+)/i);
  return match?.[1] || null;
}
```

### AI Model Configuration

**OpenAI Integration:**
- Set `OPENAI_API_KEY` in `.env` for GPT-4o model
- Improves extraction accuracy by 30-40%
- Better understanding of complex page structures
- Get API key: https://platform.openai.com/api-keys

**Without OpenAI:**
- Falls back to default Stagehand model
- Still functional but less accurate for edge cases

### Production Tips

1. **Always validate page state** with `observe()` before critical actions
2. **Clear caches** when navigating to service URLs to prevent stale data
3. **Use detailed prompts** for `extract()` - be specific about what and where
4. **Implement fallbacks** - never rely solely on AI extraction
5. **Log extensively** - helps debug issues in production
6. **Test timeouts** - some operations need longer waits (UAE Pass: 3 minutes)
7. **Monitor network state** - use `waitForLoadState('networkidle')` generously

## Getting Started

### For End Users (Electron App)

**macOS:**
1. Download `IMKAN Agents-1.0.0-arm64.dmg`
2. Double-click, drag to Applications folder
3. Right-click app → Open (first time only)
4. Enter mobile number, upload Excel file, run agent

**Windows:**
1. Download `IMKAN Agents Setup 1.0.0.exe`
2. Double-click installer, follow wizard
3. Open from Start Menu
4. Enter mobile number, upload Excel file, run agent

**No setup or configuration required!**

### For Developers (Building/Modifying App)

#### First Time Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build TypeScript:**
   ```bash
   npm run build
   ```

3. **Run in development mode:**
   ```bash
   npm run electron
   ```

#### Fast Development Workflow

**Terminal 1:**
```bash
tsc --watch
```

**Terminal 2:**
```bash
npm run electron:quick
```

Changes take 3-5 seconds instead of 15-20 seconds!

#### Building Installers

**macOS:**
```bash
npm run package:mac
```
Output: `release/IMKAN Agents-1.0.0-arm64.dmg`

**Windows (on Windows PC):**
```cmd
npm run package:win
```
Output: `release/IMKAN Agents Setup 1.0.0.exe`

### For CLI Development (Legacy)

**Setup:**
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

**Run agents:**
```bash
npm run dev                      # Interactive menu
npm run dev:dari-title-deed      # Title Deed agent
npm run dev:dari-affection-plan  # Affection Plan agent
```

## Dari Title Deed Agent - Detailed Guide

### Excel File Requirements

**Location:** `data/units.xlsx`

**Required Format:**
- Must have a column header containing "Plot Id" (case-insensitive)
- Plot numbers should be in this column (one per row)
- First row must be headers
- Can have any additional columns

**Example Structure:**
```
| Unit Name | Unit Type | Plot Id - ADM |
|-----------|-----------|---------------|
| Villa 1   | Type A    | c5            |
| Villa 2   | Type B    | d7            |
| Unit 3    | Type C    | e9            |
```

### Verifying Excel Data

Before running the agent, verify your Excel file contains the correct data:

```bash
# View what plot numbers will be processed
npx tsx -e "
import XLSX from 'xlsx';
const wb = XLSX.readFile('data/units.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
console.log('Plot numbers found:');
data.slice(1).forEach((row, i) => {
  const plotCol = data[0].findIndex(h => h && h.toString().toLowerCase().includes('plot id'));
  if (row[plotCol]) console.log((i+1) + '. ' + row[plotCol]);
});
"
```

### Workflow Execution - Smart Agent Behavior

1. **Login Phase (Steps 1-7)**
   - Opens Dari website
   - Handles UAE Pass authentication
   - User must solve captcha and approve 2FA
   - Agent automatically detects login success using observe()

2. **Application Generation Loop (Steps 8-15)** - *Smart Repeat Logic*
   - Loads all plot numbers from Excel into memory
   - **FOR EACH PLOT** (repeating process):
     - Navigate to Title Deed (Unit) Service
     - Enter Plot ID in ADM search field (left side filter)
     - Click Show Results to filter
     - **Observe** filtered results on right side
     - Click on filtered unit
     - Click Proceed button
     - **Wait** for page to navigate and load (networkidle)
     - **Observe** application generation page
     - **Wait and retry** (up to 10 attempts, 3 seconds apart) until Application ID appears
     - Extract and **save Application ID to memory**
     - Navigate back to Title Deed service for next plot
   - All Application IDs stored in `ApplicationRecord[]` array

3. **Download Phase (Steps 16-21)** - *Smart Download with Retry*
   - Navigate to Applications menu
   - **FOR EACH APPLICATION ID** in memory:
     - Enter Application ID in left side search filter
     - Click search/filter button
     - **Observe** filtered results
     - Click "View Application"
     - Wait for page to load
     - **Observe page** looking for Download button in top right corner
     - Check status indicators (in progress, pending, ready)
     - **IF READY**:
       - Click Download button in top right
       - Mark as downloaded in memory
     - **IF NOT READY**:
       - Mark for retry
       - Continue to next application
   - After all checked, if pending applications exist:
     - **Wait 5 minutes**
     - Navigate back to Applications menu
     - **Repeat download attempt** for pending applications
     - **Continue retrying** every 5 minutes until:
       - All downloaded, OR
       - Max 5 retries reached per application

### Troubleshooting

**Wrong plot numbers being searched?**
- The agent reads from `data/units.xlsx` - verify this file contains YOUR data
- Check with the verification command above
- Sample/test data may still be in the file from initial setup

**Excel file not found?**
- Ensure file exists at `data/units.xlsx`
- Check file is not open in Excel (close it)
- Verify file is valid .xlsx format

**Column not found error?**
- Ensure first row has a column containing "Plot Id" in the header
- Check for typos or extra spaces in headers
- Column name is case-insensitive but must contain "plot id"

## Known Limitations

- Captcha handling requires manual user intervention (15-20 second window)
- 2FA approval must be completed manually via UAE Pass mobile app (agent automatically detects completion - no Enter key needed)
- Login verification uses URL monitoring and page observation (may need adjustment if websites change significantly)
- Title deed downloads require 10-15 minutes processing time per application
- Excel file must be properly formatted with "Plot Id" column header
- xlsx library is CommonJS - must use default import pattern: `import XLSX from 'xlsx'`
- UAE Pass detection timeout: 3 minutes maximum wait time for 2FA approval
- Batch payment validation in Dari Affection Plan agent requires sufficient wallet balance for ALL plots upfront

## Troubleshooting Common Issues

### Electron App Issues

#### Error: "spawn node ENOENT" (Fixed in v1.0.1+)
**Cause:** Packaged apps cannot find the `node` command (not in PATH)
**Solution:** Use `process.execPath` (Electron's bundled Node) with `ELECTRON_RUN_AS_NODE: '1'`
**Fixed in:** `electron/main.cjs` lines 246-261
**Code:**
```javascript
const nodePath = isDev ? 'node' : process.execPath;
agentProcess = spawn(nodePath, [agentScriptPath, agentId], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});
```

#### Error: "Cannot find module '/path/to/app.asar/dist/index.js'" (Fixed in v1.0.1+)
**Cause:** Node.js cannot execute files from inside asar archive
**Solution:** Unpack dist and node_modules from asar
**Fixed in:** `package.json` build configuration
**Code:**
```json
"asarUnpack": ["dist/**/*", "node_modules/**/*"]
```
**Script path:** `process.resourcesPath/app.asar.unpacked/dist/index.js`

#### Error: "require is not defined in ES module scope"
**Cause:** Electron files using .js extension instead of .cjs
**Solution:** Electron files must use .cjs extension (main.cjs, preload.cjs)
**Why:** Package.json has `"type": "module"` but Electron needs CommonJS

#### macOS: "App cannot be opened because it is from an unidentified developer"
**Cause:** App is not code-signed with Apple Developer certificate
**Solution:** Right-click app → Open → Open (only needed first time)
**Alternative:** System Settings → Privacy & Security → "Open Anyway"
**Professional fix:** Get Apple Developer account ($99/year) and code sign

#### Windows: Installer shows security warning
**Cause:** App is not code-signed with certificate
**Solution:** Click "More info" → "Run anyway"
**Professional fix:** Get code signing certificate ($100-400/year)

#### Downloads not found / Wrong location
**Windows:** `C:\Users\[Name]\AppData\Roaming\imkan-agents\Downloads\`
**macOS:** `~/Library/Application Support/imkan-agents/Downloads/`
**Linux:** `~/.config/imkan-agents/Downloads/`
**Verify:** Check console output for "Downloads location:" message
**Access:** Use "Open Downloads" button in app

#### Settings not persisting
**Cause:** settings.json not writable or corrupted
**Solution:** Delete settings.json file, app will recreate with defaults
**Location:** Same as .env file (see Downloads location above)

#### .env file not created automatically
**Cause:** App data directory not writable
**Solution:** Check permissions on AppData/Application Support folder
**Manual fix:** Create .env manually with credentials from `electron/main.cjs` lines 93-96

### Agent/CLI Issues

#### TypeError: XLSX.readFile is not a function
**Cause:** Incorrect import pattern for xlsx CommonJS module
**Solution:** Use `import XLSX from 'xlsx'` (not `import * as XLSX from 'xlsx'`)

#### Agent searches wrong plot numbers
**Cause:** Excel file contains old/sample data
**Solution:** Upload correct Excel file via file picker in app
**CLI mode:** Replace `data/units.xlsx` with your actual file

#### Excel file locked/in use
**Cause:** File is open in Excel or another application
**Solution:** Close the file before uploading/running agent

#### Type errors during development
**Cause:** TypeScript compilation issues
**Solution:** Run `npm run typecheck` to identify issues

### Build Issues

#### macOS: fsevents error during build
**Cause:** fsevents optional dependency not installed
**Solution:**
```bash
npm install fsevents --save-optional
rm -rf node_modules && npm install
npm run package:mac
```

#### Windows: Cannot build .exe on Mac
**Cause:** Cross-compilation is unreliable
**Solution:** Use Windows PC, Windows VM, or GitHub Actions
**Not recommended:** electron-builder's Windows build from Mac often fails

#### Error: "electron-builder failed"
**Causes:** Insufficient disk space, antivirus blocking, Node.js version mismatch
**Solutions:**
- Ensure 2GB+ free disk space
- Temporarily disable antivirus
- Use Node.js 18+
- Clean rebuild: `rm -rf node_modules release dist && npm install && npm run build`

## Development Notes

### Module System
- Project uses ES Modules (`"type": "module"` in package.json)
- All imports must use `.js` extensions (TypeScript compiles to JS)
- CommonJS modules like xlsx require default import pattern

### Error Handling Philosophy
- Every agent method wrapped in try-catch
- Detailed error messages with troubleshooting hints
- Automatic retry with exponential backoff for network operations
- User-friendly console output with progress tracking

### Adding New Agents - Step by Step

1. **Create agent file:** `src/agents/your-agent.ts`
   ```typescript
   export class YourAgent {
     private stagehand: Stagehand | null = null;

     async initialize(): Promise<void> { /* setup */ }
     async executeWorkflow(): Promise<void> { /* main logic */ }
     async close(): Promise<void> { /* cleanup */ }
   }
   ```

2. **Register in agent-registry.ts:**
   ```typescript
   import { YourAgent } from './your-agent.js';

   export const agentRegistry: AgentInfo[] = [
     // ... existing agents
     {
       id: 'your-agent',
       name: 'Your Agent Name',
       description: 'What your agent does',
       icon: '🎯',
       agent: YourAgent,
     },
   ];
   ```

3. **Add routing in index.ts:**
   ```typescript
   if (selectedAgent.id === 'your-agent') {
     await agent.executeWorkflow();
   }
   ```

4. **Add npm script in package.json:**
   ```json
   "scripts": {
     "dev:your-agent": "tsx src/index.ts your-agent"
   }
   ```

5. **Test:**
   ```bash
   npm run dev  # Should see your agent in the menu
   npm run dev:your-agent  # Direct execution
   ```

## Project Maintenance

### Single Source of Truth
- **AGENTS.md** is the single comprehensive documentation file (this file)
- All development guidance, architecture, and troubleshooting consolidated here
- Keep this file updated as project evolves
- Delete redundant .md files after extracting important information

### Clean Repository
- No test scripts in root directory
- No duplicate documentation files
- Test files should be temporary and removed after use
- Documentation .md files can be deleted (info moved to AGENTS.md)

### Version History

**v1.2.0 - Dari Affection Plan Agent (November 2025)**
- ✅ Implemented complete Dari Affection Plan (Verification Certificate Unit) agent
- ✅ Production-grade batch payment validation (validates total balance for all plots before any payment)
- ✅ Optional account switching feature (same as Site Plan agent)
- ✅ Comprehensive configuration system with dari-affection-plan-config.ts
- ✅ Financial safety: prevents partial payments and wasted money
- ✅ Smart captcha and UAE Pass detection
- ✅ Application ID tracking for all processed plots
- ✅ Detailed final summary with payment/download status
- ✅ Full integration with Electron desktop app
- ✅ CLI support with npm run dev:dari-affection-plan
- ✅ Clean, production-ready codebase (1,535 lines verified)
- ✅ Comprehensive documentation added to AGENTS.md

**v1.1.0 - Stagehand v3 AI Enhancements (November 2025)**
- ✅ Integrated Stagehand v3 best practices (docs.stagehand.dev)
- ✅ OpenAI GPT-4o model configuration for enhanced reliability
- ✅ AI-powered data extraction with detailed natural language prompts
- ✅ Improved Application ID, wallet balance, and payment extraction
- ✅ Comprehensive cache clearing (browser cache, localStorage, sessionStorage, Cache API)
- ✅ Hard page reloads to prevent stale data
- ✅ Smart fallback strategies (AI extraction → regex patterns)
- ✅ Service name and URL configuration in UI
- ✅ Official Dari Abu Dhabi logo integration
- ✅ Industrial UI design with reduced border radius
- ✅ IMKAN logo in application header
- ✅ Enhanced logging with emoji indicators for better visibility
- ✅ Production-grade stability with AI learning capabilities

**v1.0.1 - Production Fixes (November 2025)**
- ✅ Fixed `spawn node ENOENT` error in packaged apps
- ✅ Fixed `Cannot find module app.asar/dist/index.js` error
- ✅ Added asarUnpack configuration for dist and node_modules
- ✅ Use Electron's bundled Node.js (process.execPath) instead of system node
- ✅ Added ELECTRON_RUN_AS_NODE environment variable
- ✅ Improved error logging and console output
- ✅ Production-grade agent spawning for Windows and macOS
- ✅ Verified end-to-end functionality in packaged apps

**v1.4.0 - Site Plan Agent Removal (November 2025)**
- ✅ Removed Dari Site Plan Agent (2 agents remain: Title Deed, Affection Plan)
- ✅ Removed site plan agent card from UI
- ✅ Removed SitePlans download folder
- ✅ Removed sitePlan settings from configuration
- ✅ Cleaned up agent-registry.ts, index.ts, main.cjs, app.js
- ✅ Removed dev:dari-site-plan npm script
- ✅ Updated documentation to reflect 2-agent architecture
- ✅ Simplified UI with focus on Title Deed and Affection Plan workflows

**v1.3.0 - Affection Plan Electron Integration (November 2025)**
- ✅ Integrated Dari Affection Plan Agent into Electron desktop app
- ✅ Added third agent card in UI with Dari logo
- ✅ Added affection plan settings section (service name, URL, account switching, payment)
- ✅ Added download timeout configuration (15-minute default for certificate generation)
- ✅ Created AffectionPlans download folder structure
- ✅ Updated IPC handlers to support dari-affection-plan agent
- ✅ Full configuration UI for batch payment validation settings
- ✅ Seamless integration with existing Site Plan and Title Deed agents
- ✅ Production-ready with all safety features enabled

**v1.0.0 - Electron Desktop App (November 2025)**
- ✅ Removed TAMM agent
- ✅ Created production-ready Electron desktop application
- ✅ Auto .env creation with bundled credentials
- ✅ Native file upload for Excel files
- ✅ Downloads organized by agent type and date
- ✅ Mobile number input in UI
- ✅ Settings management (basic + advanced)
- ✅ Modern IMKAN branding with SAAL.AI attribution
- ✅ macOS installer built and tested (Apple Silicon)
- ✅ Windows installer ready (build on Windows PC)
- ✅ Fixed ES module / CommonJS compatibility
- ✅ Fast development workflow (watch mode)
- ✅ Cross-platform support (Windows, macOS, Linux)

**Earlier versions:**
- CLI-based agent selector with 4 agents
- Manual .env file configuration
- Excel files in data/ directory

### Key Files (Developer Reference)

**Must understand:**
- `electron/main.cjs`: Main process, IPC handlers, .env auto-creation, agent spawning
  - Lines 246-261: Node executable path and ELECTRON_RUN_AS_NODE
  - Lines 224-232: Script path detection (dev vs production)
  - Lines 240-242: Working directory configuration
  - Lines 82-110: Auto .env creation with bundled credentials
- `electron/preload/preload.cjs`: Security bridge between main and renderer
- `electron/renderer/app.js`: UI logic, file uploads, settings management
- `src/electron-bridge.ts`: Config bridge between Electron and agents
- `src/agents/dari-title-deed-agent.ts`: Title deed automation logic
- `src/agents/dari-affection-plan-agent.ts`: Verification certificate automation with batch payment validation
- `package.json`: Build configuration, electron-builder settings
  - Lines 43-46: asarUnpack configuration (critical for packaged apps)

**Can reference when needed:**
- `electron/renderer/index.html`: UI structure
- `electron/renderer/styles.css`: Styling
- `src/config.ts`: Environment variables and validation
- `src/config/dari-site-plan-config.ts`: Site Plan agent configuration
- `src/config/dari-affection-plan-config.ts`: Affection Plan agent configuration
- `src/utils/excel-reader.ts`: Excel parsing logic

### Common Development Tasks

**Add new agent:**
1. Create agent class in `src/agents/`
2. Register in `src/agents/agent-registry.ts`
3. Add card in `electron/renderer/index.html`
4. Update `electron/main.cjs` spawn logic if needed
5. Test in development mode
6. Rebuild and test packaged app

**Update credentials:**
1. Edit `electron/main.cjs` lines 93-96 (ensureEnvFile function)
2. Rebuild: `npm run build && npm run package:mac`
3. New installers will have updated credentials

**Change UI/styling:**
1. Edit `electron/renderer/index.html` or `styles.css`
2. Quick test: `npm run electron:quick`
3. No rebuild needed for renderer changes

**Update agent logic:**
1. Edit `src/agents/*.ts`
2. Run `tsc` or `npm run build`
3. Test: `npm run electron:quick`
4. For distribution: `npm run package:mac` or `package:win`

**Debug packaged app issues:**
1. Check console output in UI
2. Check logs in Terminal (macOS) or Command Prompt (Windows)
3. Verify `app.isPackaged` detection in main.cjs
4. Check paths: development vs `process.resourcesPath`
5. Verify .env file created in app data directory

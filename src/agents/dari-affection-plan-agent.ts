import { Stagehand } from '@browserbasehq/stagehand';
import {
  loadDariAffectionPlanConfig,
  createDariAffectionPlanConfig,
  type DariAffectionPlanConfig,
} from '../config/dari-affection-plan-config.js';
import { loadElectronConfig } from '../electron-bridge.js';
import { sendEmailNotification, type EmailSummary } from '../utils/email-service.js';
import { getStagehandLocalBrowserConfig } from '../utils/local-browser.js';
import XLSX from 'xlsx';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';

/**
 * Helper function to add delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CORPORATE_STOP_WORDS = new Set([
  'A',
  'AN',
  'AND',
  'AS',
  'COMPANY',
  'EMPLOYEE',
  'FOR',
  'IMKAN',
  'L',
  'LLC',
  'LIABILITY',
  'LIMITED',
  'OF',
  'P',
  'PROPERTIES',
  'PROPERTY',
  'SERVICE',
  'SERVICES',
  'SHAREHOLDER',
  'SINGLE',
  'SOLE',
  'THE',
]);

interface PlotData {
  plotNumber: string;
  rowIndex: number;
}

interface PlotResult {
  plotNumber: string;
  rowIndex: number;
  applicationId: string | null;
  paymentCompleted: boolean;
  downloadCompleted: boolean;
  error?: string;
}

interface PersistedApplicationData {
  plotNumber: string;
  applicationId: string;
  paymentDate: string;
  downloaded: boolean;
  lastChecked: string;
  downloadedFileName?: string | null;
}

/**
 * Dari Affection Plan Agent
 * Automates affection plan processing on Dari platform using Stagehand v3 best practices
 */
export class DariAffectionPlanAgent {
  private stagehand: Stagehand | null = null;
  private config: DariAffectionPlanConfig;
  private plots: PlotData[] = [];
  private results: PlotResult[] = [];
  private startTime: Date | null = null;
  private downloadPath: string | null = null;
  private storageFilePath: string;
  private persistedApplications: Map<string, PersistedApplicationData> = new Map();
  private uploadedPlotCount = 0;
  private batchBalanceValidated = false;

  constructor() {
    this.storageFilePath = this.getStorageFilePath();

    // Load config from Electron if available, otherwise use defaults
    const electronConfig = loadElectronConfig();
    if (electronConfig) {
      // Get defaults first to merge nested objects properly
      const defaults = loadDariAffectionPlanConfig();

      this.config = createDariAffectionPlanConfig({
        mobileNumber: electronConfig.mobileNumber || '0559419961',
        excelFilePath: electronConfig.excelFilePath,
        plotColumnIndex: electronConfig.plotColumnIndex,
        navigation: {
          ...defaults.navigation,
          affectionPlanServiceText: electronConfig.serviceName ?? defaults.navigation.affectionPlanServiceText,
        },
        accountSwitching: {
          enabled: electronConfig.accountSwitching?.enabled ?? defaults.accountSwitching.enabled,
          targetAccountName: electronConfig.accountSwitching?.targetAccountName ?? defaults.accountSwitching.targetAccountName,
        },
        emailNotification: {
          enabled: electronConfig.emailNotification?.enabled ?? defaults.emailNotification.enabled,
          recipientEmail: electronConfig.emailNotification?.recipientEmail ?? defaults.emailNotification.recipientEmail,
          ccEmail: electronConfig.emailNotification?.ccEmail ?? defaults.emailNotification.ccEmail,
        },
        waitTimes: {
          ...defaults.waitTimes,
          captcha: electronConfig.waitTimes.captcha,
          uaePassTimeout: electronConfig.waitTimes.uaePassTimeout,
          downloadPageTimeout: electronConfig.waitTimes.downloadPageTimeout ?? defaults.waitTimes.downloadPageTimeout,
        },
      });
      console.log('ℹ️  Loaded configuration from Electron UI\n');
    } else {
      this.config = loadDariAffectionPlanConfig();
      console.log('ℹ️  Using default configuration\n');
    }
  }

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Dari Affection Plan Agent...\n');

    // Determine download path
    const downloadPath = process.env.DOWNLOAD_PATH || join(process.cwd(), 'downloads', 'affection-plans');
    mkdirSync(downloadPath, { recursive: true });
    this.downloadPath = downloadPath;
    const localBrowserConfig = getStagehandLocalBrowserConfig(downloadPath);

    if (localBrowserConfig.detectedBrowserPath) {
      console.log(`🌐 Using local browser executable: ${localBrowserConfig.detectedBrowserName}`);
      console.log(`   Path: ${localBrowserConfig.detectedBrowserPath}\n`);
    } else {
      console.log('⚠️  No system browser executable was auto-detected.');
      console.log('   Stagehand will fall back to its default local browser resolution.\n');
    }

    this.stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 1,
      enableCaching: false,
      domSettleTimeoutMs: this.config.waitTimes.domSettle,
      localBrowserLaunchOptions: localBrowserConfig.launchOptions,
      // Note: Uses Stagehand's built-in free model (gpt-4.1-mini)
      // No OpenAI API key required
    });

    await this.stagehand.init();

    // Configure browser download behavior
    const context = this.stagehand.context;
    if (context) {
      console.log('📥 Configuring download behavior...');
      console.log(`   Download location: ${downloadPath}\n`);

      // Set download behavior to allow downloads without prompts
      // @ts-ignore - accessing CDP for download configuration
      const client = await context.newCDPSession(this.stagehand.page);
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
      });
      console.log('✓ Downloads will be saved automatically\n');
    }

    console.log('✓ Dari Affection Plan Agent initialized\n');
    console.log('📍 Mobile Number:', this.config.mobileNumber);
    console.log('📥 Download Path:', downloadPath);
    console.log('⏱️  UAE Pass Timeout:', this.config.waitTimes.uaePassTimeout / 1000, 'seconds');
    console.log('⏱️  CAPTCHA Timeout:', this.config.waitTimes.captcha / 1000, 'seconds\n');
    this.loadPersistedApplications();
  }

  private getStorageFilePath(): string {
    const configPath = process.env.AGENT_CONFIG_PATH;
    const baseDirectory = configPath ? dirname(configPath) : process.cwd();
    return join(baseDirectory, 'dari-affection-plan-history.json');
  }

  private normalizePlotKey(plotNumber: string): string {
    return plotNumber.replace(/\s+/g, '').toUpperCase();
  }

  private loadPersistedApplications(): void {
    console.log('\n💾 Loading paid-plot history...');

    if (!existsSync(this.storageFilePath)) {
      console.log('ℹ️  No previous paid-plot history found - starting fresh');
      console.log(`   (Will create ${this.storageFilePath} after the first completed payment)\n`);
      return;
    }

    try {
      const fileContent = readFileSync(this.storageFilePath, 'utf-8');
      const applications: PersistedApplicationData[] = JSON.parse(fileContent);
      this.persistedApplications.clear();

      for (const application of applications) {
        this.persistedApplications.set(this.normalizePlotKey(application.plotNumber), application);
      }

      console.log(`✅ Loaded ${this.persistedApplications.size} previously paid plot(s)`);
      console.log('   This protects the agent from duplicate payments on reruns\n');
    } catch (error) {
      console.log(`⚠️  Failed to load paid-plot history: ${error instanceof Error ? error.message : String(error)}`);
      console.log('   Continuing without persisted history protection for this run\n');
    }
  }

  private savePersistedApplications(): void {
    try {
      mkdirSync(dirname(this.storageFilePath), { recursive: true });
      const applications = Array.from(this.persistedApplications.values());
      writeFileSync(this.storageFilePath, JSON.stringify(applications, null, 2), 'utf-8');
    } catch (error) {
      console.log(`⚠️  Failed to save paid-plot history: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getPersistedApplication(plotNumber: string): PersistedApplicationData | null {
    return this.persistedApplications.get(this.normalizePlotKey(plotNumber)) || null;
  }

  private upsertPersistedApplication(
    plotNumber: string,
    applicationId: string,
    downloaded: boolean,
    downloadedFileName: string | null = null
  ): void {
    const plotKey = this.normalizePlotKey(plotNumber);
    const existing = this.persistedApplications.get(plotKey);

    this.persistedApplications.set(plotKey, {
      plotNumber,
      applicationId,
      paymentDate: existing?.paymentDate || new Date().toISOString(),
      downloaded,
      lastChecked: new Date().toISOString(),
      downloadedFileName: downloadedFileName || existing?.downloadedFileName || null,
    });

    this.savePersistedApplications();
  }

  private async waitForDocumentReady(timeoutMs: number = 15000): Promise<void> {
    const page = this.stagehand!.page;

    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });

    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {
      // Dari pages can keep background activity alive; DOM readiness is the stronger signal here.
    }

    try {
      await page.waitForFunction(
        () => document.readyState === 'complete',
        undefined,
        { timeout: Math.min(timeoutMs, 10000) }
      );
    } catch {
      // Some pages never report "complete" in a timely way; domcontentloaded is acceptable.
    }

    await sleep(750);
  }

  private async waitForBodyText(
    expectedTexts: string[],
    description: string,
    timeoutMs: number = 15000,
    mode: 'all' | 'any' = 'all'
  ): Promise<void> {
    const page = this.stagehand!.page;

    await page.waitForFunction(
      ({ texts, matchMode }) => {
        const bodyText = (document.body?.innerText || document.documentElement?.innerText || '').toLowerCase();
        if (!bodyText) {
          return false;
        }

        if (matchMode === 'any') {
          return texts.some((text) => bodyText.includes(text));
        }

        return texts.every((text) => bodyText.includes(text));
      },
      {
        texts: expectedTexts.map((text) => text.toLowerCase()),
        matchMode: mode,
      },
      { timeout: timeoutMs }
    );

    console.log(`✓ Verified ${description}\n`);
  }

  private async waitForFirstVisibleLocator(
    locatorFactories: Array<() => any>,
    description: string,
    timeoutMs: number = 10000
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const createLocator of locatorFactories) {
        const locator = createLocator();

        try {
          await locator.waitFor({ state: 'visible', timeout: 750 });
          return locator;
        } catch {
          // Try the next locator candidate.
        }
      }

      await sleep(250);
    }

    throw new Error(`Timed out waiting for ${description}`);
  }

  private async isAnyLocatorVisible(locatorFactories: Array<() => any>, timeoutMs: number = 800): Promise<boolean> {
    for (const createLocator of locatorFactories) {
      try {
        await createLocator().waitFor({ state: 'visible', timeout: timeoutMs });
        return true;
      } catch {
        // Check the next locator candidate.
      }
    }

    return false;
  }

  private async acceptCookiesIfPresent(): Promise<void> {
    const page = this.stagehand!.page;

    try {
      await page.evaluate(() => {
        const doc = document;
        const knownIds = ['onetrust-accept-btn-handler', 'accept-recommended-btn-handler'];

        for (const id of knownIds) {
          const element = doc.getElementById(id);
          if (element instanceof HTMLElement) {
            element.click();
            return;
          }
        }

        const buttons = Array.from(doc.querySelectorAll('button'));
        const match = buttons.find((button) => /accept|allow all/i.test((button.textContent || '').trim()));
        if (match instanceof HTMLElement) {
          match.click();
        }
      });
    } catch {
      // Cookie banners are optional; no action needed if nothing is present.
    }
  }

  private async isCaptchaVisible(): Promise<boolean> {
    const page = this.stagehand!.page;

    try {
      return await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        if (bodyText.includes('captcha') || bodyText.includes('recaptcha') || bodyText.includes('hcaptcha')) {
          return true;
        }

        const frames = Array.from(document.querySelectorAll('iframe'));
        return frames.some((frame) => {
          const source = `${frame.getAttribute('src') || ''} ${frame.getAttribute('title') || ''}`.toLowerCase();
          return source.includes('captcha') || source.includes('recaptcha') || source.includes('hcaptcha');
        });
      });
    } catch {
      return false;
    }
  }

  private async verifyLoggedInDariState(): Promise<{ loggedIn: boolean; indicators: string[] }> {
    const page = this.stagehand!.page;

    await this.waitForDocumentReady(10000);
    await this.acceptCookiesIfPresent();

    const bodyText = ((await page.textContent('body')) || '').toLowerCase();
    const textIndicators = ['logout', 'profile', 'my account', 'switch account']
      .filter((indicator) => bodyText.includes(indicator));

    const loginButtonStillVisible = await this.isAnyLocatorVisible([
      () => page.locator('header, nav, [role="banner"]').locator('a, button, [role="button"]').filter({ hasText: /^login$/i }).first(),
      () => page.locator('a, button, [role="button"]').filter({ hasText: /^login$/i }).first(),
    ]);

    const observation = await page.observe({
      instruction: 'Find the logged-in account menu, profile control, switch account option, user avatar, or logout button in the Dari header',
    });

    const observedIndicators = observation
      .filter((item) => {
        const description = item.description.toLowerCase();
        return [
          'logout',
          'profile',
          'account',
          'user menu',
          'user avatar',
          'switch account',
        ].some((indicator) => description.includes(indicator));
      })
      .map((item) => item.description);

    const indicators = [...textIndicators, ...observedIndicators];

    return {
      loggedIn: indicators.length > 0 && !loginButtonStillVisible,
      indicators,
    };
  }

  private normalizeMatchText(value: string): string {
    return value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getMeaningfulTokens(value: string): string[] {
    const normalized = this.normalizeMatchText(value);
    if (!normalized) {
      return [];
    }

    return Array.from(new Set(
      normalized
        .split(' ')
        .filter((token) => token.length >= 3 && !CORPORATE_STOP_WORDS.has(token))
    ));
  }

  private buildAccountSearchPhrases(value: string): string[] {
    const normalized = this.normalizeMatchText(value);
    const rawTokens = normalized.split(' ').filter(Boolean);
    const meaningfulTokens = this.getMeaningfulTokens(value);

    const phrases = [
      normalized,
      rawTokens.slice(0, 6).join(' '),
      rawTokens.slice(0, 4).join(' '),
      meaningfulTokens.slice(0, 4).join(' '),
      meaningfulTokens.slice(0, 2).join(' '),
    ].filter((phrase) => phrase && phrase.length >= 4);

    return Array.from(new Set(phrases));
  }

  private scoreTextMatch(candidate: string, target: string): number {
    const candidateNormalized = this.normalizeMatchText(candidate);
    const targetNormalized = this.normalizeMatchText(target);

    if (!candidateNormalized || !targetNormalized) {
      return 0;
    }

    let score = 0;

    if (candidateNormalized.includes(targetNormalized)) {
      score += 100;
    }

    if (targetNormalized.includes(candidateNormalized) && candidateNormalized.length >= 8) {
      score += 50;
    }

    const targetTokens = this.getMeaningfulTokens(target);
    const candidateTokens = this.getMeaningfulTokens(candidate);

    for (const token of targetTokens) {
      if (candidateNormalized.includes(token)) {
        score += 20;
        continue;
      }

      const partialTokenMatch = candidateTokens.some((candidateToken) =>
        candidateToken.startsWith(token.slice(0, Math.min(token.length, candidateToken.length))) ||
        token.startsWith(candidateToken.slice(0, Math.min(candidateToken.length, token.length)))
      );

      if (partialTokenMatch && token.length >= 4) {
        score += 10;
      }
    }

    return score;
  }

  private async openAuthenticatedAccountDropdown(): Promise<void> {
    const page = this.stagehand!.page;

    await this.waitForDocumentReady(15000);
    await this.acceptCookiesIfPresent();

    const loginState = await this.verifyLoggedInDariState();
    if (!loginState.loggedIn) {
      throw new Error('Cannot open account dropdown because Dari does not appear to be logged in');
    }

    console.log('🔍 Looking for the authenticated account dropdown in the top-right header...');
    const observation = await page.observe({
      instruction: 'Find the logged-in account dropdown button in the top-right Dari header. Return the profile/account menu control only. Do not return notification, help, language, inbox, chat, or Verify Document controls.',
    });

    const candidates = observation
      .filter((item) => {
        if (item.method !== 'click') {
          return false;
        }

        const description = item.description.toLowerCase();
        if (description.includes('verify document') ||
            description.includes('notification') ||
            description.includes('language') ||
            description.includes('chat') ||
            description.includes('help') ||
            description.includes('inbox')) {
          return false;
        }

        return description.includes('account') ||
          description.includes('profile') ||
          description.includes('user') ||
          description.includes('dropdown') ||
          description.includes('menu');
      })
      .sort((left, right) => {
        const leftDescription = left.description.toLowerCase();
        const rightDescription = right.description.toLowerCase();
        const leftScore =
          (leftDescription.includes('dropdown') ? 3 : 0) +
          (leftDescription.includes('account') ? 3 : 0) +
          (leftDescription.includes('profile') ? 2 : 0) +
          (leftDescription.includes('menu') ? 1 : 0);
        const rightScore =
          (rightDescription.includes('dropdown') ? 3 : 0) +
          (rightDescription.includes('account') ? 3 : 0) +
          (rightDescription.includes('profile') ? 2 : 0) +
          (rightDescription.includes('menu') ? 1 : 0);
        return rightScore - leftScore;
      });

    if (candidates.length === 0) {
      throw new Error('Authenticated account dropdown was not found in the Dari header');
    }

    console.log(`🖱️  Opening account dropdown using: ${candidates[0].description}`);
    await page.act(candidates[0] as any);
    await this.waitForBodyText(['switch account'], 'account dropdown menu', 10000, 'any');
  }

  private async clickSwitchAccountMenuItem(): Promise<void> {
    const page = this.stagehand!.page;

    console.log('🔍 Finding the Switch Account option in the open dropdown...');
    const observation = await page.observe({
      instruction: 'Find the "Switch Account" menu item in the currently open account dropdown menu',
    });

    const switchAccountAction = observation.find((item) => {
      const description = item.description.toLowerCase();
      return item.method === 'click' &&
        description.includes('switch') &&
        description.includes('account');
    });

    if (!switchAccountAction) {
      const switchAccountLocator = await this.waitForFirstVisibleLocator([
        () => page.locator('text=/^switch account$/i').first(),
        () => page.locator('[role="menu"], [role="listbox"], .dropdown-menu, .menu').locator('text=/switch account/i').first(),
      ], 'Switch Account menu item', 10000);

      console.log('🖱️  Clicking Switch Account using locator fallback...');
      await switchAccountLocator.scrollIntoViewIfNeeded();
      await switchAccountLocator.click();
    } else {
      console.log(`🖱️  Clicking Switch Account using: ${switchAccountAction.description}`);
      await page.act(switchAccountAction as any);
    }

    await this.waitForDocumentReady(15000);
    await this.waitForBodyText(
      ['switch profile', 'active profile', 'other profiles'],
      'switch account popup',
      15000,
      'any'
    );
  }

  private async clickConfiguredAccountFromPopup(targetAccountName: string): Promise<string> {
    const page = this.stagehand!.page;
    const searchPhrases = this.buildAccountSearchPhrases(targetAccountName);

    console.log(`🔍 Looking for configured account in popup: ${targetAccountName}`);

    for (const phrase of searchPhrases) {
      try {
        const locator = await this.waitForFirstVisibleLocator([
          () => page.locator('[role="dialog"]').getByText(new RegExp(phrase, 'i')).first(),
          () => page.locator('.modal, .ant-modal, .ReactModal__Content').getByText(new RegExp(phrase, 'i')).first(),
          () => page.getByText(new RegExp(phrase, 'i')).first(),
        ], `account option matching "${phrase}"`, 2500);

        const accountCard = locator.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button" or contains(@class, "item") or contains(@class, "card") or contains(@class, "profile")][1]');
        try {
          await accountCard.waitFor({ state: 'visible', timeout: 750 });
          await accountCard.scrollIntoViewIfNeeded();
          await accountCard.click();
        } catch {
          await locator.scrollIntoViewIfNeeded();
          await locator.click();
        }

        return phrase;
      } catch {
        // Try the next phrase.
      }
    }

    const fallback = await page.evaluate((targetName: string) => {
      const normalize = (value: string) => value
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const stopWords = new Set([
        'A',
        'AN',
        'AND',
        'AS',
        'COMPANY',
        'EMPLOYEE',
        'FOR',
        'IMKAN',
        'L',
        'LLC',
        'LIABILITY',
        'LIMITED',
        'OF',
        'P',
        'PROPERTIES',
        'PROPERTY',
        'SERVICE',
        'SERVICES',
        'SHAREHOLDER',
        'SINGLE',
        'SOLE',
        'THE',
      ]);

      const getTokens = (value: string) => normalize(value)
        .split(' ')
        .filter((token: string) => token.length >= 3 && !stopWords.has(token));

      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 24 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const findClickableAncestor = (element: HTMLElement) => {
        let node: HTMLElement | null = element;
        for (let depth = 0; node && depth < 5; depth += 1) {
          if (!(node instanceof HTMLElement)) {
            break;
          }

          if (
            node.matches('button, a, [role="button"], li') ||
            node.hasAttribute('onclick') ||
            node.getAttribute('tabindex') !== null ||
            window.getComputedStyle(node).cursor === 'pointer'
          ) {
            return node;
          }

          node = node.parentElement;
        }

        return element instanceof HTMLElement ? element : null;
      };

      const modalRoot = Array.from(document.querySelectorAll('[role="dialog"], .modal, .ant-modal, .ReactModal__Content'))
        .find((element) => element instanceof HTMLElement && isVisible(element));

      const root = modalRoot || document.body;
      const targetNormalized = normalize(targetName);
      const targetTokens = getTokens(targetName);
      const candidates = [];
      const seen = new Set();

      for (const element of Array.from(root.querySelectorAll('button, a, [role="button"], li, div'))) {
        if (!(element instanceof HTMLElement) || !isVisible(element)) {
          continue;
        }

        const text = (element.innerText || element.textContent || '').trim();
        if (!text || text.length < 5) {
          continue;
        }

        if (/active profile|other profiles|switch profile/i.test(text)) {
          continue;
        }

        const clickable = findClickableAncestor(element);
        if (!clickable || !isVisible(clickable)) {
          continue;
        }

        const key = `${clickable.tagName}:${normalize(clickable.innerText || clickable.textContent || '')}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const candidateText = (clickable.innerText || clickable.textContent || text).trim();
        const candidateNormalized = normalize(candidateText);
        let score = 0;

        if (candidateNormalized.includes(targetNormalized)) {
          score += 100;
        }

        for (const token of targetTokens) {
          if (candidateNormalized.includes(token)) {
            score += 20;
          }
        }

        if (/employee|license|action required/i.test(candidateText)) {
          score += 5;
        }

        if (score > 0) {
          candidates.push({ clickable, text: candidateText, score });
        }
      }

      candidates.sort((left, right) => right.score - left.score);
      const best = candidates[0];

      if (!best) {
        return {
          success: false,
          chosenText: '',
          candidates: [],
        };
      }

      best.clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      best.clickable.click();

      return {
        success: true,
        chosenText: best.text,
        candidates: candidates.slice(0, 5).map((candidate) => ({
          text: candidate.text,
          score: candidate.score,
        })),
      };
    }, targetAccountName);

    if (!fallback.success) {
      throw new Error(`Configured account "${targetAccountName}" was not found in the switch account popup`);
    }

    console.log('🖱️  Clicked configured account using popup fuzzy match:');
    fallback.candidates.forEach((candidate: { text: string; score: number }, index: number) => {
      console.log(`   ${index + 1}. [${candidate.score}] ${candidate.text}`);
    });

    return fallback.chosenText;
  }

  private async waitForSwitchedAccountInHeader(targetAccountName: string, timeoutMs: number = 45000): Promise<string> {
    const page = this.stagehand!.page;
    const deadline = Date.now() + timeoutMs;
    let lastHeaderSummary = '';

    while (Date.now() < deadline) {
      try {
        await this.waitForDocumentReady(12000);
      } catch {
        // Account switching can navigate through transient states; keep polling.
      }

      await this.acceptCookiesIfPresent();

      const headerSummary = await page.evaluate(() => {
        const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
        const isVisible = (element: Element | null): element is HTMLElement => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 20 &&
            rect.height > 16 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
        };

        const header = document.querySelector('header, [role="banner"]') || document.body;
        const candidates = Array.from(header.querySelectorAll('a, button, [role="button"], span, div'))
          .filter((element) => isVisible(element))
          .map((element) => {
            const rect = (element as HTMLElement).getBoundingClientRect();
            return {
              text: normalize((element.textContent || '')),
              left: rect.left,
              width: rect.width,
            };
          })
          .filter((item) => item.text.length >= 3)
          .filter((item) => item.left > window.innerWidth * 0.55 || /employee|personal account|verify document/i.test(item.text));

        return Array.from(new Set(candidates.map((item) => item.text))).join(' | ');
      });

      lastHeaderSummary = headerSummary;
      const score = this.scoreTextMatch(headerSummary, targetAccountName);
      const hasLoginButton = /(^|\|)\s*LOGIN\s*(\||$)/i.test(headerSummary);
      const looksCorporate = /employee|license|verify document/i.test(headerSummary);
      const stillLooksPersonal = /personal account|abdulqader/i.test(headerSummary);

      if (!hasLoginButton && !stillLooksPersonal && (score >= 20 || looksCorporate)) {
        return headerSummary;
      }

      await sleep(1500);
    }

    throw new Error(`Account switch could not be verified in header. Last header snapshot: ${lastHeaderSummary}`);
  }

  private async waitForCorporateSessionFallback(timeoutMs: number = 15000): Promise<string | null> {
    const page = this.stagehand!.page;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        await this.waitForDocumentReady(10000);
      } catch {
        // Keep polling during transitional states.
      }

      const snapshot = await page.evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        return text.slice(0, 1200);
      });

      if (/employee|verify document/i.test(snapshot) && !/personal account|abdulqader/i.test(snapshot)) {
        return snapshot;
      }

      await sleep(1000);
    }

    return null;
  }

  private getPage(): any {
    return this.stagehand!.page;
  }

  private async clickLocator(locator: any, description: string): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
    console.log(`✓ ${description}\n`);
  }

  private async waitForServicesLandingPage(timeoutMs: number = 20000): Promise<void> {
    const page = this.getPage();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this.waitForDocumentReady(12000);
      await this.acceptCookiesIfPresent();

      const bodyText = ((await page.textContent('body')) || '').toLowerCase();
      const servicesObservation = await page.observe({
        instruction: 'Find service cards, service links, service search input, or "Explore services" content on the services page. Ignore the top navigation header.',
      });

      const hasServiceSurface = servicesObservation.some((item: any) => {
        const description = item.description.toLowerCase();
        return (
          description.includes('service') ||
          description.includes('certificate') ||
          description.includes('plan') ||
          description.includes('explore services')
        ) && !description.includes('header');
      });

      if (hasServiceSurface || bodyText.includes('explore services') || bodyText.includes('services')) {
        console.log('✓ Services page loaded and stable\n');
        return;
      }

      await sleep(1000);
    }

    throw new Error('Services page did not load into a stable services listing state');
  }

  private async clickConfiguredServiceFromServicesPage(serviceName: string): Promise<string> {
    const page = this.getPage();
    const searchPhrases = this.buildAccountSearchPhrases(serviceName);

    console.log(`🔍 Looking for configured service on Services page: ${serviceName}`);

    const observation = await page.observe({
      instruction: `Find the clickable service card or service link whose title best matches "${serviceName}". Ignore header navigation, breadcrumbs, and footer links.`,
    });

    const observedCandidates = observation
      .filter((item: any) => item.method === 'click')
      .map((item: any) => ({
        item,
        score: this.scoreTextMatch(item.description, serviceName),
      }))
      .filter((candidate: any) => candidate.score > 0)
      .sort((left: any, right: any) => right.score - left.score);

    if (observedCandidates.length > 0 && observedCandidates[0].item.selector) {
      const best = observedCandidates[0].item;
      console.log(`🖱️  Clicking configured service using observed selector: ${best.description}`);
      const locator = page.locator(best.selector).first();
      await this.clickLocator(locator, `Clicked service "${best.description}"`);
      return best.description;
    }

    const fallback = await page.evaluate((targetName: string, phrases: string[]) => {
      const normalize = (value: string) => value
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const target = normalize(targetName);
      const tokens = normalize(targetName).split(' ').filter(Boolean);

      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const isInsideIgnoredArea = (element: HTMLElement) => {
        return Boolean(element.closest('header, nav, footer, [role="banner"]')) ||
          /breadcrumb|back to home/i.test(element.innerText || '');
      };

      const findClickableAncestor = (element: HTMLElement): HTMLElement | null => {
        let node: HTMLElement | null = element;
        for (let depth = 0; node && depth < 5; depth += 1) {
          if (
            node.matches('a, button, [role="button"]') ||
            node.hasAttribute('onclick') ||
            node.getAttribute('tabindex') !== null ||
            window.getComputedStyle(node).cursor === 'pointer'
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return element;
      };

      const candidates: Array<{ element: HTMLElement; text: string; score: number }> = [];
      const seen = new Set<string>();

      for (const element of Array.from(document.querySelectorAll('a, button, [role="button"], div, li, article, section'))) {
        if (!(element instanceof HTMLElement) || !isVisible(element) || isInsideIgnoredArea(element)) {
          continue;
        }

        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 4) {
          continue;
        }

        const clickable = findClickableAncestor(element);
        if (!clickable || !isVisible(clickable)) {
          continue;
        }

        const clickableText = (clickable.innerText || clickable.textContent || text).replace(/\s+/g, ' ').trim();
        const key = normalize(clickableText);
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);

        const normalizedText = normalize(clickableText);
        let score = 0;

        if (normalizedText.includes(target)) {
          score += 100;
        }

        for (const phrase of phrases) {
          if (normalizedText.includes(normalize(phrase))) {
            score += 25;
          }
        }

        for (const token of tokens) {
          if (token.length >= 3 && normalizedText.includes(token)) {
            score += 10;
          }
        }

        if (score > 0) {
          candidates.push({ element: clickable, text: clickableText, score });
        }
      }

      candidates.sort((left, right) => right.score - left.score);
      const best = candidates[0];

      if (!best) {
        return { success: false, chosenText: '', topCandidates: [] as Array<{ text: string; score: number }> };
      }

      best.element.scrollIntoView({ block: 'center', inline: 'nearest' });
      best.element.click();

      return {
        success: true,
        chosenText: best.text,
        topCandidates: candidates.slice(0, 5).map((candidate) => ({ text: candidate.text, score: candidate.score })),
      };
    }, serviceName, searchPhrases);

    if (!fallback.success) {
      throw new Error(`Configured service "${serviceName}" was not found on the Services page`);
    }

    console.log('🖱️  Clicked configured service using Services page fuzzy match:');
    fallback.topCandidates.forEach((candidate: { text: string; score: number }, index: number) => {
      console.log(`   ${index + 1}. [${candidate.score}] ${candidate.text}`);
    });

    return fallback.chosenText;
  }

  private async waitForServiceWorkspaceLayout(timeoutMs: number = 25000): Promise<void> {
    const page = this.getPage();
    const deadline = Date.now() + timeoutMs;
    let lastState = '';

    while (Date.now() < deadline) {
      await this.waitForDocumentReady(15000);
      await this.acceptCookiesIfPresent();

      const state = await page.evaluate(() => {
        const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
        const isVisible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 40 &&
            rect.height > 20 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
        };

        const allElements = Array.from(document.querySelectorAll('div, section, aside, article, form')) as HTMLElement[];
        const filterContainer = allElements.find((element) => {
          const text = normalize(element.innerText || '');
          const rect = element.getBoundingClientRect();
          return isVisible(element) &&
            rect.left < window.innerWidth * 0.45 &&
            /filters/i.test(text) &&
            /plot number/i.test(text);
        }) || null;

        const bodyText = normalize(document.body?.innerText || '');
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
        const showResultsButton = buttons.find((button) => {
          const text = normalize(button.innerText || button.textContent || '');
          return isVisible(button) &&
            /show results|filter results|search/i.test(text) &&
            !/all filters/i.test(text) &&
            (filterContainer ? filterContainer.contains(button) : true);
        }) || null;

        const plotInput = Array.from(document.querySelectorAll('input, textarea')) as HTMLElement[];
        const plotNumberField = plotInput.find((input) => {
          const text = normalize((input.parentElement?.innerText || '') + ' ' + (input.getAttribute('aria-label') || '') + ' ' + (input.getAttribute('placeholder') || ''));
          return isVisible(input) &&
            /plot number/i.test(text) &&
            (filterContainer ? filterContainer.contains(input) : true);
        }) || null;

        const rightPanels = allElements.filter((element) => {
          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || '');
          return isVisible(element) &&
            rect.left > window.innerWidth * 0.28 &&
            rect.width > 220 &&
            text.length > 10;
        });

        const hasResultsArea = rightPanels.some((element) => {
          const text = normalize(element.innerText || '');
          return /ownership|municipality|district|community|plot|result|results/i.test(text);
        });

        return {
          hasFilters: Boolean(filterContainer),
          hasPlotNumberField: Boolean(plotNumberField),
          hasShowResultsButton: Boolean(showResultsButton),
          hasResultsArea,
          bodyPreview: bodyText.slice(0, 400),
        };
      });

      lastState = JSON.stringify(state);
      if (state.hasFilters && state.hasPlotNumberField && state.hasShowResultsButton && state.hasResultsArea) {
        console.log('✓ Service page loaded with Filters panel on the left and results area on the right\n');
        return;
      }

      await sleep(1000);
    }

    throw new Error(`Service workspace did not become stable. Last state: ${lastState}`);
  }

  private async fillPlotNumberIntoFilterBox(plotNumber: string): Promise<void> {
    const page = this.getPage();

    console.log(`📝 Filling Plot Number inside the left Filters box: ${plotNumber}`);
    const observation = await page.observe({
      instruction: 'Find the Plot Number input field inside the left Filters box only. Ignore Municipality, District, Community, and any fields outside the Filters box.',
      iframes: true as any,
    });

    const plotField = observation.find((item: any) => {
      const description = item.description.toLowerCase();
      return item.selector &&
        (item.method === 'type' || item.method === 'fill') &&
        description.includes('plot') &&
        description.includes('number') &&
        !description.includes('district') &&
        !description.includes('community') &&
        !description.includes('municipality');
    });

    if (plotField?.selector) {
      const locator = page.locator(plotField.selector).first();
      await locator.scrollIntoViewIfNeeded();
      await locator.fill('');
      await locator.fill(plotNumber);
      const enteredValue = await locator.inputValue();
      if (!enteredValue.includes(plotNumber)) {
        throw new Error(`Plot number field did not retain value "${plotNumber}"`);
      }
      console.log(`✓ Plot number entered into exact field: ${enteredValue}\n`);
      return;
    }

    const fallback = await page.evaluate((targetPlotNumber: string) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const filterContainer = Array.from(document.querySelectorAll('div, section, aside, article, form'))
        .find((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const text = normalize(element.innerText || '');
          const rect = element.getBoundingClientRect();
          return rect.left < window.innerWidth * 0.45 && /filters/i.test(text) && /plot number/i.test(text);
        }) as HTMLElement | undefined;

      if (!filterContainer) {
        return { success: false, value: '' };
      }

      const input = Array.from(filterContainer.querySelectorAll('input, textarea'))
        .find((element) => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || !isVisible(element)) {
            return false;
          }
          const context = normalize((element.parentElement?.innerText || '') + ' ' + (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('placeholder') || ''));
          return /plot number/i.test(context) && !/district|community|municipality/i.test(context);
        }) as HTMLInputElement | HTMLTextAreaElement | undefined;

      if (!input) {
        return { success: false, value: '' };
      }

      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = targetPlotNumber;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, value: input.value };
    }, plotNumber);

    if (!fallback.success || !fallback.value.includes(plotNumber)) {
      throw new Error(`Could not reliably fill Plot Number "${plotNumber}" into the left Filters box`);
    }

    console.log(`✓ Plot number entered using Filters-box fallback: ${fallback.value}\n`);
  }

  private async clickShowResultsInFilterBox(): Promise<void> {
    const page = this.getPage();

    console.log('🔍 Finding Show Results button in the same Filters box...');
    const observation = await page.observe({
      instruction: 'Find the "Show results", "Filter results", or search button inside the left Filters box only. Do not select the "All filters" button.',
      iframes: true as any,
    });

    const showResultsButton = observation.find((item: any) => {
      const description = item.description.toLowerCase();
      return item.selector &&
        item.method === 'click' &&
        (description.includes('show results') || description.includes('filter results') || description.includes('search')) &&
        !description.includes('all filters');
    });

    if (showResultsButton?.selector) {
      const locator = page.locator(showResultsButton.selector).first();
      await this.clickLocator(locator, `Clicked filter action "${showResultsButton.description}"`);
      return;
    }

    const clicked = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const filterContainer = Array.from(document.querySelectorAll('div, section, aside, article, form'))
        .find((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const text = normalize(element.innerText || '');
          const rect = element.getBoundingClientRect();
          return rect.left < window.innerWidth * 0.45 && /filters/i.test(text);
        }) as HTMLElement | undefined;

      if (!filterContainer) {
        return false;
      }

      const button = Array.from(filterContainer.querySelectorAll('button, a, [role="button"]'))
        .find((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const text = normalize(element.innerText || element.textContent || '');
          return /show results|filter results|search/i.test(text) && !/all filters/i.test(text);
        }) as HTMLElement | undefined;

      if (!button) {
        return false;
      }

      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return true;
    });

    if (!clicked) {
      throw new Error('Show Results button was not found inside the left Filters box');
    }

    console.log('✓ Clicked Show Results in the Filters box\n');
  }

  private async inspectFilteredResult(plotNumber: string): Promise<{
    found: boolean;
    selected: boolean;
    matchedText: string;
    noResults: boolean;
    rawPreview: string;
  }> {
    const page = this.getPage();

    return await page.evaluate((targetPlotNumber: string) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const target = normalize(targetPlotNumber);
      const bodyText = normalize(document.body?.innerText || '');
      const noResults = /you don't own any property|you do not own any property|no result|no results|not found|will not be able to proceed/i.test(bodyText);

      const candidates = Array.from(document.querySelectorAll('div, li, article, section, label'))
        .filter((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          if (rect.left < window.innerWidth * 0.28 || rect.width < 180) {
            return false;
          }

          const text = normalize(element.innerText || '');
          return text.includes(target) && /plot|ownership|municipality|district|community/i.test(text);
        }) as HTMLElement[];

      const best = candidates
        .map((element) => ({
          element,
          text: normalize(element.innerText || ''),
          selected:
            element.getAttribute('aria-checked') === 'true' ||
            element.getAttribute('aria-selected') === 'true' ||
            /selected|checked|active/.test((element.className || '').toString()),
        }))
        .sort((left, right) => left.text.length - right.text.length)[0];

      return {
        found: Boolean(best),
        selected: Boolean(best?.selected),
        matchedText: best?.text || '',
        noResults,
        rawPreview: bodyText.slice(0, 500),
      };
    }, plotNumber);
  }

  private async clickFilteredResult(plotNumber: string): Promise<string> {
    const page = this.getPage();

    console.log(`🔍 Looking for filtered result that matches plot ${plotNumber} on the right side...`);
    const observation = await page.observe({
      instruction: `Find the clickable property result card or list item on the right side that matches plot number "${plotNumber}". Ignore the left Filters box and ignore Proceed/Cancel buttons.`,
      iframes: true as any,
    });

    const resultAction = observation
      .map((item: any) => ({
        item,
        score: this.scoreTextMatch(item.description, plotNumber),
      }))
      .filter((candidate: any) => candidate.item.selector && candidate.item.method === 'click' && candidate.score > 0)
      .sort((left: any, right: any) => right.score - left.score)[0];

    if (resultAction?.item.selector) {
      const locator = page.locator(resultAction.item.selector).first();
      await this.clickLocator(locator, `Selected filtered result "${resultAction.item.description}"`);
      return resultAction.item.description;
    }

    const fallback = await page.evaluate((targetPlotNumber: string) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const findClickableAncestor = (element: HTMLElement): HTMLElement | null => {
        let node: HTMLElement | null = element;
        for (let depth = 0; node && depth < 5; depth += 1) {
          if (
            node.matches('button, a, [role="button"], li, label') ||
            node.hasAttribute('onclick') ||
            node.getAttribute('tabindex') !== null ||
            window.getComputedStyle(node).cursor === 'pointer'
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return element;
      };

      const target = normalize(targetPlotNumber);
      const candidates = Array.from(document.querySelectorAll('div, li, article, section, label'))
        .filter((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || '');
          return rect.left > window.innerWidth * 0.28 &&
            rect.width > 180 &&
            text.includes(target) &&
            /plot|ownership|municipality|district|community/i.test(text);
        })
        .map((element) => {
          const clickable = findClickableAncestor(element as HTMLElement);
          return clickable ? { clickable, text: normalize((clickable.innerText || clickable.textContent || '')) } : null;
        })
        .filter(Boolean) as Array<{ clickable: HTMLElement; text: string }>;

      const best = candidates.sort((left, right) => left.text.length - right.text.length)[0];
      if (!best) {
        return { success: false, text: '' };
      }

      best.clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      best.clickable.click();
      return { success: true, text: best.text };
    }, plotNumber);

    if (!fallback.success) {
      throw new Error(`Filtered result for plot ${plotNumber} was not found on the right side`);
    }

    console.log(`✓ Selected filtered result using right-side fallback: ${fallback.text}\n`);
    return fallback.text;
  }

  private async clickProceedFromResultsArea(): Promise<void> {
    const page = this.getPage();

    console.log('🔍 Looking for enabled Proceed button in the right-side footer area...');
    const observation = await page.observe({
      instruction: 'Find the enabled Proceed button in the footer area of the right-side results section. Ignore Cancel and ignore any buttons in the left Filters box.',
      iframes: true as any,
    });

    const proceedAction = observation.find((item: any) => {
      const description = item.description.toLowerCase();
      return item.selector &&
        item.method === 'click' &&
        description.includes('proceed') &&
        !description.includes('cancel');
    });

    if (proceedAction?.selector) {
      const locator = page.locator(proceedAction.selector).first();
      await this.clickLocator(locator, `Clicked Proceed button "${proceedAction.description}"`);
      return;
    }

    const clicked = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 40 &&
          rect.height > 20 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }

          const rect = element.getBoundingClientRect();
          const text = normalize(element.innerText || element.textContent || '');
          const isDisabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

          return rect.left > window.innerWidth * 0.28 &&
            /proceed/i.test(text) &&
            !/cancel/i.test(text) &&
            !isDisabled;
        }) as HTMLElement[];

      const best = candidates.sort((left, right) => right.getBoundingClientRect().top - left.getBoundingClientRect().top)[0];
      if (!best) {
        return false;
      }

      best.scrollIntoView({ block: 'center', inline: 'nearest' });
      best.click();
      return true;
    });

    if (!clicked) {
      throw new Error('Enabled Proceed button was not found in the right-side results area');
    }

    console.log('✓ Clicked enabled Proceed button from the right-side results area\n');
  }

  private async getPostProceedPaymentPageState(plotNumber: string): Promise<{
    ready: boolean;
    hasPayWith: boolean;
    hasPaymentDetails: boolean;
    hasPayNow: boolean;
    hasApplicationId: boolean;
    hasPlotDetails: boolean;
    hasWalletOption: boolean;
    hasCardOption: boolean;
    loadingLike: boolean;
    bodyPreview: string;
  }> {
    const page = this.getPage();

    return await page.evaluate((targetPlotNumber: string) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const bodyText = normalize(document.body?.innerText || '');
      const lower = bodyText.toLowerCase();
      const compactPlot = targetPlotNumber.replace(/\s+/g, '');

      const hasPayWith = lower.includes('pay with');
      const hasPaymentDetails = lower.includes('payment details');
      const hasPayNow = lower.includes('pay now');
      const hasApplicationId = lower.includes('application id');
      const hasPlotDetails =
        lower.includes('plot number') &&
        (lower.includes(targetPlotNumber.toLowerCase()) || lower.includes(compactPlot.toLowerCase()));
      const hasWalletOption = lower.includes('dari wallet');
      const hasCardOption = lower.includes('debit/credit card') || lower.includes('debit credit card');
      const loadingLike =
        lower.includes('loading') ||
        lower.includes('processing') ||
        lower.includes('please wait') ||
        Boolean(document.querySelector('[role="progressbar"], .spinner, .loading, .ant-spin, .loader'));

      const ready =
        hasPayWith &&
        hasPaymentDetails &&
        hasPayNow &&
        hasApplicationId &&
        hasPlotDetails &&
        (hasWalletOption || hasCardOption);

      return {
        ready,
        hasPayWith,
        hasPaymentDetails,
        hasPayNow,
        hasApplicationId,
        hasPlotDetails,
        hasWalletOption,
        hasCardOption,
        loadingLike,
        bodyPreview: bodyText.slice(0, 600),
      };
    }, plotNumber);
  }

  private async waitForPaymentPageAfterProceed(plot: PlotData): Promise<void> {
    const page = this.getPage();
    const maxWaitTimeMs = this.config.waitTimes.downloadPageTimeout;
    const startTime = Date.now();
    let lastUrl = page.url();
    let lastStateSummary = '';

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏳ WAITING FOR PAYMENT PAGE AFTER PROCEED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Plot: ${plot.plotNumber}`);
    console.log(`   Max wait time: ${Math.floor(maxWaitTimeMs / 60000)} minutes`);
    console.log('   Waiting for page with plot details on the left and Pay with / Payment details on the right\n');

    while ((Date.now() - startTime) < maxWaitTimeMs) {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

      if (elapsedSeconds === 0 || elapsedSeconds % 15 === 0) {
        try {
          await this.waitForDocumentReady(12000);
        } catch {
          // Processing pages can stay busy for a long time; keep polling the DOM state.
        }
      }

      const currentUrl = page.url();
      if (currentUrl !== lastUrl) {
        console.log(`🔄 URL changed: ${currentUrl}`);
        lastUrl = currentUrl;
      }

      const state = await this.getPostProceedPaymentPageState(plot.plotNumber);
      lastStateSummary = JSON.stringify({
        url: currentUrl,
        hasPayWith: state.hasPayWith,
        hasPaymentDetails: state.hasPaymentDetails,
        hasPayNow: state.hasPayNow,
        hasApplicationId: state.hasApplicationId,
        hasPlotDetails: state.hasPlotDetails,
        hasWalletOption: state.hasWalletOption,
        hasCardOption: state.hasCardOption,
        loadingLike: state.loadingLike,
      });

      if (state.ready) {
        console.log('✅ PAYMENT PAGE DETECTED!');
        console.log(`   URL: ${currentUrl}`);
        console.log(`   Found plot details, Application ID, Pay with, Payment details, and Pay now`);
        console.log(`   Time elapsed: ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s\n`);
        return;
      }

      if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
        console.log(`   ⏳ Still waiting... ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s elapsed`);
        console.log(`   Current state: ${lastStateSummary}`);
      }

      await sleep(state.loadingLike ? 3000 : 2000);
    }

    throw new Error(`Timed out waiting for the payment page after Proceed. Last state: ${lastStateSummary}`);
  }

  private parseMoneyAmount(rawText: string | null | undefined, mode: 'first' | 'last' = 'first'): number | null {
    if (!rawText) {
      return null;
    }

    const matches = Array.from(rawText.matchAll(/\d[\d,]*(?:\.\d+)?/g))
      .map((match) => Number.parseFloat(match[0].replace(/,/g, '')))
      .filter((value) => !Number.isNaN(value));

    if (matches.length === 0) {
      return null;
    }

    return mode === 'last' ? matches[matches.length - 1] : matches[0];
  }

  private parseWalletBalanceAmount(rawText: string | null | undefined): number | null {
    if (!rawText) {
      return null;
    }

    const balanceMatch = rawText.match(/balance[^0-9]*([\d,]+(?:\.\d+)?)/i);
    if (balanceMatch) {
      return this.parseMoneyAmount(balanceMatch[1]);
    }

    return this.parseMoneyAmount(rawText, 'first');
  }

  private parseTotalPaymentAmount(rawText: string | null | undefined): number | null {
    if (!rawText) {
      return null;
    }

    const totalMatch = rawText.match(/total\s+to\s+be\s+paid[^0-9]*([\d,]+(?:\.\d+)?)/i)
      || rawText.match(/total[^0-9]*([\d,]+(?:\.\d+)?)/i);

    if (totalMatch) {
      return this.parseMoneyAmount(totalMatch[1]);
    }

    return this.parseMoneyAmount(rawText, 'last');
  }

  private extractApplicationIdFromText(rawText: string | null | undefined): string | null {
    if (!rawText) {
      return null;
    }

    const explicitMatch = rawText.match(/application\s*id[^0-9]*(\d{8,})/i);
    if (explicitMatch) {
      return explicitMatch[1];
    }

    const genericMatch = rawText.match(/\b\d{10,}\b/);
    return genericMatch ? genericMatch[0] : null;
  }

  private isCardGatewayUrl(url: string): boolean {
    return /abudhabipay\.gov\.ae|\/adpay\//i.test(url);
  }

  private getServicesListingUrl(): string {
    const trimmedBase = this.config.baseUrl.replace(/\/+$/, '');
    return `${trimmedBase}/app/services`;
  }

  private isCertificateArtifact(filename: string | null | undefined): boolean {
    if (!filename) {
      return false;
    }

    const lower = filename.toLowerCase();
    return (lower.includes('certificate') || lower.includes('site plan'))
      && !lower.includes('receipt');
  }

  private isReceiptArtifact(filename: string | null | undefined): boolean {
    if (!filename) {
      return false;
    }

    const lower = filename.toLowerCase();
    return lower.includes('receipt') || lower.includes('payment');
  }

  private captureDownloadDirectorySnapshot(): string[] {
    if (!this.downloadPath || !existsSync(this.downloadPath)) {
      return [];
    }

    return readdirSync(this.downloadPath)
      .map((entry) => {
        const fullPath = join(this.downloadPath!, entry);
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
          return null;
        }

        return `${entry}:${stats.size}:${Math.floor(stats.mtimeMs)}`;
      })
      .filter(Boolean) as string[];
  }

  private async waitForDownloadArtifact(previousSnapshot: string[], timeoutMs: number = 30000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    const baseline = new Set(previousSnapshot);

    while (Date.now() < deadline) {
      const currentSnapshot = this.captureDownloadDirectorySnapshot();
      const newArtifact = currentSnapshot.find((item) => !baseline.has(item));
      if (newArtifact) {
        return newArtifact.split(':')[0];
      }

      await sleep(1000);
    }

    return null;
  }

  private async getPaymentPageSnapshot(plotNumber: string): Promise<{
    applicationId: string | null;
    plotMatched: boolean;
    walletOptionVisible: boolean;
    walletSelected: boolean;
    walletRadioChecked: boolean;
    cardOptionVisible: boolean;
    cardSelected: boolean;
    cardRadioChecked: boolean;
    exclusiveWalletSelection: boolean;
    payNowVisible: boolean;
    payNowEnabled: boolean;
    balanceText: string;
    totalAmountText: string;
    propertyPanelText: string;
    payWithPanelText: string;
    paymentDetailsText: string;
    processingLike: boolean;
    bodyPreview: string;
  }> {
    const page = this.getPage();

    return await page.evaluate((targetPlotNumber: string) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 &&
          rect.height > 16 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const bodyText = normalize(document.body?.innerText || '');
      const lowerBody = bodyText.toLowerCase();
      const normalizedPlot = normalize(targetPlotNumber);
      const compactPlot = normalizedPlot.replace(/\s+/g, '');

      const visibleContainers = Array.from(document.querySelectorAll('section, article, aside, div, form'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          element: element as HTMLElement,
          text: normalize((element as HTMLElement).innerText || ''),
        }));

      const payWithPanel = visibleContainers.find(({ text, element }) => {
        const rect = element.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.48 &&
          text.toLowerCase().includes('pay with') &&
          (text.toLowerCase().includes('dari wallet') || text.toLowerCase().includes('credit card'));
      });

      const paymentDetailsPanel = visibleContainers.find(({ text, element }) => {
        const rect = element.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.48 &&
          text.toLowerCase().includes('payment details') &&
          /total|municipality fee|vat|other/i.test(text);
      });

      const propertyPanel = visibleContainers.find(({ text, element }) => {
        const rect = element.getBoundingClientRect();
        return rect.left < window.innerWidth * 0.65 &&
          text.toLowerCase().includes('application id') &&
          text.toLowerCase().includes('plot number');
      });

      const findPaymentOptionRow = (container: HTMLElement | undefined, labelText: string, disallowedText?: string) => {
        if (!container) {
          return null;
        }

        const candidates = Array.from(container.querySelectorAll('label, li, article, section, div, button'))
          .filter((element) => isVisible(element))
          .map((element) => {
            const text = normalize((element as HTMLElement).innerText || '').toLowerCase();
            const rect = (element as HTMLElement).getBoundingClientRect();
            return {
              element,
              text,
              area: Math.max(1, rect.width * rect.height),
            };
          })
          .filter(({ text }) => text.includes(labelText) && (!disallowedText || !text.includes(disallowedText)))
          .sort((left, right) => left.text.length - right.text.length || left.area - right.area);

        return candidates[0]?.element || null;
      };

      const findPaymentRadioInput = (container: HTMLElement | undefined, value: 'wallet' | 'card') => {
        if (!container) {
          return null;
        }

        if (value === 'wallet') {
          return container.querySelector('input[type="radio"][value="wallet"], input#userRadiob, input#userRadioB') as HTMLInputElement | null;
        }

        return container.querySelector('input[type="radio"][value="card"], input#userRadioA, input#userRadioa') as HTMLInputElement | null;
      };

      const getCheckedRadioState = (element: Element | null): boolean => {
        if (!element || !(element instanceof HTMLElement)) {
          return false;
        }

        const directInput = element.matches('input[type="radio"], input[type="checkbox"]')
          ? element as HTMLInputElement
          : null;
        if (directInput && directInput.checked) {
          return true;
        }

        const descendantInput = element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
        return Boolean(descendantInput?.checked);
      };

      const optionAppearsSelected = (element: Element | null): boolean => {
        if (!element || !(element instanceof HTMLElement)) {
          return false;
        }

        if (
          element instanceof HTMLInputElement &&
          /radio|checkbox/i.test(element.type) &&
          element.checked
        ) {
          return true;
        }

        if (
          element.getAttribute('aria-checked') === 'true' ||
          element.getAttribute('aria-selected') === 'true' ||
          /selected|checked|active/.test(`${element.className || ''}`.toLowerCase())
        ) {
          return true;
        }

        const ownCheckedInput = element.querySelector(':scope input[type="radio"]:checked, :scope input[type="checkbox"]:checked');
        if (ownCheckedInput) {
          return true;
        }

        const explicitlySelectedDescendant = Array.from(element.querySelectorAll('[aria-checked="true"], [aria-selected="true"], input[type="radio"], input[type="checkbox"]'))
          .some((node) => {
            if (node instanceof HTMLInputElement) {
              return node.checked;
            }

            return /selected|checked|active/.test(`${(node as HTMLElement).className || ''}`.toLowerCase())
              || (node as HTMLElement).getAttribute('aria-checked') === 'true'
              || (node as HTMLElement).getAttribute('aria-selected') === 'true';
          });

        if (explicitlySelectedDescendant) {
          return true;
        }

        return false;
      };

      const walletRow = findPaymentOptionRow(payWithPanel?.element, 'dari wallet', 'debit/credit card')
        || findPaymentOptionRow(payWithPanel?.element, 'dari wallet', 'credit card')
        || findPaymentOptionRow(payWithPanel?.element, 'dari wallet');
      const cardRow = findPaymentOptionRow(payWithPanel?.element, 'debit/credit card', 'dari wallet')
        || findPaymentOptionRow(payWithPanel?.element, 'debit credit card', 'dari wallet')
        || findPaymentOptionRow(payWithPanel?.element, 'credit card', 'dari wallet')
        || findPaymentOptionRow(payWithPanel?.element, 'credit card');
      const walletRadioInput = findPaymentRadioInput(payWithPanel?.element, 'wallet');
      const cardRadioInput = findPaymentRadioInput(payWithPanel?.element, 'card');

      const payNowButton = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find((element) => {
          if (!isVisible(element)) {
            return false;
          }

          const text = normalize((element as HTMLElement).innerText || (element as HTMLElement).textContent || '');
          return /pay now/i.test(text);
        }) as HTMLElement | undefined;

      const payNowEnabled = Boolean(
        payNowButton &&
        !payNowButton.hasAttribute('disabled') &&
        payNowButton.getAttribute('aria-disabled') !== 'true' &&
        !/disabled/.test(`${payNowButton.className || ''}`.toLowerCase())
      );

      const propertyPanelText = propertyPanel?.text || '';
      const payWithPanelText = payWithPanel?.text || '';
      const paymentDetailsText = paymentDetailsPanel?.text || '';
      const applicationIdMatch = (propertyPanelText || bodyText).match(/application\s*id[^0-9]*(\d{8,})/i)
        || (propertyPanelText || bodyText).match(/\b\d{10,}\b/);
      const applicationId = applicationIdMatch ? applicationIdMatch[1] || applicationIdMatch[0] : null;
      const plotMatched = propertyPanelText.toLowerCase().includes(normalizedPlot.toLowerCase())
        || propertyPanelText.toLowerCase().includes(compactPlot.toLowerCase())
        || lowerBody.includes(`plot number:${compactPlot.toLowerCase()}`)
        || lowerBody.includes(normalizedPlot.toLowerCase());
      const processingLike =
        lowerBody.includes('loading') ||
        lowerBody.includes('processing') ||
        lowerBody.includes('please wait') ||
        lowerBody.includes('submitting') ||
        Boolean(document.querySelector('[role="progressbar"], .spinner, .loading, .ant-spin, .loader'));

      return {
        applicationId,
        plotMatched,
        walletOptionVisible: Boolean(walletRow),
        walletSelected: Boolean(walletRadioInput?.checked) || optionAppearsSelected(walletRow),
        walletRadioChecked: Boolean(walletRadioInput?.checked) || getCheckedRadioState(walletRow),
        cardOptionVisible: Boolean(cardRow),
        cardSelected: Boolean(cardRadioInput?.checked) || optionAppearsSelected(cardRow),
        cardRadioChecked: Boolean(cardRadioInput?.checked) || getCheckedRadioState(cardRow),
        exclusiveWalletSelection: Boolean(walletRadioInput?.checked) && !Boolean(cardRadioInput?.checked),
        payNowVisible: Boolean(payNowButton),
        payNowEnabled,
        balanceText: walletRow ? normalize((walletRow as HTMLElement).innerText || (walletRow as HTMLElement).textContent || '') : '',
        totalAmountText: paymentDetailsText,
        propertyPanelText,
        payWithPanelText,
        paymentDetailsText,
        processingLike,
        bodyPreview: bodyText.slice(0, 800),
      };
    }, plotNumber);
  }

  private async requireExclusiveDariWalletSelection(plotNumber: string, timeoutMs: number = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = await this.getPaymentPageSnapshot(plotNumber);
      if (state.exclusiveWalletSelection) {
        console.log('✓ Verified DARI wallet radio button is selected and card radio button is not selected\n');
        return;
      }

      await sleep(500);
    }

    const finalState = await this.getPaymentPageSnapshot(plotNumber);
    throw new Error(
      `DARI wallet radio selection verification failed. walletSelected=${finalState.walletSelected}, walletRadioChecked=${finalState.walletRadioChecked}, cardSelected=${finalState.cardSelected}, cardRadioChecked=${finalState.cardRadioChecked}, payWithPanel="${finalState.payWithPanelText}"`
    );
  }

  private async selectDariWalletPaymentMethod(plotNumber: string): Promise<void> {
    const page = this.getPage();
    const before = await this.getPaymentPageSnapshot(plotNumber);

    if (!before.walletOptionVisible) {
      throw new Error('DARI wallet option is not visible on the payment page');
    }

    if (before.exclusiveWalletSelection) {
      console.log('✓ DARI wallet is already selected\n');
      return;
    }

    const clicked = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 &&
          rect.height > 16 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const containers = Array.from(document.querySelectorAll('section, article, aside, div, form'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          element: element as HTMLElement,
          text: normalize((element as HTMLElement).innerText || ''),
        }));

      const payWithPanel = containers.find(({ text, element }) => {
        const rect = element.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.48 &&
          text.toLowerCase().includes('pay with') &&
          text.toLowerCase().includes('dari wallet');
      })?.element;

      if (!payWithPanel) {
        return false;
      }

      const walletInput = payWithPanel.querySelector('input[type="radio"][value="wallet"], input#userRadiob, input#userRadioB') as HTMLInputElement | null;
      const cardInput = payWithPanel.querySelector('input[type="radio"][value="card"], input#userRadioA, input#userRadioa') as HTMLInputElement | null;

      if (!walletInput) {
        return false;
      }

      if (walletInput.checked && !cardInput?.checked) {
        return true;
      }

      const walletLabel = walletInput.id
        ? payWithPanel.querySelector(`label[for="${walletInput.id}"]`) as HTMLElement | null
        : null;
      const walletButtonRoot = walletInput.closest('.MuiButtonBase-root, .MuiIconButton-root, [role="radio"]') as HTMLElement | null;
      const clickable = walletLabel || walletButtonRoot || walletInput;

      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });

      if (clickable instanceof HTMLInputElement) {
        clickable.click();
      } else {
        clickable.click();
      }

      if (!walletInput.checked) {
        walletInput.checked = true;
        walletInput.dispatchEvent(new Event('input', { bubbles: true }));
        walletInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return walletInput.checked;
    });

    if (!clicked) {
      const walletLocator = await this.waitForFirstVisibleLocator([
        () => page.locator('label[for="userRadiob"]').first(),
        () => page.locator('input[type="radio"][value="wallet"]').first(),
        () => page.locator('img[alt="Dariwallet"]').first(),
        () => page.locator('label').filter({ hasText: /^DARI wallet/i }).first(),
      ], 'DARI wallet payment radio option', 10000);

      await this.clickLocator(walletLocator, 'Clicked DARI wallet payment radio option');
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const after = await this.getPaymentPageSnapshot(plotNumber);
      if (after.exclusiveWalletSelection) {
        console.log('✓ Verified DARI wallet is selected\n');
        return;
      }

      await sleep(750);
    }

    const finalState = await this.getPaymentPageSnapshot(plotNumber);
    throw new Error(`DARI wallet option did not become exclusively selected after clicking it. walletSelected=${finalState.walletSelected}, cardSelected=${finalState.cardSelected}, payWithPanel="${finalState.payWithPanelText}"`);
  }

  private async clickPayNowAndWaitForProcessing(plotNumber: string): Promise<void> {
    const page = this.getPage();
    const beforeUrl = page.url();
    const before = await this.getPaymentPageSnapshot(plotNumber);

    if (!before.walletSelected) {
      throw new Error('Refusing to click Pay now because DARI wallet is not selected');
    }

    if (before.cardSelected) {
      throw new Error('Refusing to click Pay now because Debit/credit card is still selected');
    }

    if (!before.exclusiveWalletSelection) {
      throw new Error('Refusing to click Pay now because the DARI wallet radio button is not exclusively selected');
    }

    if (!before.payNowVisible || !before.payNowEnabled) {
      throw new Error('Refusing to click Pay now because the button is not visible and enabled');
    }

    const clicked = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 &&
          rect.height > 16 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const button = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find((element) => {
          if (!isVisible(element)) {
            return false;
          }

          const text = normalize((element as HTMLElement).innerText || (element as HTMLElement).textContent || '');
          const disabled = (element as HTMLElement).hasAttribute('disabled')
            || (element as HTMLElement).getAttribute('aria-disabled') === 'true'
            || /disabled/.test(`${(element as HTMLElement).className || ''}`.toLowerCase());

          return /pay now/i.test(text) && !disabled;
        }) as HTMLElement | undefined;

      if (!button) {
        return false;
      }

      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return true;
    });

    if (!clicked) {
      const payNowButton = await this.waitForFirstVisibleLocator([
        () => page.locator('button').filter({ hasText: /pay now/i }).first(),
        () => page.locator('[role="button"]').filter({ hasText: /pay now/i }).first(),
        () => page.locator('a').filter({ hasText: /pay now/i }).first(),
      ], 'Pay now button', 10000);

      await this.clickLocator(payNowButton, 'Clicked Pay now');
    }

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const currentUrl = page.url();
      const state = await this.getPaymentPageSnapshot(plotNumber);

      if (this.isCardGatewayUrl(currentUrl)) {
        throw new Error(`Wrong payment method detected: redirected to Abu Dhabi Pay card gateway (${currentUrl}) instead of paying with DARI wallet`);
      }

      if (currentUrl !== beforeUrl || state.processingLike || !state.payNowVisible || !state.payNowEnabled) {
        console.log('✓ Payment processing started\n');
        return;
      }

      await sleep(1000);
    }

    throw new Error('Pay now was clicked, but the page never showed a processing or navigation state');
  }

  private async getFinalCertificatePageState(plotNumber: string, applicationId: string | null): Promise<{
    ready: boolean;
    hasDownloadButton: boolean;
    hasCertificateContext: boolean;
    hasApplicationId: boolean;
    plotMatched: boolean;
    processingLike: boolean;
    bodyPreview: string;
  }> {
    const page = this.getPage();

    return await page.evaluate((payload: { targetPlotNumber: string; targetApplicationId: string | null }) => {
      const { targetPlotNumber, targetApplicationId } = payload;
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 &&
          rect.height > 16 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const bodyText = normalize(document.body?.innerText || '');
      const lowerBody = bodyText.toLowerCase();
      const normalizedPlot = normalize(targetPlotNumber).toLowerCase();
      const compactPlot = normalizedPlot.replace(/\s+/g, '');
      const hasDownloadButton = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .some((element) => {
          if (!isVisible(element)) {
            return false;
          }

          const text = normalize((element as HTMLElement).innerText || (element as HTMLElement).textContent || '').toLowerCase();
          return text.includes('download');
        });

      const hasCertificateContext =
        lowerBody.includes('certificate') ||
        lowerBody.includes('site plan') ||
        lowerBody.includes('verification certificate') ||
        lowerBody.includes('download');
      const hasApplicationId = Boolean(
        (targetApplicationId && lowerBody.includes(targetApplicationId.toLowerCase())) ||
        lowerBody.includes('application id')
      );
      const plotMatched =
        lowerBody.includes(normalizedPlot) ||
        lowerBody.includes(compactPlot) ||
        lowerBody.includes(`plot number:${compactPlot}`);
      const processingLike =
        lowerBody.includes('loading') ||
        lowerBody.includes('processing') ||
        lowerBody.includes('please wait') ||
        lowerBody.includes('submitting') ||
        Boolean(document.querySelector('[role="progressbar"], .spinner, .loading, .ant-spin, .loader'));

      return {
        ready: hasDownloadButton && (hasCertificateContext || hasApplicationId || plotMatched),
        hasDownloadButton,
        hasCertificateContext,
        hasApplicationId,
        plotMatched,
        processingLike,
        bodyPreview: bodyText.slice(0, 800),
      };
    }, { targetPlotNumber: plotNumber, targetApplicationId: applicationId });
  }

  private async waitForCertificateDownloadPage(plot: PlotData, applicationId: string | null): Promise<void> {
    const page = this.getPage();
    const maxWaitTimeMs = this.config.waitTimes.downloadPageTimeout;
    const startTime = Date.now();
    let lastUrl = page.url();
    let lastStateSummary = '';

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏳ WAITING FOR CERTIFICATE DOWNLOAD PAGE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Plot: ${plot.plotNumber}`);
    console.log(`   Application ID: ${applicationId || 'unknown'}`);
    console.log(`   Max wait time: ${Math.floor(maxWaitTimeMs / 60000)} minutes\n`);

    while ((Date.now() - startTime) < maxWaitTimeMs) {
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      const currentUrl = page.url();

      if (currentUrl !== lastUrl) {
        console.log(`🔄 URL changed: ${currentUrl}`);
        lastUrl = currentUrl;
      }

      const state = await this.getFinalCertificatePageState(plot.plotNumber, applicationId);
      lastStateSummary = JSON.stringify({
        url: currentUrl,
        hasDownloadButton: state.hasDownloadButton,
        hasCertificateContext: state.hasCertificateContext,
        hasApplicationId: state.hasApplicationId,
        plotMatched: state.plotMatched,
        processingLike: state.processingLike,
      });

      if (state.ready) {
        console.log('✅ CERTIFICATE DOWNLOAD PAGE DETECTED!');
        console.log(`   URL: ${currentUrl}`);
        console.log(`   Time elapsed: ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s\n`);
        return;
      }

      if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
        console.log(`   ⏳ Still waiting... ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s elapsed`);
        console.log(`   Current state: ${lastStateSummary}`);
      }

      await sleep(state.processingLike ? 3000 : 2000);
    }

    throw new Error(`Timed out waiting for the final certificate download page. Last state: ${lastStateSummary}`);
  }

  private async clickCertificateDownloadAndVerify(): Promise<{ success: boolean; filename: string | null; kind: 'certificate' | 'receipt' | null }> {
    const page = this.getPage();
    const beforeSnapshot = this.captureDownloadDirectorySnapshot();

    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    const clickedKind = await page.evaluate(() => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 20 &&
          rect.height > 16 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      };

      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter((element) => isVisible(element))
        .map((element) => ({
          element: element as HTMLElement,
          text: normalize((element as HTMLElement).innerText || (element as HTMLElement).textContent || '').toLowerCase(),
        }))
        .filter(({ text }) => text.includes('download'));

      const certificateTarget = candidates.find(({ text }) => text.includes('download certificate'));
      const receiptTarget = candidates.find(({ text }) => text.includes('download payment receipt') || text.includes('download receipt') || text.includes('receipt'));
      const target = certificateTarget || receiptTarget;
      const kind = certificateTarget ? 'certificate' : receiptTarget ? 'receipt' : null;
      if (!target || !kind) {
        return null;
      }

      target.element.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.element.click();
      return kind;
    });

    const isExpectedArtifact = (filename: string | null | undefined, kind: 'certificate' | 'receipt') =>
      kind === 'certificate'
        ? this.isCertificateArtifact(filename)
        : this.isReceiptArtifact(filename);

    if (!clickedKind) {
      const downloadButton = await this.waitForFirstVisibleLocator([
        () => page.locator('button').filter({ hasText: /^download certificate$/i }).first(),
        () => page.locator('[role="button"]').filter({ hasText: /^download certificate$/i }).first(),
        () => page.locator('a').filter({ hasText: /^download certificate$/i }).first(),
        () => page.locator('button').filter({ hasText: /^download payment receipt$/i }).first(),
        () => page.locator('[role="button"]').filter({ hasText: /^download payment receipt$/i }).first(),
        () => page.locator('a').filter({ hasText: /^download payment receipt$/i }).first(),
        () => page.locator('button').filter({ hasText: /download/i }).first(),
        () => page.locator('[role="button"]').filter({ hasText: /download/i }).first(),
        () => page.locator('a').filter({ hasText: /download/i }).first(),
      ], 'download action button', 10000);

      const buttonText = ((await downloadButton.textContent()) || '').trim().toLowerCase();
      const fallbackKind: 'certificate' | 'receipt' =
        buttonText.includes('certificate') ? 'certificate' : 'receipt';

      const secondDownloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await this.clickLocator(downloadButton, `Clicked download ${fallbackKind} button`);
      const fallbackDownload = await secondDownloadPromise;

      if (fallbackDownload) {
        const suggestedFilename = fallbackDownload.suggestedFilename();
        await fallbackDownload.path().catch(() => null);
        return {
          success: isExpectedArtifact(suggestedFilename, fallbackKind),
          filename: suggestedFilename || null,
          kind: fallbackKind,
        };
      }

      const artifact = await this.waitForDownloadArtifact(beforeSnapshot, 20000);
      return {
        success: isExpectedArtifact(artifact, fallbackKind),
        filename: artifact,
        kind: fallbackKind,
      };
    }

    const download = await downloadPromise;
    if (download) {
      const suggestedFilename = download.suggestedFilename();
      await download.path().catch(() => null);
      return {
        success: isExpectedArtifact(suggestedFilename, clickedKind),
        filename: suggestedFilename || null,
        kind: clickedKind,
      };
    }

    const artifact = await this.waitForDownloadArtifact(beforeSnapshot, 20000);
    return {
      success: isExpectedArtifact(artifact, clickedKind),
      filename: artifact,
      kind: clickedKind,
    };
  }

  /**
   * Step 1: Navigate to Dari homepage
   */
  async navigateToHomepage(): Promise<void> {
    console.log('==============================================');
    console.log('Step 1: Navigate to Dari Homepage');
    console.log('==============================================\n');

    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log(`🌐 Navigating to: ${this.config.baseUrl}`);
    await this.stagehand.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    await this.waitForDocumentReady(20000);
    await this.acceptCookiesIfPresent();
    await this.waitForBodyText(['dari'], 'Dari homepage shell', 15000, 'any');

    console.log(`📍 Current URL: ${this.stagehand.page.url()}`);
    console.log('✓ Dari homepage loaded and stable\n');
  }

  /**
   * Step 2: Click Login button
   */
  async clickLoginButton(): Promise<void> {
    console.log('==============================================');
    console.log('Step 2: Click Login Button');
    console.log('==============================================\n');

    const page = this.stagehand!.page;

    await this.waitForDocumentReady(10000);
    await this.acceptCookiesIfPresent();

    console.log('🔍 Verifying Login button is present in the Dari header...');
    const observation = await page.observe({
      instruction: 'Find the Login button in the main Dari website header navigation',
    });
    const loginCandidates = observation.filter((item) => {
      const description = item.description.toLowerCase();
      return item.method === 'click' &&
        description.includes('login') &&
        !description.includes('uae pass');
    });

    if (loginCandidates.length === 0) {
      throw new Error('Login button was not observed in the Dari header');
    }

    const loginButton = await this.waitForFirstVisibleLocator([
      () => page.locator('header, nav, [role="banner"]').locator('a, button, [role="button"]').filter({ hasText: /^login$/i }).first(),
      () => page.locator('a, button, [role="button"]').filter({ hasText: /^login$/i }).first(),
    ], 'Dari header Login button', 15000);

    console.log('🖱️  Clicking the exact Login control in the header...');
    await loginButton.scrollIntoViewIfNeeded();
    await loginButton.click();

    await this.waitForDocumentReady(15000);
    await this.waitForBodyText(['login with uae pass'], 'Dari login page', 15000, 'any');

    console.log('✓ Login button clicked\n');
  }

  /**
   * Step 3: Click "Login with UAE Pass" button
   */
  async clickUAEPassButton(): Promise<void> {
    console.log('==============================================');
    console.log('Step 3: Click UAE Pass Login');
    console.log('==============================================\n');

    const page = this.stagehand!.page;

    await this.waitForDocumentReady(15000);
    await this.waitForBodyText(['login with uae pass'], 'UAE PASS option on Dari login page', 15000, 'any');

    console.log('🔍 Verifying the Login with UAE PASS button and text...');
    const observation = await page.observe({
      instruction: 'Find the "Login with UAE PASS" button on the Dari login page',
    });
    const uaePassCandidates = observation.filter((item) => {
      const description = item.description.toLowerCase();
      return item.method === 'click' &&
        description.includes('uae') &&
        description.includes('pass');
    });

    if (uaePassCandidates.length === 0) {
      throw new Error('Login with UAE PASS button was not observed on the login page');
    }

    const uaePassButton = await this.waitForFirstVisibleLocator([
      () => page.locator('button').filter({ hasText: /login with uae\s*pass/i }).first(),
      () => page.locator('a, [role="button"]').filter({ hasText: /login with uae\s*pass/i }).first(),
    ], 'Login with UAE PASS button', 15000);

    console.log('🖱️  Clicking the Login with UAE PASS button...');
    await uaePassButton.scrollIntoViewIfNeeded();
    await uaePassButton.click();

    await this.waitForDocumentReady(20000);
    await this.waitForBodyText(['login to uae pass'], 'UAE PASS login form', 20000, 'any');

    console.log('✓ UAE Pass login initiated\n');
  }

  /**
   * Step 4: Enter mobile number and handle CAPTCHA
   */
  async enterMobileNumber(): Promise<void> {
    console.log('==============================================');
    console.log('Step 4: Enter Mobile Number');
    console.log('==============================================\n');

    const page = this.stagehand!.page;

    await this.waitForDocumentReady(20000);
    await this.waitForBodyText(['login to uae pass'], 'UAE PASS form heading', 20000, 'any');

    const mobileInput = await this.waitForFirstVisibleLocator([
      () => page.locator('input[type="tel"]').first(),
      () => page.locator('input[inputmode="numeric"]').first(),
      () => page.locator('input[name*="mobile" i]').first(),
      () => page.locator('input[placeholder*="mobile" i]').first(),
      () => page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
    ], 'UAE PASS mobile number input', 15000);

    console.log(`📱 Entering mobile number from configuration: ${this.config.mobileNumber}`);
    await mobileInput.scrollIntoViewIfNeeded();
    await mobileInput.fill('');
    await mobileInput.fill(this.config.mobileNumber);
    await sleep(500);

    const enteredValue = await mobileInput.inputValue();
    const expectedDigits = this.config.mobileNumber.replace(/\D/g, '');
    const enteredDigits = enteredValue.replace(/\D/g, '');

    if (enteredDigits !== expectedDigits) {
      throw new Error(`UAE PASS mobile number input mismatch. Expected ${this.config.mobileNumber}, got ${enteredValue}`);
    }

    console.log('✓ Mobile number entered\n');

    const rememberMeCheckbox = page.locator('input[type="checkbox"]').first();
    try {
      await rememberMeCheckbox.waitFor({ state: 'visible', timeout: 2000 });
      if (!(await rememberMeCheckbox.isChecked())) {
        await rememberMeCheckbox.check();
        console.log('✓ Remember me enabled\n');
      }
    } catch {
      console.log('ℹ️  Remember me checkbox not found or already handled\n');
    }

    console.log('🔍 Checking whether a CAPTCHA is visible on the UAE PASS form...');
    if (await this.isCaptchaVisible()) {
      console.log('⚠️  CAPTCHA detected on the UAE PASS form.');
      console.log('   The agent will wait for you before submitting login.\n');
    } else {
      console.log('✓ No CAPTCHA detected\n');
    }
  }

  /**
   * Step 5: Click Login/Submit button
   */
  async clickLoginSubmit(): Promise<void> {
    console.log('==============================================');
    console.log('Step 5: Submit Login');
    console.log('==============================================\n');

    const page = this.stagehand!.page;

    await this.waitForDocumentReady(10000);

    if (await this.isCaptchaVisible()) {
      console.log(`⏳ Waiting up to ${this.config.waitTimes.captcha / 1000} seconds for CAPTCHA/manual verification...`);
      console.log('👉 Solve the CAPTCHA if it appears, then the agent will continue\n');
      await sleep(this.config.waitTimes.captcha);
    }

    const loginSubmitButton = await this.waitForFirstVisibleLocator([
      () => page.locator('button').filter({ hasText: /^login$/i }).first(),
      () => page.locator('input[type="submit"]').first(),
      () => page.locator('[role="button"]').filter({ hasText: /^login$/i }).first(),
    ], 'UAE PASS Login/Submit button', 15000);

    console.log('🖱️  Clicking the UAE PASS Login button...');
    await loginSubmitButton.scrollIntoViewIfNeeded();
    await loginSubmitButton.click();
    await sleep(this.config.waitTimes.afterClick);

    console.log('✓ Login submitted\n');
  }

  /**
   * Step 6: Detect UAE Pass 2FA completion automatically
   */
  async detectUAEPassCompletion(): Promise<void> {
    console.log('==============================================');
    console.log('Step 6: UAE Pass 2FA Detection');
    console.log('==============================================\n');

    const page = this.stagehand!.page;

    console.log('📱 UAE Pass 2FA Required');
    console.log('👉 Open your UAE PASS app and approve the request that says "DARI Web Portal"');
    console.log('👉 Select the correct number in the app, then confirm the login\n');
    console.log(`⏳ Monitoring for login completion (timeout: ${this.config.waitTimes.uaePassTimeout / 1000}s)...\n`);

    const startTime = Date.now();
    let detectedLogin = false;
    let lastUrl = page.url();

    while (Date.now() - startTime < this.config.waitTimes.uaePassTimeout) {
      await sleep(3000); // Check every 3 seconds

      const currentUrl = page.url();
      if (currentUrl !== lastUrl) {
        console.log(`🔄 URL changed: ${currentUrl}`);
        lastUrl = currentUrl;
      }

      // Check if we're back to Dari (not on UAE Pass anymore)
      if (!this.config.detection.uaePassUrlPattern.test(currentUrl) && currentUrl.includes('dari.ae')) {
        console.log('🔍 Returned to Dari domain. Verifying authenticated state...');

        const loginState = await this.verifyLoggedInDariState();

        if (loginState.loggedIn) {
          detectedLogin = true;
          console.log('✅ Login detected successfully!');
          console.log(`📊 Found ${loginState.indicators.length} login indicators:`);
          loginState.indicators.forEach((indicator) => console.log(`   - ${indicator}`));
          console.log();
          break;
        }
      }

      // Show progress
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed % 10 === 0) {
        console.log(`⏳ Still waiting... (${elapsed}s elapsed)`);
      }
    }

    if (!detectedLogin) {
      throw new Error('UAE Pass 2FA timeout - login not completed within time limit');
    }

    console.log('✓ UAE Pass authentication completed\n');
  }

  /**
   * Step 6.5: Switch Account (Optional - based on config)
   */
  async switchAccount(): Promise<void> {
    console.log('==============================================');
    console.log(`Step 6.5: Switch to ${this.config.accountSwitching.targetAccountName}`);
    console.log('==============================================\n');

    await this.openAuthenticatedAccountDropdown();
    console.log('✓ Account dropdown opened\n');

    await this.clickSwitchAccountMenuItem();
    console.log('✓ Switch Account option clicked\n');

    const matchedAccount = await this.clickConfiguredAccountFromPopup(this.config.accountSwitching.targetAccountName);
    console.log(`✓ Account option clicked: ${matchedAccount}\n`);

    console.log('⏳ Waiting for Dari to reload with the switched account...');
    let headerSummary: string;

    try {
      headerSummary = await this.waitForSwitchedAccountInHeader(matchedAccount, 45000);
    } catch (error) {
      console.log('⚠️  Strict account-header verification did not complete in time.');
      console.log('   Attempting relaxed corporate-session confirmation...\n');

      const fallbackSummary = await this.waitForCorporateSessionFallback(15000);
      if (!fallbackSummary) {
        throw error;
      }

      headerSummary = fallbackSummary;
      console.log('✓ Corporate session confirmed using fallback verification\n');
    }

    console.log('✓ Page reloaded with switched account');
    console.log(`📍 Header snapshot: ${headerSummary}`);
    console.log(`✅ Successfully switched to ${this.config.accountSwitching.targetAccountName}\n`);
  }

  /**
   * Step 7: Navigate to Services menu
   */
  async navigateToServicesMenu(): Promise<void> {
    console.log('==============================================');
    console.log('Step 7: Navigate to Services Menu');
    console.log('==============================================\n');

    const page = this.getPage();

    await this.waitForDocumentReady(15000);
    await this.acceptCookiesIfPresent();

    const servicesMenu = await this.waitForFirstVisibleLocator([
      () => page.locator('header, nav, [role="banner"]').locator('a, button, [role="button"]').filter({ hasText: /^services$/i }).first(),
      () => page.locator('a, button, [role="button"]').filter({ hasText: /^services$/i }).first(),
    ], 'top header Services menu', 15000);

    console.log('🖱️  Clicking Services menu in the top header...');
    try {
      await this.clickLocator(servicesMenu, 'Services menu clicked');
      await this.waitForServicesLandingPage(20000);
    } catch (error) {
      console.log('⚠️  Header Services click was blocked or unstable.');
      console.log('   Falling back to direct navigation to the Services listing...\n');

      const servicesUrl = this.getServicesListingUrl();
      await page.goto(servicesUrl, { waitUntil: 'domcontentloaded' });
      await this.waitForDocumentReady(20000);
      await this.acceptCookiesIfPresent();
      await this.waitForServicesLandingPage(20000);

      console.log(`✓ Recovered by navigating directly to: ${servicesUrl}\n`);
    }
  }

  /**
   * Step 8: Select Verification Certificate (Unit) service
   */
  async selectAffectionPlanService(): Promise<void> {
    console.log('==============================================');
    console.log('Step 8: Select Verification Certificate (Unit) Service');
    console.log('==============================================\n');

    console.log(`🔍 Looking for "${this.config.navigation.affectionPlanServiceText}" service...`);
    const matchedService = await this.clickConfiguredServiceFromServicesPage(this.config.navigation.affectionPlanServiceText);
    console.log(`✓ Configured service clicked: ${matchedService}\n`);
    await this.waitForServiceWorkspaceLayout(25000);
  }

  /**
   * Step 9: Extract page information and verify we're on the right page
   */
  async verifyAffectionPlanPage(): Promise<void> {
    console.log('==============================================');
    console.log('Step 9: Verify Service Page');
    console.log('==============================================\n');

    await this.waitForServiceWorkspaceLayout(25000);
    console.log(`✓ Successfully verified ${this.config.navigation.affectionPlanServiceText} service page with Filters and results layout\n`);
  }

  /**
   * Load plot numbers from Excel file
   */
  async loadPlotNumbers(): Promise<void> {
    console.log('==============================================');
    console.log('Step 10: Load Plot Numbers from Excel');
    console.log('==============================================\n');

    const excelPath = this.getExcelFilePath();
    console.log(`📁 Excel file path: ${excelPath}`);

    if (!existsSync(excelPath)) {
      throw new Error(`Excel file not found at: ${excelPath}`);
    }

    console.log('✓ Excel file found');

    const workbook = XLSX.readFile(excelPath);
    console.log(`✓ Workbook loaded, sheets: ${workbook.SheetNames.join(', ')}`);

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (data.length === 0) {
      throw new Error('Excel file is empty');
    }

    console.log(`✓ Loaded ${data.length} rows from Excel`);

    const headerRow = data[0];
    console.log(`📋 Header row: ${JSON.stringify(headerRow)}`);

    const plotColumnIndex = this.config.plotColumnIndex;
    console.log(`✓ Using column index ${plotColumnIndex} for Plot Numbers (column ${plotColumnIndex + 1})\n`);

    this.plots = [];
    this.uploadedPlotCount = 0;
    const seenPlotKeys = new Set<string>();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row && row[plotColumnIndex]) {
        const plotNumber = row[plotColumnIndex].toString().trim();
        if (plotNumber) {
          this.uploadedPlotCount += 1;
          const plotKey = this.normalizePlotKey(plotNumber);

          if (seenPlotKeys.has(plotKey)) {
            console.log(`⚠️  Duplicate plot number found in Excel: ${plotNumber} (Row ${i + 1})`);
            console.log('   Skipping duplicate row for safety so the agent does not pay twice\n');

            this.results.push({
              plotNumber,
              rowIndex: i + 1,
              applicationId: null,
              paymentCompleted: false,
              downloadCompleted: false,
              error: 'Duplicate plot number in Excel - skipped for safety',
            });
            continue;
          }

          seenPlotKeys.add(plotKey);
          this.plots.push({
            plotNumber,
            rowIndex: i + 1,
          });
        }
      }
    }

    if (this.plots.length === 0) {
      throw new Error(`No plot numbers found in column ${plotColumnIndex + 1} of Excel file`);
    }

    console.log(`✅ Loaded ${this.plots.length} unique plot numbers for processing:\n`);
    this.plots.forEach((plot, index) => {
      console.log(`   ${index + 1}. Plot ${plot.plotNumber} (Row ${plot.rowIndex})`);
    });
    console.log('');
  }

  getExcelFilePath(): string {
    if (isAbsolute(this.config.excelFilePath)) {
      return this.config.excelFilePath;
    }
    return join(process.cwd(), this.config.excelFilePath);
  }

  /**
   * Step 11: Search and filter by plot number
   */
  async searchAndFilterPlot(plot: PlotData): Promise<void> {
    console.log('\n==============================================');
    console.log(`Step 11: Search for Plot ${plot.plotNumber}`);
    console.log('==============================================\n');

    const page = this.getPage();

    await this.waitForServiceWorkspaceLayout(20000);
    await this.fillPlotNumberIntoFilterBox(plot.plotNumber);
    await this.clickShowResultsInFilterBox();

    console.log('⏳ Waiting for filtered result area to update...');
    await sleep(this.config.waitTimes.pageLoad);

    let resultState = await this.inspectFilteredResult(plot.plotNumber);
    let attempts = 0;
    while (!resultState.found && !resultState.noResults && attempts < 10) {
      await sleep(1000);
      resultState = await this.inspectFilteredResult(plot.plotNumber);
      attempts++;
    }

    console.log(`📊 Result inspection: found=${resultState.found}, noResults=${resultState.noResults}`);
    if (resultState.matchedText) {
      console.log(`   Matched text: ${resultState.matchedText}`);
    }
    console.log('');

    const noPropertyMessage = resultState.noResults;
    const noResults = !resultState.found;

    if (noPropertyMessage || noResults) {
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('⚠️  PLOT NOT FOUND IN DARI SYSTEM');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`   Plot Number: ${plot.plotNumber}`);
      console.log(`   Message: "You don't own any property and will not be able to proceed"`);
      console.log(`   Action: Skipping this plot and continuing with next plot`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      // Track as skipped/not found
      this.results.push({
        plotNumber: plot.plotNumber,
        rowIndex: plot.rowIndex,
        applicationId: null,
        paymentCompleted: false,
        downloadCompleted: false,
        error: 'Plot not found - You don\'t own any property',
      });

      return;
    }

    console.log('✅ Results found for this plot - proceeding...\n');

    const selectedResult = await this.clickFilteredResult(plot.plotNumber);
    console.log(`✅ Property result selected: ${selectedResult}\n`);

    const selectionState = await this.inspectFilteredResult(plot.plotNumber);
    if (!selectionState.found) {
      throw new Error(`Filtered result for plot ${plot.plotNumber} disappeared after selection`);
    }

    await this.clickProceedFromResultsArea();
    console.log('✅ Proceed button clicked\n');

    await this.waitForPaymentPageAfterProceed(plot);

    const pageUrl = page.url();
    console.log(`📍 Current URL after payment page load: ${pageUrl}\n`);

    // Extract Application ID
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 STEP 12: Extract Application ID');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const paymentPageState = await this.getPaymentPageSnapshot(plot.plotNumber);
    let applicationId = paymentPageState.applicationId
      || this.extractApplicationIdFromText(paymentPageState.propertyPanelText)
      || this.extractApplicationIdFromText(paymentPageState.bodyPreview)
      || this.extractApplicationIdFromText(await page.textContent('body'));

    if (!applicationId) {
      console.log('❌ Could not extract Application ID');
      console.log('   Skipping this plot...\n');

      this.results.push({
        plotNumber: plot.plotNumber,
        rowIndex: plot.rowIndex,
        applicationId: null,
        paymentCompleted: false,
        downloadCompleted: false,
        error: 'Application ID not found on payment page',
      });

      return;
    }

    console.log(`✅ Application ID extracted: ${applicationId}`);
    console.log(`   Plot block verified: ${paymentPageState.plotMatched ? 'yes' : 'no'}\n`);

    // Select DARI Wallet payment option (Radio B)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💳 STEP 13: Select DARI Wallet Payment Option');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('🔍 Selecting the DARI wallet option inside the Pay with panel...');
    await this.selectDariWalletPaymentMethod(plot.plotNumber);

    // Extract wallet balance and payment amount
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 STEP 14: Check Wallet Balance vs Payment Amount');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await this.requireExclusiveDariWalletSelection(plot.plotNumber);
    const verifiedPaymentState = await this.getPaymentPageSnapshot(plot.plotNumber);
    const walletBalanceText = verifiedPaymentState.balanceText;
    const paymentAmountText = verifiedPaymentState.paymentDetailsText;
    const balance = this.parseWalletBalanceAmount(walletBalanceText);
    const amount = this.parseTotalPaymentAmount(paymentAmountText);

    console.log('📊 Payment Information:');
    console.log(`   DARI Wallet Balance: ${walletBalanceText || 'not found'}`);
    console.log(`   Payment Details: ${paymentAmountText || 'not found'}`);
    console.log('');

    console.log(`💵 Numeric Comparison:`);
    console.log(`   Balance: ${balance}`);
    console.log(`   Amount: ${amount}\n`);

    if (balance === null || amount === null) {
      console.log('❌ Could not parse balance or payment amount');
      console.log('   Skipping this plot...\n');

      this.results.push({
        plotNumber: plot.plotNumber,
        rowIndex: plot.rowIndex,
        applicationId,
        paymentCompleted: false,
        downloadCompleted: false,
        error: 'Could not parse wallet balance or total payment amount from the payment page',
      });

      return;
    }

    const isFirstPlot = !this.batchBalanceValidated;

    if (isFirstPlot) {
      const totalPlots = this.plots.length;
      const totalRequired = amount * totalPlots;

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('💰 BATCH PAYMENT VALIDATION (First Plot Check)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`   Total Plots to Process:    ${totalPlots}`);
      console.log(`   Payment per Plot:          ${amount.toFixed(2)} AED`);
      console.log(`   Total Required:            ${totalRequired.toFixed(2)} AED`);
      console.log(`   Current Wallet Balance:    ${balance.toFixed(2)} AED`);
      console.log('');

      if (balance < totalRequired) {
        const shortage = totalRequired - balance;

        console.log('🛑 INSUFFICIENT BALANCE FOR COMPLETE BATCH!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚠️  Your wallet balance cannot cover ALL plots.');
        console.log('⚠️  Agent will STOP to prevent partial payments.');
        console.log('');
        console.log('📊 CALCULATION:');
        console.log(`   ${totalPlots} plots × ${amount.toFixed(2)} AED = ${totalRequired.toFixed(2)} AED needed`);
        console.log(`   You have: ${balance.toFixed(2)} AED`);
        console.log(`   Shortage: ${shortage.toFixed(2)} AED`);
        console.log('');
        console.log('💡 NEXT STEPS:');
        console.log(`   1. Add ${shortage.toFixed(2)} AED to your DARI wallet`);
        console.log(`   2. Restart the agent to process all ${totalPlots} plots`);
        console.log('');
        console.log('✅ BENEFIT: No partial payments - either all plots succeed or none!');
        console.log('');
        console.log('🛑 STOPPING WORKFLOW NOW (No payments made)\n');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        this.results.push({
          plotNumber: plot.plotNumber,
          rowIndex: plot.rowIndex,
          applicationId,
          paymentCompleted: false,
          downloadCompleted: false,
          error: `Insufficient balance for batch: need ${totalRequired.toFixed(2)} AED for ${totalPlots} plots, have ${balance.toFixed(2)} AED`,
        });

        throw new Error(`Insufficient balance: need ${totalRequired.toFixed(2)} AED for ${totalPlots} plots, have ${balance.toFixed(2)} AED. Add ${shortage.toFixed(2)} AED and restart.`);
      }

      console.log('✅ SUFFICIENT BALANCE FOR ALL PLOTS!');
      console.log(`   ${balance.toFixed(2)} AED ≥ ${totalRequired.toFixed(2)} AED required`);
      console.log('   Proceeding with confidence - can complete entire batch!\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      this.batchBalanceValidated = true;
    } else {
      // For subsequent plots, just check this plot's amount
      if (balance < amount) {
        console.log('⚠️  WARNING: Insufficient balance for this plot');
        console.log(`   This shouldn't happen - initial check showed sufficient balance`);
        console.log(`   Plot: ${plot.plotNumber}`);
        console.log(`   Available: ${balance.toFixed(2)} AED`);
        console.log(`   Required: ${amount.toFixed(2)} AED`);
        console.log('   Skipping this plot...\n');

        this.results.push({
          plotNumber: plot.plotNumber,
          rowIndex: plot.rowIndex,
          applicationId,
          paymentCompleted: false,
          downloadCompleted: false,
          error: `Insufficient balance (shortage: ${(amount - balance).toFixed(2)})`,
        });

        return;
      }
    }

    console.log('✅ SUFFICIENT BALANCE!');
    console.log(`   Wallet has enough balance to proceed with payment\n`);

    // Click Pay Now button
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💳 STEP 15: Click Pay Now Button');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('🖱️  Clicking Pay now only after wallet selection and balance checks passed...');
    await this.clickPayNowAndWaitForProcessing(plot.plotNumber);

    // Wait for payment processing and next page
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏳ STEP 16: Wait for Payment Processing & Download Page');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('⏳ Waiting for the final page that shows the download button...');
    await this.waitForCertificateDownloadPage(plot, applicationId);
    this.upsertPersistedApplication(plot.plotNumber, applicationId, false);

    // Observe the download/certificate page
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 STEP 17: Observe & Download Certificate');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const finalPageState = await this.getFinalCertificatePageState(plot.plotNumber, applicationId);
    console.log('📊 Final Page Verification:');
    console.log(`   Download button visible: ${finalPageState.hasDownloadButton}`);
    console.log(`   Certificate context visible: ${finalPageState.hasCertificateContext}`);
    console.log(`   Application ID visible: ${finalPageState.hasApplicationId}`);
    console.log(`   Plot match visible: ${finalPageState.plotMatched}\n`);

    console.log('📥 Clicking download button and verifying the file save...');
    const downloadResult = await this.clickCertificateDownloadAndVerify();

    if (downloadResult.success) {
      this.upsertPersistedApplication(plot.plotNumber, applicationId, true, downloadResult.filename);
      console.log(`✅ ${downloadResult.kind === 'receipt' ? 'PAYMENT RECEIPT' : 'CERTIFICATE'} DOWNLOAD VERIFIED!`);
      if (downloadResult.filename) {
        console.log(`   File: ${downloadResult.filename}`);
      }
      console.log('');
    } else {
      this.upsertPersistedApplication(plot.plotNumber, applicationId, false);
      console.log('❌ Download could not be verified after clicking the button\n');
    }

    // Save result for this plot
    this.results.push({
      plotNumber: plot.plotNumber,
      rowIndex: plot.rowIndex,
      applicationId,
      paymentCompleted: true,
      downloadCompleted: downloadResult.success,
    });

    // Show plot summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 PLOT PROCESSING SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Plot Number:     ${plot.plotNumber}`);
    console.log(`   Row Index:       ${plot.rowIndex}`);
    console.log(`   Application ID:  ${applicationId || 'N/A'}`);
    console.log(`   Payment:         ✅ Completed`);
    console.log(`   Download:        ${downloadResult.success ? '✅ Success' : '⚠️  Pending/Failed'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  /**
   * Navigate back to service page for next plot
   */
  async navigateBackToServicePage(): Promise<void> {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔄 Navigating Back to Service Page');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const page = this.getPage();
    const servicesUrl = this.getServicesListingUrl();

    console.log(`🌐 Returning to services listing directly: ${servicesUrl}`);
    await page.goto(servicesUrl, { waitUntil: 'domcontentloaded' });
    await this.waitForDocumentReady(20000);
    await this.acceptCookiesIfPresent();
    await this.waitForServicesLandingPage(20000);

    console.log('🖱️  Re-opening configured service from the Services page...');
    await this.selectAffectionPlanService();
    await this.verifyAffectionPlanPage();

    console.log('✅ Back on service page, ready for next plot\n');
  }

  /**
   * Show final comprehensive summary of all processed plots
   */
  async showFinalSummary(): Promise<void> {
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    FINAL PROCESSING SUMMARY                    ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');

    // Calculate statistics
    const totalPlotsUploaded = this.uploadedPlotCount || this.plots.length;
    const safetySkippedPlots = this.results.filter(r =>
      r.error?.includes('skipped for safety') ||
      r.error?.includes('Already paid in a previous run')
    ).length;
    const plotsAttempted = this.results.length;
    const plotsSkipped = totalPlotsUploaded - plotsAttempted; // Plots never attempted
    const paidPlots = this.results.filter(r => r.paymentCompleted).length;
    const downloadedPlots = this.results.filter(r => r.downloadCompleted).length;
    const notFoundPlots = this.results.filter(r => r.error?.includes('not found') || r.error?.includes('don\'t own any property')).length;
    const otherFailedPlots = this.results.filter(r =>
      r.error &&
      !r.error.includes('not found') &&
      !r.error.includes('don\'t own any property') &&
      !r.error.includes('skipped for safety') &&
      !r.error.includes('Already paid in a previous run')
    ).length;
    const pendingDownloads = paidPlots - downloadedPlots;

    console.log('📊 OVERALL STATISTICS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Total Plots Uploaded:      ${totalPlotsUploaded} (from Excel)`);
    console.log(`   Plots Attempted:           ${plotsAttempted}`);
    console.log(`   Plots Skipped:             ${plotsSkipped} ${plotsSkipped > 0 ? '⚠️' : ''}`);
    console.log(`   Payments Completed:        ${paidPlots} ✅`);
    console.log(`   Downloads Completed:       ${downloadedPlots} 📥`);
    console.log(`   Downloads Pending:         ${pendingDownloads} ⏳`);
    console.log(`   Safety Skips:              ${safetySkippedPlots} 🛡️`);
    console.log(`   Not Found in Dari:         ${notFoundPlots} 🔍`);
    console.log(`   Other Failures:            ${otherFailedPlots} ❌`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Warning for skipped plots
    if (plotsSkipped > 0) {
      console.log('🛑 PLOTS SKIPPED WARNING:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`   ${plotsSkipped} plot(s) from the Excel file were NOT processed.`);
      console.log('   The agent stopped before attempting these plots.');
      console.log('   Likely cause: Insufficient balance or critical error on first plot.');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    if (safetySkippedPlots > 0) {
      console.log('🛡️  SAFETY SKIPS:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   These rows were intentionally skipped to avoid duplicate payment.\n');

      this.results
        .filter(r => r.error?.includes('skipped for safety') || r.error?.includes('Already paid in a previous run'))
        .forEach((result) => {
          console.log(`   • Plot ${result.plotNumber} (Row ${result.rowIndex})`);
          console.log(`     Reason: ${result.error}`);
        });

      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    // Detailed results table
    console.log('📋 DETAILED RESULTS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    this.results.forEach((result, index) => {
      console.log(`${index + 1}. Plot: ${result.plotNumber} (Row ${result.rowIndex})`);
      console.log(`   Application ID:  ${result.applicationId || 'N/A'}`);
      console.log(`   Payment:         ${result.paymentCompleted ? '✅ Completed' : '❌ Not Completed'}`);
      console.log(`   Download:        ${result.downloadCompleted ? '✅ Downloaded' : '⚠️  Pending/Failed'}`);
      if (result.error) {
        console.log(`   Error:           ${result.error}`);
      }
      console.log('');
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show plots that were not found in Dari
    if (notFoundPlots > 0) {
      console.log('🔍 PLOTS NOT FOUND IN DARI SYSTEM:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   These plots do not exist in the Dari system or you do not own them.');
      console.log('   No payments were made for these plots.\n');

      const notFoundResults = this.results.filter(r => r.error?.includes('not found') || r.error?.includes('don\'t own any property'));
      notFoundResults.forEach((result) => {
        console.log(`   • Plot ${result.plotNumber} (Row ${result.rowIndex})`);
      });

      console.log('\n   💡 Verify these plot numbers are correct and exist in your Dari account.');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    // Show plots that were paid but not downloaded (critical info)
    if (pendingDownloads > 0) {
      console.log('⚠️  IMPORTANT - PLOTS PAID BUT NOT DOWNLOADED:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   These plots have been paid for but downloads did not complete.');
      console.log('   You can retry downloading these certificates later.\n');

      const pendingResults = this.results.filter(r => r.paymentCompleted && !r.downloadCompleted);
      pendingResults.forEach((result) => {
        console.log(`   • Plot ${result.plotNumber}: Application ID ${result.applicationId}`);
      });

      console.log('');
      console.log('   💡 Save these Application IDs - you\'ll need them to retry downloads.');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    // Show success message if all completed
    const totalFailedPlots = notFoundPlots + otherFailedPlots;

    if (downloadedPlots === totalPlotsUploaded) {
      console.log('🎉 SUCCESS! All plots processed and downloaded successfully!\n');
    } else if (paidPlots === plotsAttempted && downloadedPlots > 0) {
      console.log('✅ All payments completed! Some downloads may need retry.\n');
    } else if (totalFailedPlots === plotsAttempted) {
      console.log('❌ No plots were successfully processed. Please check errors above.\n');
    } else if (plotsSkipped > 0) {
      console.log(`⚠️  PARTIAL COMPLETION: ${plotsSkipped} plot(s) were skipped and not processed.\n`);
    }

    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                     PROCESSING COMPLETE                        ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    // Send email notification if enabled
    if (this.config.emailNotification.enabled && this.config.emailNotification.recipientEmail) {
      console.log('═══════════════════════════════════════════════════════════════\n');

      const emailSummary: EmailSummary = {
        agentName: 'Dari Affection Plan Agent',
        totalPlots: totalPlotsUploaded, // Use uploaded count, not attempted count
        successfulPlots: downloadedPlots,
        failedPlots: totalFailedPlots,
        results: this.results,
        startTime: this.startTime || undefined,
        endTime: new Date(),
      };

      const emailResult = await sendEmailNotification(
        this.config.emailNotification.recipientEmail,
        emailSummary,
        this.config.emailNotification.ccEmail || undefined
      );

      if (emailResult.success) {
        console.log('✅ Email summary sent successfully!');
        console.log(`   Sent to: ${this.config.emailNotification.recipientEmail}`);
        if (this.config.emailNotification.ccEmail) {
          console.log(`   CC: ${this.config.emailNotification.ccEmail}`);
        }
        console.log('');
      } else {
        console.error('❌ Failed to send email summary');
        console.error(`   Error: ${emailResult.error}\n`);
      }

      console.log('═══════════════════════════════════════════════════════════════\n');
    }
  }

  /**
   * Main workflow execution
   */
  async executeWorkflow(): Promise<void> {
    try {
      // Track start time for email summary
      this.startTime = new Date();
      this.batchBalanceValidated = false;

      await this.initialize();

      if (!this.stagehand?.page) {
        throw new Error('Stagehand not initialized');
      }

      console.log('\n🎯 Starting Dari Affection Plan Workflow\n');
      console.log('==============================================\n');

      // Execute workflow steps
      await this.navigateToHomepage();
      await this.clickLoginButton();
      await this.clickUAEPassButton();
      await this.enterMobileNumber();
      await this.clickLoginSubmit();
      await this.detectUAEPassCompletion();

      // Conditional account switching
      if (this.config.accountSwitching.enabled) {
        await this.switchAccount();
      } else {
        console.log('ℹ️  Account switching disabled in config - skipping\n');
      }

      await this.navigateToServicesMenu();
      await this.selectAffectionPlanService();
      await this.verifyAffectionPlanPage();

      // Load plot numbers from Excel
      await this.loadPlotNumbers();

      // Process all plots
      console.log('\n==============================================');
      console.log(`Processing ${this.plots.length} Plots`);
      console.log('==============================================\n');

      for (let i = 0; i < this.plots.length; i++) {
        const plot = this.plots[i];
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`📍 Processing plot ${i + 1} of ${this.plots.length}: ${plot.plotNumber}`);
        console.log(`${'━'.repeat(60)}\n`);

        const persistedApplication = this.getPersistedApplication(plot.plotNumber);
        if (persistedApplication) {
          console.log('🛡️  DUPLICATE PAYMENT SAFETY CHECK');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`   Plot Number:     ${plot.plotNumber}`);
          console.log(`   Application ID:  ${persistedApplication.applicationId}`);
          console.log(`   Paid On:         ${new Date(persistedApplication.paymentDate).toLocaleString()}`);
          console.log(`   Downloaded:      ${persistedApplication.downloaded ? 'Yes' : 'No'}`);

          if (persistedApplication.downloaded) {
            console.log('   Action:          Skip completely - already paid and downloaded before');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            this.results.push({
              plotNumber: plot.plotNumber,
              rowIndex: plot.rowIndex,
              applicationId: persistedApplication.applicationId,
              paymentCompleted: true,
              downloadCompleted: true,
            });
          } else {
            console.log('   Action:          Skip payment - already paid before, download still pending');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

            this.results.push({
              plotNumber: plot.plotNumber,
              rowIndex: plot.rowIndex,
              applicationId: persistedApplication.applicationId,
              paymentCompleted: true,
              downloadCompleted: false,
              error: 'Already paid in a previous run - skipped to avoid duplicate payment',
            });
          }

          continue;
        }

        try {
          await this.searchAndFilterPlot(plot);
        } catch (plotError) {
          const errorMessage = plotError instanceof Error ? plotError.message : String(plotError);

          // Stop the entire workflow for any payment-critical failure.
          if (errorMessage.includes('Insufficient balance for batch') ||
              errorMessage.includes('need') && errorMessage.includes('for') && errorMessage.includes('plots') ||
              errorMessage.includes('DARI wallet') ||
              errorMessage.includes('Debit/credit card') ||
              errorMessage.includes('Abu Dhabi Pay') ||
              errorMessage.includes('Pay now')) {
            console.error(`\n❌ CRITICAL: Payment validation failed!`);
            console.error(`   ${errorMessage}\n`);

            // Re-throw to stop the entire workflow
            throw plotError;
          }

          // For other errors (plot not found, extraction failed, etc.), continue to next plot
          console.error(`❌ Error processing plot ${plot.plotNumber}:`, plotError);
          console.log('   Continuing to next plot...\n');

          // Track error if not already tracked
          const alreadyTracked = this.results.some(r => r.plotNumber === plot.plotNumber);
          if (!alreadyTracked) {
            this.results.push({
              plotNumber: plot.plotNumber,
              rowIndex: plot.rowIndex,
              applicationId: null,
              paymentCompleted: false,
              downloadCompleted: false,
              error: errorMessage,
            });
          }
        }

        // Navigate back to service page for next plot
        if (i < this.plots.length - 1) {
          console.log('⏳ Preparing for next plot...\n');
          await sleep(2000);

          try {
            await this.navigateBackToServicePage();
          } catch (navError) {
            console.error(`❌ CRITICAL: Could not return to the service page for the next plot: ${navError instanceof Error ? navError.message : String(navError)}`);
            console.log('   Stopping the workflow to avoid operating from the wrong page.\n');
            throw navError;
          }
        }
      }

      // Show comprehensive final summary
      await this.showFinalSummary();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a batch validation error (insufficient balance)
      if (errorMessage.includes('Insufficient balance for batch') ||
          errorMessage.includes('need') && errorMessage.includes('for') && errorMessage.includes('plots')) {

        console.log('\n');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║              WORKFLOW STOPPED - INSUFFICIENT BALANCE           ║');
        console.log('╚════════════════════════════════════════════════════════════════╝');
        console.log('');
        console.log('🛑 The agent detected insufficient wallet balance for all plots');
        console.log('   and stopped BEFORE making any payments.\n');
        console.log('💰 This is a safety feature to prevent partial payments.\n');

        // Show the summary of what was attempted
        if (this.results.length > 0) {
          await this.showFinalSummary();
        }

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('                     NEXT STEPS');
        console.log('═══════════════════════════════════════════════════════════════');

        // Extract amount from error message
        const amountMatch = errorMessage.match(/Add ([\d.]+) AED/);
        const amountToAdd = amountMatch ? amountMatch[1] : 'required amount';

        console.log('\n📝 TO CONTINUE:');
        console.log(`   1. Log into Dari portal: ${this.config.baseUrl}`);
        console.log(`   2. Add ${amountToAdd} AED to your DARI wallet`);
        console.log(`   3. Re-run this agent to process all plots\n`);
        console.log('💡 TIP: The agent will validate balance again before any payment.\n');
        console.log('═══════════════════════════════════════════════════════════════\n');

        // Exit cleanly without stack trace
        return;

      } else {
        // For other errors, show generic error message
        console.error('\n==============================================');
        console.error('❌ Workflow Failed');
        console.error('==============================================\n');
        console.error('Error:', error);
        console.error('\n💡 Troubleshooting:');
        console.error('   - Check if mobile number is correct');
        console.error('   - Ensure UAE Pass 2FA was approved on mobile');
        console.error('   - Verify CAPTCHA was solved correctly');
        console.error('   - Check if service name matches the Dari website\n');

        // For unexpected errors, throw to show stack trace for debugging
        throw error;
      }
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.stagehand) {
      console.log('🔒 Closing browser...');
      try {
        await this.stagehand.close();
        console.log('✓ Browser closed\n');
      } catch (err) {
        console.error('⚠️  Error closing browser:', err);
      }
    }
  }
}

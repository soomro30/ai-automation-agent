import { Stagehand } from '@browserbasehq/stagehand';
import { config } from '../config.js';
import { retry, sleep } from '../utils/retry.js';
import { ExcelReader, PlotData } from '../utils/excel-reader.js';
import { loadElectronConfig } from '../electron-bridge.js';
import { getStagehandLocalBrowserConfig } from '../utils/local-browser.js';

interface ApplicationRecord {
  plotNumber: string;
  applicationId: string;
  rowIndex: number;
  downloaded: boolean;
  retries: number;
}

export class DariTitleDeedAgent {
  private stagehand: Stagehand | null = null;
  private applications: ApplicationRecord[] = [];
  private plots: PlotData[] = [];
  private readonly MAX_DOWNLOAD_RETRIES = 5;
  private readonly DOWNLOAD_CHECK_INTERVAL_MS = 300000;
  private excelFilePath: string;
  private plotColumnIndex: number;

  constructor() {
    const electronConfig = loadElectronConfig();
    if (electronConfig) {
      this.excelFilePath = electronConfig.excelFilePath;
      this.plotColumnIndex = electronConfig.plotColumnIndex;
    } else {
      this.excelFilePath = 'data/units.xlsx';
      this.plotColumnIndex = 2;
    }
  }

  async initialize(): Promise<void> {
    console.log('Initializing Dari Title Deed Agent...\n');
    const localBrowserConfig = getStagehandLocalBrowserConfig();

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
      domSettleTimeoutMs: 3000,
      localBrowserLaunchOptions: localBrowserConfig.launchOptions,
    });

    await this.stagehand.init();

    console.log('✓ Dari Title Deed Agent initialized\n');
    console.log('==============================================');
    console.log('📋 DARI TITLE DEED AUTOMATION AGENT');
    console.log('==============================================');
    console.log('Automated title deed generation and download');
    console.log('==============================================\n');
  }

  async loadPlotNumbers(): Promise<void> {
    console.log('Loading plot numbers from Excel file...');
    this.plots = ExcelReader.readPlotNumbers(this.excelFilePath, this.plotColumnIndex);

    if (this.plots.length === 0) {
      throw new Error('No plot numbers found in Excel file');
    }

    console.log(`✓ Loaded ${this.plots.length} plot numbers:\n`);
    this.plots.forEach((plot, index) => {
      console.log(`  ${index + 1}. Plot ${plot.plotNumber} (Row ${plot.rowIndex})`);
    });
    console.log('');
  }

  async navigateToDari(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 1: Navigating to https://www.dari.ae/en/...');
    await retry(
      async () => {
        await this.stagehand!.page.goto('https://www.dari.ae/en/', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Navigation failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Successfully navigated to Dari website\n');
  }

  async clickLoginButton(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 2: Clicking Login button on top right...');
    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: 'click on the Login button in the top right corner',
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Click login failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Clicked Login button\n');
    await sleep(2000);
  }

  async clickUAEPassLogin(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 3: Clicking Login with UAE Pass...');
    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: 'click on Login with UAE Pass button',
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Click UAE Pass login failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Clicked Login with UAE Pass\n');
    await sleep(3000);
  }

  async enterMobileAndLogin(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 4: Waiting for UAE Pass page and entering mobile number...');
    await sleep(2000);

    const mobileNumber = config.tamm.mobileNumber || '971559419961';
    console.log(`Entering mobile number: ${mobileNumber}`);

    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: `enter mobile number ${mobileNumber} in the mobile number field`,
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Enter mobile number failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );

    await sleep(2000);

    console.log('\n⚠️  Please solve the captcha if it appears...');
    console.log('Waiting 20 seconds for manual captcha solution...\n');
    await sleep(20000);

    console.log('Clicking Login button...');
    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: 'click the Login button or authorize button to proceed',
        });
      },
      {
        maxAttempts: 5,
        delayMs: 3000,
        onRetry: (attempt, error) => {
          console.log(`Click login failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Login button clicked\n');
    await sleep(2000);
  }

  async waitForUAEPassApproval(): Promise<void> {
    console.log('==============================================');
    console.log('Step 5-6: UAE Pass 2FA Required');
    console.log('==============================================');
    console.log('A notification has been sent to your mobile.');
    console.log('Please approve the login request in your UAE Pass app.\n');
    console.log('Waiting for login to complete automatically...\n');

    const MAX_WAIT_ATTEMPTS = 60;
    const CHECK_INTERVAL_MS = 3000;
    let loginSuccessful = false;

    for (let attempt = 1; attempt <= MAX_WAIT_ATTEMPTS; attempt++) {
      console.log(`Checking login status... (attempt ${attempt}/${MAX_WAIT_ATTEMPTS})`);

      await sleep(CHECK_INTERVAL_MS);

      const currentUrl = this.stagehand!.page.url();
      console.log(`Current URL: ${currentUrl}`);

      if (!currentUrl.includes('login') && !currentUrl.includes('auth') && !currentUrl.includes('uaepass')) {
        console.log('✓ URL changed - verifying login success...\n');

        await this.stagehand!.page.waitForLoadState('networkidle');
        await sleep(2000);

        const pageObservation = await this.stagehand!.page.observe({
          instruction: 'Find elements that indicate the user is logged in, such as user profile, dashboard, logout button, or services menu',
        });

        console.log(`Page observation: ${JSON.stringify(pageObservation.slice(0, 3), null, 2)}\n`);

        const hasLoginIndicators = pageObservation.some(
          (item: any) =>
            item.description?.toLowerCase().includes('logout') ||
            item.description?.toLowerCase().includes('profile') ||
            item.description?.toLowerCase().includes('dashboard') ||
            item.description?.toLowerCase().includes('services') ||
            item.description?.toLowerCase().includes('account')
        );

        if (hasLoginIndicators) {
          loginSuccessful = true;
          break;
        }
      }
    }

    if (!loginSuccessful) {
      throw new Error('Login verification timeout. Please check if UAE Pass approval was completed.');
    }

    console.log('✓ Successfully logged into Dari website\n');
    await sleep(2000);
  }

  async navigateToServicesMenu(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 8: Clicking Services menu in top menu bar...');
    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: 'click on the Services menu in the top navigation bar',
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Click Services menu failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Clicked Services menu\n');
    await sleep(2000);
  }

  async selectTitleDeedService(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('Step 9: Selecting Title Deed (Unit) Service...');
    await retry(
      async () => {
        await this.stagehand!.page.act({
          action: 'click on Title Deed Unit service or Title Deed service option',
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Select Title Deed service failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );
    console.log('✓ Selected Title Deed (Unit) Service\n');
    await sleep(3000);
    console.log('✓ Title Deed service page loaded with filters and units\n');
  }

  async searchPlotAndGenerateApplication(plot: PlotData): Promise<string | null> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing Plot: ${plot.plotNumber} (Row ${plot.rowIndex})`);
    console.log('='.repeat(60));

    try {
      console.log('Step 11: Entering Plot Number in ADM search field on left side...');
      console.log(`Searching for Plot ID: ${plot.plotNumber}`);
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: `enter ${plot.plotNumber} in the Plot Id - ADM search field or filter on the left side`,
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
          onRetry: (attempt, error) => {
            console.log(`Enter plot number failed (attempt ${attempt}): ${error.message}`);
          },
        }
      );

      await sleep(2000);

      console.log('Step 12: Clicking Show Results to filter units...');
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'click the Show Results button or search button to filter and display matching units',
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
          onRetry: (attempt, error) => {
            console.log(`Click Show Results failed (attempt ${attempt}): ${error.message}`);
          },
        }
      );

      await this.stagehand!.page.waitForLoadState('networkidle');
      await sleep(3000);

      console.log('Observing search results...');
      const resultsObservation = await this.stagehand!.page.observe({
        instruction: 'Find the filtered unit results on the right side. Look for units matching the search.',
      });

      console.log(`Search results observation: ${JSON.stringify(resultsObservation.slice(0, 3), null, 2)}\n`);
      console.log('✓ Search results displayed\n');

      console.log('Step 13: Clicking on the filtered unit...');
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'click on the unit that appears in the search results on the right side',
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
          onRetry: (attempt, error) => {
            console.log(`Click unit failed (attempt ${attempt}): ${error.message}`);
          },
        }
      );

      await sleep(2000);

      console.log('Clicking Proceed button at the bottom of the page...');
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'scroll down and click the Proceed button at the bottom of the page',
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
          onRetry: (attempt, error) => {
            console.log(`Click Proceed failed (attempt ${attempt}): ${error.message}`);
          },
        }
      );

      console.log('✓ Proceed button clicked\n');

      console.log('Step 14: Waiting for page to navigate and load...');
      await this.stagehand!.page.waitForLoadState('networkidle');
      await sleep(3000);
      console.log('✓ Page loaded\n');

      console.log('Observing page to confirm application generation screen...');
      const pageObservation = await this.observeApplicationPage();
      console.log(`Page observation: ${pageObservation}\n`);

      console.log('Waiting for Application ID to be generated and displayed...');
      const applicationId = await this.waitForAndExtractApplicationId();

      if (applicationId) {
        console.log(`✓ Application generated successfully!`);
        console.log(`📋 Application ID: ${applicationId}\n`);
        console.log('⏱️  Title deed will be ready in 10-15 minutes\n');
        return applicationId;
      } else {
        console.log('⚠️  Could not extract Application ID after multiple attempts.\n');
        console.log('Please check the page manually to see if application was generated.\n');
        return null;
      }
    } catch (error) {
      console.error(`❌ Error processing plot ${plot.plotNumber}:`, error);
      return null;
    }
  }

  async observeApplicationPage(): Promise<string> {
    if (!this.stagehand?.page) {
      return 'Cannot observe - page not initialized';
    }

    try {
      const observation = await this.stagehand.page.observe({
        instruction: 'Describe what you see on this page. Is there an Application ID shown? Is the application being processed? What is the current status?',
      });

      if (Array.isArray(observation) && observation.length > 0) {
        return observation.map(item => item.description || '').join('; ');
      }

      return 'No observation available';
    } catch (error) {
      return `Observation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async waitForAndExtractApplicationId(): Promise<string | null> {
    if (!this.stagehand?.page) {
      return null;
    }

    const MAX_ATTEMPTS = 10;
    const WAIT_BETWEEN_ATTEMPTS_MS = 3000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`Attempt ${attempt}/${MAX_ATTEMPTS} to extract Application ID...`);

      try {
        const pageText = await this.stagehand.page.textContent('body');

        if (pageText) {
          const patterns = [
            /Application\s+ID\s*:?\s*([A-Z0-9-]+)/i,
            /Reference\s+Number\s*:?\s*([A-Z0-9-]+)/i,
            /Request\s+ID\s*:?\s*([A-Z0-9-]+)/i,
            /ID\s*:?\s*([A-Z0-9]{6,})/i,
          ];

          for (const pattern of patterns) {
            const match = pageText.match(pattern);
            if (match && match[1]) {
              console.log(`✓ Found Application ID: ${match[1]}`);
              return match[1];
            }
          }
        }

        const extractResult = await this.stagehand.page.extract(
          'Find and extract the Application ID, Reference Number, or Request ID from the page. Return only the ID number/code itself.'
        );

        if (extractResult.extraction && typeof extractResult.extraction === 'string') {
          const extracted = extractResult.extraction.trim();
          if (extracted && extracted.length > 0) {
            const match = extracted.match(/([A-Z0-9-]{6,})/i);
            if (match) {
              console.log(`✓ Extracted Application ID via AI: ${match[1]}`);
              return match[1];
            }
          }
        }

        if (attempt < MAX_ATTEMPTS) {
          console.log(`No Application ID found yet. Waiting ${WAIT_BETWEEN_ATTEMPTS_MS / 1000} seconds...`);
          await sleep(WAIT_BETWEEN_ATTEMPTS_MS);
        }

      } catch (error) {
        console.log(`Extraction attempt ${attempt} failed:`, error instanceof Error ? error.message : String(error));

        if (attempt < MAX_ATTEMPTS) {
          await sleep(WAIT_BETWEEN_ATTEMPTS_MS);
        }
      }
    }

    console.log('❌ Could not extract Application ID after all attempts');
    return null;
  }

  async processAllPlots(): Promise<void> {
    console.log('\n==============================================');
    console.log('Step 15: Processing All Plots from Excel');
    console.log('==============================================\n');

    for (let i = 0; i < this.plots.length; i++) {
      const plot = this.plots[i];
      console.log(`\nProcessing plot ${i + 1} of ${this.plots.length}...`);

      const applicationId = await this.searchPlotAndGenerateApplication(plot);

      if (applicationId) {
        this.applications.push({
          plotNumber: plot.plotNumber,
          applicationId,
          rowIndex: plot.rowIndex,
          downloaded: false,
          retries: 0,
        });
      } else {
        console.log(`⚠️  Skipping plot ${plot.plotNumber} - could not generate application\n`);
      }

      if (i < this.plots.length - 1) {
        console.log('Navigating back to search for next plot...');
        await this.navigateBackToTitleDeedService();
        await sleep(2000);
      }
    }

    console.log('\n==============================================');
    console.log('✓ All Plots Processed');
    console.log('==============================================');
    console.log(`Total Applications Generated: ${this.applications.length}/${this.plots.length}\n`);

    this.applications.forEach((app, index) => {
      console.log(`  ${index + 1}. Plot ${app.plotNumber} → Application ${app.applicationId}`);
    });
    console.log('');
  }

  async navigateBackToTitleDeedService(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    try {
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'click the back button or navigate back to the properties or title deed service page',
          });
        },
        {
          maxAttempts: 2,
          delayMs: 2000,
        }
      );
      await sleep(2000);
    } catch (error) {
      console.log('Attempting alternative navigation...');
      await this.navigateToServicesMenu();
      await this.selectTitleDeedService();
    }
  }

  async navigateToApplicationsMenu(): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log('\n==============================================');
    console.log('Step 16-17: Navigating to Applications Page');
    console.log('==============================================\n');

    const currentUrl = this.stagehand.page.url();

    if (currentUrl.includes('/app/applications')) {
      console.log('✓ Already on Applications page\n');
      await sleep(2000);
      return;
    }

    console.log('Navigating to Applications page via URL...');
    await retry(
      async () => {
        await this.stagehand!.page.goto('https://www.dari.ae/en/app/applications?type=applications', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, error) => {
          console.log(`Navigate to Applications page failed (attempt ${attempt}): ${error.message}`);
        },
      }
    );

    console.log('✓ Navigated to Applications page\n');
    await sleep(3000);

    console.log('Observing Applications page...');
    const pageObservation = await this.stagehand.page.observe({
      instruction: 'Find the Application ID search field or filter on the left side, and the applications list on the right.',
    });

    console.log(`Applications page observation: ${JSON.stringify(pageObservation.slice(0, 5), null, 2)}\n`);
  }

  async downloadTitleDeeds(): Promise<void> {
    console.log('\n==============================================');
    console.log('Step 18-21: Downloading Title Deeds');
    console.log('==============================================\n');

    const pendingApplications = this.applications.filter(app => !app.downloaded);

    if (pendingApplications.length === 0) {
      console.log('✓ All title deeds already downloaded!\n');
      return;
    }

    console.log(`Total Applications to Download: ${pendingApplications.length}\n`);

    for (const app of pendingApplications) {
      await this.downloadSingleTitleDeed(app);
    }

    console.log('\n==============================================');
    console.log('Download Summary');
    console.log('==============================================');
    const downloaded = this.applications.filter(app => app.downloaded).length;
    const pending = this.applications.filter(app => !app.downloaded).length;

    console.log(`✓ Downloaded: ${downloaded}/${this.applications.length}`);
    console.log(`⏱️  Pending: ${pending}/${this.applications.length}\n`);

    if (pending > 0) {
      console.log('Some title deeds are still being processed.');
      console.log('The agent will retry pending downloads...\n');
      await this.retryPendingDownloads();
    }
  }

  async downloadSingleTitleDeed(app: ApplicationRecord): Promise<void> {
    if (!this.stagehand?.page) {
      throw new Error('Stagehand not initialized');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Application ID: ${app.applicationId} (Plot ${app.plotNumber})`);
    console.log('─'.repeat(60));

    try {
      console.log('Step 18: Observing Applications page to locate search field...');
      const searchObservation = await this.stagehand.page.observe({
        instruction: 'Find the Application ID input field or search box on the left side where I can type to filter applications',
      });

      console.log(`Search field observation: ${JSON.stringify(searchObservation.slice(0, 3), null, 2)}\n`);

      console.log(`Entering Application ID: ${app.applicationId}`);
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: `type ${app.applicationId} into the Application ID input field or search box on the left side`,
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
        }
      );

      await sleep(2000);

      console.log('Clicking Show Results or Search button...');
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'click the Show Results button or Search button to filter the applications',
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
        }
      );

      await this.stagehand.page.waitForLoadState('networkidle');
      await sleep(3000);

      console.log('Observing filtered application results...');
      const resultsObservation = await this.stagehand.page.observe({
        instruction: 'Find the filtered application that matches the search on the right side. Look for the application row with View Application or View button.',
      });

      console.log(`Filtered results: ${JSON.stringify(resultsObservation.slice(0, 5), null, 2)}\n`);

      if (resultsObservation.length === 0) {
        console.log('⚠️  No applications found in filtered results. Skipping...\n');
        app.retries++;
        return;
      }

      console.log('Step 19: Clicking View Application button...');
      await retry(
        async () => {
          await this.stagehand!.page.act({
            action: 'click the View Application button or link for the filtered application on the right side',
          });
        },
        {
          maxAttempts: 3,
          delayMs: 2000,
        }
      );

      await this.stagehand.page.waitForLoadState('networkidle');
      await sleep(3000);

      console.log('Step 20: Checking if title deed certificate is ready...');
      const isReady = await this.checkTitleDeedStatus();

      if (isReady) {
        console.log('Step 21: Title deed is ready! Downloading from top right...');

        await retry(
          async () => {
            await this.stagehand!.page.act({
              action: 'click the Download button in the top right corner to download the title deed certificate',
            });
          },
          {
            maxAttempts: 3,
            delayMs: 2000,
          }
        );

        await sleep(5000);
        app.downloaded = true;
        console.log(`✓ Successfully downloaded title deed for Application ${app.applicationId}\n`);
      } else {
        console.log(`⏱️  Title deed is still being processed. Retry ${app.retries + 1}/${this.MAX_DOWNLOAD_RETRIES}`);
        console.log('Will check again in 5 minutes...\n');
        app.retries++;
      }

      console.log('Navigating back to Applications list...');
      await this.navigateToApplicationsMenu();
      await sleep(2000);
    } catch (error) {
      console.error(`❌ Error downloading title deed for ${app.applicationId}:`, error);
      app.retries++;
    }
  }

  async checkTitleDeedStatus(): Promise<boolean> {
    if (!this.stagehand?.page) {
      return false;
    }

    try {
      console.log('Observing application details page...');

      const observation = await this.stagehand.page.observe({
        instruction: 'Find the title deed status, download button in the top right corner, or any status indicators showing if the certificate is ready or still being processed.',
      });

      console.log(`Page observation (${observation.length} elements found):`);
      console.log(`${JSON.stringify(observation.slice(0, 5), null, 2)}\n`);

      if (observation.length === 0) {
        console.log('⚠️  Page appears empty - may not have navigated correctly\n');
        return false;
      }

      const hasDownloadButton = observation.some(
        (item: any) =>
          (item.description?.toLowerCase().includes('download') &&
           (item.description?.toLowerCase().includes('button') ||
            item.description?.toLowerCase().includes('title') ||
            item.description?.toLowerCase().includes('certificate'))) ||
          (item.description?.toLowerCase().includes('download') &&
           item.description?.toLowerCase().includes('top right'))
      );

      if (hasDownloadButton) {
        console.log('✓ Download button detected in top right - title deed is ready!\n');
        return true;
      }

      const pageText = await this.stagehand.page.textContent('body');
      const isInProgress = pageText?.toLowerCase().includes('in progress') ||
        pageText?.toLowerCase().includes('processing') ||
        pageText?.toLowerCase().includes('pending') ||
        pageText?.toLowerCase().includes('being processed') ||
        pageText?.toLowerCase().includes('under review');

      if (isInProgress) {
        console.log('⏱️  Title deed is still being processed (found "in progress" indicator)...\n');
        return false;
      }

      const statusInfo = observation.find(
        (item: any) =>
          item.description?.toLowerCase().includes('status') ||
          item.description?.toLowerCase().includes('progress') ||
          item.description?.toLowerCase().includes('application')
      );

      if (statusInfo) {
        console.log(`Application status: ${statusInfo.description}\n`);
      }

      console.log('⚠️  Could not definitively determine if title deed is ready.\n');
      console.log('No "in progress" indicator found, but no download button either.\n');
      return false;
    } catch (error) {
      console.log(`Error checking status: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async retryPendingDownloads(): Promise<void> {
    const pending = this.applications.filter(app => !app.downloaded && app.retries < this.MAX_DOWNLOAD_RETRIES);

    if (pending.length === 0) {
      console.log('✓ All downloads completed or max retries reached.\n');
      return;
    }

    console.log(`\nRetrying ${pending.length} pending downloads...`);
    console.log(`Waiting ${this.DOWNLOAD_CHECK_INTERVAL_MS / 60000} minutes before retry...\n`);

    await sleep(this.DOWNLOAD_CHECK_INTERVAL_MS);

    await this.navigateToApplicationsMenu();
    await sleep(2000);

    for (const app of pending) {
      await this.downloadSingleTitleDeed(app);
    }

    const stillPending = this.applications.filter(app => !app.downloaded && app.retries < this.MAX_DOWNLOAD_RETRIES);
    if (stillPending.length > 0) {
      await this.retryPendingDownloads();
    }
  }

  async executeWorkflow(): Promise<void> {
    try {
      await this.initialize();
      await this.loadPlotNumbers();

      await this.navigateToDari();
      await this.clickLoginButton();
      await this.clickUAEPassLogin();
      await this.enterMobileAndLogin();
      await this.waitForUAEPassApproval();

      await this.navigateToServicesMenu();
      await this.selectTitleDeedService();

      await this.processAllPlots();

      await this.navigateToApplicationsMenu();
      await this.downloadTitleDeeds();

      console.log('\n==============================================');
      console.log('✓ DARI TITLE DEED WORKFLOW COMPLETED');
      console.log('==============================================\n');

      this.printFinalSummary();
    } catch (error) {
      console.error('\n❌ Error during Dari Title Deed workflow:', error);
      console.error('\nTroubleshooting tips:');
      console.error('- Ensure units.xlsx exists in the data/ folder');
      console.error('- Check that UAE Pass app is installed and configured');
      console.error('- Verify mobile number is correct');
      console.error('- Check network connectivity\n');
      throw error;
    } finally {
      await this.close();
    }
  }

  printFinalSummary(): void {
    console.log('Final Summary:');
    console.log(`Total Plots Processed: ${this.plots.length}`);
    console.log(`Applications Generated: ${this.applications.length}`);
    console.log(`Title Deeds Downloaded: ${this.applications.filter(app => app.downloaded).length}`);
    console.log(`Still Pending: ${this.applications.filter(app => !app.downloaded).length}\n`);

    console.log('Application Records:');
    this.applications.forEach((app, index) => {
      const status = app.downloaded ? '✓ Downloaded' : '⏱️  Pending';
      console.log(`  ${index + 1}. ${app.applicationId} - Plot ${app.plotNumber} - ${status}`);
    });
    console.log('');
  }

  async close(): Promise<void> {
    if (this.stagehand) {
      await this.stagehand.close();
      console.log('Dari Title Deed Agent closed');
    }
  }
}

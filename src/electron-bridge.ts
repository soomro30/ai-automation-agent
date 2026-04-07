import { DariSitePlanConfig } from './config/dari-site-plan-config.js';
import fs from 'fs';

export interface ElectronAgentConfig {
  excelFilePath: string;
  downloadPath: string;
  plotColumnIndex: number;
  mobileNumber?: string;
  serviceName?: string;
  serviceUrl?: string;
  accountSwitching?: {
    enabled: boolean;
    targetAccountName: string;
  };
  payment?: {
    enabled: boolean;
  };
  emailNotification?: {
    enabled: boolean;
    recipientEmail: string;
    ccEmail: string;
  };
  waitTimes: {
    captcha: number;
    uaePassTimeout: number;
    downloadPageTimeout?: number;
  };
}

export function getMobileNumber(): string {
  const electronConfig = loadElectronConfig();
  if (electronConfig?.mobileNumber) {
    return electronConfig.mobileNumber;
  }
  return process.env.TAMM_MOBILE_NUMBER || '+971559419961';
}

export function loadElectronConfig(): ElectronAgentConfig | null {
  const configPath = process.env.AGENT_CONFIG_PATH;
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading Electron config:', error);
    return null;
  }
}

export function getDownloadPath(): string {
  return process.env.DOWNLOAD_PATH || 'downloads';
}

export function mergeElectronConfigWithDefaults(
  defaultConfig: DariSitePlanConfig,
  electronConfig: ElectronAgentConfig
): DariSitePlanConfig {
  return {
    ...defaultConfig,
    excelFilePath: electronConfig.excelFilePath,
    plotColumnIndex: electronConfig.plotColumnIndex,
    navigation: {
      ...defaultConfig.navigation,
      sitePlanServiceText: electronConfig.serviceName ?? defaultConfig.navigation.sitePlanServiceText,
      sitePlanServiceUrl: electronConfig.serviceUrl ?? defaultConfig.navigation.sitePlanServiceUrl,
    },
    accountSwitching: {
      enabled: electronConfig.accountSwitching?.enabled ?? defaultConfig.accountSwitching.enabled,
      targetAccountName: electronConfig.accountSwitching?.targetAccountName ?? defaultConfig.accountSwitching.targetAccountName,
    },
    payment: {
      ...defaultConfig.payment,
      enabled: electronConfig.payment?.enabled ?? defaultConfig.payment.enabled,
    },
    waitTimes: {
      ...defaultConfig.waitTimes,
      captcha: electronConfig.waitTimes.captcha,
      uaePassTimeout: electronConfig.waitTimes.uaePassTimeout,
    },
  };
}

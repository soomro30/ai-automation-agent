/**
 * Configuration for Dari Affection Plan Agent
 * All settings can be customized via Electron UI or by editing this file
 */

export interface DariAffectionPlanConfig {
  baseUrl: string;
  mobileNumber: string;
  excelFilePath: string;
  plotColumnIndex: number;

  navigation: {
    servicesMenuText: string;
    affectionPlanServiceText: string;
  };

  accountSwitching: {
    enabled: boolean;
    targetAccountName: string;
  };

  emailNotification: {
    enabled: boolean;
    recipientEmail: string;
    ccEmail: string;
  };

  waitTimes: {
    pageLoad: number;
    afterClick: number;
    captcha: number;
    uaePassTimeout: number;
    domSettle: number;
    downloadPageTimeout: number;
  };

  detection: {
    loginSuccessIndicators: string[];
    uaePassUrlPattern: RegExp;
  };
}

export const defaultDariAffectionPlanConfig: DariAffectionPlanConfig = {
  baseUrl: 'https://www.dari.ae/en/',
  mobileNumber: '0504945959',
  excelFilePath: 'data/siteplan.xlsx',
  plotColumnIndex: 2, // 3rd column (0-based index)

  navigation: {
    servicesMenuText: 'Services',
    affectionPlanServiceText: 'Verification Certificate (Unit)',
  },

  accountSwitching: {
    enabled: true, // Set to true to enable account switching
    targetAccountName: 'Al Jurf Hospitality Service', // Change to your account name
  },

  emailNotification: {
    enabled: false, // Set to true to enable email notifications
    recipientEmail: '', // Email address to receive summary reports
    ccEmail: '', // CC email address (optional)
  },

  waitTimes: {
    pageLoad: 3000,
    afterClick: 1500,
    captcha: 20000,           // 20 seconds for manual CAPTCHA solving
    uaePassTimeout: 180000,   // 3 minutes for UAE Pass 2FA
    domSettle: 3000,
    downloadPageTimeout: 900000, // 15 minutes for certificate generation (can take 5-10 minutes)
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

export function loadDariAffectionPlanConfig(): DariAffectionPlanConfig {
  return { ...defaultDariAffectionPlanConfig };
}

export function createDariAffectionPlanConfig(
  overrides: Partial<DariAffectionPlanConfig>
): DariAffectionPlanConfig {
  return {
    ...defaultDariAffectionPlanConfig,
    ...overrides,
    navigation: {
      ...defaultDariAffectionPlanConfig.navigation,
      ...(overrides.navigation || {}),
    },
    accountSwitching: {
      ...defaultDariAffectionPlanConfig.accountSwitching,
      ...(overrides.accountSwitching || {}),
    },
    emailNotification: {
      ...defaultDariAffectionPlanConfig.emailNotification,
      ...(overrides.emailNotification || {}),
    },
    waitTimes: {
      ...defaultDariAffectionPlanConfig.waitTimes,
      ...(overrides.waitTimes || {}),
    },
    detection: {
      ...defaultDariAffectionPlanConfig.detection,
      ...(overrides.detection || {}),
    },
  };
}

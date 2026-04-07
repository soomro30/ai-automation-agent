import { existsSync } from 'fs';
import { join } from 'path';

interface BrowserCandidate {
  name: string;
  path: string;
}

export interface StagehandLocalBrowserConfig {
  launchOptions?: {
    executablePath?: string;
    acceptDownloads?: boolean;
    downloadsPath?: string;
  };
  detectedBrowserName: string | null;
  detectedBrowserPath: string | null;
}

function buildBrowserCandidates(): BrowserCandidate[] {
  const candidates: BrowserCandidate[] = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

    candidates.push(
      { name: 'Microsoft Edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Microsoft Edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Google Chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chromium', path: join(programFiles, 'Chromium', 'Application', 'chrome.exe') },
      { name: 'Chromium', path: join(programFilesX86, 'Chromium', 'Application', 'chrome.exe') }
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
    );
  } else {
    candidates.push(
      { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
      { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
      { name: 'Chromium', path: '/usr/bin/chromium-browser' },
      { name: 'Chromium', path: '/usr/bin/chromium' },
      { name: 'Chromium', path: '/snap/bin/chromium' },
      { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
      { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge-stable' }
    );
  }

  return candidates;
}

export function getStagehandLocalBrowserConfig(downloadsPath?: string): StagehandLocalBrowserConfig {
  const match = buildBrowserCandidates().find((candidate) => existsSync(candidate.path));

  const launchOptions: StagehandLocalBrowserConfig['launchOptions'] = {};

  if (match) {
    launchOptions.executablePath = match.path;
  }

  if (downloadsPath) {
    launchOptions.acceptDownloads = true;
    launchOptions.downloadsPath = downloadsPath;
  }

  return {
    launchOptions: Object.keys(launchOptions).length > 0 ? launchOptions : undefined,
    detectedBrowserName: match?.name || null,
    detectedBrowserPath: match?.path || null,
  };
}

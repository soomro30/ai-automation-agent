let currentAgent = null;
let selectedFile = null;
let settings = {};
let consoleLogBuffer = [];

const views = {
  selection: document.getElementById('agentSelectionView'),
  config: document.getElementById('agentConfigView'),
  running: document.getElementById('agentRunningView'),
  finished: document.getElementById('agentFinishedView'),
};

async function init() {
  settings = await window.electronAPI.getSettings();
  setupEventListeners();
  showView('selection');
}

function setupEventListeners() {
  document.querySelectorAll('.select-agent-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const card = e.target.closest('.agent-card');
      const agentId = card.dataset.agentId;
      selectAgent(agentId);
    });
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    showView('selection');
    resetConfig();
  });

  document.getElementById('selectFileBtn').addEventListener('click', selectFile);
  document.getElementById('runAgentBtn').addEventListener('click', runAgent);
  document.getElementById('stopAgentBtn').addEventListener('click', stopAgent);
  document.getElementById('openDownloadsBtn').addEventListener('click', openDownloads);
  document.getElementById('openDownloadsFolderBtn').addEventListener('click', openDownloads);
  document.getElementById('copyFinishedLogsBtn').addEventListener('click', copyConsoleLogs);
  document.getElementById('runAnotherBtn').addEventListener('click', () => {
    showView('selection');
    resetConfig();
  });
  document.getElementById('clearConsoleBtn').addEventListener('click', clearConsole);
  document.getElementById('copyConsoleBtn').addEventListener('click', copyConsoleLogs);

  document.getElementById('advancedToggle').addEventListener('click', () => {
    const advancedSection = document.getElementById('advancedSettings');
    advancedSection.classList.toggle('hidden');
  });

  document.getElementById('enableAccountSwitch').addEventListener('change', (e) => {
    document.getElementById('accountName').disabled = !e.target.checked;
  });

  document.getElementById('enableEmailNotification').addEventListener('change', (e) => {
    document.getElementById('recipientEmail').disabled = !e.target.checked;
    document.getElementById('ccEmail').disabled = !e.target.checked;
  });

  window.electronAPI.onAgentOutput((data) => {
    appendConsoleOutput(data, 'info');
  });

  window.electronAPI.onAgentError((data) => {
    appendConsoleOutput(data, 'error');
  });

  window.electronAPI.onAgentFinished((data) => {
    if (data.success && data.code === 0) {
      setRunningStatus('success', 'Agent completed successfully. Logs are preserved below.');
      showView('finished');
      if (data.downloadPath) {
        const pathElement = document.getElementById('downloadPath');
        if (pathElement) {
          pathElement.textContent = data.downloadPath;
        }
      }
    } else {
      setRunningStatus('error', `Agent failed with exit code ${data.code}. Logs are preserved below for copying.`);
      alert(`Agent failed with exit code ${data.code}. Check console output for details.`);
      showView('running');
    }
  });
}

function showView(viewName) {
  Object.values(views).forEach(view => view.classList.add('hidden'));
  views[viewName].classList.remove('hidden');
}

function selectAgent(agentId) {
  currentAgent = agentId;
  document.getElementById('agentTitle').textContent = 'Configure Dari Affection Plan Agent';
  document.getElementById('accountSwitchingSection').classList.remove('hidden');
  document.getElementById('serviceConfigSection').classList.remove('hidden');
  document.getElementById('emailNotificationSection').classList.remove('hidden');
  document.getElementById('downloadTimeoutSection').classList.remove('hidden');

  loadAgentSettings(agentId);
  showView('config');
}

function loadAgentSettings(agentId) {
  const agentSettings = settings.affectionPlan || {};
  const configuredServiceName = agentSettings.serviceName && agentSettings.serviceName !== 'Site Plan'
    ? agentSettings.serviceName
    : 'Verification Certificate (Unit)';

  document.getElementById('mobileNumber').value = settings.general?.mobileNumber || '+971559419961';
  document.getElementById('plotColumn').value = agentSettings.plotColumnIndex || 2;
  document.getElementById('serviceName').value = configuredServiceName;
  document.getElementById('enableAccountSwitch').checked = agentSettings.accountSwitching?.enabled || false;
  document.getElementById('accountName').value = agentSettings.accountSwitching?.targetAccountName || '';
  document.getElementById('accountName').disabled = !agentSettings.accountSwitching?.enabled;
  document.getElementById('enableEmailNotification').checked = agentSettings.emailNotification?.enabled || false;
  document.getElementById('recipientEmail').value = agentSettings.emailNotification?.recipientEmail || '';
  document.getElementById('ccEmail').value = agentSettings.emailNotification?.ccEmail || '';
  document.getElementById('recipientEmail').disabled = !agentSettings.emailNotification?.enabled;
  document.getElementById('ccEmail').disabled = !agentSettings.emailNotification?.enabled;
  document.getElementById('downloadTimeout').value = (agentSettings.waitTimes?.downloadPageTimeout || 900000) / 1000;

  document.getElementById('captchaTimeout').value = (agentSettings.waitTimes?.captcha || 10000) / 1000;
  document.getElementById('uaePassTimeout').value = (agentSettings.waitTimes?.uaePassTimeout || 180000) / 1000;
}

async function selectFile() {
  const filePath = await window.electronAPI.selectExcelFile();
  if (filePath) {
    selectedFile = filePath;
    const fileName = filePath.split(/[/\\]/).pop();
    document.getElementById('fileName').textContent = fileName;

    // Count plots in the selected file
    const plotColumnIndex = parseInt(document.getElementById('plotColumn').value);
    const plotCountResult = await window.electronAPI.countPlotsInExcel(filePath, plotColumnIndex);

    if (plotCountResult.success) {
      const plotCount = plotCountResult.count;
      document.getElementById('fileName').textContent = `${fileName} (${plotCount} plot${plotCount !== 1 ? 's' : ''})`;
    } else {
      document.getElementById('fileName').textContent = `${fileName} (unable to count plots)`;
    }

    document.getElementById('fileInfo').classList.remove('hidden');
    document.getElementById('runAgentBtn').disabled = false;
  }
}

async function runAgent() {
  if (!selectedFile || !currentAgent) {
    alert('Please select an Excel file first');
    return;
  }

  const mobileNumber = document.getElementById('mobileNumber').value.trim();
  if (!mobileNumber) {
    alert('Please enter a mobile number for UAE Pass login');
    return;
  }

  // Count plots in Excel file
  const plotColumnIndex = parseInt(document.getElementById('plotColumn').value);
  const plotCountResult = await window.electronAPI.countPlotsInExcel(selectedFile, plotColumnIndex);

  if (!plotCountResult.success) {
    alert(`Error reading Excel file: ${plotCountResult.error}`);
    return;
  }

  const plotCount = plotCountResult.count;

  // Show confirmation dialog with plot count
  const confirmMessage = `⚠️ CONFIRMATION REQUIRED\n\n` +
    `You are about to process ${plotCount} plot(s) from the Excel file.\n\n` +
    `⚠️ WARNING:\n` +
    `• Each plot will deduct a fee from your DARI Wallet balance\n` +
    `• Make sure you uploaded the correct Excel file\n` +
    `• Verify you have sufficient balance for all plots\n\n` +
    `Do you want to proceed with ${plotCount} plot(s)?`;

  const confirmed = confirm(confirmMessage);
  if (!confirmed) {
    return; // User cancelled
  }

  if (!settings.general) {
    settings.general = {};
  }
  settings.general.mobileNumber = mobileNumber;

  const agentSettings = {
    plotColumnIndex: parseInt(document.getElementById('plotColumn').value),
    waitTimes: {
      captcha: parseInt(document.getElementById('captchaTimeout').value) * 1000,
      uaePassTimeout: parseInt(document.getElementById('uaePassTimeout').value) * 1000,
    },
  };

  agentSettings.serviceName = document.getElementById('serviceName').value.trim();
  agentSettings.accountSwitching = {
    enabled: document.getElementById('enableAccountSwitch').checked,
    targetAccountName: document.getElementById('accountName').value,
  };
  agentSettings.emailNotification = {
    enabled: document.getElementById('enableEmailNotification').checked,
    recipientEmail: document.getElementById('recipientEmail').value.trim(),
    ccEmail: document.getElementById('ccEmail').value.trim(),
  };
  agentSettings.waitTimes.downloadPageTimeout = parseInt(document.getElementById('downloadTimeout').value) * 1000;

  if (!settings.affectionPlan) {
    settings.affectionPlan = {};
  }
  settings.affectionPlan = { ...settings.affectionPlan, ...agentSettings };

  await window.electronAPI.saveSettings(settings);

  showView('running');
  setRunningStatus('running', 'Agent is processing your request...');
  const runningTitle = 'Dari Affection Plan Agent Running...';
  const agentFolder = 'AffectionPlans';

  document.getElementById('runningAgentTitle').textContent = runningTitle;

  clearConsole();

  const downloadPath = await window.electronAPI.getDownloadsPath();
  const timestamp = new Date().toISOString().split('T')[0];
  const fullPath = `${downloadPath}/${agentFolder}/${timestamp}`;

  document.getElementById('downloadPath').textContent = fullPath;
  document.getElementById('downloadInfo').classList.remove('hidden');

  const result = await window.electronAPI.runAgent(currentAgent, selectedFile);

  if (!result.success) {
    setRunningStatus('error', `Agent could not start: ${result.error}`);
    appendConsoleOutput(`Fatal startup error: ${result.error}`, 'error');
    alert(`Error: ${result.error}`);
    showView('running');
  }
}

async function stopAgent() {
  const confirmed = confirm('Are you sure you want to stop the agent?');
  if (confirmed) {
    await window.electronAPI.stopAgent();
    showView('config');
  }
}

function openDownloads() {
  window.electronAPI.openDownloads();
}

function appendConsoleOutput(text, type = 'info') {
  const consoleElement = document.getElementById('consoleOutput');
  const normalizedText = typeof text === 'string' ? text : String(text);
  consoleLogBuffer.push({ text: normalizedText, type });

  const line = normalizedText.endsWith('\n') ? normalizedText : `${normalizedText}\n`;
  consoleElement.textContent += line;
  consoleElement.scrollTop = consoleElement.scrollHeight;
}

function clearConsole() {
  consoleLogBuffer = [];
  document.getElementById('consoleOutput').textContent = '';
}

async function copyConsoleLogs(event) {
  const copyButton = event?.currentTarget || document.getElementById('copyConsoleBtn');
  const logText = consoleLogBuffer.map((entry) => entry.text).join('\n');

  if (!logText.trim()) {
    alert('There are no logs to copy yet.');
    return;
  }

  try {
    await navigator.clipboard.writeText(logText);
    const originalLabel = copyButton.textContent;
    copyButton.textContent = 'Copied';
    setTimeout(() => {
      copyButton.textContent = originalLabel;
    }, 1500);
  } catch (error) {
    alert(`Unable to copy logs automatically. You can still select and copy them manually.\n\n${error}`);
  }
}

function setRunningStatus(status, message) {
  const indicator = document.getElementById('statusIndicator');
  const spinner = document.getElementById('statusSpinner');
  const statusText = document.getElementById('statusText');
  const stopButton = document.getElementById('stopAgentBtn');

  indicator.classList.remove('status-running', 'status-success', 'status-error');
  indicator.classList.add(`status-${status}`);
  statusText.textContent = message;

  if (status === 'running') {
    spinner.classList.remove('hidden');
    stopButton.disabled = false;
  } else {
    spinner.classList.add('hidden');
    stopButton.disabled = true;
  }
}

function resetConfig() {
  selectedFile = null;
  currentAgent = null;
  document.getElementById('fileName').textContent = 'No file selected';
  document.getElementById('fileInfo').classList.add('hidden');
  document.getElementById('runAgentBtn').disabled = true;
  document.getElementById('advancedSettings').classList.add('hidden');
}

init();

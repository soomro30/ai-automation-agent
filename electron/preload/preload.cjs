const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectExcelFile: () => ipcRenderer.invoke('select-excel-file'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  runAgent: (agentId, excelFilePath) => ipcRenderer.invoke('run-agent', agentId, excelFilePath),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  countPlotsInExcel: (excelFilePath, plotColumnIndex) => ipcRenderer.invoke('count-plots-in-excel', excelFilePath, plotColumnIndex),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openLogFile: (logFilePath) => ipcRenderer.invoke('open-log-file', logFilePath),

  onAgentOutput: (callback) => {
    ipcRenderer.on('agent-output', (event, data) => callback(data));
  },
  onAgentError: (callback) => {
    ipcRenderer.on('agent-error', (event, data) => callback(data));
  },
  onAgentFinished: (callback) => {
    ipcRenderer.on('agent-finished', (event, data) => callback(data));
  },
});

const fs = require('fs');
const file = 'chrome-extension/popup/popup.js';
let content = fs.readFileSync(file, 'utf8');

// Fix 1: Properly handle initial UI state by fully clearing state if sw_running is false
const targetLoadStr = `  // Load saved mode / queue state (results stay in the panel only; no auto local files)
  chrome.storage.local.get([
    'savedAccounts', 'sw_running', 'sw_paused', 'execMode',
    'sw_current', 'sw_queue'
  ], (r) => {
    if (r.savedAccounts) els.accountInput.value = r.savedAccounts;
    if (r.execMode) setMode(r.execMode);
    updateCount();
    if (r.sw_running) {
      setUiState('running');
    } else if (r.sw_paused || r.sw_current || (r.sw_queue && r.sw_queue.length)) {
      setUiState('paused');
      if (r.sw_current?.email) els.currentAccountText.textContent = r.sw_current.email + '（已暂停）';
    } else {
      setUiState('idle');
    }
  });`;

const replacementLoadStr = `  // Load saved mode / queue state (results stay in the panel only; no auto local files)
  chrome.storage.local.get([
    'savedAccounts', 'sw_running', 'sw_paused', 'execMode',
    'sw_current', 'sw_queue'
  ], (r) => {
    if (r.savedAccounts) els.accountInput.value = r.savedAccounts;
    if (r.execMode) setMode(r.execMode);
    updateCount();
    
    // 强制清理残留状态：如果后台脚本并没有真的在运行（或者重启了浏览器），不能仅仅因为 sw_current 残留就变为 paused
    // 我们必须信任 sw_running 或 sw_paused，如果两者都不为 true，强制进入 idle
    if (r.sw_running) {
      setUiState('running');
    } else if (r.sw_paused) {
      setUiState('paused');
      if (r.sw_current?.email) els.currentAccountText.textContent = r.sw_current.email + '（已暂停）';
    } else {
      setUiState('idle');
      // 可以顺手清理一下残留队列
      chrome.storage.local.remove(['sw_current', 'sw_queue']);
    }
  });`;

if (content.includes(targetLoadStr)) {
  content = content.replace(targetLoadStr, replacementLoadStr);
  console.log("Popup UI initialization patched");
} else {
  console.log("Failed to patch popup UI initialization");
}

fs.writeFileSync(file, content);

// Chrome Extension Service Worker — Simplified 4-Step Flow
// Step 1: Open auth page | Step 2: Auto-fill email/password | Step 3: Backup email & code | Step 4: Exchange token

let accountsQueue = [];
let currentAccount = null;
let currentTabId = null;
let results = [];
let isRunning = false;
let isPaused = false;
let settings = {};
let currentMode = 'auto'; // 'auto' | 'step-by-step'
// In-memory guards against concurrent tab events / double step-4 (storage races).
let step4Lock = false;
const claimedAuthCodes = new Set();
// Round-robin index for multi fixed backup emails (persisted across accounts in a batch).
let backupEmailCursor = 0;

function getScopes() {
  // 如果用户在设置里选择了 Graph 模式，就只申请 Graph 权限；否则默认申请 IMAP 权限
  if (settings.apiMode === 'graph') {
    return 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
  }
  return 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
}
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

const KNOWN_CLIENT_IDS = [
  '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
];

// Strip Origin/Referer headers to bypass Microsoft cross-origin check for native client
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'Origin', operation: 'remove' },
      { header: 'Referer', operation: 'remove' }
    ]},
    condition: { urlFilter: '||login.microsoftonline.com/common/oauth2/v2.0/token', resourceTypes: ['xmlhttprequest'] }
  }]
});

// ============== PKCE Helpers ==============
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}
function base64URLEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64URLEncode(new Uint8Array(hash));
}
function getRandomState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}
function getClientId() {
  if (settings.clientIdMode === 'custom' && settings.customClientId) return settings.customClientId;
  return KNOWN_CLIENT_IDS[Math.floor(Math.random() * KNOWN_CLIENT_IDS.length)];
}

function randomBackupLocalPart(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function parseFixedBackupList(settingsObj = settings) {
  const raw = settingsObj.backupEmailList;
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map((s) => String(s || '').trim()).filter(Boolean);
  } else if (typeof raw === 'string' && raw.trim()) {
    list = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  // Legacy single field fallback.
  if (!list.length && settingsObj.backupEmail) {
    list = String(settingsObj.backupEmail).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  return list.slice(0, 10);
}

// Resolve backup email from settings: multi fixed (round-robin), or random local-part @ domain.
function resolveBackupEmail(settingsObj = settings) {
  const mode = settingsObj.backupEmailMode === 'random' ? 'random' : 'fixed';
  if (mode === 'random') {
    const domain = (settingsObj.backupEmailDomain || '').trim().replace(/^@/, '');
    if (!domain) return '';
    return `${randomBackupLocalPart()}@${domain}`;
  }
  const list = parseFixedBackupList(settingsObj);
  if (!list.length) return '';
  const idx = ((backupEmailCursor % list.length) + list.length) % list.length;
  const email = list[idx];
  backupEmailCursor = (idx + 1) % list.length;
  return email;
}

function describeFixedBackupPick(settingsObj, picked) {
  const list = parseFixedBackupList(settingsObj);
  if (!list.length || !picked) return '';
  const pos = list.indexOf(picked);
  if (pos < 0) return `固定备用邮箱: ${picked}`;
  return `固定备用邮箱 (${pos + 1}/${list.length}): ${picked}`;
}
function buildAuthUrl(clientId, codeChallenge, state) {
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    scope: getScopes(), code_challenge: codeChallenge, code_challenge_method: 'S256',
    state: state, prompt: 'login'
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// ============== Side Panel ==============
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// ============== State Persistence ==============
async function saveState() {
  await chrome.storage.local.set({
    sw_queue: accountsQueue, sw_current: currentAccount,
    sw_tabId: currentTabId, sw_results: results, sw_running: isRunning,
    sw_paused: isPaused, sw_mode: currentMode, sw_settings: settings,
    sw_backupEmailCursor: backupEmailCursor
  });
}
async function loadState() {
  const d = await chrome.storage.local.get([
    'sw_queue', 'sw_current', 'sw_tabId', 'sw_results',
    'sw_running', 'sw_paused', 'sw_mode', 'sw_settings', 'sw_backupEmailCursor'
  ]);
  accountsQueue = d.sw_queue || [];
  currentAccount = d.sw_current || null;
  currentTabId = d.sw_tabId || null;
  results = d.sw_results || [];
  isRunning = d.sw_running || false;
  isPaused = d.sw_paused || false;
  currentMode = d.sw_mode || 'auto';
  settings = d.sw_settings || {};
  if (typeof d.sw_backupEmailCursor === 'number') backupEmailCursor = d.sw_backupEmailCursor;
}

// ============== Message Handler ==============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  loadState().then(async () => {
    switch (msg.action) {
      case 'start':
        currentMode = msg.mode || 'auto';
        settings = await chrome.storage.local.get(null);
        await saveState();
        await startProcess(msg.accounts);
        break;
      case 'pause':
        await pauseProcess();
        break;
      case 'resume':
        await resumeProcess(msg.mode);
        break;
      case 'stop':
        await stopProcess();
        break;
      case 'skipCurrentStep':
        if (currentTabId) {
          try { await chrome.tabs.sendMessage(currentTabId, { action: 'skipCurrentStep' }); } catch(e) {}
        }
        break;
      case 'reopenAuth':
        // Content script detected backup-email verified / expired-code page.
        if (isPaused || !isRunning) {
          sendLog('已暂停/停止，跳过自动重开授权页', 'warning');
          break;
        }
        sendLog(
          msg.reason === 'backup-verified'
            ? '✅ 备用邮箱已验证成功，自动重开授权页'
            : '正在重开授权页...',
          'success'
        );
        await executeStep1();
        break;
      case 'executeStep':
        if (msg.step === 1) {
          await executeStep1();
          break;
        }
        if (msg.step === 4) {
          await executeStep4();
          break;
        }
        if (currentTabId) {
          try {
            // Verify tab still exists
            await chrome.tabs.get(currentTabId);
            await chrome.tabs.sendMessage(currentTabId, { action: 'executeStep', step: msg.step, account: currentAccount });
            sendLog(`📤 已执行步骤 ${msg.step}/4`, 'info');
          } catch(e) {
            sendLog(`⚠️ 步骤 ${msg.step}/4 执行失败：页面可能已关闭，请先执行步骤 1`, 'error');
          }
        } else {
          sendLog('⚠️ 没有打开的授权页面，请先点击步骤 1 打开授权页', 'error');
        }
        if (currentAccount) broadcastStep(msg.step, 'active', currentAccount.email);
        break;
      case 'getCurrentAccount':
        sendResponse(currentAccount);
        break;
      case 'fetchVerificationCode':
        const code = await fetchCodeFromTempEmail();
        sendResponse(code);
        break;
      case 'skipAccount':
        // Content script 发现无法继续（例如备用邮箱不匹配），直接标记为失败并跳过
        sendLog(`[${currentAccount?.email || '未知'}] ❌ 被主动跳过: ${msg.reason}`, 'error');
        if (currentAccount) {
          const email = currentAccount.email;
          const password = currentAccount.password;
          const clientId = currentAccount.clientId;
          const backupEmail = currentAccount.backupEmail;
          await finishAccount({
            success: false,
            email, password, clientId, backupEmail,
            error: msg.reason
          });
          if (currentTabId) {
             chrome.tabs.remove(currentTabId).catch(() => {});
             currentTabId = null;
          }
        }
        break;
      case 'matchMaskedEmail':
        const masked = msg.maskedEmail || '';
        const [maskLocal, maskDomain] = masked.split('@');
        let matched = null;
        if (maskLocal && maskDomain) {
            let list = parseFixedBackupList(settings);
            if (!list || list.length === 0) {
              const res1 = await chrome.storage.local.get('backupEmailList');
              list = parseFixedBackupList({ backupEmailList: res1.backupEmailList });
            }
            if (!list || list.length === 0) {
              const res2 = await chrome.storage.local.get('sw_settings');
              list = parseFixedBackupList(res2.sw_settings || {});
            }
            const prefix = maskLocal.replace(/\*/g, '').replace(/\s+/g, '').toLowerCase();
            const pureDomain = maskDomain.replace(/\s+/g, '').toLowerCase();
            sendLog(`[匹配调试] 当前池 ${list.length} 个，寻找前缀 '${prefix}', 域名 '${maskDomain}'`, 'info');
            for (let e of list) {
                const [l, d] = e.split('@');
                if (d && d.replace(/s+/g, '').toLowerCase() === pureDomain && l.toLowerCase().startsWith(prefix)) {
                    matched = e;
                    break;
                }
            }
        }
        sendResponse(matched);
        break;
      case 'log':
        sendLog(msg.message, msg.level);
        break;
    }
  }).catch(err => {
    console.error('Handler error:', err);
    sendLog(`⚠️ 内部错误: ${err.message}`, 'error');
  });
  return true;
});

// ============== Tab URL Listener (stash auth code; auto step 4 in auto mode) ==============
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  loadState().then(async () => {
    if (isPaused || !isRunning) return;
    const url = changeInfo.url || tab.url;
    if (!url || !url.includes('nativeclient') || tabId !== currentTabId || !currentAccount) return;

    try {
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');

      if (err) {
        const desc = u.searchParams.get('error_description') || err;
        const email = currentAccount.email;
        sendLog(`[${email}] 授权错误: ${desc}`, 'error');
        await finishAccount({
          success: false,
          email,
          password: currentAccount.password,
          clientId: currentAccount.clientId,
          error: desc
        });
        return;
      }

      // Stash auth code once. Auto mode exchanges immediately; step-by-step waits for click.
      // Guard with claimedAuthCodes so reopened pages / double onUpdated never re-exchange.
      if (code && !currentAccount.pendingAuthCode && !currentAccount.isFetchingToken && !step4Lock) {
        if (claimedAuthCodes.has(code)) return;
        claimedAuthCodes.add(code);
        // Keep set bounded
        if (claimedAuthCodes.size > 50) {
          const first = claimedAuthCodes.values().next().value;
          claimedAuthCodes.delete(first);
        }

        currentAccount.pendingAuthCode = code;
        currentAccount.autoStep4Scheduled = currentMode === 'auto';
        await saveState();
        broadcastStep(3, 'completed', currentAccount.email);
        broadcastStep(4, 'active', currentAccount.email);
        broadcastToPopup({ type: 'tokenReady', account: currentAccount.email, auto: currentMode === 'auto' });

        if (currentMode === 'auto') {
          sendLog(`[${currentAccount.email}] ✅ 授权码已就绪，自动执行步骤 4 换取令牌`, 'success');
          setTimeout(() => {
            executeStep4().catch((e) => {
              if (/null|undefined/i.test(e?.message || '') && /email/i.test(e?.message || '')) return;
              sendLog(`自动换取令牌失败: ${e.message}`, 'error');
            });
          }, 400);
        } else {
          sendLog(`[${currentAccount.email}] ✅ 授权码已就绪，请点击“步骤 4”获取令牌`, 'success');
        }
      }
    } catch (_) {}
  });
});

// Step 1: open / reopen Microsoft auth page for current account
async function executeStep1() {
  await loadState();
  settings = { ...settings, ...(await chrome.storage.local.get(null)) };

  // If no running account, bootstrap from the first queued/saved account state if possible
  if (!currentAccount) {
    if (accountsQueue.length > 0) {
      isRunning = true;
      await saveState();
      await processNext();
      return;
    }
    sendLog('⚠️ 没有进行中的账号。请先点击“开始处理”载入账号，再点步骤 1', 'error');
    return;
  }

  // Reset auth progress for a fresh login attempt
  currentAccount.pendingAuthCode = null;
  currentAccount.isFetchingToken = false;
  currentAccount.autoStep4Scheduled = false;
  currentAccount.closingAuthTab = false;
  isRunning = true;

  const clientId = currentAccount.clientId || getClientId();
  currentAccount.clientId = clientId;
  // Keep existing backup for this account (avoid advancing multi-list cursor on step-1 retry).
  // Only pick a new one if missing, or random mode and empty.
  if (!currentAccount.backupEmail) {
    currentAccount.backupEmail = resolveBackupEmail(settings);
  }
  if (!currentAccount.backupEmail) {
    sendLog('⚠️ 未配置备用邮箱：固定模式请填邮箱列表，随机模式请填域名', 'warning');
  } else if (settings.backupEmailMode === 'random') {
    sendLog(`[${currentAccount.email}] 随机备用邮箱: ${currentAccount.backupEmail}`, 'info');
  } else {
    sendLog(`[${currentAccount.email}] ${describeFixedBackupPick(settings, currentAccount.backupEmail)}`, 'info');
  }

  sendLog(`[${currentAccount.email}] 步骤 1/4：正在打开授权页面...`, 'info');
  broadcastStep(1, 'active', currentAccount.email);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = getRandomState();
  const authUrl = buildAuthUrl(clientId, codeChallenge, state);
  const key = currentAccount.email + '_' + clientId;
  await chrome.storage.local.set({ [`pkce_${key}`]: { codeVerifier, state } });
  await saveState();

  // Prefer reusing existing auth tab; otherwise open a new one
  let reused = false;
  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      await chrome.tabs.update(currentTabId, { url: authUrl, active: true });
      reused = true;
    } catch (_) {
      currentTabId = null;
    }
  }
  if (!reused) {
    const tab = await chrome.tabs.create({ url: authUrl, active: true });
    currentTabId = tab.id;
    await saveState();
  }

  const emailSnapshot = currentAccount?.email || '';
  setTimeout(() => {
    broadcastStep(1, 'completed', emailSnapshot);
    if (currentMode === 'auto') {
      broadcastStep(2, 'active', emailSnapshot);
    } else {
      sendLog(`[${emailSnapshot}] 📝 授权页已打开，请点击“步骤 2”填写账号密码`, 'warning');
    }
  }, 1500);
}

// Step 4: exchange authorization code for refresh token
async function executeStep4() {
  // Hard lock against concurrent auto + manual / double nativeclient events.
  if (step4Lock) return;
  step4Lock = true;

  try {
    await loadState();
    if (!currentAccount) return;
    if (currentAccount.isFetchingToken) {
      sendLog('步骤 4/4：正在换取令牌，请稍候...', 'info');
      return;
    }
    if (!currentAccount.pendingAuthCode) {
      sendLog('⚠️ 授权码尚未就绪。请先完成步骤 3（必要时可多次执行），待页面授权成功后再点步骤 4', 'warning');
      broadcastStep(4, 'pending', currentAccount.email);
      return;
    }

    // Snapshot fields up front — finishAccount / concurrent calls may clear currentAccount mid-await.
    const snap = {
      email: currentAccount.email,
      password: currentAccount.password,
      clientId: currentAccount.clientId,
      backupEmail: currentAccount.backupEmail,
      code: currentAccount.pendingAuthCode
    };

    // Already have a success for this email in current batch — never re-exchange expired codes.
    if (results.some((r) => r.success && r.email === snap.email && r.token)) {
      sendLog(`[${snap.email}] 已有成功令牌，跳过重复换取`, 'info');
      currentAccount = null;
      await saveState();
      setTimeout(() => processNext(), 500);
      return;
    }

    currentAccount.isFetchingToken = true;
    currentAccount.closingAuthTab = true;
    // Clear pending code immediately so a second nativeclient navigation cannot re-use it.
    currentAccount.pendingAuthCode = null;
    await saveState();
    sendLog(`[${snap.email}] 步骤 4/4：开始换取令牌...`, 'info');
    broadcastStep(4, 'active', snap.email);

    if (currentTabId) {
      const tabToClose = currentTabId;
      currentTabId = null;
      await saveState();
      chrome.tabs.remove(tabToClose).catch(() => {});
    }

    const key = snap.email + '_' + snap.clientId;
    const pkce = await chrome.storage.local.get([`pkce_${key}`]);
    const verifier = pkce[`pkce_${key}`]?.codeVerifier;
    chrome.storage.local.remove(`pkce_${key}`);

    if (!verifier) {
      await finishAccount({
        success: false,
        email: snap.email,
        password: snap.password,
        clientId: snap.clientId,
        backupEmail: snap.backupEmail,
        error: 'PKCE verifier 丢失'
      });
      return;
    }

    try {
      const tokenRes = await exchangeToken(snap.code, snap.clientId, verifier);
      
      // 注：不再使用 HTTP 请求验证 IMAP 令牌，因为会导致 401 误杀。
      // 只要成功拿到 refresh_token 即认为成功。

      broadcastStep(4, 'completed', snap.email);
      await finishAccount({
        success: true,
        email: snap.email,
        password: snap.password,
        clientId: snap.clientId,
        token: tokenRes.refresh_token,
        backupEmail: snap.backupEmail
      });
    } catch (err) {
      // If we already recorded success for this email, swallow expired-code noise.
      await loadState();
      if (results.some((r) => r.success && r.email === snap.email && r.token)) {
        sendLog(`[${snap.email}] 忽略过期授权码错误（令牌已成功获取）`, 'info');
        return;
      }
      broadcastStep(4, 'error', snap.email);
      await finishAccount({
        success: false,
        email: snap.email,
        password: snap.password,
        clientId: snap.clientId,
        backupEmail: snap.backupEmail,
        error: err.message
      });
    }
  } finally {
    step4Lock = false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  loadState().then(async () => {
    // Ignore intentional close during step-4 token exchange.
    if (tabId !== currentTabId) return;
    if (currentAccount?.closingAuthTab || currentAccount?.isFetchingToken) {
      currentTabId = null;
      await saveState();
      return;
    }
    sendLog('登录页面被关闭，任务暂停', 'warning');
    currentTabId = null;
    isRunning = false;
    await saveState();
    broadcastToPopup({ type: 'paused' });
  });
});

// ============== Start Processing ==============
async function startProcess(accounts) {
  isRunning = true;
  isPaused = false;
  step4Lock = false;
  results = [];
  currentAccount = null;
  claimedAuthCodes.clear();
  backupEmailCursor = 0;
  if (currentTabId) { chrome.tabs.remove(currentTabId).catch(() => {}); currentTabId = null; }

  accountsQueue = accounts.map(a => {
    const p = a.split(/----|:|\|/);
    return { email: p[0]?.trim(), password: p[1]?.trim() };
  }).filter(a => a.email && a.password);

  // Clean old PKCE data
  chrome.storage.local.get(null, all => {
    const keys = Object.keys(all).filter(k => k.startsWith('pkce_'));
    if (keys.length) chrome.storage.local.remove(keys);
  });

  await saveState();
  sendLog(`开始处理 ${accountsQueue.length} 个账号`, 'info');
  broadcastToPopup({ type: 'started', total: accountsQueue.length });
  processNext();
}

// ============== Pause / Resume ==============
async function pauseProcess() {
  await loadState();
  if (!isRunning && !currentAccount && accountsQueue.length === 0) {
    sendLog('没有进行中的任务可暂停', 'warning');
    return;
  }
  isPaused = true;
  isRunning = false;
  // Keep queue / currentAccount / tab / results so resume can continue.
  await saveState();
  sendLog('⏸ 任务已暂停（当前账号与队列已保留，可点“继续”）', 'warning');
  broadcastToPopup({
    type: 'paused',
    resumable: true,
    account: currentAccount?.email || null,
    remaining: accountsQueue.length + (currentAccount ? 1 : 0)
  });
}

async function resumeProcess(mode) {
  await loadState();
  settings = { ...settings, ...(await chrome.storage.local.get(null)) };
  if (mode) currentMode = mode;

  if (!currentAccount && accountsQueue.length === 0) {
    sendLog('⚠️ 没有可继续的任务，请重新“开始处理”', 'error');
    isPaused = false;
    isRunning = false;
    await saveState();
    broadcastToPopup({ type: 'paused', resumable: false });
    return;
  }

  isPaused = false;
  isRunning = true;
  step4Lock = false;
  await saveState();

  const label = currentAccount?.email || accountsQueue[0]?.email || '';
  sendLog(`▶ 继续处理（当前: ${label || '队列下一账号'}，剩余 ${accountsQueue.length + (currentAccount ? 1 : 0)}）`, 'info');
  broadcastToPopup({
    type: 'resumed',
    account: currentAccount?.email || null,
    remaining: accountsQueue.length + (currentAccount ? 1 : 0)
  });

  if (currentAccount) {
    // Resume mid-account: reopen auth page and let content scripts continue.
    if (currentAccount.isFetchingToken) {
      currentAccount.isFetchingToken = false;
    }
    // If auth code already pending, finish step 4; otherwise reopen login.
    if (currentAccount.pendingAuthCode) {
      if (currentMode === 'auto') {
        setTimeout(() => { executeStep4().catch(() => {}); }, 300);
      } else {
        sendLog('授权码仍在，请点击“步骤 4”获取令牌', 'warning');
        broadcastStep(4, 'active', currentAccount.email);
      }
    } else {
      await executeStep1();
    }
  } else {
    processNext();
  }
}

// ============== Process Next Account ==============
async function processNext() {
  await loadState();
  if (isPaused) return;
  if (!isRunning || accountsQueue.length === 0) {
    isRunning = false;
    isPaused = false;
    broadcastToPopup({ type: 'finished', results: results });
    chrome.storage.local.set({ sw_running: false, sw_paused: false });
    sendLog('所有账号已处理完毕！', 'success');
    // Clean up state flags
    await chrome.storage.local.remove(['sw_running', 'sw_paused', 'sw_current', 'sw_tabId', 'sw_queue']);
    return;
  }

  const account = accountsQueue.shift();
  // Skip accounts already successfully finished in this batch (reopen/retry safety).
  if (results.some((r) => r.success && r.email === account.email && r.token)) {
    sendLog(`[${account.email}] 本批已成功，跳过`, 'info');
    setTimeout(() => processNext(), 300);
    return;
  }

  const clientId = getClientId();
  // Refresh settings so multi-list edits from options take effect mid-batch.
  const live = await chrome.storage.local.get([
    'backupEmail', 'backupEmailList', 'backupEmailMode', 'backupEmailDomain',
    'clientIdMode', 'customClientId', 'tempEmailEnabled', 'tempEmailApiUrl', 'tempEmailAdminPassword'
  ]);
  settings = { ...settings, ...live };
  const backupEmail = resolveBackupEmail(settings);
  currentAccount = { ...account, clientId, backupEmail };
  step4Lock = false;
  if (!backupEmail) {
    sendLog(`[${account.email}] ⚠️ 未配置备用邮箱：固定模式请填邮箱列表，随机模式请填域名`, 'warning');
  } else if (settings.backupEmailMode === 'random') {
    sendLog(`[${account.email}] 随机备用邮箱: ${backupEmail}`, 'info');
  } else {
    sendLog(`[${account.email}] ${describeFixedBackupPick(settings, backupEmail)}`, 'info');
  }
  sendLog(`[${account.email}] 步骤 1/4：正在打开授权页面...`, 'info');
  broadcastStep(1, 'active', account.email);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = getRandomState();
  const authUrl = buildAuthUrl(clientId, codeChallenge, state);

  const key = account.email + '_' + clientId;
  await chrome.storage.local.set({ [`pkce_${key}`]: { codeVerifier, state } });
  await saveState();

  if (currentMode === 'step-by-step') {
    sendLog(`[${account.email}] 📝 逐步骤模式：点击"步骤 2"圆圈开始自动登录`, 'warning');
  }

  const params = { url: authUrl };
  if (currentTabId) {
    chrome.tabs.update(currentTabId, { url: authUrl });
  } else {
    chrome.tabs.create(params, tab => { currentTabId = tab.id; saveState(); });
  }

  setTimeout(() => {
    broadcastStep(1, 'completed', account.email);
    if (currentMode === 'auto') {
      broadcastStep(2, 'active', account.email);
    } else {
      sendLog(`[${account.email}] 📝 逐步骤模式：点击"步骤 2"圆圈开始自动登录`, 'warning');
    }
  }, 3000);
}

// ============== Finish Current Account ==============
async function finishAccount(result) {
  await loadState();
  const saved = currentAccount;

  // Concurrent finish (e.g. double auto step-4): already cleared — skip quietly.
  if (!saved) {
    if (!result?.email) return;
    if (results.some((r) => r.email === result.email && r.token === result.token && r.success === result.success)) return;
  } else {
    currentAccount = null;
  }

  if (!result.password && saved) result.password = saved.password || '';
  if (!result.backupEmail && saved) result.backupEmail = saved.backupEmail || '';
  if (!result.clientId && saved) result.clientId = saved.clientId || '';
  if (!result.email && saved) result.email = saved.email || '';

  // Prefer success over later FAILED for same email (expired-code after success).
  if (!result.success) {
    const existingSuccess = results.find((r) => r.success && r.email === result.email && r.token);
    if (existingSuccess) {
      sendLog(`[${result.email}] 忽略失败结果（已有成功令牌）: ${String(result.error || '').slice(0, 80)}`, 'info');
      if (!isPaused && isRunning) setTimeout(() => processNext(), 500);
      return;
    }
  } else {
    // Drop any prior FAILED rows for this email in current batch display storage.
    results = results.filter((r) => !(r.email === result.email && !r.success));
  }

  const lineKey = `${result.email}|${result.success}|${result.token || result.error || ''}`;
  if (results.some((r) => `${r.email}|${r.success}|${r.token || r.error || ''}` === lineKey)) {
    return;
  }

  results.push(result);
  await saveState();

  if (result.success) {
    sendLog(`[${result.email}] ✅ 获取 Refresh Token 成功`, 'success');
  } else {
    sendLog(`[${result.email}] ❌ 失败: ${result.error}`, 'error');
  }

  broadcastToPopup({ type: 'accountResult', result });

  if (isPaused) return;
  setTimeout(() => processNext(), 2000);
}

// ============== Stop (full cancel) ==============
async function stopProcess() {
  isRunning = false;
  isPaused = false;
  step4Lock = false;
  accountsQueue = [];
  currentAccount = null;
  try {
    await chrome.storage.local.set({
      sw_running: false, sw_paused: false,
      sw_queue: [], sw_current: null, sw_tabId: null
    });
    await saveState();
  } catch (_) {
    chrome.storage.local.set({ sw_running: false, sw_paused: false });
  }
  sendLog('任务已停止（队列已清空）', 'warning');
  broadcastToPopup({ type: 'stopped' });
}

// ============== Token Exchange ==============
async function exchangeToken(authCode, clientId, codeVerifier) {
  const body = new URLSearchParams({
    client_id: clientId, scope: getScopes(), code: authCode,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: codeVerifier
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error_description || j.error || msg; } catch(_) { msg = text ? `${msg} - ${text.substring(0,200)}` : msg; }
    throw new Error(msg);
  }
  return await res.json();
}

// ============== Temp Email Polling ==============
async function loadTempEmailSettings() {
  // Always re-read from storage so options page changes take effect immediately.
  const all = await chrome.storage.local.get([
    'tempEmailEnabled', 'tempEmailApiUrl', 'tempEmailAdminPassword',
    'backupEmail', 'backupEmailList', 'backupEmailMode', 'backupEmailDomain', 'sw_settings'
  ]);
  const fromSw = all.sw_settings || {};
  return {
    tempEmailEnabled: all.tempEmailEnabled ?? fromSw.tempEmailEnabled,
    tempEmailApiUrl: all.tempEmailApiUrl || fromSw.tempEmailApiUrl || '',
    tempEmailAdminPassword: all.tempEmailAdminPassword || fromSw.tempEmailAdminPassword || '',
    backupEmail: all.backupEmail || fromSw.backupEmail || '',
    backupEmailList: all.backupEmailList || fromSw.backupEmailList || [],
    backupEmailMode: all.backupEmailMode || fromSw.backupEmailMode || 'fixed',
    backupEmailDomain: all.backupEmailDomain || fromSw.backupEmailDomain || ''
  };
}

function normalizeApiBase(raw) {
  let url = (raw || '').trim().replace(/\/$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/$/, '');
}

async function fetchCodeFromTempEmail() {
  const cfg = await loadTempEmailSettings();
  settings = { ...settings, ...cfg };

  if (!cfg.tempEmailEnabled) {
    sendLog('⚠️ 未启用自动接码，请到设置页勾选“启用自动接码”', 'warning');
    return null;
  }
  if (!cfg.tempEmailApiUrl || !cfg.tempEmailAdminPassword) {
    sendLog('⚠️ 接码 API 地址或 Admin 密码未配置，请到设置页填写', 'warning');
    return null;
  }

  const apiUrl = normalizeApiBase(cfg.tempEmailApiUrl);
  const adminPass = cfg.tempEmailAdminPassword;
  const searchAddress = currentAccount?.backupEmail ||
    (cfg.backupEmailMode === 'random' ? '' : (cfg.backupEmail || ''));

  // Validate URL early
  try {
    // eslint-disable-next-line no-new
    new URL(apiUrl);
  } catch (_) {
    sendLog(`❌ 接码 API 地址无效: ${cfg.tempEmailApiUrl}`, 'error');
    return null;
  }

  sendLog(`正在查询验证码 (API: ${apiUrl}，邮箱: ${searchAddress || '未指定'})...`, 'info');

  for (let i = 0; i < 20; i++) {
    await loadState();
    if (!isRunning || isPaused) {
      sendLog('已暂停/停止，取消验证码轮询', 'warning');
      return null;
    }
    try {
      let url = `${apiUrl}/admin/mails?limit=10&offset=0`;
      if (searchAddress) url += `&address=${encodeURIComponent(searchAddress)}`;

      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-admin-auth': adminPass, 'Content-Type': 'application/json' },
        cache: 'no-store'
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        sendLog(`查询失败，状态码: ${res.status}${bodyText ? ` — ${bodyText.slice(0, 120)}` : ''}`, 'error');
        if (res.status === 401 || res.status === 403) {
          sendLog('⚠️ Admin 密码可能不正确，请到设置页检查', 'warning');
          return null;
        }
        // For 5xx keep retrying
      } else {
        const data = await res.json();
        const mails = data.results || data.mails || data || [];
        if (!Array.isArray(mails)) {
          sendLog(`⚠️ 接码接口返回格式异常: ${typeof data}`, 'warning');
        } else if (!mails.length) {
          // no mails yet
        } else {
          for (const mail of mails) {
            let fullText = '';
            for (const key of Object.keys(mail || {})) {
              if (typeof mail[key] === 'string') fullText += mail[key] + '\n';
            }

            const patterns = [
              /你的一次性代码为[：:]\s*(\d{6})/,
              /安全代码[：:]\s*(\d{6})/,
              /一次性代码[：:]\s*(\d{6})/,
              /security code[：:]\s*(\d{6})/i,
              /code[：:\s]+(\d{6})/i,
              /(\d{6})(?:\s|$)(?!.*\d{6})/m,
            ];
            for (const p of patterns) {
              const m = fullText.match(p);
              if (m?.[1]) {
                sendLog(`✅ 匹配到验证码: ${m[1]}`, 'success');
                return m[1];
              }
            }
          }
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      if (/Failed to fetch|NetworkError|network/i.test(msg)) {
        sendLog(`❌ 查询异常: Failed to fetch（无法访问接码 API）`, 'error');
        if (i === 0) {
          sendLog(`排查: 1) 设置页 API 地址是否正确 2) 用浏览器直接打开 ${apiUrl} 看能否访问 3) 设置页点“测试连接”`, 'warning');
        }
      } else {
        sendLog(`❌ 查询异常: ${msg}`, 'error');
      }
    }
    if (i < 19) {
      sendLog(`第 ${i + 1}/20 次: 未获取到，等待3秒...`, 'info');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  sendLog('❌ 验证码获取超时', 'error');
  return null;
}

// ============== Broadcast Helpers ==============
function sendLog(message, level = 'info') {
  console.log(`[${level}] ${message}`);
  broadcastToPopup({ type: 'log', message, level });
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastStep(step, status, account) {
  broadcastToPopup({ type: 'stepUpdate', step, status, account });
}


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
// When true, in-memory queue/current is ahead of storage — skip loadState until saveState lands.
let stateDirty = false;
// Finished accounts since last Microsoft session cleanup (normal/incognito each have own SW).
let accountsSinceCleanup = 0;
const CLEANUP_EVERY_N = 5;
// Last auth URL opened for current account (used to recover from SSL/blank error pages).
let lastAuthUrl = null;
// Rate-limit SSL/blank-page auto-recovery per account email.
const pageRecoverAttempts = new Map(); // email -> { count, lastAt }
// Full task re-runs after hard SSL / recover budget (transient proxy glitches).
const pageFullRerunCount = new Map(); // email -> number of full re-runs already used
const PAGE_RECOVER_MAX = 2; // soft blank only — limited blank hops, then full re-run
const PAGE_FULL_RERUN_MAX = 1; // soft blank exhausted: re-run whole account once, then skip
// Hard SSL/proxy errors rarely heal by reopening the same auth page — skip immediately.
const PAGE_RECOVER_COOLDOWN_MS = 2500;
// Blank/error must stay continuous this long before SW recovers (nav white-flash is shorter).
const PAGE_ANOMALY_SUSTAIN_MS = 3000;
// Soft blank only when automation has no progress this long (login transitions need more than 3s).
const PAGE_STUCK_MS = 10000;
// After a top-frame navigation starts, ignore soft-blank for this long (email→password hop).
const PAGE_NAV_GRACE_MS = 6000;
// Pending anomaly watches: tabId -> { firstSeenAt, reason, url, lastLogAt, hard, timer }
const pageAnomalyWatch = new Map();
// last progress timestamp (account actions / healthy page) — soft blank needs stuck + sustain
let lastProgressAt = Date.now();
// Last top-frame navigation start — soft blank must wait past grace after this.
let lastNavAt = 0;
// Suppress re-detect while a recovery navigation is in flight.
let pageRecoverInFlightUntil = 0;

function markProgress() {
  lastProgressAt = Date.now();
}

function isTaskStuck() {
  return Date.now() - lastProgressAt >= PAGE_STUCK_MS;
}

function isInNavGrace() {
  return lastNavAt > 0 && Date.now() - lastNavAt < PAGE_NAV_GRACE_MS;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// Slightly slower inter-account / post-success pacing (anti risk-control).
const ADVANCE_DELAY_MS = 2800;
const ADVANCE_DELAY_JITTER_MS = 1200;
const STEP4_AUTO_DELAY_MS = 900;
const AUTH_UI_READY_MS = 2200;

function humanDelay(baseMs, jitterMs = 400) {
  return baseMs + Math.floor(Math.random() * Math.max(0, jitterMs));
}

// Origins / cookie domains used by Microsoft login & Outlook (clear only these).
const MS_BROWSING_ORIGINS = [
  'https://login.microsoftonline.com',
  'https://login.live.com',
  'https://account.live.com',
  'https://account.microsoft.com',
  'https://signup.live.com',
  'https://outlook.live.com',
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://www.office.com',
  'https://www.microsoft.com',
  'https://microsoft.com',
  'https://www.live.com',
  'https://live.com',
];
const MS_COOKIE_DOMAIN_SUFFIXES = [
  'login.microsoftonline.com',
  'microsoftonline.com',
  'login.live.com',
  'account.live.com',
  'account.microsoft.com',
  'live.com',
  'microsoft.com',
  'office.com',
  'office365.com',
  'outlook.live.com',
  'outlook.office.com',
  'msn.com',
];

function getScopes() {
  // 默认 Graph；仅当显式选择 imap 时走 IMAP/SMTP
  const mode = (settings.apiMode || 'graph').toLowerCase();
  if (mode === 'imap') {
    return 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
  }
  return 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
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
  return list.slice(0, 100);
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
  const payload = {
    sw_queue: accountsQueue, sw_current: currentAccount,
    sw_tabId: currentTabId, sw_results: results, sw_running: isRunning,
    sw_paused: isPaused, sw_mode: currentMode, sw_settings: settings,
    sw_backupEmailCursor: backupEmailCursor
  };
  await chrome.storage.local.set(payload);
  stateDirty = false;
}
async function loadState() {
  // Never clobber unpersisted in-memory mutations (root cause of skip loop).
  if (stateDirty) return;
  // Live batch in memory: prefer memory over storage to avoid races with concurrent handlers.
  if (isRunning || isPaused || currentAccount || accountsQueue.length > 0) {
    return;
  }
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
function markDirty() {
  stateDirty = true;
}

// ============== Proxy (HTTP / SOCKS5) ==============
// In-memory credentials for chrome.webRequest.onAuthRequired (HTTP proxy auth).
let proxyAuthCredentials = null;
let proxyAuthListenerAttached = false;

function readProxyConfig(raw) {
  const enabled = !!raw?.proxyEnabled;
  const type = raw?.proxyType === 'socks5' ? 'socks5' : 'http';
  const host = String(raw?.proxyHost || '').trim();
  const port = Number(String(raw?.proxyPort || '').trim());
  const username = String(raw?.proxyUsername || '').trim();
  const password = String(raw?.proxyPassword || '');
  return { enabled, type, host, port, username, password };
}

function validateProxyConfig(cfg) {
  if (!cfg.enabled) return null;
  if (!cfg.host) return '代理主机不能为空';
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    return '代理端口无效（需 1–65535）';
  }
  if (cfg.type !== 'http' && cfg.type !== 'socks5') return '代理类型无效';
  return null;
}

function ensureProxyAuthListener() {
  if (proxyAuthListenerAttached) return;
  if (!chrome.webRequest?.onAuthRequired) return;
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (details.isProxy && proxyAuthCredentials?.username) {
        callback({ authCredentials: { ...proxyAuthCredentials } });
        return;
      }
      callback();
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );
  proxyAuthListenerAttached = true;
}

function setProxyAuth(cfg) {
  if (cfg?.enabled && cfg.username) {
    proxyAuthCredentials = {
      username: cfg.username,
      password: cfg.password || ''
    };
    ensureProxyAuthListener();
  } else {
    proxyAuthCredentials = null;
  }
}

// Incognito SW cannot touch scope "regular".
// - regular: write regular + incognito_persistent so 无痕也能用
// - incognito: write session_only (必成) + persistent (尽量持久)
function isIncognitoContext() {
  return !!chrome.extension?.inIncognitoContext;
}

function proxyScopesForWrite() {
  if (isIncognitoContext()) return ['incognito_session_only', 'incognito_persistent'];
  return ['regular', 'incognito_persistent'];
}

// Primary scope must succeed; secondary (e.g. incognito_persistent) is best-effort.
function applyProxyScopes(scopes, applyOne) {
  return new Promise((resolve) => {
    if (!scopes.length) {
      resolve({ ok: false, error: '无可用代理作用域' });
      return;
    }
    const primary = scopes[0];
    const errors = {};
    let left = scopes.length;
    let primaryOk = false;

    const finish = () => {
      if (primaryOk) {
        const warning = Object.entries(errors)
          .filter(([s]) => s !== primary)
          .map(([s, m]) => `${s}: ${m}`)
          .join('; ') || undefined;
        resolve({ ok: true, scopes, warning });
        return;
      }
      resolve({
        ok: false,
        error: errors[primary] || Object.values(errors)[0] || '设置代理失败',
        scopes
      });
    };

    for (const scope of scopes) {
      try {
        applyOne(scope, (errMsg) => {
          if (errMsg) errors[scope] = errMsg;
          else if (scope === primary) primaryOk = true;
          left -= 1;
          if (left === 0) finish();
        });
      } catch (e) {
        errors[scope] = e?.message || String(e);
        left -= 1;
        if (left === 0) finish();
      }
    }
  });
}

function clearBrowserProxy() {
  return applyProxyScopes(proxyScopesForWrite(), (scope, done) => {
    chrome.proxy.settings.clear({ scope }, () => {
      done(chrome.runtime.lastError?.message || null);
    });
  });
}

function setBrowserProxy(cfg) {
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme: cfg.type === 'socks5' ? 'socks5' : 'http',
        host: cfg.host,
        port: cfg.port
      },
      bypassList: ['<local>']
    }
  };
  return applyProxyScopes(proxyScopesForWrite(), (scope, done) => {
    chrome.proxy.settings.set({ value: config, scope }, () => {
      done(chrome.runtime.lastError?.message || null);
    });
  });
}

async function applyProxyFromStorage(raw) {
  const source = raw || (await chrome.storage.local.get([
    'proxyEnabled', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername', 'proxyPassword'
  ]));
  const cfg = readProxyConfig(source);
  const invalid = validateProxyConfig(cfg);
  if (invalid) {
    setProxyAuth(null);
    await clearBrowserProxy();
    return { ok: false, error: invalid };
  }
  if (!cfg.enabled) {
    setProxyAuth(null);
    const cleared = await clearBrowserProxy();
    if (cleared.ok) console.log('[proxy] cleared (system default)');
    return cleared.ok ? { ok: true, enabled: false } : cleared;
  }
  setProxyAuth(cfg);
  const applied = await setBrowserProxy(cfg);
  if (applied.ok) {
    console.log(`[proxy] applied ${cfg.type} ${cfg.host}:${cfg.port}`);
    return {
      ok: true,
      enabled: true,
      type: cfg.type,
      host: cfg.host,
      port: cfg.port
    };
  }
  return applied;
}

function parseExitProbe(text, contentType) {
  const body = String(text || '');
  let ip = null;
  let country = null;
  let region = null;
  let city = null;
  let org = null;

  // cloudflare cdn-cgi/trace: ip=... / loc=US / colo=SFO
  const cfIp = body.match(/(?:^|\n)ip=([0-9a-fA-F:.]+)/);
  if (cfIp?.[1]) ip = cfIp[1];
  const cfLoc = body.match(/(?:^|\n)loc=([A-Z]{2})/);
  if (cfLoc?.[1]) country = cfLoc[1];

  try {
    if (/json/i.test(contentType || '') || body.trim().startsWith('{')) {
      const j = JSON.parse(body);
      if (!ip) {
        if (j.ip) ip = String(j.ip);
        else if (j.origin) ip = String(j.origin).split(',')[0].trim();
        else if (j.query) ip = String(j.query);
      }
      country = country || j.country_code || j.countryCode || j.country || null;
      region = j.region || j.regionName || j.region_name || null;
      city = j.city || null;
      org = j.org || j.isp || j.as || null;
      if (typeof country === 'string' && country.length > 3 && j.country_name) {
        // ipwho/ipapi style: country is full name
        country = j.country_code || j.countryCode || country;
      }
    }
  } catch (_) { /* ignore */ }

  if (!ip) {
    const plain = body.trim();
    if (/^[0-9a-fA-F:.]+$/.test(plain)) ip = plain;
  }
  return { ip, country, region, city, org };
}

function formatRegion({ country, region, city, org }) {
  const parts = [];
  if (city) parts.push(String(city));
  if (region && String(region) !== String(city)) parts.push(String(region));
  if (country) parts.push(String(country));
  let s = parts.filter(Boolean).join(', ');
  if (org) s = s ? `${s} · ${org}` : String(org);
  return s || null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
      credentials: 'omit',
      redirect: 'follow'
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text,
      contentType: res.headers.get('content-type') || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

// Enrich IP with city/region/ISP via free HTTPS geo APIs (best-effort).
async function lookupIpGeo(ip) {
  if (!ip) return null;
  const urls = [
    `https://ipwho.is/${encodeURIComponent(ip)}`,
    `https://ipapi.co/${encodeURIComponent(ip)}/json/`
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, 8000);
      if (!res.ok) continue;
      const j = JSON.parse(res.text);
      // ipwho.is uses success:false on error
      if (j && j.success === false) continue;
      if (j && j.error) continue;
      const country = j.country_code || j.countryCode || j.country || null;
      const region = j.region || j.regionName || j.region_name || null;
      const city = j.city || null;
      const org = j.org || j.isp || j.connection?.isp || j.as || null;
      const label = formatRegion({ country, region, city, org });
      if (label) return { country, region, city, org, label };
    } catch (_) { /* try next */ }
  }
  return null;
}

// Temporarily apply form proxy, measure latency + exit IP/region, then restore saved proxy.
async function testProxyConnection(rawForm) {
  const cfg = readProxyConfig({ ...rawForm, proxyEnabled: true });
  const invalid = validateProxyConfig(cfg);
  if (invalid) return { ok: false, error: invalid };

  const prev = await chrome.storage.local.get([
    'proxyEnabled', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername', 'proxyPassword'
  ]);

  // Primary: Cloudflare trace (ip + country). Fallbacks if blocked.
  const TEST_URLS = [
    { url: 'https://www.cloudflare.com/cdn-cgi/trace', label: 'cloudflare' },
    { url: 'https://api.ipify.org?format=json', label: 'ipify' },
    { url: 'https://www.msftconnecttest.com/connecttest.txt', label: 'msft' }
  ];
  const TIMEOUT_MS = 12000;
  const context = chrome.extension?.inIncognitoContext ? '无痕' : '普通';

  try {
    setProxyAuth(cfg);
    const applied = await setBrowserProxy(cfg);
    if (!applied.ok) {
      let err = applied.error || '无法应用代理设置';
      if (/incognito|regular settings/i.test(err)) {
        err = `${err}（当前为${context}模式，已按上下文选择代理作用域仍失败）`;
      }
      return { ok: false, error: err };
    }
    // Give chrome.proxy a brief moment to take effect.
    await sleep(400);

    let lastError = '全部探测地址均失败';
    for (const item of TEST_URLS) {
      const started = Date.now();
      try {
        const res = await fetchWithTimeout(item.url, TIMEOUT_MS);
        const latencyMs = Date.now() - started;
        if (!res.ok && res.status >= 500) {
          lastError = `${item.label} HTTP ${res.status}`;
          continue;
        }
        if (!res.ok && res.status !== 0) {
          if (res.status === 403 || res.status === 401) {
            const probe = parseExitProbe(res.text, res.contentType);
            let region = formatRegion(probe);
            if (probe.ip && !probe.city) {
              const geo = await lookupIpGeo(probe.ip);
              if (geo?.label) region = geo.label;
            }
            return {
              ok: true,
              latencyMs,
              ip: probe.ip,
              region,
              url: item.label,
              context,
              note: `HTTP ${res.status}（代理已通，探测站拒绝）`
            };
          }
          lastError = `${item.label} HTTP ${res.status}`;
          continue;
        }
        const probe = parseExitProbe(res.text, res.contentType);
        let region = formatRegion(probe);
        // Cloudflare only gives country code — look up city/region/ISP.
        if (probe.ip && (!probe.city || !probe.region)) {
          const geo = await lookupIpGeo(probe.ip);
          if (geo?.label) region = geo.label;
        }
        return {
          ok: true,
          latencyMs,
          ip: probe.ip,
          region,
          url: item.label,
          context
        };
      } catch (e) {
        const name = e?.name || '';
        const msg = e?.message || String(e);
        if (name === 'AbortError') {
          lastError = `${item.label} 超时（>${TIMEOUT_MS}ms）`;
        } else {
          lastError = `${item.label}: ${msg}`;
        }
      }
    }
    return { ok: false, error: lastError };
  } finally {
    try {
      await applyProxyFromStorage(prev);
    } catch (e) {
      console.warn('[proxy] restore after test failed:', e?.message || e);
    }
  }
}

/**
 * After SW cold start / window crash: rehydrate batch state.
 * If a batch was running but the auth tab is gone, force paused so user can click 继续.
 */
async function recoverInterruptedBatch() {
  const d = await chrome.storage.local.get([
    'sw_queue', 'sw_current', 'sw_tabId', 'sw_results',
    'sw_running', 'sw_paused', 'sw_mode', 'sw_settings', 'sw_backupEmailCursor'
  ]);
  const hasWork = !!(d.sw_current || (Array.isArray(d.sw_queue) && d.sw_queue.length > 0));
  if (!hasWork && !d.sw_running && !d.sw_paused) return;

  // Rehydrate memory from storage (SW just woke empty).
  accountsQueue = d.sw_queue || [];
  currentAccount = d.sw_current || null;
  currentTabId = d.sw_tabId || null;
  results = d.sw_results || [];
  currentMode = d.sw_mode || 'auto';
  settings = d.sw_settings || {};
  if (typeof d.sw_backupEmailCursor === 'number') backupEmailCursor = d.sw_backupEmailCursor;

  let tabAlive = false;
  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      tabAlive = true;
    } catch (_) {
      currentTabId = null;
    }
  }

  // Was running but auth tab vanished (window/tab closed) → pause, keep queue/results.
  if (d.sw_running && hasWork && !tabAlive) {
    isRunning = false;
    isPaused = true;
    markDirty();
    await saveState();
    sendLog('检测到窗口/登录页异常关闭，任务已暂停（队列与结果已保留），可点“继续”恢复', 'warning');
    return;
  }

  // Storage already paused, or orphaned work with neither flag (legacy tab-close bug).
  if (hasWork && (d.sw_paused || (!d.sw_running && !d.sw_paused))) {
    isRunning = false;
    isPaused = true;
    markDirty();
    await saveState();
    if (!d.sw_paused) {
      sendLog('检测到未完成任务，已切换为暂停，可点“继续”恢复', 'warning');
    }
    return;
  }

  // Running and tab still there — restore flags in memory.
  if (d.sw_running && hasWork && tabAlive) {
    isRunning = true;
    isPaused = false;
    return;
  }

  // Stale running/paused flags with no work.
  if (!hasWork && (d.sw_running || d.sw_paused)) {
    isRunning = false;
    isPaused = false;
    currentAccount = null;
    accountsQueue = [];
    currentTabId = null;
    markDirty();
    await saveState();
  }
}

/** Re-check auth tab; if batch was running but tab is gone, force paused. */
async function ensureTaskStateConsistent() {
  if (!isRunning && !isPaused && !currentAccount && accountsQueue.length === 0) {
    await loadState();
  }
  const hasWork = !!(currentAccount || accountsQueue.length > 0);
  if (!hasWork) return;

  let tabAlive = false;
  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      tabAlive = true;
    } catch (_) {
      currentTabId = null;
    }
  }

  if (isRunning && !tabAlive) {
    isRunning = false;
    isPaused = true;
    markDirty();
    await saveState();
    sendLog('登录页面已不存在，任务已暂停，可点“继续”恢复', 'warning');
  } else if (!isRunning && !isPaused && hasWork) {
    isPaused = true;
    markDirty();
    await saveState();
  }
}

function buildTaskStatus() {
  const hasWork = !!(currentAccount || accountsQueue.length > 0);
  return {
    running: !!isRunning,
    paused: !!isPaused,
    hasWork,
    account: currentAccount?.email || null,
    queueLen: accountsQueue.length,
    results,
    done: results.length,
    total: results.length + accountsQueue.length + (currentAccount ? 1 : 0)
  };
}

// Re-apply saved proxy when SW wakes / extension loads; recover interrupted batch.
(async () => {
  try {
    await applyProxyFromStorage();
  } catch (e) {
    console.warn('[proxy] startup apply failed:', e?.message || e);
  }
  try {
    await recoverInterruptedBatch();
  } catch (e) {
    console.warn('[recover] interrupted batch recovery failed:', e?.message || e);
  }
})();

// ============== Message Handler ==============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  loadState().then(async () => {
    switch (msg.action) {
      case 'applyProxySettings': {
        const result = await applyProxyFromStorage();
        sendResponse(result);
        return;
      }
      case 'testProxyConnection': {
        const result = await testProxyConnection(msg.proxy || {});
        sendResponse(result);
        return;
      }
      case 'getTaskStatus': {
        await ensureTaskStateConsistent();
        sendResponse(buildTaskStatus());
        return;
      }
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
      case 'skipToNextAccount':
        await skipToNextAccount(msg.reason || '用户手动切换到下一个账号');
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
      case 'pageErrorRecover':
        // Content already sustained anomaly ≥3s before sending; recover immediately.
        await recoverFromPageError(msg.reason || 'content-detect', {
          tabId: sender?.tab?.id,
          url: msg.url || sender?.tab?.url || ''
        });
        break;
      case 'progressHeartbeat':
        // Content marks automation progress / healthy login UI → cancel soft blank.
        markProgress();
        if (sender?.tab?.id != null) clearPageAnomalyWatch(sender.tab.id);
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
        markProgress();
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
      case 'matchMaskedEmail': {
        const masked = String(msg.maskedEmail || '').replace(/\s+/g, '');
        const at = masked.indexOf('@');
        let matched = null;
        if (at > 0) {
          const maskLocal = masked.slice(0, at);
          const maskDomain = masked.slice(at + 1);
          // 优先读 options 最新配置，再回落到内存 settings
          const live = await chrome.storage.local.get(['backupEmailList', 'backupEmail', 'backupEmailMode']);
          let list = parseFixedBackupList(live);
          if (!list.length) list = parseFixedBackupList(settings);
          const prefix = maskLocal.replace(/\*/g, '').toLowerCase();
          const pureDomain = maskDomain.toLowerCase();
          sendLog(`[匹配] 池 ${list.length} 个，掩码前缀 '${prefix}'，域名 '${pureDomain}'`, 'info');
          if (prefix) {
            for (const e of list) {
              const email = String(e || '').trim();
              const i = email.indexOf('@');
              if (i <= 0) continue;
              const local = email.slice(0, i).toLowerCase();
              const domain = email.slice(i + 1).toLowerCase();
              if (domain === pureDomain && local.startsWith(prefix)) {
                matched = email;
                break;
              }
            }
          }
          // 命中后写回当前账号，确保后续接码 API 用对地址
          if (matched && currentAccount) {
            currentAccount.backupEmail = matched;
            markProgress();
            await saveState();
            sendLog(`[匹配] 已将当前账号备用邮箱更新为 ${matched}`, 'success');
          } else if (!matched) {
            sendLog(`[匹配] 未找到与 ${masked} 匹配的备用邮箱`, 'warning');
          }
        }
        sendResponse(matched);
        break;
      }
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
    if (tabId !== currentTabId || !currentAccount) return;

    // Navigation start / URL change = live hop (email→password etc.). Cancel soft blank.
    if (changeInfo.status === 'loading' || changeInfo.url) {
      lastNavAt = Date.now();
      markProgress();
      clearPageAnomalyWatch(tabId);
    }

    // Detect SSL / network error interstitials after load completes (or when title changes).
    if (changeInfo.status === 'complete' || changeInfo.title) {
      maybeProbeErrorPage(
        tabId,
        tab?.url || changeInfo.url || '',
        tab?.title || changeInfo.title || '',
        changeInfo.status === 'complete'
      ).catch(() => {});
    }

    const url = changeInfo.url || tab.url;
    if (!url || !url.includes('nativeclient')) return;

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
          }, humanDelay(STEP4_AUTO_DELAY_MS, 400));
        } else {
          sendLog(`[${currentAccount.email}] ✅ 授权码已就绪，请点击“步骤 4”获取令牌`, 'success');
        }
      }
    } catch (_) {}
  });
});

// Top-frame navigation committed → live hop; soft blank must wait out grace.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.tabId !== currentTabId) return;
  lastNavAt = Date.now();
  markProgress();
  clearPageAnomalyWatch(details.tabId);
});

// Network / SSL failures (content scripts often cannot run on chrome-error pages).
// Only recover after the error has stayed continuous for PAGE_ANOMALY_SUSTAIN_MS.
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  loadState().then(async () => {
    if (isPaused || !isRunning) return;
    if (details.tabId !== currentTabId || !currentAccount) return;
    const err = String(details.error || '');
    // Ignore aborted/cancelled navigations (we often cancel when switching accounts).
    if (/ERR_ABORTED/i.test(err)) return;
    if (!isLikelyPageError(err, details.url || '', '')) return;
    await notePageAnomaly(err || 'webNavigation-error', {
      tabId: details.tabId,
      url: details.url || '',
      hard: true
    });
  }).catch(() => {});
});

function isLikelyPageError(errorText, url, title) {
  const blob = `${errorText || ''} ${url || ''} ${title || ''}`.toLowerCase();
  if (/chrome-error:\/\/|chromewebdata/i.test(blob)) return true;
  if (/err_ssl|err_connection|err_timed_out|err_name_not_resolved|err_network|err_tunnel|err_proxy|err_cert|err_empty_response|err_connection_reset|err_connection_closed|err_connection_refused|err_internet_disconnected|err_address_unreachable|err_ssl_protocol_error|err_ssl_version|err_bad_ssl|err_http2|dns_probe|net::err_/i.test(blob)) return true;
  if (/无法提供安全连接|此网站无法提供安全连接|安全连接|响应无效|无法访问此网站|网页无法打开|连接已重置|连接超时|暂时无法访问|没有互联网连接|privacy error|your connection is not private|this site can.?t (be reached|provide a secure connection)|err_ssl_protocol_error/i.test(blob)) return true;
  return false;
}

function isMsAuthRelatedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = (u.hostname || '').toLowerCase();
    return (
      h.includes('login.live.com') ||
      h.includes('login.microsoftonline.com') ||
      h.includes('account.live.com') ||
      h.includes('account.microsoft.com') ||
      h.includes('microsoft.com') ||
      h.includes('live.com') ||
      h.includes('office.com') ||
      h.includes('outlook.') ||
      url.startsWith('chrome-error://')
    );
  } catch (_) {
    return /login\.live|microsoftonline|chrome-error/i.test(String(url));
  }
}

/**
 * Start / refresh anomaly sustain watch.
 * hard=true  → SSL/network error: recover after continuous ≥3s
 * hard=false → soft blank: only if task stuck ≥ PAGE_STUCK_MS, then continuous ≥3s
 */
async function notePageAnomaly(reason, { tabId, url, hard = true } = {}) {
  if (isPaused || !isRunning || !currentAccount) return;
  if (tabId != null && currentTabId != null && tabId !== currentTabId) return;
  // Don't interrupt a successful token exchange.
  if (currentAccount.isFetchingToken || step4Lock || currentAccount.pendingAuthCode) return;
  // Ignore noise while recovery navigation is still settling.
  if (Date.now() < pageRecoverInFlightUntil) return;

  // Soft blank: only when task stuck AND not mid email→password (etc.) navigation.
  if (!hard) {
    if (!isTaskStuck() || isInNavGrace()) {
      clearPageAnomalyWatch(tabId != null ? tabId : currentTabId);
      return;
    }
  }

  const tid = tabId != null ? tabId : currentTabId;
  if (tid == null) return;

  const now = Date.now();
  let watch = pageAnomalyWatch.get(tid);
  if (!watch) {
    watch = { firstSeenAt: now, reason, url: url || '', lastLogAt: 0, hard: !!hard, timer: null };
    pageAnomalyWatch.set(tid, watch);
  } else {
    watch.reason = reason || watch.reason;
    if (url) watch.url = url;
    // Once hard error is seen, keep hard.
    if (hard) watch.hard = true;
  }

  const sustained = now - watch.firstSeenAt;
  if (sustained < PAGE_ANOMALY_SUSTAIN_MS) {
    if (now - watch.lastLogAt > 2000) {
      watch.lastLogAt = now;
      const email = currentAccount.email || 'unknown';
      sendLog(
        watch.hard
          ? `[${email}] 检测到错误页，持续观察中 (${Math.round(sustained / 100) / 10}s / ${PAGE_ANOMALY_SUSTAIN_MS / 1000}s)…`
          : `[${email}] 任务卡住且页面异常（非正常登录页），持续观察中 (${Math.round(sustained / 100) / 10}s / ${PAGE_ANOMALY_SUSTAIN_MS / 1000}s)…`,
        'warning'
      );
    }
    // Re-arm: webNavigation / onUpdated may not fire again while stuck on error page.
    if (watch.timer) clearTimeout(watch.timer);
    const remain = Math.max(200, PAGE_ANOMALY_SUSTAIN_MS - sustained + 50);
    watch.timer = setTimeout(() => {
      const w = pageAnomalyWatch.get(tid);
      if (!w) return;
      notePageAnomaly(w.reason, { tabId: tid, url: w.url, hard: w.hard }).catch(() => {});
    }, remain);
    return;
  }

  if (watch.timer) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  pageAnomalyWatch.delete(tid);
  await recoverFromPageError(reason || watch.reason, { tabId: tid, url: url || watch.url });
}

function clearPageAnomalyWatch(tabId) {
  if (tabId == null) return;
  const w = pageAnomalyWatch.get(tabId);
  if (w?.timer) clearTimeout(w.timer);
  pageAnomalyWatch.delete(tabId);
}

async function maybeProbeErrorPage(tabId, url, title, statusComplete = false) {
  if (isPaused || !isRunning || tabId !== currentTabId || !currentAccount) return;
  if (title && isLikelyPageError('', url, title)) {
    await notePageAnomaly(`title:${title}`, { tabId, url, hard: true });
    return;
  }
  // Only probe MS / error-related tabs to avoid random page noise.
  if (url && !isMsAuthRelatedUrl(url) && !isLikelyPageError('', url, title || '')) return;

  let probe = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        try {
          const body = (document.body?.innerText || document.documentElement?.innerText || '').slice(0, 2500);
          const html = (document.documentElement?.outerHTML || '').slice(0, 2000);
          const href = location.href || '';
          // Any interactive control means a normal login step (not blank).
          const hasUi = !!(
            document.querySelector(
              'input[name="loginfmt"], input[name="passwd"], input[type="password"], input[type="email"], ' +
              '#i0116, #i0118, #idSIButton9, #otc, input[name="otc"], #proofConfirmationText, ' +
              'input[name="ProofConfirmation"], input[name="EmailAddress"], input[type="text"], ' +
              'textarea, button, input[type="submit"], input[type="button"], [role="button"], ' +
              '#msaTile, #idBtn_Back, #idBtn_Accept, form'
            )
          );
          const ready = document.readyState || '';
          return { body, html, href, title: document.title || '', hasUi, ready };
        } catch (e) {
          return { body: '', html: '', href: location?.href || '', title: document?.title || '', hasUi: false, ready: '', err: String(e) };
        }
      }
    });
    probe = results?.[0]?.result || null;
  } catch (_) {
    // executeScript often fails on chrome-error:// pages — treat as hard recoverable error.
    if (isLikelyPageError('', url, title) || /^chrome-error:/i.test(url || '')) {
      await notePageAnomaly('probe-inject-failed', { tabId, url, hard: true });
    }
    return;
  }

  if (!probe) return;
  const text = `${probe.title || ''} ${probe.body || ''} ${probe.html || ''} ${probe.href || ''}`;
  if (!isLikelyPageError(text, probe.href || url, probe.title || title)) {
    // Soft blank: complete load + past nav grace + MS host + no UI + almost no text + task stuck.
    const bare = String(probe.body || '').replace(/\s+/g, ' ').trim();
    const hostOk = isMsAuthRelatedUrl(probe.href || url);
    const hasLoginUi = !!probe.hasUi ||
      /loginfmt|passwd|type="password"|i0116|i0118|idSIButton9|otc|proof|验证码|sign in|登录|输入你的密码|输入密码|password|邮箱|email|验证你的|帐户|账户|keep me signed|保持登录/i.test(
        `${probe.html || ''} ${probe.body || ''} ${probe.title || ''}`
      );
    // Any recognizable login UI or meaningful copy = healthy (cancel blank watch).
    if (hasLoginUi || bare.length >= 40) {
      clearPageAnomalyWatch(tabId);
      markProgress();
      return;
    }
    // Mid-navigation or still loading — never soft-blank.
    if (!statusComplete || isInNavGrace() || (probe.ready && probe.ready !== 'complete')) {
      clearPageAnomalyWatch(tabId);
      return;
    }
    if (hostOk && bare.length < 40 && isTaskStuck()) {
      await notePageAnomaly('blank-stuck', { tabId, url: probe.href || url, hard: false });
      return;
    }
    clearPageAnomalyWatch(tabId);
    return;
  }
  await notePageAnomaly(probe.title || 'content-error-page', { tabId, url: probe.href || url, hard: true });
}

/** Hard SSL/network errors should re-run the whole account, not blank-hop. */
function isHardNetworkError(reason) {
  const s = String(reason || '');
  return /ERR_SSL|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT|ERR_NETWORK|ERR_TUNNEL|ERR_PROXY|ERR_CERT|ERR_EMPTY|ERR_INTERNET|ERR_ADDRESS|ERR_HTTP2|chrome-error|无法提供安全连接|安全连接|响应无效|title:.*安全|probe-inject-failed|content-error-page|webNavigation-error|too\s*many\s*requests|请求过多|rate\s*limit|throttl|http\s*429/i.test(s);
}

/**
 * Skip current account after a hard SSL/proxy error (no re-open auth page).
 */
async function skipAccountOnHardError(reason) {
  if (!currentAccount) return;
  const email = currentAccount.email || 'unknown';
  const shortReason = String(reason || 'unknown').slice(0, 100);
  const password = currentAccount.password;
  const clientId = currentAccount.clientId;
  const backupEmail = currentAccount.backupEmail;

  clearPageAnomalyWatch(currentTabId);
  pageRecoverInFlightUntil = Date.now() + 8000;
  step4Lock = false;
  lastAuthUrl = null;
  pageRecoverAttempts.delete(email);
  pageFullRerunCount.delete(email);

  if (currentTabId) {
    const tabToClose = currentTabId;
    currentTabId = null;
    try { await chrome.tabs.remove(tabToClose); } catch (_) {}
  }

  sendLog(
    `[${email}] ⚠️ 硬网络/SSL 错误，直接跳过该账号（${shortReason}；请检查代理/网络）`,
    'error'
  );
  await finishAccount({
    success: false,
    email,
    password,
    clientId,
    backupEmail,
    error: `页面异常(硬错误跳过): ${shortReason}`
  });
}

/**
 * Re-run current account from step 1, or skip if already re-ran.
 * Used for soft blank / stuck pages that may recover after a clean reopen.
 */
async function fullRerunCurrentAccount(reason) {
  if (!currentAccount) return;
  const email = currentAccount.email || 'unknown';
  const shortReason = String(reason || 'unknown').slice(0, 100);
  const used = pageFullRerunCount.get(email) || 0;

  clearPageAnomalyWatch(currentTabId);
  pageRecoverInFlightUntil = Date.now() + 8000;
  step4Lock = false;
  lastAuthUrl = null;
  pageRecoverAttempts.delete(email);

  // Close broken error tab first.
  if (currentTabId) {
    const tabToClose = currentTabId;
    currentTabId = null;
    try { await chrome.tabs.remove(tabToClose); } catch (_) {}
  }

  if (used < PAGE_FULL_RERUN_MAX) {
    pageFullRerunCount.set(email, used + 1);

    const requeue = {
      email: currentAccount.email,
      password: currentAccount.password,
      backupEmail: currentAccount.backupEmail || undefined
    };
    if (!(accountsQueue[0] && accountsQueue[0].email === requeue.email)) {
      accountsQueue.unshift(requeue);
    }
    currentAccount = null;
    markDirty();
    await saveState();

    try {
      await clearMicrosoftSession({ quiet: true, closeTab: false, dropPkce: true });
    } catch (_) {}

    sendLog(
      `[${email}] 检测到页面异常（${shortReason}），整任务从步骤1重跑 (${used + 1}/${PAGE_FULL_RERUN_MAX})…`,
      'warning'
    );
    // Reset step UI so side panel doesn't stay on stale 3/4 completed.
    broadcastStep(1, 'pending', email);
    broadcastStep(2, 'pending', email);
    broadcastStep(3, 'pending', email);
    broadcastStep(4, 'pending', email);

    isRunning = true;
    isPaused = false;
    scheduleAdvance(humanDelay(2000, 600));
    return;
  }

  sendLog(
    `[${email}] ⚠️ 整任务重跑后仍异常，跳过该账号（${shortReason}；请检查代理/网络）`,
    'error'
  );
  await finishAccount({
    success: false,
    email,
    password: currentAccount.password,
    clientId: currentAccount.clientId,
    backupEmail: currentAccount.backupEmail,
    error: `页面异常(已重跑): ${shortReason}`
  });
}

/**
 * Recover from SSL / blank / network error pages.
 * Hard SSL/proxy → skip account immediately (reopening auth rarely helps).
 * Soft blank → at most PAGE_RECOVER_MAX blank hops, then full re-run once.
 */
async function recoverFromPageError(reason, { tabId, url } = {}) {
  if (isPaused || !isRunning || !currentAccount) return;
  if (tabId != null && currentTabId != null && tabId !== currentTabId) return;

  const email = currentAccount.email || 'unknown';
  if (currentAccount.isFetchingToken || step4Lock || currentAccount.pendingAuthCode) return;

  const now = Date.now();
  if (now < pageRecoverInFlightUntil) return;

  const prev = pageRecoverAttempts.get(email) || { count: 0, lastAt: 0 };
  if (now - prev.lastAt < PAGE_RECOVER_COOLDOWN_MS) return;

  const hard = isHardNetworkError(reason);
  clearPageAnomalyWatch(currentTabId || tabId);
  markProgress();

  // Hard SSL/proxy: skip immediately — reopening auth on same network almost always fails again.
  if (hard) {
    pageRecoverAttempts.set(email, { count: PAGE_RECOVER_MAX + 1, lastAt: now });
    pageRecoverInFlightUntil = Date.now() + 8000;
    sendLog(`[${email}] 硬错误页，直接跳过: ${String(reason || '').slice(0, 100)}`, 'warning');
    await skipAccountOnHardError(reason);
    return;
  }

  // Soft blank: limited in-page recover, then full re-run.
  if (prev.count >= PAGE_RECOVER_MAX) {
    if (prev.count === PAGE_RECOVER_MAX) {
      pageRecoverAttempts.set(email, { count: prev.count + 1, lastAt: now });
      await fullRerunCurrentAccount(reason || 'blank-stuck');
    }
    return;
  }

  const attempt = prev.count + 1;
  pageRecoverAttempts.set(email, { count: attempt, lastAt: now });
  const shortReason = String(reason || 'unknown').slice(0, 120);
  sendLog(`[${email}] 疑似白屏，尝试页内恢复 (${attempt}/${PAGE_RECOVER_MAX}): ${shortReason}`, 'warning');
  pageRecoverInFlightUntil = Date.now() + 4500;

  const target = lastAuthUrl;
  const tid = currentTabId || tabId;

  try {
    if (tid != null && target) {
      await chrome.tabs.get(tid);
      await chrome.tabs.update(tid, { url: 'about:blank', active: true });
      await sleep(humanDelay(350, 150));
      await chrome.tabs.update(tid, { url: target, active: true });
      sendLog(`[${email}] 已强制重新打开授权页（跳过表单重提）`, 'info');
      pageRecoverInFlightUntil = Date.now() + 4000;
      return;
    }
  } catch (_) {
    currentTabId = null;
  }

  try {
    await executeStep1();
    pageRecoverInFlightUntil = Date.now() + 4000;
  } catch (e) {
    sendLog(`[${email}] 页内恢复失败，改为整任务重跑: ${e.message || e}`, 'warning');
    await fullRerunCurrentAccount(e.message || reason);
  }
}

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
  markProgress();

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = getRandomState();
  const authUrl = buildAuthUrl(clientId, codeChallenge, state);
  lastAuthUrl = authUrl;
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
  }, humanDelay(AUTH_UI_READY_MS, 500));
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
      scheduleAdvance(500);
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
      // Do not loadState here — it can resurrect a just-cleared currentAccount / unshifted queue.
      if (results.some((r) => r.success && r.email === snap.email && r.token)) {
        sendLog(`[${snap.email}] 忽略过期授权码错误（令牌已成功获取）`, 'info');
        if (!currentAccount && !isPaused && isRunning) {
          scheduleAdvance(500);
        }
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
      markDirty();
      await saveState();
      return;
    }
    // Keep queue / current / results — enter paused so user can click 继续.
    currentTabId = null;
    isRunning = false;
    isPaused = true;
    markDirty();
    await saveState();
    sendLog('登录页面被关闭，任务已暂停（可点“继续”恢复）', 'warning');
    broadcastToPopup({
      type: 'paused',
      resumable: true,
      account: currentAccount?.email || null,
      remaining: accountsQueue.length + (currentAccount ? 1 : 0)
    });
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
  accountsSinceCleanup = 0;
  lastAuthUrl = null;
  pageRecoverAttempts.clear();
  pageFullRerunCount.clear();
  for (const w of pageAnomalyWatch.values()) {
    if (w?.timer) clearTimeout(w.timer);
  }
  pageAnomalyWatch.clear();
  markProgress();
  markDirty();
  if (currentTabId) { chrome.tabs.remove(currentTabId).catch(() => {}); currentTabId = null; }

  accountsQueue = accounts.map(a => {
    const p = a.split(/----|:|\|/);
    return { email: p[0]?.trim(), password: p[1]?.trim() };
  }).filter(a => a.email && a.password);
  markDirty();

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
        setTimeout(() => { executeStep4().catch(() => {}); }, humanDelay(STEP4_AUTO_DELAY_MS, 400));
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
  // On SW cold start memory is empty — restore once. While a batch is live in
  // memory, never loadState here: concurrent handlers' loadState can otherwise
  // resurrect a just-shifted account and spam "本批已成功，跳过".
  if (!isRunning && accountsQueue.length === 0 && !currentAccount) {
    await loadState();
  }
  if (isPaused) return;
  if (!isRunning) return;

  // Drain any already-succeeded accounts without tight setTimeout loops.
  while (accountsQueue.length > 0) {
    const head = accountsQueue[0];
    if (results.some((r) => r.success && r.email === head.email && r.token)) {
      accountsQueue.shift();
      markDirty();
      sendLog(`[${head.email}] 本批已成功，跳过`, 'info');
      continue;
    }
    break;
  }
  // Persist queue after draining so loadState cannot restore stale heads.
  await saveState();

  if (accountsQueue.length === 0) {
    isRunning = false;
    isPaused = false;
    currentAccount = null;
    markDirty();
    await saveState();
    broadcastToPopup({ type: 'finished', results: results });
    chrome.storage.local.set({ sw_running: false, sw_paused: false });
    sendLog('所有账号已处理完毕！', 'success');
    await chrome.storage.local.remove(['sw_running', 'sw_paused', 'sw_current', 'sw_tabId', 'sw_queue']);
    return;
  }

  const account = accountsQueue.shift();
  // Save immediately after shift so any concurrent loadState sees the shorter queue.
  currentAccount = null;
  markDirty();
  await saveState();

  const clientId = getClientId();
  // Refresh settings so multi-list edits from options take effect mid-batch.
  const live = await chrome.storage.local.get([
    'backupEmail', 'backupEmailList', 'backupEmailMode', 'backupEmailDomain',
    'clientIdMode', 'customClientId', 'tempEmailEnabled', 'tempEmailApiUrl',
    'tempEmailAdminPassword', 'apiMode'
  ]);
  // Re-load queue/current only if another path mutated storage mid-await — but keep our shift.
  // Prefer memory for queue/current; only merge settings from live.
  settings = { ...settings, ...live };
  // Prefer backup already bound to this account (e.g. full-task re-run); else pick next.
  const backupEmail = account.backupEmail || resolveBackupEmail(settings);
  currentAccount = { ...account, clientId, backupEmail };
  step4Lock = false;
  markProgress();
  pageRecoverInFlightUntil = 0;
  clearPageAnomalyWatch(currentTabId);
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
  lastAuthUrl = authUrl;
  // Fresh account → allow a new recovery budget.
  pageRecoverAttempts.delete(account.email);

  const key = account.email + '_' + clientId;
  await chrome.storage.local.set({ [`pkce_${key}`]: { codeVerifier, state } });
  await saveState();

  if (currentMode === 'step-by-step') {
    sendLog(`[${account.email}] 📝 逐步骤模式：点击"步骤 2"圆圈开始自动登录`, 'warning');
  }

  const params = { url: authUrl };
  if (currentTabId) {
    try {
      await chrome.tabs.get(currentTabId);
      chrome.tabs.update(currentTabId, { url: authUrl });
    } catch (_) {
      currentTabId = null;
      chrome.tabs.create(params, tab => { currentTabId = tab.id; saveState(); });
    }
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
  }, humanDelay(AUTH_UI_READY_MS + 500, 600));
}

// ============== Microsoft / Outlook session cleanup ==============
function profileLabel() {
  try {
    return chrome.extension?.inIncognitoContext ? '无痕模式' : '普通模式';
  } catch (_) {
    return '当前配置';
  }
}

function isMsCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  return MS_COOKIE_DOMAIN_SUFFIXES.some((s) => d === s || d.endsWith('.' + s));
}

/**
 * Clear MS cookies / site data.
 * closeTab=false keeps the current auth tab (used during SSL recovery mid-account).
 * dropPkce=false keeps PKCE so the same authorize URL can still exchange tokens.
 */
async function clearMicrosoftSession({ quiet = false, closeTab = false, dropPkce = false } = {}) {
  const label = profileLabel();
  if (!quiet) {
    sendLog(`🧹 [${label}] 清理 Outlook/Microsoft 登录缓存...`, 'warning');
  }

  if (closeTab && currentTabId) {
    const tabToClose = currentTabId;
    currentTabId = null;
    try { await chrome.tabs.remove(tabToClose); } catch (_) {}
  }

  let cookieCount = 0;
  try {
    const all = await chrome.cookies.getAll({});
    const targets = all.filter((c) => isMsCookieDomain(c.domain));
    await Promise.all(targets.map((c) => {
      const protocol = c.secure ? 'https:' : 'http:';
      const host = (c.domain || '').startsWith('.') ? c.domain.slice(1) : c.domain;
      const url = `${protocol}//${host}${c.path || '/'}`;
      const opts = { url, name: c.name };
      if (c.storeId) opts.storeId = c.storeId;
      return chrome.cookies.remove(opts).catch(() => null);
    }));
    cookieCount = targets.length;
  } catch (e) {
    if (!quiet) sendLog(`[${label}] Cookie 清理失败: ${e.message || e}`, 'warning');
  }

  try {
    await chrome.browsingData.remove(
      { origins: MS_BROWSING_ORIGINS },
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        cacheStorage: true,
        serviceWorkers: true,
        fileSystems: true,
        pluginData: true,
      }
    );
  } catch (e) {
    if (!quiet) sendLog(`[${label}] browsingData 清理失败: ${e.message || e}`, 'warning');
  }

  if (dropPkce) {
    try {
      const all = await chrome.storage.local.get(null);
      const pkceKeys = Object.keys(all || {}).filter((k) => k.startsWith('pkce_'));
      if (pkceKeys.length) await chrome.storage.local.remove(pkceKeys);
    } catch (_) {}
  }

  return cookieCount;
}

async function clearOutlookSessionCache(reason = '') {
  const label = profileLabel();
  sendLog(`🧹 [${label}] 清理 Outlook/Microsoft 登录缓存${reason ? `（${reason}）` : ''}...`, 'warning');
  const cookieCount = await clearMicrosoftSession({ quiet: true, closeTab: true, dropPkce: true });
  accountsSinceCleanup = 0;
  markDirty();
  await saveState();
  sendLog(`🧹 [${label}] 缓存清理完成（Cookie ${cookieCount} 条）`, 'success');
}

/** After finishing N accounts, clear MS session before opening the next auth page. */
async function scheduleAdvance(delayMs = ADVANCE_DELAY_MS) {
  if (isPaused || !isRunning) return;
  const needClean = accountsSinceCleanup >= CLEANUP_EVERY_N;
  const wait = needClean
    ? Math.max(delayMs, humanDelay(1200, 400))
    : humanDelay(delayMs, ADVANCE_DELAY_JITTER_MS);
  setTimeout(async () => {
    if (isPaused || !isRunning) return;
    try {
      if (accountsSinceCleanup >= CLEANUP_EVERY_N) {
        await clearOutlookSessionCache(`已处理 ${accountsSinceCleanup} 个账号`);
        // Extra pause after cache clear so next login looks less bot-like.
        await new Promise((r) => setTimeout(r, humanDelay(800, 600)));
      }
    } catch (e) {
      sendLog(`缓存清理异常: ${e.message || e}`, 'warning');
    }
    if (!isPaused && isRunning) processNext();
  }, wait);
}

// ============== Manual skip to next account ==============
async function skipToNextAccount(reason = '用户手动切换到下一个账号') {
  // Prefer in-memory state; only fill gaps from storage if SW was just woken.
  if (!isRunning && !isPaused && !currentAccount && accountsQueue.length === 0) {
    await loadState();
  }
  if (!currentAccount && accountsQueue.length === 0) {
    sendLog('没有可切换的账号', 'warning');
    return;
  }

  step4Lock = false;
  const email = currentAccount?.email;

  // Close current auth tab so the next account starts clean.
  if (currentTabId) {
    const tabToClose = currentTabId;
    currentTabId = null;
    chrome.tabs.remove(tabToClose).catch(() => {});
  }

  if (currentAccount) {
    const alreadyOk = results.some((r) => r.success && r.email === currentAccount.email && r.token);
    if (!alreadyOk) {
      // Mark incomplete account as skipped (not a hard failure noise if user just wants next).
      const skipped = {
        success: false,
        email: currentAccount.email,
        password: currentAccount.password || '',
        clientId: currentAccount.clientId || '',
        backupEmail: currentAccount.backupEmail || '',
        error: reason
      };
      results = results.filter((r) => !(r.email === skipped.email && !r.success));
      results.push(skipped);
      markDirty();
      broadcastToPopup({ type: 'accountResult', result: skipped });
      sendLog(`[${skipped.email}] ⏭ ${reason}`, 'warning');
      accountsSinceCleanup += 1;
    } else {
      sendLog(`[${currentAccount.email}] ⏭ 已有成功结果，切换下一账号`, 'info');
    }
    currentAccount = null;
    markDirty();
  } else {
    sendLog(`⏭ ${reason}`, 'warning');
  }

  // Ensure running so processNext will continue (works from paused too).
  isPaused = false;
  isRunning = true;
  markDirty();
  await saveState();
  broadcastToPopup({ type: 'resumed', account: null, remaining: accountsQueue.length });
  scheduleAdvance(humanDelay(900, 400));
}

// ============== Finish Current Account ==============
async function finishAccount(result) {
  // Snapshot before any await: concurrent loadState must not resurrect a finished account.
  const saved = currentAccount;
  let shouldAdvance = false;

  if (!saved) {
    if (!result?.email) return;
    // Already finished this exact outcome — still try to advance if queue remains.
    if (results.some((r) => r.email === result.email && r.token === result.token && r.success === result.success)) {
      if (!isPaused && isRunning && !currentAccount) {
        scheduleAdvance(humanDelay(1200, 400));
      }
      return;
    }
  } else {
    currentAccount = null;
    markDirty();
    shouldAdvance = true;
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
      await saveState();
      if (!isPaused && isRunning) scheduleAdvance(500);
      return;
    }
  } else {
    // Drop any prior FAILED rows for this email in current batch display storage.
    results = results.filter((r) => !(r.email === result.email && !r.success));
    markDirty();
  }

  const lineKey = `${result.email}|${result.success}|${result.token || result.error || ''}`;
  if (results.some((r) => `${r.email}|${r.success}|${r.token || r.error || ''}` === lineKey)) {
    // Duplicate finish must still advance the queue (was the main stuck-after-success bug).
    await saveState();
    if (!isPaused && isRunning) scheduleAdvance(500);
    return;
  }

  results.push(result);
  accountsSinceCleanup += 1;
  markDirty();
  await saveState();

  if (result.success) {
    sendLog(`[${result.email}] ✅ 获取 Refresh Token 成功`, 'success');
    pageFullRerunCount.delete(result.email);
    pageRecoverAttempts.delete(result.email);
  } else {
    sendLog(`[${result.email}] ❌ 失败: ${result.error}`, 'error');
  }

  broadcastToPopup({ type: 'accountResult', result });

  if (isPaused) return;
  // Always advance after a terminal finish when still running.
  if (shouldAdvance || isRunning) {
    scheduleAdvance(ADVANCE_DELAY_MS);
  }
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
  // Wait for the new mail to arrive — immediate poll often grabs a previous code.
  sendLog('等待 3 秒后再取码（避免取到上一次的旧验证码）...', 'info');
  await new Promise(r => setTimeout(r, 3000));

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


// content.js — Outlook login + backup-email verification flow
// Step 1: background opens auth page
// Step 2: fill Outlook email/password
// Step 3: backup email (initial / re-verify) + verification code
// Step 4: background captures code and exchanges token
let currentAccount = null;
let observer = null;
let checkTimer = null;
let lastAction = '';
let lastPageKind = '';
let execMode = 'auto';
// True while fetchVerificationCode is in flight — blocks concurrent re-entry
// (MutationObserver used to re-trigger fill while the 3s wait left the box empty).
let codeFetchInFlight = false;
// Rate-limit local page-error recovery reports (background has its own cap).
let lastErrorReportAt = 0;
const ERROR_REPORT_COOLDOWN_MS = 5000;
// Only recover after continuous hard error, or blank + task stuck, for this long.
const ANOMALY_SUSTAIN_MS = 3000;
// Soft blank only after no automation progress this long (login hops need more than 3s).
const STUCK_MS = 10000;
// After pagehide / unload, ignore soft blank (email→password transition flash).
const NAV_GRACE_MS = 6000;
let anomalyFirstSeenAt = 0;
let anomalyPendingLog = false;
let lastProgressAt = Date.now();
let lastNavAt = 0;
let lastHeartbeatAt = 0;
// Slightly slower interaction pacing to reduce automation / risk-control signals.
const PAGE_CHECK_DEBOUNCE_MS = 750;
const FILL_TO_SUBMIT_MS = 1100;
const FILL_TO_SUBMIT_JITTER_MS = 400;

function humanDelay(baseMs, jitterMs = 300) {
  return baseMs + Math.floor(Math.random() * Math.max(0, jitterMs));
}

function isTopFrame() {
  try {
    return window === window.top;
  } catch (_) {
    return true;
  }
}

function markProgress() {
  lastProgressAt = Date.now();
  clearAnomalyWatch();
  // Sync progress to SW so soft-blank probe there also resets (throttle ~1.2s).
  const now = Date.now();
  if (isTopFrame() && now - lastHeartbeatAt > 1200) {
    lastHeartbeatAt = now;
    chrome.runtime.sendMessage({ action: 'progressHeartbeat' }).catch(() => {});
  }
}

function isTaskStuck() {
  return Date.now() - lastProgressAt >= STUCK_MS;
}

function isInNavGrace() {
  return lastNavAt > 0 && Date.now() - lastNavAt < NAV_GRACE_MS;
}

// Blank/error recovery only in top frame (MS pages have empty iframes that false-trigger).
if (isTopFrame()) {
  startObserver();
  setTimeout(checkPageState, 1200);
  setTimeout(detectAndRecoverErrorPage, 2000);
  setTimeout(detectAndRecoverErrorPage, 4500);
}

chrome.runtime.sendMessage({ action: 'getCurrentAccount' }, (account) => {
  if (account?.email) {
    currentAccount = account;
    markProgress();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'skipCurrentStep') handleSkip();
  if (msg.action === 'executeStep') {
    if (msg.account?.email) currentAccount = msg.account;
    markProgress();
    // Allow step 3 to run multiple times (backup email may need two passes).
    if (msg.step === 2 || msg.step === 3) {
      lastAction = '';
      lastPageKind = '';
      codeFetchInFlight = false;
    }
    if (msg.step === 2) executeStep2();
    if (msg.step === 3) executeStep3();
  }
});

function startObserver() {
  observer?.disconnect();
  observer = new MutationObserver(() => debouncedCheck());
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'type', 'value', 'hidden', 'aria-hidden']
    });
  }
}

function debouncedCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkPageState, PAGE_CHECK_DEBOUNCE_MS);
}

window.addEventListener('beforeunload', () => {
  lastNavAt = Date.now();
  markProgress();
  observer?.disconnect();
  clearTimeout(checkTimer);
});

// SPA / same-document hops and soft navigations during login.
window.addEventListener('pagehide', () => {
  lastNavAt = Date.now();
  markProgress();
});
window.addEventListener('pageshow', () => {
  lastNavAt = Date.now();
  markProgress();
});

function sendLog(message, level = 'info') {
  chrome.runtime.sendMessage({ action: 'log', message, level }).catch(() => {});
}

function pageText() {
  return document.body?.innerText || '';
}

function isVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  return el.offsetWidth > 0 &&
    el.offsetHeight > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    el.type !== 'hidden';
}

function findVisible(selector) {
  try {
    return [...document.querySelectorAll(selector)].find(isVisible) || null;
  } catch (_) {
    return null;
  }
}

function findAllVisible(selector) {
  try {
    return [...document.querySelectorAll(selector)].filter(isVisible);
  } catch (_) {
    return [];
  }
}

function typeVal(input, value) {
  if (!input) return;
  input.focus();
  // React / Fluent controlled inputs ignore plain .value= — use native setter.
  try {
    const proto = input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
  } catch (_) {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  markProgress();
}

function clickEl(element) {
  if (!element) return;
  element.focus?.();
  element.click();
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  markProgress();
}

function buttonText(el) {
  return (el?.value || el?.innerText || el?.textContent || '').trim();
}

function getSubmitButton({ sendCode = false } = {}) {
  const candidates = findAllVisible('input[type="submit"], button[type="submit"], #iNext, #idSIButton9, button, a');
  const pattern = sendCode
    ? /发送验证代码|发送验证码|send verification code|send code/i
    : /下一步|继续|next|continue|提交|submit/i;
  const matched = candidates.find((el) => pattern.test(buttonText(el)));
  if (matched) return matched;
  if (sendCode) return null;
  return findVisible('input[type="submit"], button[type="submit"], #iNext, #idSIButton9');
}

function getProofEmailInput() {
  const direct = findVisible([
    'input[name*="proofemail" i]',
    'input[id*="proofemail" i]',
    'input[name="ProofEmail"]',
    'input[id="EmailAddress"]',
    'input[id="iProofEmail"]',
    'input[type="email"]:not([name="loginfmt"])',
    'input[aria-label="电子邮件"]',
    'input[aria-label="邮箱"]',
    'input[aria-label="Email"]',
    'input[placeholder*="example.com"]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="邮箱"]',
    'input[aria-label*="电子邮件"]',
    'input[aria-label*="someone@example.com"]',
    'input[name="email"]',
    'input[id="email"]'
  ].join(', '));
  if (direct) return direct;

  const generic = findAllVisible(
    'input[type="email"], input[type="text"], input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="password"])'
  ).filter((el) => !/loginfmt|passwd|password|otc|code/i.test(`${el.name}${el.id}`));
  if (generic.length === 1) return generic[0];
  return null;
}

function looksLikeEmailInput(el) {
  if (!el) return false;
  const meta = `${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
  return el.type === 'email' ||
    /email|proofemail|电子邮件|邮箱|example\.com|@/.test(meta);
}

function looksLikeCodeInput(el) {
  if (!el || looksLikeEmailInput(el)) return false;
  const meta = `${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('aria-describedby') || ''}`.toLowerCase();
  const maxLen = Number(el.getAttribute('maxlength') || 0);
  return el.type === 'tel' ||
    el.type === 'number' ||
    maxLen === 1 ||
    maxLen === 6 ||
    /otc|code|proofconfirmation|iotttext|验证码|代码|security.?code|one-time/i.test(meta);
}

function getCodeInputs() {
  const named = findAllVisible([
    'input[name="ProofConfirmation"]',
    'input[id="iProofCode"]',
    'input[id*="OTC" i]',
    'input[name*="otc" i]',
    'input[id*="code" i]',
    'input[name*="code" i]',
    'input[id="iOttText"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="代码"]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="code" i]',
    'input[aria-label*="代码"]',
    'input[aria-label*="验证码"]',
    'input[aria-label*="code" i]'
  ].join(', ')).filter((el) => !looksLikeEmailInput(el));
  if (named.length) return named;

  // 6-digit split boxes commonly use maxlength=1 without otc/code ids.
  const digitBoxes = findAllVisible('input[maxlength="1"], input[autocomplete="one-time-code"]')
    .filter((el) => el.type !== 'password' && el.name !== 'loginfmt' && !looksLikeEmailInput(el));
  if (digitBoxes.length >= 4) return digitBoxes;

  // Modern "输入代码" page: single plain text field, no code/otc id.
  const body = pageText();
  if (/输入你的代码|输入代码|输入验证码|enter your code|enter the code|security code/i.test(body)) {
    const singles = findAllVisible(
      'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
    ).filter((el) => {
      if (looksLikeEmailInput(el) || el.name === 'loginfmt' || el.type === 'password') return false;
      if (looksLikeCodeInput(el)) return true;
      // Lone non-email text box on an enter-code page.
      return true;
    });
    if (singles.length === 1) return singles;
    // Prefer the focused / empty one if multiple.
    const empty = singles.filter((el) => !String(el.value || '').trim());
    if (empty.length === 1) return empty;
    if (singles.length) return [singles[0]];
  }

  return [];
}

// Figure 5: "验证你的电子邮件" + email field + "发送验证码".
// Must NOT be treated as a code page just because button text contains "验证码".
function isProofResendPage(body, proofInput) {
  const hasSendBtn = !!getSubmitButton({ sendCode: true });
  const hasResendCopy = /验证你的电子邮件|验证你的邮箱|发送验证代码|发送验证码|send verification code|send code|请在此处输入它|备选电子邮件|关联的备选电子邮件|这与你的帐户关联的备选电子邮件不匹配/i.test(body);
  if (!hasSendBtn && !hasResendCopy) return false;
  // Prefer a detected email field; otherwise any single non-code text/email box counts.
  if (proofInput && !looksLikeCodeInput(proofInput)) return true;
  if (hasSendBtn) {
    const candidates = findAllVisible(
      'input[type="email"], input[type="text"], input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="password"])'
    ).filter((el) => !looksLikeCodeInput(el));
    if (candidates.length === 1) return true;
  }
  return false;
}

function isProofInitialPage(body, proofInput) {
  if (!proofInput) return false;
  return /让我们来保护你的帐户|保护你的帐户|备用电子邮件|备用邮箱|添加另一种方法|安全信息|someone@example.com/i.test(body);
}

// Intermediate risk-control page: choose where to send the security code (dropdown + 下一步).
// Copy like "如果保护过度… / 我们应该将代码发送到什么地方？" — no code input yet.
function isCodeSendMethodPage(body) {
  const text = String(body || '');
  // Strong Chinese copy from the protection / channel picker page.
  if (/如果保护过度|我们可以电话联系|可以电话联系我们/i.test(text)
    && /代码发送到什么地方|将代码发送到|发送到什么地方/i.test(text)) {
    return true;
  }
  if (/我们应该将代码发送到什么地方|Where should we send (?:a |your )?code|How do you want to get (?:your )?code/i.test(text)) {
    return true;
  }
  // Dropdown "向 xxx 发送电子邮件" + "我已有验证码" without an actual code box.
  const hasChannelCopy = /向\s*\S+@\S+\s*发送(?:电子)?邮件|Send (?:an )?email to|发送电子邮件/i.test(text)
    && /我已有验证码|I (?:already )?have (?:a |the )?code/i.test(text);
  if (hasChannelCopy) {
    const codeInputs = getCodeInputs();
    const hasRealCodeBox = codeInputs.length >= 1 && (
      codeInputs.length >= 4 || codeInputs.every(looksLikeCodeInput)
    );
    if (!hasRealCodeBox && !/输入你的代码|输入代码|输入验证码|enter your code|enter the code/i.test(text)) {
      return true;
    }
  }
  return false;
}

function isCodePage(body, codeInputs, proofInput) {
  // Figure 5 re-verify page also mentions "代码/验证码"; never treat it as code entry.
  if (isProofResendPage(body, proofInput)) return false;
  // Channel picker ("where should we send the code?") is not a fillable code page.
  if (isCodeSendMethodPage(body)) return false;
  // Expired-code banner means backup email already verified — not a fillable code page.
  if (isCodeExpiredPage(body)) return false;

  // Real digit boxes / OTC inputs only.
  if (codeInputs.length >= 4) return true;
  if (codeInputs.length >= 1 && codeInputs.every(looksLikeCodeInput)) return true;

  // Strong enter-code phrases. Bare "验证码" alone is too weak (appears on "发送验证码").
  if (/输入你的代码|输入代码|输入验证码|安全代码|enter your code|enter the code|security code|如果 .+ 与你帐户上的电子邮件地址匹配/i.test(body)) {
    // If the only visible field is clearly an email field, still not a code page.
    if (proofInput && looksLikeEmailInput(proofInput) && !codeInputs.length) return false;
    return true;
  }
  return false;
}

// After backup email is bound, Microsoft may show "enter code" again with a red
// banner that previous codes expired — treat as verified, reopen OAuth auth page.
function isCodeExpiredPage(body) {
  return /所有以前的代码都已失效|请申请新的安全代码|previous codes? (have )?expired|request a new security code|ask for a new security code|codes? (are|have been) (no longer valid|invalid)/i.test(body);
}

function reopenAuthAfterBackupVerified(source = '自动') {
  if (lastAction === 'code-expired-reauth') return;
  lastAction = 'code-expired-reauth';
  sendLog(`${source}：检测到旧验证码已失效（备用邮箱已验证成功），正在重开授权页...`, 'success');
  chrome.runtime.sendMessage({ action: 'reopenAuth', reason: 'backup-verified' }).catch(() => {});
}

function resolveProofInput(preferred) {
  if (preferred && !looksLikeCodeInput(preferred)) return preferred;
  const candidates = findAllVisible(
    'input[type="email"], input[type="text"], input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="password"])'
  ).filter((el) => !looksLikeCodeInput(el));
  return candidates[0] || preferred || null;
}

function findCancelButton() {
  // Prefer explicit cancel controls on passkey / security-key setup pages.
  const byId = findVisible('#iCancel, #idBtn_Back, button[id*="cancel" i], input[id*="cancel" i], button[data-testid*="cancel" i]');
  if (byId) return byId;

  const candidates = findAllVisible(
    'button, a, input[type="button"], input[type="submit"], div[role="button"], span[role="button"]'
  );
  // Exact-ish cancel labels first
  const exact = candidates.find((el) => /^(取消|Cancel|No|否)$/i.test(buttonText(el)));
  if (exact) return exact;
  return candidates.find((el) =>
    /取消|Cancel|暂时跳过|Skip for now|以后再说|Not now|No thanks|跳过|Don't set up|稍后/i.test(buttonText(el))
  ) || null;
}

function dismissPasskeyPage(source = 'auto') {
  if (lastAction === 'passkey') return true;
  const cancel = findCancelButton();
  lastAction = 'passkey';
  if (cancel) {
    clickEl(cancel);
    // Some Microsoft dialogs need a second stronger click event sequence.
    setTimeout(() => {
      try {
        cancel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        cancel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        cancel.click();
      } catch (_) {}
    }, humanDelay(400, 200));
    sendLog(`${source}：检测到设置密钥页面，已点击取消`, 'info');
    return true;
  }
  sendLog(`${source}：检测到设置密钥页面，未找到取消按钮，请手动点“取消”`, 'warning');
  return true;
}

function isAccountLockedPage(body) {
  // "帐户已锁定" intermediate page before human verification.
  return /帐户已锁定|账户已锁定|your account (has been |is )?locked|account locked|锁定了你的帐户|锁定了你的账户|We've locked|we locked your account|违反.*服务协议.*锁定|完成人机验证/i.test(body)
    && /下一步|Next|继续|Continue|取消|Cancel/i.test(body);
}

function isHumanCheckPage(body) {
  // Press-and-hold / "prove you're not a robot" challenge.
  if (/证明你不是机器人|prove you.?re not a robot|are you a robot|human verification|人机验证/i.test(body)) return true;
  if (/长按该按钮|press and hold (the )?button|hold (the )?button/i.test(body)) return true;
  // Button-only signal when copy is sparse.
  const holdBtn = findAllVisible('button, a, div[role="button"], input[type="button"], span[role="button"]')
    .find((el) => /^(按住|Press and hold|Hold|长按)$/i.test(buttonText(el))
      || /按住|Press and hold|Hold to|长按/i.test(buttonText(el)));
  return !!holdBtn && /机器人|robot|人机|验证|verify|hold|按住|长按/i.test(body);
}

function findHoldButton() {
  return findAllVisible('button, a, div[role="button"], input[type="button"], span[role="button"]')
    .find((el) => /^(按住|Press and hold|Hold|长按)$/i.test(buttonText(el))
      || /按住|Press and hold|Hold to|长按该按钮|长按/i.test(buttonText(el)))
    || null;
}

function isBrowserErrorPage(body) {
  const text = String(body || '');
  if (/ERR_[A-Z0-9_]+/.test(text)) return true;
  if (/chrome-error:\/\/|chromewebdata/i.test(location.href || '')) return true;
  if (/无法提供安全连接|此网站无法提供安全连接|安全连接|响应无效|无法访问此网站|网页无法打开|连接已重置|连接超时|暂时无法访问|没有互联网连接|隐私错误|您的连接不是私密连接/i.test(text)) return true;
  if (/this site can.?t (be reached|provide a secure connection)|your connection is not private|net::err_|dns_probe_finished|err_ssl|err_connection|err_timed_out|err_name_not_resolved|err_empty_response|err_tunnel|err_proxy|err_cert/i.test(text)) return true;
  return false;
}

/**
 * Microsoft / CDN rate-limit interstitial (often a nearly blank page with only
 * "Too Many Requests"). Skip account — reopening usually hits the same limit.
 * Returns a short reason string, or null.
 */
function detectRateLimitPage(body = pageText()) {
  const title = String(document.title || '');
  const text = String(body || '');
  const hay = (title + ' | ' + text).slice(0, 4000);

  const rules = [
    { re: /too\s*many\s*requests/i, label: 'Too Many Requests' },
    { re: /请求过多|请求次数过多|请求太频繁|访问过于频繁|访问次数过多|操作过于频繁|频率过高/i, label: '请求过多' },
    { re: /rate\s*limit(?:ed|ing)?|throttl(?:e|ed|ing)|http\s*429|status\s*code\s*429/i, label: 'rate limited' }
  ];
  for (const { re, label } of rules) {
    if (re.test(hay)) {
      const fromTitle = title && re.test(title) ? title.trim() : '';
      const fromBody = (text.match(re) || [])[0] || '';
      return (fromTitle || fromBody || label).replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  return null;
}

/** Skip current account after rate-limit / 429 page (uses existing SW skipAccount). */
function handleRateLimitSkip(source, message) {
  if (lastAction === 'rate-limit-skip') return;
  lastAction = 'rate-limit-skip';
  const reason = String(message || 'Too Many Requests').replace(/\s+/g, ' ').trim().slice(0, 160);
  sendLog(`${source}：检测到请求过多/限流（${reason}），跳过当前账号`, 'error');
  chrome.runtime.sendMessage({
    action: 'skipAccount',
    reason: `请求过多: ${reason}`
  }).catch(() => {});
}

/** Meaningful login / proof / code UI — never treat as blank. */
function hasAuthFlowUi() {
  // Password / email / proof / submit — any of these means a normal MS login step.
  if (findVisible(
    'input[name="loginfmt"], input[type="password"], input[type="email"], input[name="passwd"], ' +
    '#i0116, #i0118, #idSIButton9, #otc, input[name="otc"], #proofConfirmationText, ' +
    'input[name="ProofConfirmation"], input[name="EmailAddress"], input[id*="proof" i], ' +
    'input[id*="email" i], input[aria-label*="邮箱"], input[aria-label*="email" i], ' +
    'input[aria-label*="密码"], input[aria-label*="password" i], ' +
    'input[placeholder*="邮箱"], input[placeholder*="email" i], input[placeholder*="密码"], ' +
    'input[placeholder*="password" i], #msaTile, #idBtn_Back, #idBtn_Accept, form'
  )) return true;

  const body = pageText();
  // Auth copy alone is enough when page is clearly a login step (even if input not yet painted).
  if (/输入你的密码|输入密码|enter your password|enter password|输入你的电子邮件|输入电子邮件|sign in|登录|验证你的|验证码|保持登录|keep me signed|帐户已锁定|证明你不是机器人/i.test(body)) {
    return true;
  }
  // Any visible text input + auth-ish copy (covers proof-email "验证你的电子邮件" layout).
  const textInputs = findAllVisible(
    'input[type="text"], input:not([type]), input[type="tel"], input[type="number"], textarea, input[type="password"], input[type="email"]'
  );
  if (textInputs.length && /验证|邮箱|email|code|验证码|发送|登录|sign in|password|密码|帐户|账户/i.test(body)) {
    return true;
  }
  // Form with input + primary button is an active step, not a blank page.
  if (textInputs.length && findVisible('button, input[type="submit"], input[type="button"], [role="button"]')) {
    return true;
  }
  // Any primary action button with auth copy = not blank.
  if (findVisible('button, input[type="submit"], input[type="button"], [role="button"]') &&
      /下一步|继续|next|continue|登录|sign in|发送|提交|submit/i.test(body)) {
    return true;
  }
  return false;
}

function isNearlyBlankPage() {
  // Never evaluate blank inside iframes (MS embeds empty frames).
  if (!isTopFrame()) return false;
  if (document.readyState !== 'complete') return false;
  // Ignore early navigation white flash + post-hop grace (email→password).
  if (performance.now() < 4000) return false;
  if (isInNavGrace()) return false;
  // Soft blank only when automation has made no progress for STUCK_MS.
  if (!isTaskStuck()) return false;
  if (hasAuthFlowUi()) return false;

  const body = pageText().replace(/\s+/g, ' ').trim();
  // Password / email pages have short-ish copy; keep threshold low only for true empty shells.
  if (body.length >= 40) return false;
  // Error interstitials have buttons like Reload — still blank/broken if no auth UI.
  const host = (location.hostname || '').toLowerCase();
  const msHost = /login\.live\.com|login\.microsoftonline\.com|account\.live\.com|account\.microsoft\.com|live\.com|microsoft\.com|office\.com|outlook\./i.test(host)
    || /^chrome-error:/i.test(location.href || '');
  return msHost;
}

function clearAnomalyWatch() {
  anomalyFirstSeenAt = 0;
  anomalyPendingLog = false;
}

function detectAndRecoverErrorPage() {
  try {
    // Iframes must not drive recovery (false blank on nested frames).
    if (!isTopFrame()) return false;

    const body = pageText();
    // Rate-limit interstitial → skip account (do not reopen / blank-recover).
    const rateLimit = detectRateLimitPage(body);
    if (rateLimit) {
      handleRateLimitSkip('异常检测', rateLimit);
      return true;
    }
    const errPage = isBrowserErrorPage(body);
    // Hard SSL/network errors: sustain only (no stuck gate — error page is already stuck).
    // Soft blank: only after task stuck ≥ STUCK_MS (checked inside isNearlyBlankPage).
    const blank = !errPage && isNearlyBlankPage();
    if (!errPage && !blank) {
      clearAnomalyWatch();
      return false;
    }

    const now = Date.now();
    if (!anomalyFirstSeenAt) {
      anomalyFirstSeenAt = now;
      if (!anomalyPendingLog) {
        anomalyPendingLog = true;
        sendLog(
          errPage
            ? `检测到 SSL/网络错误页，持续 ${ANOMALY_SUSTAIN_MS / 1000}s 后自动恢复…`
            : `任务已卡住 ${STUCK_MS / 1000}s 且页面异常（非正常登录页），持续 ${ANOMALY_SUSTAIN_MS / 1000}s 后自动恢复…`,
          'warning'
        );
      }
      return true;
    }
    if (now - anomalyFirstSeenAt < ANOMALY_SUSTAIN_MS) {
      return true;
    }
    if (now - lastErrorReportAt < ERROR_REPORT_COOLDOWN_MS) return true;
    lastErrorReportAt = now;
    clearAnomalyWatch();

    const reloadBtn = findAllVisible('button, a, input[type="button"], input[type="submit"]')
      .find((el) => /重新加载|reload|刷新|retry|重试|try again/i.test(buttonText(el)));
    if (reloadBtn) {
      sendLog(`异常已持续 ${ANOMALY_SUSTAIN_MS / 1000}s，点击「${buttonText(reloadBtn).slice(0, 20)}」并请求后台恢复`, 'warning');
      clickEl(reloadBtn);
    } else {
      sendLog(`异常已持续 ${ANOMALY_SUSTAIN_MS / 1000}s，请求后台重新打开授权页`, 'warning');
    }

    chrome.runtime.sendMessage({
      action: 'pageErrorRecover',
      reason: errPage ? (body.match(/ERR_[A-Z0-9_]+/)?.[0] || 'ssl-or-net-error') : 'blank-stuck',
      url: location.href,
      sustainedMs: ANOMALY_SUSTAIN_MS
    }).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

// Strict mutual-exclusion page classifier.
function classifyPage() {
  const body = pageText();
  const emailInput = findVisible('input[name="loginfmt"]');
  const passwordInput = findVisible('input[type="password"]');
  const accountTile = findVisible('#msaTile, div[aria-label*="Personal"], div[aria-label*="个人"]');
  const codeInputs = getCodeInputs();
  const proofInput = getProofEmailInput();

  // Rate-limit before blank/error — short "Too Many Requests" pages look blank otherwise.
  if (isTopFrame()) {
    const rateMsg = detectRateLimitPage(body);
    if (rateMsg) return { kind: 'rate-limit', message: rateMsg };
  }

  // Hard SSL/network errors first. Soft blank only when stuck (see isNearlyBlankPage).
  if (isTopFrame() && (isBrowserErrorPage(body) || isNearlyBlankPage())) {
    return { kind: 'page-error' };
  }

  // Passkey/setup-key pages can appear mid-flow after password or after backup email.
  // Check early so they are not blocked by other heuristics.
  if (/passkey|通行密钥|Windows Hello|正在设置密钥|设置密钥|安全密钥|security key|Set up a passkey|Create a passkey|设置通行密钥|打开安全窗口|完成密钥设置/i.test(body)) {
    return { kind: 'passkey', cancel: findCancelButton() };
  }

  // Account locked → next step is human verification. Detect before login fields
  // (this page has no password/email inputs but is part of the login path).
  if (isAccountLockedPage(body) && !isHumanCheckPage(body)) {
    return { kind: 'account-locked', nextBtn: getSubmitButton() };
  }

  // Human verification / "press and hold" — must be completed manually.
  // Check early: page has no login/proof inputs and must not be misread as other states.
  if (isHumanCheckPage(body)) {
    return { kind: 'human-check', holdBtn: findHoldButton() };
  }

  if (accountTile) return { kind: 'account-tile', accountTile };
  if (emailInput) return { kind: 'login-email', emailInput };
  if (passwordInput) {
    // Wrong password / password login unavailable / too many attempts → skip account.
    const pwdFail = detectPasswordLoginFailure(body);
    if (pwdFail) return { kind: 'password-error', message: pwdFail, passwordInput };
    return { kind: 'login-password', passwordInput };
  }

  // After successful backup-email verify, expired-code page → reopen auth.
  if (isCodeExpiredPage(body)) {
    return { kind: 'code-expired' };
  }

  // Risk-control channel picker: "where should we send the code?" → click 下一步.
  // Must run before isCodePage so we don't try to fill a non-existent code box.
  if (isCodeSendMethodPage(body)) {
    return { kind: 'code-send-method', nextBtn: getSubmitButton() };
  }

  // Figure 5 first: "验证你的电子邮件" + email field + "发送验证码".
  if (isProofResendPage(body, proofInput)) {
    return { kind: 'proof-resend', proofInput: resolveProofInput(proofInput) };
  }

  if (isCodePage(body, codeInputs, proofInput)) {
    return { kind: 'code', codeInputs: codeInputs.length ? codeInputs : [] };
  }

  if (isProofInitialPage(body, proofInput)) {
    return { kind: 'proof-initial', proofInput: resolveProofInput(proofInput) };
  }
  if (proofInput) {
    // Unknown proof-email style page: treat as initial binding by default.
    return { kind: 'proof-initial', proofInput: resolveProofInput(proofInput) };
  }

  if (/Keep me signed in|保持登录状态/i.test(body) && findVisible('#idBtn_Back')) {
    return { kind: 'keep-signed-in', backBtn: findVisible('#idBtn_Back') };
  }
  if (/已成功添加|安全信息就绪|一切就绪|信息已更新/i.test(body)) {
    return { kind: 'verification-complete' };
  }

  const accept = findVisible('#idBtn_Accept') ||
    findAllVisible('#idSIButton9, button[type="submit"], button, a')
      .find((el) => /accept|接受|allow|允许/i.test(buttonText(el)));
  if (accept) return { kind: 'consent', accept };

  return { kind: 'none' };
}

function notePageChange(kind) {
  if (kind !== lastPageKind) {
    lastPageKind = kind;
    lastAction = '';
  }
  // Recognized interactive steps count as progress (cancels blank-stuck recovery).
  if (kind && kind !== 'page-error' && kind !== 'none') {
    markProgress();
  }
}

function handleSkip() {
  const page = classifyPage();
  notePageChange(page.kind);
  switch (page.kind) {
    case 'login-email':
      return sendLog('跳过：请在页面上手动填写 Outlook 邮箱', 'warning');
    case 'login-password':
      return sendLog('跳过：请在页面上手动填写 Outlook 密码', 'warning');
    case 'password-error':
      return handlePasswordLoginFailure('跳过', page.message);
    case 'rate-limit':
      return handleRateLimitSkip('跳过', page.message);
    case 'code':
      return sendLog('跳过：请手动输入备用邮箱验证码', 'warning');
    case 'proof-initial':
    case 'proof-resend':
      return sendLog('跳过：请手动填写备用邮箱', 'warning');
    case 'keep-signed-in':
      return sendLog('跳过：请手动处理保持登录提示', 'warning');
    case 'passkey':
      return sendLog('跳过：检测到设置密钥/通行密钥页面，可点取消', 'warning');
    case 'code-expired':
      return sendLog('跳过：备用邮箱已验证成功，请点击“步骤 1”重开授权页', 'warning');
    case 'account-locked':
      return sendLog('跳过：帐户已锁定，需手动点“下一步”并完成人机验证', 'warning');
    case 'human-check':
      return sendLog('人机验证需手动完成：请在页面上长按“按住”按钮', 'warning');
    case 'code-send-method':
      return sendLog('跳过：请手动选择代码发送方式并点“下一步”', 'warning');
    default:
      return sendLog('未检测到可跳过的登录步骤', 'warning');
  }
}

/** Visible error nodes near the password form (MS often uses #passwordError). */
function collectPasswordErrorSnippets() {
  const selectors = [
    '#passwordError',
    '#usernameError',
    '#idTd_Tile_ErrorMsg_Login',
    '[id*="passwordError" i]',
    '[id*="Error" i]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '.alert-error',
    '[class*="error" i]'
  ];
  const texts = [];
  for (const sel of selectors) {
    try {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 300) texts.push(t);
      }
    } catch (_) {}
  }
  return texts;
}

/**
 * Detect password-page hard failures that should skip the account:
 * - 密码登录不可用
 * - 不正确的帐户或密码 / 次数过多
 * - common EN variants
 * Returns a short reason string, or null.
 */
function detectPasswordLoginFailure(body = pageText()) {
  const snippets = collectPasswordErrorSnippets();
  const hay = (snippets.join(' | ') + ' | ' + String(body || '')).slice(0, 6000);

  const rules = [
    { re: /密码登录不可用/i, label: '密码登录不可用' },
    { re: /不正确的帐户或密码.*次数过多|次数过多.*不正确的帐户或密码|尝试登录的次数过多/i, label: '登录次数过多' },
    { re: /你使用不正确的帐户或密码/i, label: '帐户或密码不正确（次数过多）' },
    { re: /帐户或密码不正确|账户或密码不正确|密码不正确|密码错误/i, label: '帐户或密码不正确' },
    { re: /Your account or password is incorrect/i, label: 'account or password incorrect' },
    { re: /password is incorrect|incorrect password/i, label: 'password incorrect' },
    { re: /too many times|too many (failed )?sign-?in attempts|too many attempts/i, label: 'too many sign-in attempts' },
    { re: /sign-?in (is )?temporarily (blocked|locked)|暂时(无法|不能)登录|登录暂时被阻止/i, label: 'sign-in temporarily blocked' }
  ];

  for (const { re, label } of rules) {
    if (re.test(hay)) {
      // Prefer the concrete UI snippet when available.
      const hit = snippets.find((s) => re.test(s));
      return hit || label;
    }
  }
  return null;
}

/** Skip current account after password login hard-fail (uses existing SW skipAccount). */
function handlePasswordLoginFailure(source, message) {
  if (lastAction === 'password-error-skip') return;
  lastAction = 'password-error-skip';
  const reason = String(message || '密码错误或登录次数过多').replace(/\s+/g, ' ').trim().slice(0, 160);
  sendLog(`${source}：检测到密码登录失败（${reason}），跳过当前账号`, 'error');
  chrome.runtime.sendMessage({
    action: 'skipAccount',
    reason: `密码登录失败: ${reason}`
  }).catch(() => {});
}

// Step 2: account tile / Outlook email / Outlook password / keep-signed-in / passkey
function executeStep2() {
  const page = classifyPage();
  notePageChange(page.kind);

  if (page.kind === 'password-error') {
    handlePasswordLoginFailure('步骤 2/4', page.message);
    return;
  }
  if (page.kind === 'rate-limit') {
    handleRateLimitSkip('步骤 2/4', page.message);
    return;
  }

  if (page.kind === 'account-tile') {
    if (lastAction === 'account-tile') return;
    lastAction = 'account-tile';
    sendLog('步骤 2/4：选择个人帐户', 'info');
    clickEl(page.accountTile);
    return;
  }

  if (page.kind === 'login-email') {
    if (!currentAccount?.email) return sendLog('步骤 2/4：未获取到 Outlook 邮箱，请手动输入', 'error');
    if (lastAction === 'login-email') return;
    lastAction = 'login-email';
    sendLog(`步骤 2/4：填写 Outlook 邮箱 ${currentAccount.email}`, 'info');
    typeVal(page.emailInput, currentAccount.email);
    setTimeout(() => clickEl(getSubmitButton()), humanDelay(FILL_TO_SUBMIT_MS, FILL_TO_SUBMIT_JITTER_MS));
    return;
  }

  if (page.kind === 'login-password') {
    if (!currentAccount?.password) return sendLog('步骤 2/4：未获取到 Outlook 密码，请手动输入', 'error');
    if (lastAction === 'login-password') return;
    lastAction = 'login-password';
    sendLog('步骤 2/4：填写 Outlook 密码', 'info');
    typeVal(page.passwordInput, currentAccount.password);
    setTimeout(() => clickEl(getSubmitButton()), humanDelay(FILL_TO_SUBMIT_MS, FILL_TO_SUBMIT_JITTER_MS));
    return;
  }

  if (page.kind === 'keep-signed-in') {
    if (lastAction === 'keep-signed-in') return;
    lastAction = 'keep-signed-in';
    clickEl(page.backBtn);
    sendLog('步骤 2/4：跳过保持登录提示', 'info');
    return;
  }

  if (page.kind === 'passkey') {
    dismissPasskeyPage('步骤 2/4');
    return;
  }

  if (page.kind === 'account-locked') {
    handleAccountLocked('步骤 2/4', page.nextBtn);
    return;
  }

  if (page.kind === 'human-check') {
    handleHumanCheck('步骤 2/4', page.holdBtn);
    return;
  }

  if (page.kind === 'code-send-method') {
    handleCodeSendMethod('步骤 2/4', page.nextBtn);
    return;
  }

  sendLog('步骤 2/4：等待 Outlook 邮箱或密码页面', 'warning');
}

// Account locked intermediate page: auto-click 下一步 to reach human-check.
function handleAccountLocked(source, nextBtn) {
  if (lastAction === 'account-locked') return;
  lastAction = 'account-locked';
  const btn = nextBtn || getSubmitButton();
  if (btn) {
    clickEl(btn);
    sendLog(`${source}：检测到“帐户已锁定”，已点击下一步（接下来请完成人机验证）`, 'warning');
  } else {
    sendLog(`${source}：检测到“帐户已锁定”，未找到下一步按钮，请手动点击`, 'warning');
  }
}

// Risk-control: "where should we send the code?" dropdown page → click 下一步.
function handleCodeSendMethod(source, nextBtn) {
  if (lastAction === 'code-send-method') return;
  lastAction = 'code-send-method';
  const btn = nextBtn || getSubmitButton();
  if (btn) {
    clickEl(btn);
    sendLog(`${source}：检测到代码发送方式页（备用邮箱风控），已点击下一步`, 'info');
  } else {
    sendLog(`${source}：检测到代码发送方式页，未找到下一步按钮，请手动点击`, 'warning');
  }
}

// Press-and-hold robot check — cannot automate reliably; prompt user only.
function handleHumanCheck(source, holdBtn) {
  if (lastAction === 'human-check') return;
  lastAction = 'human-check';
  sendLog(
    `${source}：⚠️ 检测到人机验证（证明你不是机器人 / 按住），请手动长按“按住”完成，通过后流程会继续`,
    'warning'
  );
  // Do not try to auto long-press — Microsoft blocks synthetic hold events.
  void holdBtn;
}

// Step 3: proof-initial / proof-resend / code / consent / complete / passkey mid-flow
function executeStep3() {
  const page = classifyPage();
  notePageChange(page.kind);

  if (page.kind === 'rate-limit') {
    handleRateLimitSkip('步骤 3/4', page.message);
    return;
  }

  // Passkey may appear after verification code — cancel here too.
  if (page.kind === 'passkey') {
    dismissPasskeyPage('步骤 3/4');
    return;
  }

  // These can also appear mid-flow after password.
  if (page.kind === 'account-locked') {
    handleAccountLocked('步骤 3/4', page.nextBtn);
    return;
  }
  if (page.kind === 'human-check') {
    handleHumanCheck('步骤 3/4', page.holdBtn);
    return;
  }
  if (page.kind === 'code-send-method') {
    handleCodeSendMethod('步骤 3/4', page.nextBtn);
    return;
  }

  // Expired previous codes = backup email already verified → reopen OAuth.
  if (page.kind === 'code-expired') {
    reopenAuthAfterBackupVerified('步骤 3/4');
    return;
  }

  if (page.kind === 'verification-complete') {
    if (lastAction === 'verification-complete') return;
    lastAction = 'verification-complete';
    clickEl(getSubmitButton());
    sendLog('步骤 3/4：备用邮箱验证完成', 'success');
    return;
  }

  if (page.kind === 'consent') {
    if (lastAction === 'consent') return;
    lastAction = 'consent';
    clickEl(page.accept);
    sendLog('步骤 3/4：确认 Microsoft 授权', 'info');
    return;
  }

  if (page.kind === 'code') {
    fillVerificationCode(page.codeInputs);
    return;
  }

  if (page.kind === 'proof-resend' || page.kind === 'proof-initial') {
    if (!currentAccount?.backupEmail) return sendLog('步骤 3/4：请在设置中配置备用邮箱', 'warning');
    if (lastAction === page.kind) return;
    lastAction = page.kind;
    const input = resolveProofInput(page.proofInput);
    if (!input) return sendLog('步骤 3/4：未找到备用邮箱输入框', 'warning');

    const executeFill = (emailToFill) => {
      typeVal(input, '');
      typeVal(input, emailToFill);
      sendLog(`步骤 3/4：填写备用邮箱 ${emailToFill}`, 'info');
      setTimeout(() => {
        const button = page.kind === 'proof-resend'
          ? getSubmitButton({ sendCode: true }) || getSubmitButton()
          : getSubmitButton();
        clickEl(button);
        sendLog(
          page.kind === 'proof-resend' ? '步骤 3/4：已点击发送验证码' : '步骤 3/4：已点击下一步',
          'info'
        );
      }, humanDelay(FILL_TO_SUBMIT_MS, FILL_TO_SUBMIT_JITTER_MS));
    };

    // 检查页面上是否提示了掩码邮箱 (例如 "我们将向 05*****@ldymail.cc.cd 发送代码")
    const bodyText = pageText();
    // 兼容中英文文案，并容忍掩码邮箱前后的空白/换行
    const maskedMatch =
      bodyText.match(/我们将向\s*([^\s@]+@[^\s@]+)\s*发送代码/i) ||
      bodyText.match(/向\s*([^\s@]+@[^\s@]+)\s*发送(?:验证)?代码/i) ||
      bodyText.match(/we(?:'|’)ll send (?:a )?code to\s*([^\s@]+@[^\s@]+)/i) ||
      bodyText.match(/send (?:a )?code to\s*([^\s@]+@[^\s@]+)/i) ||
      bodyText.match(/([0-9a-z*]{2,}\*{2,}[0-9a-z*]*@[^\s@]+)/i);
    if (maskedMatch) {
      const maskedEmail = String(maskedMatch[1] || '').replace(/\s+/g, '');
      sendLog(`步骤 3/4：页面提示需验证已有邮箱 ${maskedEmail}，正在本地池中匹配...`, 'info');
      chrome.runtime.sendMessage({ action: 'matchMaskedEmail', maskedEmail }, (matchedEmail) => {
        if (chrome.runtime.lastError) {
          lastAction = '';
          sendLog(`❌ 匹配请求失败: ${chrome.runtime.lastError.message}`, 'error');
          return;
        }
        if (!matchedEmail) {
          sendLog(`❌ 本地备用邮箱池中未找到与 ${maskedEmail} 匹配的邮箱，跳过该账号`, 'error');
          chrome.runtime.sendMessage({ action: 'skipAccount', reason: `找不到匹配的备用邮箱 ${maskedEmail}` });
          return;
        }
        sendLog(`✅ 成功匹配到已有备用邮箱 ${matchedEmail}`, 'success');
        // 同步本地与后台，保证后续接码使用匹配到的地址
        if (currentAccount) currentAccount.backupEmail = matchedEmail;
        executeFill(matchedEmail);
      });
      return;
    }

    // 如果没有提示掩码，说明是新绑定，直接使用分配好的备用邮箱
    executeFill(currentAccount.backupEmail);
    return;
  }

  sendLog('步骤 3/4：等待备用邮箱验证页面', 'warning');
}

function fillVerificationCode(codeInputs) {
  // Single-flight: ignore re-entry while a fetch/poll is already running.
  if (codeFetchInFlight) return;

  // Allow retry if previous fill left the box empty (input was missing / React rejected).
  if (lastAction === 'verification-code') {
    const existing = getCodeInputs();
    const hasValue = existing.some((el) => String(el.value || '').replace(/\s/g, '').length >= 4);
    if (hasValue) return;
    // Locked with empty box and no in-flight fetch — unlock and try again.
    lastAction = '';
  }
  lastAction = 'verification-code';
  codeFetchInFlight = true;
  // Safety: SW poll is ~3s + 20×3s; if callback never returns, unlock for retry.
  const fetchGuard = setTimeout(() => {
    if (codeFetchInFlight) {
      codeFetchInFlight = false;
      lastAction = '';
      sendLog('步骤 3/4：取码超时未回调，已解锁可重试', 'warning');
    }
  }, 75000);
  sendLog('步骤 3/4：正在获取备用邮箱验证码...', 'info');
  chrome.runtime.sendMessage({ action: 'fetchVerificationCode' }, (code) => {
    clearTimeout(fetchGuard);
    codeFetchInFlight = false;
    if (chrome.runtime.lastError) {
      lastAction = '';
      return sendLog(`步骤 3/4：取码失败: ${chrome.runtime.lastError.message}`, 'warning');
    }
    if (!code) {
      lastAction = '';
      return sendLog('步骤 3/4：未获取到验证码，请手动输入', 'warning');
    }
    sendLog('步骤 3/4：已获取验证码，正在填写', 'success');
    // Re-query inputs at fill time (DOM may have settled after fetch delay).
    const liveInputs = getCodeInputs();
    const targets = (liveInputs.length ? liveInputs : codeInputs) || [];
    if (!targets.length) {
      lastAction = '';
      sendLog('步骤 3/4：未找到验证码输入框，将在页面就绪后重试', 'warning');
      return;
    }
    fillCode(code, targets);
    // Verify fill stuck; if React rejected it, retry once with re-query.
    setTimeout(() => {
      const check = getCodeInputs();
      const filled = check.some((el) => String(el.value || '').replace(/\s/g, '').includes(String(code).slice(0, 3)));
      if (!filled && check.length) {
        sendLog('步骤 3/4：验证码框未写入，重试填写…', 'warning');
        fillCode(code, check);
      } else if (!filled && !check.length) {
        lastAction = '';
        sendLog('步骤 3/4：验证码框仍未就绪，稍后重试', 'warning');
        return;
      }
      setTimeout(() => clickEl(getSubmitButton()), humanDelay(FILL_TO_SUBMIT_MS, FILL_TO_SUBMIT_JITTER_MS));
    }, 350);
  });
}

function fillCode(code, inputs) {
  if (!inputs?.length || !code) return false;
  const boxes = inputs.length >= 4 ? inputs : [inputs[0]];
  if (boxes.length >= 4) {
    const digits = String(code).replace(/\D/g, '');
    digits.split('').forEach((char, index) => {
      if (boxes[index]) typeVal(boxes[index], char);
    });
  } else {
    typeVal(boxes[0], String(code));
  }
  return true;
}

async function checkPageState() {
  // Nested frames only observe mutations for parent; never drive login automation.
  if (!isTopFrame()) return;

  const { sw_running, sw_paused, execMode: storedMode } = await chrome.storage.local.get(['sw_running', 'sw_paused', 'execMode']);
  // Paused or stopped: do not drive the page.
  if (!sw_running || sw_paused) return;
  if (storedMode) execMode = storedMode;

  // Hard error / blank-stuck first (auto + step-by-step).
  if (detectAndRecoverErrorPage()) return;

  const page = classifyPage();
  notePageChange(page.kind);

  if (page.kind === 'page-error') {
    detectAndRecoverErrorPage();
    return;
  }

  // Password hard-fail → skip account (auto + step-by-step).
  if (page.kind === 'password-error') {
    handlePasswordLoginFailure(execMode === 'auto' ? '自动' : '检测', page.message);
    return;
  }

  // Rate-limit / 429 → skip account (auto + step-by-step).
  if (page.kind === 'rate-limit') {
    handleRateLimitSkip(execMode === 'auto' ? '自动' : '检测', page.message);
    return;
  }

  // Always auto-dismiss passkey / keep-signed-in, even in step-by-step mode.
  if (page.kind === 'passkey') {
    dismissPasskeyPage('自动');
    return;
  }
  if (page.kind === 'keep-signed-in') {
    if (lastAction !== 'keep-signed-in') {
      lastAction = 'keep-signed-in';
      clickEl(page.backBtn);
      sendLog('自动：跳过保持登录提示', 'info');
    }
    return;
  }

  // Account locked → click Next to reach human-check (both modes).
  if (page.kind === 'account-locked') {
    handleAccountLocked(execMode === 'auto' ? '自动' : '检测', page.nextBtn);
    return;
  }

  // Human-check: only prompt (cannot auto long-press).
  if (page.kind === 'human-check') {
    handleHumanCheck(execMode === 'auto' ? '自动' : '检测', page.holdBtn);
    return;
  }

  // Channel picker → click Next so Microsoft sends the code (both modes).
  if (page.kind === 'code-send-method') {
    handleCodeSendMethod(execMode === 'auto' ? '自动' : '检测', page.nextBtn);
    return;
  }

  // Backup email verified (expired-code banner) → always reopen auth.
  if (page.kind === 'code-expired') {
    reopenAuthAfterBackupVerified(execMode === 'auto' ? '自动' : '检测');
    return;
  }

  if (page.kind === 'verification-complete') {
    if (lastAction !== 'verification-complete') {
      lastAction = 'verification-complete';
      sendLog('✅ 备用邮箱验证完成，等待授权结果', 'success');
      clickEl(getSubmitButton());
    }
    return;
  }

  if (execMode !== 'auto') {
    if (page.kind !== 'none' && lastAction !== `detect-${page.kind}`) {
      lastAction = `detect-${page.kind}`;
      if (page.kind === 'login-email' || page.kind === 'login-password' || page.kind === 'account-tile') {
        sendLog('📌 检测到登录页面，请点击“步骤 2”填写账号密码', 'info');
      } else if (page.kind === 'code') {
        sendLog('📌 检测到验证码页面，请点击“步骤 3”获取并填写验证码', 'info');
      } else if (page.kind === 'code-send-method') {
        sendLog('📌 检测到代码发送方式页，请点击“步骤 3”点下一步', 'info');
      } else if (page.kind === 'proof-resend') {
        sendLog('📌 检测到备用邮箱再验证页面，请点击“步骤 3”填写并发送验证码', 'info');
      } else if (page.kind === 'proof-initial') {
        sendLog('📌 检测到备用邮箱绑定页面，请点击“步骤 3”填写备用邮箱', 'info');
      } else if (page.kind === 'consent') {
        sendLog('📌 检测到授权确认页，请点击“步骤 3”确认', 'info');
      }
    }
    return;
  }

  // auto mode: drive the full state machine
  switch (page.kind) {
    case 'account-tile':
    case 'login-email':
    case 'login-password':
      executeStep2();
      break;
    case 'proof-initial':
    case 'proof-resend':
    case 'code':
    case 'code-send-method':
    case 'consent':
      executeStep3();
      break;
    default:
      break;
  }
}

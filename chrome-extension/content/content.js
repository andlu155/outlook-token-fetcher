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

startObserver();
setTimeout(checkPageState, 1000);

chrome.runtime.sendMessage({ action: 'getCurrentAccount' }, (account) => {
  if (account?.email) currentAccount = account;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'skipCurrentStep') handleSkip();
  if (msg.action === 'executeStep') {
    if (msg.account?.email) currentAccount = msg.account;
    // Allow step 3 to run multiple times (backup email may need two passes).
    if (msg.step === 2 || msg.step === 3) {
      lastAction = '';
      lastPageKind = '';
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
  checkTimer = setTimeout(checkPageState, 400);
}

window.addEventListener('beforeunload', () => {
  observer?.disconnect();
  clearTimeout(checkTimer);
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
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function clickEl(element) {
  if (!element) return;
  element.focus?.();
  element.click();
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
  const meta = `${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
  const maxLen = Number(el.getAttribute('maxlength') || 0);
  return el.type === 'tel' ||
    el.type === 'number' ||
    maxLen === 1 ||
    maxLen === 6 ||
    /otc|code|proofconfirmation|iOttText|验证码|代码/.test(meta);
}

function getCodeInputs() {
  const named = findAllVisible([
    'input[name="ProofConfirmation"]',
    'input[id="iProofCode"]',
    'input[id*="OTC" i]',
    'input[name*="otc" i]',
    'input[id*="code" i]',
    'input[name*="code" i]',
    'input[id="iOttText"]'
  ].join(', ')).filter((el) => !looksLikeEmailInput(el));
  if (named.length) return named;

  // 6-digit split boxes commonly use maxlength=1 without otc/code ids.
  const digitBoxes = findAllVisible('input[maxlength="1"], input[autocomplete="one-time-code"]')
    .filter((el) => el.type !== 'password' && el.name !== 'loginfmt' && !looksLikeEmailInput(el));
  if (digitBoxes.length >= 4) return digitBoxes;

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

function isCodePage(body, codeInputs, proofInput) {
  // Figure 5 re-verify page also mentions "代码/验证码"; never treat it as code entry.
  if (isProofResendPage(body, proofInput)) return false;
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
    }, 200);
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

// Strict mutual-exclusion page classifier.
function classifyPage() {
  const body = pageText();
  const emailInput = findVisible('input[name="loginfmt"]');
  const passwordInput = findVisible('input[type="password"]');
  const accountTile = findVisible('#msaTile, div[aria-label*="Personal"], div[aria-label*="个人"]');
  const codeInputs = getCodeInputs();
  const proofInput = getProofEmailInput();

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
  if (passwordInput) return { kind: 'login-password', passwordInput };

  // After successful backup-email verify, expired-code page → reopen auth.
  if (isCodeExpiredPage(body)) {
    return { kind: 'code-expired' };
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
}

function handleSkip() {
  const page = classifyPage();
  notePageChange(page.kind);
  switch (page.kind) {
    case 'login-email':
      return sendLog('跳过：请在页面上手动填写 Outlook 邮箱', 'warning');
    case 'login-password':
      return sendLog('跳过：请在页面上手动填写 Outlook 密码', 'warning');
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
    default:
      return sendLog('未检测到可跳过的登录步骤', 'warning');
  }
}

// Step 2: account tile / Outlook email / Outlook password / keep-signed-in / passkey
function executeStep2() {
  const page = classifyPage();
  notePageChange(page.kind);

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
    setTimeout(() => clickEl(getSubmitButton()), 600);
    return;
  }

  if (page.kind === 'login-password') {
    if (!currentAccount?.password) return sendLog('步骤 2/4：未获取到 Outlook 密码，请手动输入', 'error');
    if (lastAction === 'login-password') return;
    lastAction = 'login-password';
    sendLog('步骤 2/4：填写 Outlook 密码', 'info');
    typeVal(page.passwordInput, currentAccount.password);
    setTimeout(() => clickEl(getSubmitButton()), 600);
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
      }, 600);
    };

    // 检查页面上是否提示了掩码邮箱 (例如 "我们将向 05*****@ldymail.cc.cd 发送代码")
    const bodyText = pageText();
    // 匹配类似：我们将向 05*****@ldymail.cc.cd 发送代码
    const maskedMatch = bodyText.match(/我们将向s*([^s]+@[^s]+)s*发送代码/i) || bodyText.match(/向s*([^s]+@[^s]+)s*发送/i);
    if (maskedMatch) {
      const maskedEmail = maskedMatch[1];
      sendLog(`步骤 3/4：页面提示需验证已有邮箱 ${maskedEmail}，正在本地池中匹配...`, 'info');
      chrome.runtime.sendMessage({ action: 'matchMaskedEmail', maskedEmail }, (matchedEmail) => {
        if (!matchedEmail) {
          sendLog(`❌ 本地备用邮箱池中未找到与 ${maskedEmail} 匹配的邮箱，跳过该账号`, 'error');
          chrome.runtime.sendMessage({ action: 'skipAccount', reason: `找不到匹配的备用邮箱 ${maskedEmail}` });
          return;
        }
        sendLog(`✅ 成功匹配到已有备用邮箱 ${matchedEmail}`, 'success');
        // 将当前正在执行的账号的备用邮箱更新为匹配到的，防止后续接码时用错
        currentAccount.backupEmail = matchedEmail; 
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
  if (lastAction === 'verification-code') return;
  lastAction = 'verification-code';
  sendLog('步骤 3/4：正在获取备用邮箱验证码...', 'info');
  chrome.runtime.sendMessage({ action: 'fetchVerificationCode' }, (code) => {
    if (!code) {
      lastAction = '';
      return sendLog('步骤 3/4：未获取到验证码，请手动输入', 'warning');
    }
    sendLog('步骤 3/4：已获取验证码，正在填写', 'success');
    fillCode(code, codeInputs);
    setTimeout(() => clickEl(getSubmitButton()), 600);
  });
}

function fillCode(code, inputs) {
  if (!inputs?.length) return;
  const boxes = inputs.length >= 4 ? inputs : [inputs[0]];
  if (boxes.length >= 4) {
    code.split('').forEach((char, index) => {
      if (boxes[index]) typeVal(boxes[index], char);
    });
  } else {
    typeVal(boxes[0], code);
  }
}

async function checkPageState() {
  const { sw_running, sw_paused, execMode: storedMode } = await chrome.storage.local.get(['sw_running', 'sw_paused', 'execMode']);
  // Paused or stopped: do not drive the page.
  if (!sw_running || sw_paused) return;
  if (storedMode) execMode = storedMode;

  const page = classifyPage();
  notePageChange(page.kind);

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
    case 'consent':
      executeStep3();
      break;
    default:
      break;
  }
}

const fs = require('fs');
const file = 'chrome-extension/content/content.js';
let content = fs.readFileSync(file, 'utf8');

const targetStr = `  if (page.kind === 'proof-resend' || page.kind === 'proof-initial') {
    if (!currentAccount?.backupEmail) return sendLog('步骤 3/4：请在设置中配置备用邮箱', 'warning');
    if (lastAction === page.kind) return;
    lastAction = page.kind;
    const input = resolveProofInput(page.proofInput);
    if (!input) return sendLog('步骤 3/4：未找到备用邮箱输入框', 'warning');
    // Clear wrong value if a verification code was previously mistyped here.
    typeVal(input, '');
    typeVal(input, currentAccount.backupEmail);
    sendLog(\`步骤 3/4：填写备用邮箱 \${currentAccount.backupEmail}\`, 'info');
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
    return;
  }`;

const replacement = `  if (page.kind === 'proof-resend' || page.kind === 'proof-initial') {
    if (!currentAccount?.backupEmail) return sendLog('步骤 3/4：请在设置中配置备用邮箱', 'warning');
    if (lastAction === page.kind) return;
    lastAction = page.kind;
    const input = resolveProofInput(page.proofInput);
    if (!input) return sendLog('步骤 3/4：未找到备用邮箱输入框', 'warning');

    const executeFill = (emailToFill) => {
      typeVal(input, '');
      typeVal(input, emailToFill);
      sendLog(\`步骤 3/4：填写备用邮箱 \${emailToFill}\`, 'info');
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
    const maskedMatch = bodyText.match(/我们将向\s*([^\s]+@[^\s]+)\s*发送代码/i) || bodyText.match(/向\s*([^\s]+@[^\s]+)\s*发送/i);
    if (maskedMatch) {
      const maskedEmail = maskedMatch[1];
      sendLog(\`步骤 3/4：页面提示需验证已有邮箱 \${maskedEmail}，正在本地池中匹配...\`, 'info');
      chrome.runtime.sendMessage({ action: 'matchMaskedEmail', maskedEmail }, (matchedEmail) => {
        if (!matchedEmail) {
          sendLog(\`❌ 本地备用邮箱池中未找到与 \${maskedEmail} 匹配的邮箱，跳过该账号\`, 'error');
          chrome.runtime.sendMessage({ action: 'skipAccount', reason: \`找不到匹配的备用邮箱 \${maskedEmail}\` });
          return;
        }
        sendLog(\`✅ 成功匹配到已有备用邮箱 \${matchedEmail}\`, 'success');
        // 将当前正在执行的账号的备用邮箱更新为匹配到的，防止后续接码时用错
        currentAccount.backupEmail = matchedEmail; 
        executeFill(matchedEmail);
      });
      return;
    }

    // 如果没有提示掩码，说明是新绑定，直接使用分配好的备用邮箱
    executeFill(currentAccount.backupEmail);
    return;
  }`;

if (content.includes(targetStr)) {
  fs.writeFileSync(file, content.replace(targetStr, replacement));
  console.log("Content script patched");
} else {
  console.log("Failed to patch content script");
}

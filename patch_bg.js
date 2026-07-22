const fs = require('fs');
const file = 'chrome-extension/background/background.js';
let content = fs.readFileSync(file, 'utf8');

const targetStr = `      case 'fetchVerificationCode':
        const code = await fetchCodeFromTempEmail();
        sendResponse(code);
        break;`;

const replacement = `      case 'fetchVerificationCode':
        const code = await fetchCodeFromTempEmail();
        sendResponse(code);
        break;
      case 'skipAccount':
        // Content script 发现无法继续（例如备用邮箱不匹配），直接标记为失败并跳过
        sendLog(\`[\${currentAccount?.email || '未知'}] ❌ 被主动跳过: \${msg.reason}\`, 'error');
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
        // 将掩码（例如 05*****@ldymail.cc.cd）与用户设置的邮箱池进行匹配
        const masked = msg.maskedEmail || '';
        const [maskLocal, maskDomain] = masked.split('@');
        let matched = null;
        
        if (maskLocal && maskDomain) {
            // 获取用户配置的所有备用邮箱
            const list = parseFixedBackupList(settings);
            // 将掩码的星号转为正则表达式，例如 05***** 变成 ^05.*$
            const regexStr = '^' + maskLocal.replace(/\*/g, '.*') + '$';
            const regex = new RegExp(regexStr, 'i');
            
            for (let e of list) {
                const [l, d] = e.split('@');
                if (d && d.toLowerCase() === maskDomain.toLowerCase() && regex.test(l)) {
                    matched = e;
                    break;
                }
            }
        }
        sendResponse(matched);
        break;`;

if (content.includes(targetStr)) {
  fs.writeFileSync(file, content.replace(targetStr, replacement));
  console.log("Background script patched");
} else {
  console.log("Failed to patch background script");
}

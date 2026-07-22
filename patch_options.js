const fs = require('fs');
const fileBg = 'chrome-extension/background/background.js';
const fileOptionsHtml = 'chrome-extension/options/options.html';
const fileOptionsJs = 'chrome-extension/options/options.js';

// We need to add a setting to let the user choose the API mode (IMAP vs Graph) because they can't be mixed.
let bgContent = fs.readFileSync(fileBg, 'utf8');

// Replace static SCOPES with dynamic calculation
bgContent = bgContent.replace(
  "const SCOPES = 'offline_access Mail.Read Mail.Send IMAP.AccessAsUser.All SMTP.Send';",
  `function getScopes() {
  // 如果用户在设置里选择了 Graph 模式，就只申请 Graph 权限；否则默认申请 IMAP 权限
  if (settings.apiMode === 'graph') {
    return 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
  }
  return 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
}`
);

// Update usages of SCOPES
bgContent = bgContent.replace(/scope: SCOPES/g, 'scope: getScopes()');

fs.writeFileSync(fileBg, bgContent);

// Update options.html to add a dropdown for API Mode
let htmlContent = fs.readFileSync(fileOptionsHtml, 'utf8');
if (!htmlContent.includes('apiMode')) {
  const insertPos = htmlContent.indexOf('<div class="settings-group" id="tempEmailGroup">');
  const injectHtml = `
      <div class="settings-group">
        <div class="group-title">
          <span class="icon">🔌</span> API 授权模式
        </div>
        <div class="setting-item">
          <div class="setting-label">
            <span>授权协议类型</span>
            <span class="setting-desc">决定获取到的 Token 支持哪种协议。如果取件网站(如 mail.chatai.codes)不支持 IMAP，请改为 Graph。</span>
          </div>
          <div class="setting-control">
            <select id="apiMode">
              <option value="imap">IMAP/SMTP (默认，适合大部分传统邮件客户端)</option>
              <option value="graph">Microsoft Graph (适合现代云端取件网站)</option>
            </select>
          </div>
        </div>
      </div>
  `;
  htmlContent = htmlContent.substring(0, insertPos) + injectHtml + htmlContent.substring(insertPos);
  fs.writeFileSync(fileOptionsHtml, htmlContent);
}

// Update options.js to save/load the new setting
let jsContent = fs.readFileSync(fileOptionsJs, 'utf8');
if (!jsContent.includes('apiMode')) {
  jsContent = jsContent.replace(
    "const clientIdMode = document.getElementById('clientIdMode');",
    "const clientIdMode = document.getElementById('clientIdMode');\nconst apiMode = document.getElementById('apiMode');"
  );
  jsContent = jsContent.replace(
    "clientIdMode: clientIdMode.value,",
    "clientIdMode: clientIdMode.value,\n    apiMode: apiMode.value || 'imap',"
  );
  jsContent = jsContent.replace(
    "clientIdMode.value = items.clientIdMode || 'random';",
    "clientIdMode.value = items.clientIdMode || 'random';\n      if(apiMode) apiMode.value = items.apiMode || 'imap';"
  );
  fs.writeFileSync(fileOptionsJs, jsContent);
}
console.log("Options patched");

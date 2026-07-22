const fs = require('fs');
const file = 'chrome-extension/options/options.html';
let content = fs.readFileSync(file, 'utf8');

const targetStr = `      <div class="settings-group">
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

if (content.includes(targetStr)) {
  fs.writeFileSync(file, content.replace(targetStr, ""));
  console.log("Top settings group removed");
} else {
  console.log("Could not find top settings group to remove");
}

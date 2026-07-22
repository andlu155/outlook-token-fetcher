const fs = require('fs');
const file = 'chrome-extension/options/options.html';
let content = fs.readFileSync(file, 'utf8');

const targetStr = `      <div class="card-title">🔑 Client ID 配置</div>
      <div class="form-group">
        <div class="radio-group">`;

const replacement = `      <div class="card-title">🔑 Client ID 与 协议配置</div>
      <div class="form-group">
        <label>API 授权模式</label>
        <select id="apiMode" style="width: 100%; padding: 8px; margin-bottom: 12px; background: rgba(0,0,0,0.3); color: white; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <option value="graph">Microsoft Graph (默认，适合现代云端/mail.chatai.codes)</option>
          <option value="imap">IMAP/SMTP (适合大部分传统邮件客户端)</option>
        </select>
        <div class="hint" style="margin-bottom: 16px;">决定获取的 Token 支持哪种协议。如果软件不支持 IMAP，请用 Graph。</div>
      </div>
      <div class="form-group">
        <label>Client ID 选择</label>
        <div class="radio-group">`;

if (content.includes(targetStr)) {
  fs.writeFileSync(file, content.replace(targetStr, replacement));
  console.log("options.html patched successfully");
} else {
  console.log("Failed to patch options.html");
}

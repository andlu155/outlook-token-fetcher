document.addEventListener('DOMContentLoaded', () => {
  const MAX_FIXED = 10;
  const fields = [
    'backupEmail',
    'backupEmailDomain',
    'tempEmailEnabled',
    'tempEmailApiUrl',
    'tempEmailAdminPassword',
    'customClientId',
    'apiMode'
  ];

  function parseFixedList(text) {
    return String(text || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_FIXED);
  }

  function updateFixedCountHint() {
    const hint = document.getElementById('fixedEmailCountHint');
    const ta = document.getElementById('backupEmailList');
    if (!hint || !ta) return;
    const list = parseFixedList(ta.value);
    hint.textContent = `已填写 ${list.length} / ${MAX_FIXED} 个。处理账号时按列表顺序循环选用。`;
    if (list.length >= MAX_FIXED) {
      hint.style.color = 'var(--accent)';
    } else {
      hint.style.color = '';
    }
  }

  // Load
  chrome.storage.local.get([...fields, 'clientIdMode', 'backupEmailMode', 'backupEmailList'], (result) => {
    fields.forEach(f => {
      const el = document.getElementById(f);
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = !!result[f];
        } else {
          el.value = result[f] || '';
        }
      }
    });

    // Multi fixed list: prefer backupEmailList; migrate single backupEmail if needed.
    const listEl = document.getElementById('backupEmailList');
    if (listEl) {
      let list = Array.isArray(result.backupEmailList)
        ? result.backupEmailList.map((s) => String(s || '').trim()).filter(Boolean)
        : parseFixedList(result.backupEmailList);
      if (!list.length && result.backupEmail) {
        list = parseFixedList(result.backupEmail);
      }
      listEl.value = list.slice(0, MAX_FIXED).join('\n');
      updateFixedCountHint();
    }

    if (result.clientIdMode) {
      const radio = document.querySelector(`input[name="clientIdMode"][value="${result.clientIdMode}"]`);
      if (radio) radio.checked = true;
    }
    const backupMode = result.backupEmailMode === 'random' ? 'random' : 'fixed';
    const modeRadio = document.querySelector(`input[name="backupEmailMode"][value="${backupMode}"]`);
    if (modeRadio) modeRadio.checked = true;

    toggleCustomId();
    toggleBackupMode();
    updateRandomPreview();
  });

  document.querySelectorAll('input[name="clientIdMode"]').forEach(radio => {
    radio.addEventListener('change', toggleCustomId);
  });
  document.querySelectorAll('input[name="backupEmailMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      toggleBackupMode();
      updateRandomPreview();
    });
  });
  document.getElementById('backupEmailDomain')?.addEventListener('input', updateRandomPreview);
  document.getElementById('backupEmailList')?.addEventListener('input', updateFixedCountHint);

  function toggleCustomId() {
    const isCustom = document.getElementById('modeCustom').checked;
    document.getElementById('customIdContainer').style.display = isCustom ? 'block' : 'none';
  }

  function toggleBackupMode() {
    const isRandom = document.getElementById('backupModeRandom').checked;
    document.getElementById('fixedEmailGroup').style.display = isRandom ? 'none' : 'block';
    document.getElementById('randomEmailGroup').style.display = isRandom ? 'block' : 'none';
  }

  function randomLocalPart() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function updateRandomPreview() {
    const preview = document.getElementById('randomEmailPreview');
    if (!preview) return;
    const domain = (document.getElementById('backupEmailDomain').value || '').trim().replace(/^@/, '');
    if (!domain) {
      preview.textContent = '示例：请先填写域名';
      return;
    }
    preview.textContent = `示例：${randomLocalPart()}@${domain}`;
  }

  // Toggle Password Visibility
  document.getElementById('togglePasswordBtn').addEventListener('click', (e) => {
    const pwdInput = document.getElementById('tempEmailAdminPassword');
    if (pwdInput.type === 'password') {
      pwdInput.type = 'text';
      e.target.textContent = '🙈 隐藏';
    } else {
      pwdInput.type = 'password';
      e.target.textContent = '👁️ 显示';
    }
  });

  // Test API Connection
  document.getElementById('testApiBtn').addEventListener('click', async () => {
    const apiUrl = document.getElementById('tempEmailApiUrl').value.trim().replace(/\/$/, '');
    const adminPass = document.getElementById('tempEmailAdminPassword').value;
    const resultDiv = document.getElementById('apiTestResult');

    if (!apiUrl || !adminPass) {
      resultDiv.textContent = '❌ 请先填写 API 地址和密码';
      resultDiv.style.color = '#f14c4c';
      return;
    }

    resultDiv.textContent = '⏳ 正在测试连接...';
    resultDiv.style.color = '#0078d4';

    try {
      const res = await fetch(`${apiUrl}/admin/mails?limit=1&offset=0`, {
        headers: { 'x-admin-auth': adminPass }
      });

      if (res.ok) {
        resultDiv.textContent = '✅ 测试成功！成功连接到接码后台。';
        resultDiv.style.color = '#28a745';
      } else if (res.status === 401) {
        resultDiv.textContent = `❌ 测试失败：密码错误 (401)`;
        resultDiv.style.color = '#f14c4c';
      } else {
        resultDiv.textContent = `❌ 测试失败：返回状态码 ${res.status} (地址不正确或服务异常)`;
        resultDiv.style.color = '#f14c4c';
      }
    } catch (e) {
      resultDiv.textContent = `❌ 请求报错：${e.message} (跨域被拦截或网络错误)`;
      resultDiv.style.color = '#f14c4c';
    }
  });

  // Save
  document.getElementById('saveBtn').addEventListener('click', () => {
    const data = {};
    fields.forEach(f => {
      const el = document.getElementById(f);
      if (!el) return;
      data[f] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });
    data.clientIdMode = document.querySelector('input[name="clientIdMode"]:checked').value;
    data.backupEmailMode = document.querySelector('input[name="backupEmailMode"]:checked').value;
    if (data.backupEmailDomain) data.backupEmailDomain = data.backupEmailDomain.replace(/^@/, '');

    const fixedList = parseFixedList(document.getElementById('backupEmailList')?.value || '');
    data.backupEmailList = fixedList;
    // Keep legacy single field as first entry for older code paths.
    data.backupEmail = fixedList[0] || '';

    if (data.backupEmailMode === 'fixed' && !fixedList.length) {
      const status = document.getElementById('status');
      status.textContent = '⚠️ 固定模式请至少填写 1 个备用邮箱（最多 10 个）';
      status.style.color = '#f59e0b';
      return;
    }
    if (data.backupEmailMode === 'random' && !data.backupEmailDomain) {
      const status = document.getElementById('status');
      status.textContent = '⚠️ 随机模式请填写邮箱域名';
      status.style.color = '#f59e0b';
      return;
    }

    chrome.storage.local.set(data, () => {
      const status = document.getElementById('status');
      status.style.color = 'var(--success)';
      status.textContent = data.backupEmailMode === 'fixed'
        ? `✅ 设置已保存（固定备用邮箱 ${fixedList.length} 个）`
        : '✅ 设置已保存';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});

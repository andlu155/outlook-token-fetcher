document.addEventListener('DOMContentLoaded', () => {
  const MAX_FIXED = 100;
  const fields = [
    'backupEmail',
    'backupEmailDomain',
    'tempEmailEnabled',
    'tempEmailApiUrl',
    'tempEmailAdminPassword',
    'customClientId',
    'clientIdPool',
    'apiMode',
    'proxyEnabled',
    'proxyType',
    'proxyHost',
    'proxyPort',
    'proxyUsername',
    'proxyPassword',
    'paceAdvanceDelayMs',
    'paceAdvanceJitterMs',
    'paceCleanupEveryN',
    'paceCodeWaitMs',
    'paceCodePollIntervalMs',
    'paceCodePollMax'
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

  function toggleProxyFields() {
    const enabled = document.getElementById('proxyEnabled')?.checked;
    const box = document.getElementById('proxyFields');
    if (!box) return;
    // Keep fields editable so user can fill + test before enabling permanently.
    box.style.opacity = enabled ? '1' : '0.85';
  }

  function readProxyForm() {
    return {
      proxyEnabled: !!document.getElementById('proxyEnabled')?.checked,
      proxyType: document.getElementById('proxyType')?.value === 'socks5' ? 'socks5' : 'http',
      proxyHost: (document.getElementById('proxyHost')?.value || '').trim(),
      proxyPort: (document.getElementById('proxyPort')?.value || '').trim(),
      proxyUsername: (document.getElementById('proxyUsername')?.value || '').trim(),
      proxyPassword: document.getElementById('proxyPassword')?.value || ''
    };
  }

  function validateProxy(data, { requireEnabled = true } = {}) {
    if (requireEnabled && !data.proxyEnabled) return null;
    const host = (data.proxyHost || '').trim();
    const portStr = String(data.proxyPort || '').trim();
    if (!host) return '⚠️ 请填写代理主机地址';
    if (!/^\d+$/.test(portStr)) return '⚠️ 代理端口必须是数字';
    const port = Number(portStr);
    if (port < 1 || port > 65535) return '⚠️ 代理端口需在 1–65535';
    if (data.proxyType !== 'http' && data.proxyType !== 'socks5') {
      return '⚠️ 代理类型仅支持 HTTP 或 SOCKS5';
    }
    return null;
  }

  // Load
  chrome.storage.local.get([...fields, 'clientIdMode', 'backupEmailMode', 'backupEmailList'], (result) => {
    fields.forEach(f => {
      const el = document.getElementById(f);
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = !!result[f];
        } else if (f === 'apiMode') {
          el.value = result[f] || 'graph';
        } else if (f === 'proxyType') {
          el.value = result[f] === 'socks5' ? 'socks5' : 'http';
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
    toggleProxyFields();
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
  document.getElementById('proxyEnabled')?.addEventListener('change', toggleProxyFields);

  function toggleCustomId() {
    const isCustom = document.getElementById('modeCustom').checked;
    document.getElementById('customIdContainer').style.display = isCustom ? 'block' : 'none';
    const pool = document.getElementById('clientIdPoolContainer');
    if (pool) pool.style.display = isCustom ? 'none' : 'block';
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

  // Test proxy connectivity / latency
  document.getElementById('testProxyBtn')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('proxyTestResult');
    const btn = document.getElementById('testProxyBtn');
    const form = readProxyForm();
    const err = validateProxy(form, { requireEnabled: false });
    if (err) {
      resultDiv.textContent = err;
      resultDiv.style.color = '#f59e0b';
      return;
    }

    // Optional broad host permission helps proxy auth + exit IP probes.
    if (chrome.permissions?.request) {
      try {
        const origins = ['*://*/*'];
        const has = await chrome.permissions.contains({ origins });
        if (!has) await chrome.permissions.request({ origins });
      } catch (_) {}
    }

    btn.disabled = true;
    resultDiv.style.color = '#0078d4';
    resultDiv.textContent = `⏳ 正在通过 ${form.proxyType.toUpperCase()} ${form.proxyHost}:${form.proxyPort} 测试...`;

    chrome.runtime.sendMessage({
      action: 'testProxyConnection',
      proxy: form
    }, (resp) => {
      btn.disabled = false;
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        resultDiv.style.color = '#f14c4c';
        resultDiv.textContent = `❌ 测试失败：${runtimeErr.message}`;
        return;
      }
      if (!resp || resp.ok === false) {
        resultDiv.style.color = '#f14c4c';
        resultDiv.textContent = `❌ 连接失败：${resp?.error || '未知错误'}`;
        return;
      }
      resultDiv.style.color = '#28a745';
      const ipPart = resp.ip ? ` · 出口 IP ${resp.ip}` : '';
      const regionPart = resp.region ? ` · 地区 ${resp.region}` : '';
      const msPart = typeof resp.latencyMs === 'number' ? `${resp.latencyMs} ms` : '—';
      const urlPart = resp.url ? ` · ${resp.url}` : '';
      const ctxPart = resp.context ? ` · ${resp.context}` : '';
      const notePart = resp.note ? ` · ${resp.note}` : '';
      resultDiv.textContent = `✅ 连接正常 · 延迟 ${msPart}${ipPart}${regionPart}${urlPart}${ctxPart}${notePart}`;
    });
  });

  // Emergency reset browser proxy settings to system default
  document.getElementById('resetProxyBtn')?.addEventListener('click', () => {
    const resultDiv = document.getElementById('proxyTestResult');
    if (!resultDiv) return;
    resultDiv.style.color = '#0078d4';
    resultDiv.textContent = '⏳ 正在清空代理设置并恢复系统网络...';
    chrome.runtime.sendMessage({ action: 'resetProxy' }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resultDiv.style.color = '#f14c4c';
        resultDiv.textContent = `❌ 重置代理失败: ${err.message}`;
        return;
      }
      const chk = document.getElementById('proxyEnabled');
      if (chk) chk.checked = false;
      toggleProxyFields();
      resultDiv.style.color = '#28a745';
      resultDiv.textContent = '✅ 已清除 Chrome 代理接管，恢复系统默认网络！';
      setTimeout(() => { resultDiv.textContent = ''; }, 4000);
    });
  });

  function normalizeOriginPattern(raw) {
    let url = String(raw || '').trim().replace(/\/$/, '');
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/*`;
    } catch (_) {
      return '';
    }
  }

  async function ensureApiHostPermission(apiUrl) {
    const origin = normalizeOriginPattern(apiUrl);
    if (!origin || !chrome.permissions?.request) return { ok: true };
    try {
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (has) return { ok: true, already: true };
      const granted = await chrome.permissions.request({ origins: [origin] });
      return { ok: granted, granted, origin };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

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

    resultDiv.textContent = '⏳ 正在请求主机权限并测试连接...';
    resultDiv.style.color = '#0078d4';

    const perm = await ensureApiHostPermission(apiUrl);
    if (!perm.ok) {
      resultDiv.textContent = `❌ 未授予接码 API 访问权限${perm.error ? `（${perm.error}）` : '（请在弹窗中允许）'}`;
      resultDiv.style.color = '#f14c4c';
      return;
    }

    try {
      let base = apiUrl;
      if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
      base = base.replace(/\/$/, '');
      const res = await fetch(`${base}/admin/mails?limit=1&offset=0`, {
        headers: { 'x-admin-auth': adminPass }
      });

      if (res.ok) {
        resultDiv.textContent = '✅ 测试成功！已授权并连接到接码后台。';
        resultDiv.style.color = '#28a745';
      } else if (res.status === 401) {
        resultDiv.textContent = `❌ 测试失败：密码错误 (401)`;
        resultDiv.style.color = '#f14c4c';
      } else {
        resultDiv.textContent = `❌ 测试失败：返回状态码 ${res.status} (地址不正确或服务异常)`;
        resultDiv.style.color = '#f14c4c';
      }
    } catch (e) {
      resultDiv.textContent = `❌ 请求报错：${e.message} (权限/跨域/网络)`;
      resultDiv.style.color = '#f14c4c';
    }
  });

  function runClear(mode, confirmMsg) {
    const resultDiv = document.getElementById('clearDataResult');
    if (!confirm(confirmMsg)) return;
    chrome.runtime.sendMessage({ action: 'clearSensitiveData', mode }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resultDiv.style.color = '#f14c4c';
        resultDiv.textContent = `❌ ${err.message}`;
        return;
      }
      if (!resp?.ok) {
        resultDiv.style.color = '#f14c4c';
        resultDiv.textContent = '❌ 清理失败';
        return;
      }
      resultDiv.style.color = '#28a745';
      const labels = { results: '处理结果', secrets: '敏感配置', all: '结果+敏感配置+队列' };
      resultDiv.textContent = `✅ 已清空：${labels[mode] || mode}`;
      if (mode === 'secrets' || mode === 'all') {
        // Reflect cleared secret fields in UI
        const pwd = document.getElementById('tempEmailAdminPassword');
        const pp = document.getElementById('proxyPassword');
        const pu = document.getElementById('proxyUsername');
        const cid = document.getElementById('customClientId');
        if (pwd) pwd.value = '';
        if (pp) pp.value = '';
        if (pu) pu.value = '';
        if (cid) cid.value = '';
      }
      setTimeout(() => { resultDiv.textContent = ''; }, 4000);
    });
  }

  document.getElementById('clearResultsOptBtn')?.addEventListener('click', () => {
    runClear('results', '确定清空全部处理结果（含 token）？');
  });
  document.getElementById('clearSecretsBtn')?.addEventListener('click', () => {
    runClear('secrets', '确定清空敏感配置（接码密码、代理账密、Client ID、侧栏账号缓存等）？备用邮箱列表会保留。');
  });
  document.getElementById('clearAllSensitiveBtn')?.addEventListener('click', () => {
    runClear('all', '确定全部清空？将删除结果、敏感配置与批处理队列。');
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
    data.proxyType = data.proxyType === 'socks5' ? 'socks5' : 'http';
    data.proxyEnabled = !!data.proxyEnabled;

    const fixedList = parseFixedList(document.getElementById('backupEmailList')?.value || '');
    data.backupEmailList = fixedList;
    // Keep legacy single field as first entry for older code paths.
    data.backupEmail = fixedList[0] || '';

    const status = document.getElementById('status');
    if (data.backupEmailMode === 'fixed' && !fixedList.length) {
      status.textContent = '⚠️ 固定模式请至少填写 1 个备用邮箱（最多 100 个）';
      status.style.color = '#f59e0b';
      return;
    }
    if (data.backupEmailMode === 'random' && !data.backupEmailDomain) {
      status.textContent = '⚠️ 随机模式请填写邮箱域名';
      status.style.color = '#f59e0b';
      return;
    }
    const proxyErr = validateProxy(data);
    if (proxyErr) {
      status.textContent = proxyErr;
      status.style.color = '#f59e0b';
      return;
    }

    // Request host permission for temp-mail API when enabled (non-blocking if denied — test button also requests).
    if (data.tempEmailEnabled && data.tempEmailApiUrl) {
      ensureApiHostPermission(data.tempEmailApiUrl).catch(() => {});
    }

    chrome.storage.local.set(data, () => {
      // Apply proxy via background so auth listener stays in SW.
      chrome.runtime.sendMessage({ action: 'applyProxySettings' }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          status.style.color = '#f59e0b';
          status.textContent = `⚠️ 设置已保存，但代理应用失败: ${err.message}`;
          return;
        }
        if (resp && resp.ok === false) {
          status.style.color = '#f59e0b';
          status.textContent = `⚠️ 设置已保存，但代理应用失败: ${resp.error || '未知错误'}`;
          return;
        }
        let msg = data.backupEmailMode === 'fixed'
          ? `✅ 设置已保存（固定备用邮箱 ${fixedList.length} 个）`
          : '✅ 设置已保存';
        if (data.proxyEnabled) {
          status.style.color = 'var(--success)';
          msg += ` · 代理已启用 ${data.proxyType.toUpperCase()} ${data.proxyHost}:${data.proxyPort}`;
          status.textContent = msg;
          setTimeout(() => { status.textContent = ''; }, 3000);
        } else if ((data.proxyHost || '').trim() && String(data.proxyPort || '').trim()) {
          // Filled but not enabled — easy to miss the checkbox.
          status.style.color = '#f59e0b';
          status.textContent = `${msg} · 代理地址已填写但未启用。请勾选上方「启用代理」后再保存，浏览器才会走代理`;
        } else {
          status.style.color = 'var(--success)';
          msg += ' · 未启用代理';
          status.textContent = msg;
          setTimeout(() => { status.textContent = ''; }, 3000);
        }
      });
    });
  });
});

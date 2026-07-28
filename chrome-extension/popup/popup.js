// popup.js — Simplified 4-step progress UI with step-by-step click support
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  const els = {
    accountInput: $('accountInput'),
    accountCount: $('accountCount'),
    startBtn: $('startBtn'),
    pauseBtn: $('pauseBtn'),
    resumeBtn: $('resumeBtn'),
    stopBtn: $('stopBtn'),
    skipBtn: $('skipBtn'),
    nextAccountBtn: $('nextAccountBtn'),
    settingsBtn: $('settingsBtn'),
    logContainer: $('logContainer'),
    clearLogBtn: $('clearLogBtn'),
    resultsOutput: $('resultsOutput'),
    resultCount: $('resultCount'),
    resultSortSelect: $('resultSortSelect'),
    copyResultsBtn: $('copyResultsBtn'),
    copySuccessBtn: $('copySuccessBtn'),
    exportResultsBtn: $('exportResultsBtn'),
    retryFailedBtn: $('retryFailedBtn'),
    clearResultsBtn: $('clearResultsBtn'),
    parseHint: $('parseHint'),
    currentAccountText: $('currentAccountText'),
    progressText: $('progressText'),
    step1: $('step1'), step2: $('step2'), step3: $('step3'), step4: $('step4'),
    conn1: $('conn1'), conn2: $('conn2'), conn3: $('conn3'),
    modeAuto: $('modeAuto'), modeManual: $('modeManual'), modeHint: $('modeHint'),
  };

  let currentMode = 'auto';
  const modeHints = {
    auto: '自动模式：步骤 1-4 全自动（含换取令牌）；备用邮箱验证成功后会重开授权页',
    'step-by-step': '逐步骤模式：点步骤圆圈执行。步骤 1 打开/重开授权页，步骤 3 可多次点，步骤 4 获取令牌',
  };

  const steps = [null, els.step1, els.step2, els.step3, els.step4];
  const conns = [null, null, els.conn1, els.conn2, els.conn3];
  let totalAccounts = 0;
  let uiState = 'idle'; // idle | running | paused
  // Ordered result records for sort (execution order preserved via seq).
  let resultRecords = [];
  let resultSeq = 0;
  let resultSortMode = 'order'; // 'order' | 'status'

  // ============== Mode switching ==============
  function setMode(mode) {
    currentMode = mode;
    els.modeAuto.classList.toggle('mode-active', mode === 'auto');
    els.modeManual.classList.toggle('mode-active', mode === 'step-by-step');
    els.modeHint.textContent = modeHints[mode];
    chrome.storage.local.set({ execMode: mode });
    updateStepClickability();
  }
  els.modeAuto.addEventListener('click', () => setMode('auto'));
  els.modeManual.addEventListener('click', () => setMode('step-by-step'));

  // Load saved mode / queue / results (results are persisted in storage so accidental panel/window close does not wipe them)
  chrome.storage.local.get([
    'savedAccounts', 'sw_running', 'sw_paused', 'execMode',
    'sw_current', 'sw_queue', 'sw_results', 'resultSortMode'
  ], (r) => {
    if (r.savedAccounts) els.accountInput.value = r.savedAccounts;
    if (r.execMode) setMode(r.execMode);
    if (r.resultSortMode === 'status' || r.resultSortMode === 'order') {
      resultSortMode = r.resultSortMode;
      if (els.resultSortSelect) els.resultSortSelect.value = resultSortMode;
    }
    updateCount();

    // Restore prior batch results after side panel / window reopen.
    restoreResultsFromStorage(r.sw_results);

    function applyProgress(done, remaining, hasCurrent) {
      const total = done + remaining + (hasCurrent ? 1 : 0);
      if (total) {
        totalAccounts = total;
        els.progressText.textContent = `${done}/${total}`;
      }
    }

    // Prefer live SW status (handles window-crash → auto-pause).
    chrome.runtime.sendMessage({ action: 'getTaskStatus' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        // Fallback to storage flags if SW is unavailable.
        if (r.sw_paused || (r.sw_running && (r.sw_current || (r.sw_queue && r.sw_queue.length)))) {
          setUiState('paused');
          if (r.sw_current?.email) els.currentAccountText.textContent = r.sw_current.email + '（已暂停）';
          applyProgress(
            resultRecords.length,
            Array.isArray(r.sw_queue) ? r.sw_queue.length : 0,
            !!r.sw_current
          );
          addLog('任务已中断并暂停，可点“继续”恢复', 'warning');
        } else if (r.sw_running) {
          setUiState('running');
          if (r.sw_current?.email) els.currentAccountText.textContent = r.sw_current.email;
          applyProgress(
            resultRecords.length,
            Array.isArray(r.sw_queue) ? r.sw_queue.length : 0,
            !!r.sw_current
          );
        } else {
          setUiState('idle');
        }
        return;
      }

      // Prefer fresher results from SW if present.
      if (Array.isArray(status.results) && status.results.length && !resultRecords.length) {
        restoreResultsFromStorage(status.results);
      }
      if (status.stats) renderStats(status.stats);
      else refreshStats();

      if (status.running) {
        setUiState('running');
        if (status.account) els.currentAccountText.textContent = status.account;
        applyProgress(status.done || resultRecords.length, status.queueLen || 0, !!status.account);
      } else if (status.paused || status.hasWork) {
        setUiState('paused');
        if (status.account) els.currentAccountText.textContent = status.account + '（已暂停）';
        applyProgress(status.done || resultRecords.length, status.queueLen || 0, !!status.account);
        addLog('任务已暂停（含异常关闭恢复），可点“继续”从当前账号恢复', 'warning');
      } else {
        setUiState('idle');
        // Only clear residual queue when truly idle with no work.
        chrome.storage.local.remove(['sw_current', 'sw_queue']);
      }
    });
  });

  // Account count + live precheck
  let parseTimer = null;
  els.accountInput.addEventListener('input', () => {
    updateCount();
    clearTimeout(parseTimer);
    parseTimer = setTimeout(runAccountPrecheck, 280);
  });
  function updateCount() {
    const lines = els.accountInput.value.split('\n').map(l => l.trim()).filter(l => l);
    els.accountCount.textContent = lines.length;
    chrome.storage.local.set({ savedAccounts: els.accountInput.value });
  }

  function localParseAccounts(text) {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const lines = String(text || '').split('\n');
    const valid = [];
    const invalid = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const p = raw.split(/----|:|\|/);
      const email = (p[0] || '').trim();
      const password = (p[1] || '').trim();
      if (!email || !password) {
        invalid.push({ line: i + 1, reason: '缺少邮箱或密码' });
        continue;
      }
      if (!emailRe.test(email)) {
        invalid.push({ line: i + 1, reason: '邮箱格式无效' });
        continue;
      }
      const key = email.toLowerCase();
      if (seen.has(key)) {
        invalid.push({ line: i + 1, reason: '重复邮箱' });
        continue;
      }
      seen.add(key);
      valid.push(email);
    }
    return { valid, invalid, validCount: valid.length, invalidCount: invalid.length };
  }

  function runAccountPrecheck() {
    if (!els.parseHint) return;
    const text = els.accountInput.value;
    if (!text.trim()) {
      els.parseHint.hidden = true;
      els.parseHint.textContent = '';
      return;
    }
    const p = localParseAccounts(text);
    els.parseHint.hidden = false;
    if (!p.validCount && p.invalidCount) {
      els.parseHint.className = 'parse-hint warn';
      const sample = p.invalid.slice(0, 3).map((x) => `L${x.line} ${x.reason}`).join('；');
      els.parseHint.textContent = `预检：0 有效，${p.invalidCount} 行无效（${sample}）`;
    } else if (p.invalidCount) {
      els.parseHint.className = 'parse-hint warn';
      const sample = p.invalid.slice(0, 3).map((x) => `L${x.line} ${x.reason}`).join('；');
      els.parseHint.textContent = `预检：${p.validCount} 有效，跳过 ${p.invalidCount} 行（${sample}${p.invalidCount > 3 ? '…' : ''}）`;
    } else {
      els.parseHint.className = 'parse-hint ok';
      els.parseHint.textContent = `预检：${p.validCount} 个账号格式有效`;
    }
  }

  function updateRetryButton() {
    const failed = resultRecords.filter((r) => !r.success);
    if (els.retryFailedBtn) {
      els.retryFailedBtn.disabled = !(failed.length && uiState === 'idle');
      els.retryFailedBtn.textContent = failed.length ? `重跑失败(${failed.length})` : '重跑失败';
    }
    if (els.clearResultsBtn) {
      els.clearResultsBtn.disabled = resultRecords.length === 0 && !els.resultsOutput.value.trim();
    }
  }

  // ============== Step circles ==============
  function updateStepClickability() {
    for (let i = 1; i <= 4; i++) {
      const item = steps[i];
      if (!item) continue;
      const circle = item.querySelector('.step-circle');
      if (!circle) continue;
      const allowClick = i === 1 || i === 4 || currentMode === 'step-by-step';
      if (allowClick) {
        item.classList.add('clickable-step');
        item.title = i === 1
          ? '点击重新打开授权页'
          : i === 4
            ? (currentMode === 'auto' ? '自动模式下授权码就绪后会自动换取；也可手动点击' : '点击获取令牌（需先完成授权）')
            : `点击执行步骤 ${i}`;
      } else {
        item.classList.remove('clickable-step');
        item.title = '';
      }
    }
  }

  function onStepClick(stepNum) {
    if (stepNum !== 1 && stepNum !== 4 && currentMode !== 'step-by-step') return;
    addLog(`📤 触发步骤 ${stepNum}/4...`, 'info');
    chrome.runtime.sendMessage({ action: 'executeStep', step: stepNum });
    setStep(stepNum, 'active');
  }

  for (let i = 1; i <= 4; i++) {
    if (steps[i]) steps[i].addEventListener('click', () => onStepClick(i));
  }

  function resetSteps() {
    for (let i = 1; i <= 4; i++) {
      const circle = steps[i]?.querySelector('.step-circle');
      if (circle) { circle.className = 'step-circle pending'; circle.textContent = i; }
    }
    for (let i = 2; i <= 4; i++) {
      if (conns[i]) conns[i].className = 'step-connector';
    }
  }

  function setStep(n, status) {
    const circle = steps[n]?.querySelector('.step-circle');
    if (!circle) return;
    circle.className = 'step-circle ' + status;
    if (status === 'completed' || status === 'error') {
      circle.textContent = status === 'completed' ? '✓' : '✗';
    } else {
      circle.textContent = n;
    }
    if (n > 1 && conns[n]) conns[n].className = 'step-connector' + (status === 'completed' ? ' completed' : '');
  }

  function setUiState(state) {
    uiState = state;
    const running = state === 'running';
    const paused = state === 'paused';
    els.startBtn.disabled = running || paused;
    if (els.pauseBtn) els.pauseBtn.disabled = !running;
    if (els.resumeBtn) els.resumeBtn.disabled = !paused;
    els.stopBtn.disabled = !(running || paused);
    els.skipBtn.disabled = !running;
    // 下一个账号：自动/逐步骤/暂停均可点，强制切到队列下一号
    if (els.nextAccountBtn) els.nextAccountBtn.disabled = !(running || paused);
    els.accountInput.disabled = running;
    updateRetryButton();
  }

  // ============== Actions ==============
  els.startBtn.addEventListener('click', () => {
    const rawLines = els.accountInput.value.split('\n').map(l => l.trim()).filter(l => l);
    if (!rawLines.length) return;
    const pre = localParseAccounts(els.accountInput.value);
    if (!pre.validCount) {
      addLog('没有有效账号（需要 邮箱----密码，且邮箱格式正确）', 'error');
      runAccountPrecheck();
      return;
    }
    if (pre.invalidCount) {
      addLog(`预检将跳过 ${pre.invalidCount} 行无效/重复账号`, 'warning');
    }
    totalAccounts = pre.validCount;
    setUiState('running');
    resetSteps();
    setStep(1, 'active');
    resultRecords = [];
    resultSeq = 0;
    els.resultsOutput.value = '';
    els.resultCount.textContent = '0';
    clearLog();
    const modeLabel = currentMode === 'auto' ? '自动' : '逐步骤';
    addLog(`开始处理 ${pre.validCount} 个有效账号，模式: ${modeLabel}`, 'info');
    chrome.runtime.sendMessage({ action: 'start', accounts: rawLines, mode: currentMode });
  });

  els.pauseBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'pause' });
    addLog('正在暂停任务（保留当前账号与队列）...', 'warning');
  });

  els.resumeBtn?.addEventListener('click', () => {
    setUiState('running');
    addLog('正在继续任务...', 'info');
    chrome.runtime.sendMessage({ action: 'resume', mode: currentMode });
  });

  els.stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stop' });
    addLog('正在停止任务（清空队列）...', 'warning');
  });

  els.skipBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'skipCurrentStep' });
    addLog('已发送跳过指令', 'warning');
  });

  els.nextAccountBtn?.addEventListener('click', () => {
    addLog('⏭ 正在切换到下一个账号...', 'warning');
    setUiState('running');
    resetSteps();
    setStep(1, 'active');
    chrome.runtime.sendMessage({ action: 'skipToNextAccount', reason: '用户手动切换到下一个账号' });
  });

  els.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'log':
        addLog(msg.message, msg.level);
        break;
      case 'stepUpdate':
        setStep(msg.step, msg.status);
        if (msg.account) els.currentAccountText.textContent = msg.account;
        if (msg.status === 'completed' && msg.step < 4 && currentMode === 'auto') {
          setStep(msg.step + 1, 'active');
        }
        if (msg.status === 'completed' && msg.step === 3 && currentMode === 'step-by-step') {
          setStep(4, 'pending');
          addLog('步骤 3 可重复执行；授权码就绪后请手动点击“步骤 4”获取令牌', 'info');
        }
        break;
      case 'tokenReady':
        setStep(3, 'completed');
        setStep(4, 'active');
        if (msg.account) els.currentAccountText.textContent = msg.account;
        if (msg.auto || currentMode === 'auto') {
          addLog('授权码已就绪，正在自动换取令牌...', 'success');
        } else {
          addLog('授权码已就绪，请点击“步骤 4”获取令牌', 'success');
        }
        break;
      case 'accountResult':
        appendResult(msg.result);
        break;
      case 'stats':
        if (msg.stats) renderStats(msg.stats);
        else refreshStats();
        break;
      case 'started':
        setUiState('running');
        if (msg.total) els.progressText.textContent = `1/${msg.total}`;
        break;
      case 'finished':
        setUiState('idle');
        addLog('✅ 所有账号处理完毕！', 'success');
        els.currentAccountText.textContent = '完成';
        els.progressText.textContent = '';
        break;
      case 'paused':
        setUiState(msg.resumable === false ? 'idle' : 'paused');
        if (msg.account) els.currentAccountText.textContent = msg.account + '（已暂停）';
        addLog(
          msg.resumable === false
            ? '任务已停止'
            : `任务已暂停${msg.remaining != null ? `（剩余 ${msg.remaining}）` : ''}，可点“继续”`,
          'warning'
        );
        break;
      case 'resumed':
        setUiState('running');
        if (msg.account) els.currentAccountText.textContent = msg.account;
        addLog('任务已继续', 'success');
        break;
      case 'stopped':
        setUiState('idle');
        addLog('任务已停止（队列已清空）', 'warning');
        break;
    }
  });

  function formatResultLine(rec) {
    if (rec.success) {
      return `${rec.email}----${rec.password}----${rec.clientId || '内置ID'}----${rec.token}`;
    }
    return `${rec.email}----${rec.password}----FAILED----${rec.error || ''}`;
  }

  function getSortedResultRecords() {
    const list = resultRecords.slice();
    if (resultSortMode === 'status') {
      // Success group first, then failed; keep execution order within each group.
      list.sort((a, b) => {
        if (a.success !== b.success) return a.success ? -1 : 1;
        return a.seq - b.seq;
      });
    } else {
      list.sort((a, b) => a.seq - b.seq);
    }
    return list;
  }

  function renderResults() {
    const sorted = getSortedResultRecords();
    els.resultsOutput.value = sorted.map(formatResultLine).join('\n');
    els.resultCount.textContent = String(sorted.length);
    if (totalAccounts) els.progressText.textContent = `${sorted.length}/${totalAccounts}`;
    els.resultsOutput.scrollTop = els.resultsOutput.scrollHeight;
    updateRetryButton();
  }

  function normalizeStoredResult(r, seq) {
    return {
      seq,
      success: !!r.success,
      email: String(r.email || ''),
      password: r.password || '',
      clientId: r.clientId || '',
      token: r.token || '',
      error: r.error || ''
    };
  }

  function restoreResultsFromStorage(list) {
    if (!Array.isArray(list) || !list.length) return;
    resultRecords = [];
    resultSeq = 0;
    for (const raw of list) {
      const email = String(raw?.email || '');
      if (!email) continue;
      // Prefer success over later failures for same email (same rules as appendResult).
      if (raw.success) {
        resultRecords = resultRecords.filter((x) => x.email !== email);
      } else if (resultRecords.some((x) => x.email === email && x.success)) {
        continue;
      } else {
        resultRecords = resultRecords.filter((x) => !(x.email === email && !x.success));
      }
      resultRecords.push(normalizeStoredResult(raw, ++resultSeq));
    }
    renderResults();
    if (resultRecords.length) {
      addLog(`已恢复上次处理结果 ${resultRecords.length} 条（侧栏/窗口关闭后仍保留）`, 'info');
      refreshStats();
    }
  }

  function appendResult(r) {
    const email = String(r.email || '');
    if (!email) return;

    // If already success for this email, ignore later failures.
    if (!r.success) {
      if (resultRecords.some((x) => x.email === email && x.success)) return;
    }

    // On success, drop any prior failure/duplicate for same email.
    if (r.success) {
      resultRecords = resultRecords.filter((x) => x.email !== email);
    } else {
      // Keep only latest failure per email when not success.
      resultRecords = resultRecords.filter((x) => !(x.email === email && !x.success));
    }

    resultRecords.push(normalizeStoredResult(r, ++resultSeq));
    renderResults();
    refreshStats();
  }

  function summarizeLocal() {
    const list = resultRecords;
    const success = list.filter((r) => r.success).length;
    const failed = list.length - success;
    const reasons = {};
    for (const r of list) {
      if (r.success) continue;
      let key = String(r.error || '未知').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (/密码|password/i.test(key)) key = '密码/登录失败';
      else if (/请求过多|rate|too many/i.test(key)) key = '限流';
      else if (/人机|机器人/i.test(key)) key = '人机验证';
      else if (/网络|SSL|硬错误|proxy/i.test(key)) key = '网络/代理';
      else if (/用户|跳过|切换/i.test(key)) key = '用户跳过';
      reasons[key] = (reasons[key] || 0) + 1;
    }
    const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([reason, count]) => ({ reason, count }));
    return {
      total: list.length,
      success,
      failed,
      successRate: list.length ? Math.round((success / list.length) * 1000) / 10 : 0,
      topReasons,
    };
  }

  function renderStats(stats) {
    const card = document.getElementById('statsCard');
    const summary = document.getElementById('statsSummary');
    const reasonsEl = document.getElementById('statsReasons');
    if (!card || !summary) return;
    if (!stats || !stats.total) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    summary.textContent = `成功 ${stats.success} · 失败 ${stats.failed} · 合计 ${stats.total} · 成功率 ${stats.successRate}%`;
    if (reasonsEl) {
      reasonsEl.innerHTML = '';
      for (const item of stats.topReasons || []) {
        const chip = document.createElement('span');
        chip.className = 'stats-chip';
        chip.textContent = `${item.reason} ×${item.count}`;
        reasonsEl.appendChild(chip);
      }
    }
  }

  function refreshStats() {
    renderStats(summarizeLocal());
  }

  if (els.resultSortSelect) {
    els.resultSortSelect.addEventListener('change', () => {
      resultSortMode = els.resultSortSelect.value === 'status' ? 'status' : 'order';
      chrome.storage.local.set({ resultSortMode });
      renderResults();
      addLog(
        resultSortMode === 'status' ? '处理结果已按状态分组（成功在前）' : '处理结果已按执行先后排序',
        'info'
      );
    });
  }

  function addLog(message, level = 'info') {
    const el = document.createElement('div');
    el.className = `log-line ${level}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    el.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escapeHtml(message)}</span>`;
    els.logContainer.appendChild(el);
    els.logContainer.scrollTop = els.logContainer.scrollHeight;
    while (els.logContainer.children.length > 200) els.logContainer.removeChild(els.logContainer.firstChild);
  }
  function clearLog() { els.logContainer.innerHTML = ''; }
  els.clearLogBtn.addEventListener('click', clearLog);

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function copyText(text, okMsg) {
    if (!String(text || '').trim()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      els.resultsOutput.value = text;
      els.resultsOutput.select();
      document.execCommand('copy');
    }
    addLog(okMsg || '已复制', 'success');
  }

  els.copyResultsBtn.addEventListener('click', () => {
    copyText(els.resultsOutput.value, '结果已复制');
  });

  els.copySuccessBtn?.addEventListener('click', () => {
    const lines = getSortedResultRecords().filter((r) => r.success).map(formatResultLine).join('\n');
    if (!lines.trim()) {
      addLog('没有成功结果可复制', 'warning');
      return;
    }
    copyText(lines, `已复制 ${lines.split('\n').length} 条成功结果`);
  });

  els.exportResultsBtn.addEventListener('click', () => {
    const text = els.resultsOutput.value;
    if (!text.trim()) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tokens_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    addLog('结果已导出（建议导出后清空结果）', 'success');
  });

  els.clearResultsBtn?.addEventListener('click', () => {
    if (!resultRecords.length && !els.resultsOutput.value.trim()) return;
    if (!confirm('确定清空全部处理结果？（本地持久化也会删除，不可恢复）')) return;
    resultRecords = [];
    resultSeq = 0;
    els.resultsOutput.value = '';
    els.resultCount.textContent = '0';
    updateRetryButton();
    refreshStats();
    chrome.runtime.sendMessage({ action: 'clearResults' }, () => {
      addLog('处理结果已清空', 'warning');
    });
  });

  els.retryFailedBtn?.addEventListener('click', () => {
    if (uiState !== 'idle') {
      addLog('请先停止当前任务再重跑失败项', 'warning');
      return;
    }
    const failed = resultRecords.filter((r) => !r.success && r.email && r.password);
    if (!failed.length) {
      addLog('没有带密码的失败记录可重跑（请从账号框重新粘贴）', 'warning');
      return;
    }
    const lines = failed.map((r) => `${r.email}----${r.password}`);
    // Prefill input for visibility
    els.accountInput.value = lines.join('\n');
    updateCount();
    runAccountPrecheck();
    totalAccounts = resultRecords.filter((r) => r.success).length + lines.length;
    setUiState('running');
    resetSteps();
    setStep(1, 'active');
    // Keep success rows; drop failure rows locally (SW will re-broadcast)
    resultRecords = resultRecords.filter((r) => r.success);
    resultSeq = resultRecords.length;
    renderResults();
    clearLog();
    addLog(`重跑 ${lines.length} 个失败账号（已成功 ${resultRecords.length} 条保留）`, 'info');
    chrome.runtime.sendMessage({
      action: 'retryFailed',
      accounts: lines,
      mode: currentMode
    }, (resp) => {
      if (chrome.runtime.lastError) {
        setUiState('idle');
        addLog(`重跑失败: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      if (resp && resp.ok === false) {
        setUiState('idle');
        addLog(`重跑失败: ${resp.error || '未知错误'}`, 'error');
      }
    });
  });

  // Initial precheck if saved accounts exist
  setTimeout(() => {
    updateCount();
    runAccountPrecheck();
    updateRetryButton();
  }, 0);
});

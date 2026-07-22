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
    settingsBtn: $('settingsBtn'),
    logContainer: $('logContainer'),
    clearLogBtn: $('clearLogBtn'),
    resultsOutput: $('resultsOutput'),
    resultCount: $('resultCount'),
    copyResultsBtn: $('copyResultsBtn'),
    exportResultsBtn: $('exportResultsBtn'),
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

  // Load saved mode / queue state (results stay in the panel only; no auto local files)
  chrome.storage.local.get([
    'savedAccounts', 'sw_running', 'sw_paused', 'execMode',
    'sw_current', 'sw_queue'
  ], (r) => {
    if (r.savedAccounts) els.accountInput.value = r.savedAccounts;
    if (r.execMode) setMode(r.execMode);
    updateCount();
    
    // 强制清理残留状态：如果后台脚本并没有真的在运行（或者重启了浏览器），不能仅仅因为 sw_current 残留就变为 paused
    // 我们必须信任 sw_running 或 sw_paused，如果两者都不为 true，强制进入 idle
    if (r.sw_running) {
      setUiState('running');
    } else if (r.sw_paused) {
      setUiState('paused');
      if (r.sw_current?.email) els.currentAccountText.textContent = r.sw_current.email + '（已暂停）';
    } else {
      setUiState('idle');
      // 可以顺手清理一下残留队列
      chrome.storage.local.remove(['sw_current', 'sw_queue']);
    }
  });

  // Account count
  els.accountInput.addEventListener('input', updateCount);
  function updateCount() {
    const lines = els.accountInput.value.split('\n').map(l => l.trim()).filter(l => l);
    els.accountCount.textContent = lines.length;
    chrome.storage.local.set({ savedAccounts: els.accountInput.value });
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
    els.startBtn.disabled = running;
    if (els.pauseBtn) els.pauseBtn.disabled = !running;
    if (els.resumeBtn) els.resumeBtn.disabled = !paused;
    els.stopBtn.disabled = !(running || paused);
    els.skipBtn.disabled = !running;
    els.accountInput.disabled = running;
  }

  // ============== Actions ==============
  els.startBtn.addEventListener('click', () => {
    const lines = els.accountInput.value.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) return;
    totalAccounts = lines.length;
    setUiState('running');
    resetSteps();
    setStep(1, 'active');
    els.resultsOutput.value = '';
    els.resultCount.textContent = '0';
    clearLog();
    const modeLabel = currentMode === 'auto' ? '自动' : '逐步骤';
    addLog(`开始处理 ${lines.length} 个账号，模式: ${modeLabel}`, 'info');
    chrome.runtime.sendMessage({ action: 'start', accounts: lines, mode: currentMode });
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

  function appendResult(r) {
    const lines = els.resultsOutput.value.split('\n').filter((l) => l.trim());
    if (!r.success) {
      const hasSuccess = lines.some((l) => l.startsWith(r.email + '----') && !l.includes('----FAILED----'));
      if (hasSuccess) return;
    } else {
      const filtered = lines.filter((l) => !(l.startsWith(r.email + '----') && l.includes('----FAILED----')));
      const withoutDup = filtered.filter((l) => !l.startsWith(r.email + '----'));
      els.resultsOutput.value = withoutDup.join('\n');
    }

    const line = r.success
      ? `${r.email}----${r.password}----${r.clientId || '内置ID'}----${r.token}`
      : `${r.email}----${r.password}----FAILED----${r.error}`;
    const current = els.resultsOutput.value.trim();
    els.resultsOutput.value = current ? current + '\n' + line : line;
    els.resultsOutput.scrollTop = els.resultsOutput.scrollHeight;
    const count = els.resultsOutput.value.split('\n').filter(l => l.trim()).length;
    els.resultCount.textContent = count;
    if (totalAccounts) els.progressText.textContent = `${count}/${totalAccounts}`;
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

  els.copyResultsBtn.addEventListener('click', async () => {
    if (!els.resultsOutput.value.trim()) return;
    try {
      await navigator.clipboard.writeText(els.resultsOutput.value);
    } catch (_) {
      els.resultsOutput.select();
      document.execCommand('copy');
    }
    addLog('结果已复制', 'success');
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
  });
});

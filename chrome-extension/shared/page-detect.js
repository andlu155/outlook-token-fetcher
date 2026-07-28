/**
 * Pure page text detectors (no DOM). Used by tests + can be mirrored in content.
 * Content script still uses DOM-aware classifyPage; these cover skip/hard-fail copy.
 */

export function detectRateLimitFromText(title, body) {
  const hay = (`${title || ''} | ${body || ''}`).slice(0, 4000);
  const rules = [
    { re: /too\s*many\s*requests/i, label: 'Too Many Requests' },
    { re: /请求过多|请求次数过多|请求太频繁|访问过于频繁|访问次数过多|操作过于频繁|频率过高/i, label: '请求过多' },
    { re: /rate\s*limit(?:ed|ing)?|throttl(?:e|ed|ing)|http\s*429|status\s*code\s*429/i, label: 'rate limited' },
  ];
  for (const { re, label } of rules) {
    if (re.test(hay)) {
      const fromTitle = title && re.test(title) ? String(title).trim() : '';
      const fromBody = (String(body || '').match(re) || [])[0] || '';
      return (fromTitle || fromBody || label).replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  return null;
}

export function detectTryLaterFromText(title, body) {
  const hay = (`${title || ''} | ${body || ''}`).slice(0, 4000);
  const rules = [
    { re: /请稍后重试|请稍后再试|稍后再试/i, label: '请稍后重试' },
    { re: /目前无法使[你您]登录|暂时无法使[你您]登录|目前无法登录|暂时无法登录|无法使[你您]登录/i, label: '目前无法使你登录' },
    { re: /we (can'?t|cannot) sign you in( right now)?|unable to sign you in|try again later|please try again later/i, label: 'try again later' },
    { re: /something went wrong.*try again|出了点问题.*稍[后後]再试/i, label: '出了点问题，请稍后重试' },
  ];
  for (const { re, label } of rules) {
    if (re.test(hay)) {
      const fromTitle = title && re.test(title) ? String(title).trim() : '';
      const fromBody = (String(body || '').match(re) || [])[0] || '';
      return (fromTitle || fromBody || label).replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  return null;
}

export function detectPasswordFailureFromText(body, snippets = []) {
  const hay = (snippets.join(' | ') + ' | ' + String(body || '')).slice(0, 6000);
  const rules = [
    { re: /密码登录不可用/i, label: '密码登录不可用' },
    { re: /不正确的帐户或密码.*次数过多|次数过多.*不正确的帐户或密码|尝试登录的次数过多/i, label: '登录次数过多' },
    { re: /你使用不正确的帐户或密码/i, label: '帐户或密码不正确（次数过多）' },
    { re: /帐户或密码不正确|账户或密码不正确|密码不正确|密码错误/i, label: '帐户或密码不正确' },
    { re: /Your account or password is incorrect/i, label: 'account or password incorrect' },
    { re: /password is incorrect|incorrect password/i, label: 'password incorrect' },
    { re: /too many times|too many (failed )?sign-?in attempts|too many attempts/i, label: 'too many sign-in attempts' },
    { re: /sign-?in (is )?temporarily (blocked|locked)|暂时(无法|不能)登录|登录暂时被阻止/i, label: 'sign-in temporarily blocked' },
  ];
  for (const { re, label } of rules) {
    if (re.test(hay)) {
      const hit = snippets.find((s) => re.test(s));
      return hit || label;
    }
  }
  return null;
}

export function detectCodeExpiredFromText(body) {
  return /所有以前的代码都已失效|请申请新的安全代码|previous codes? (have )?expired|request a new security code|ask for a new security code|codes? (are|have been) (no longer valid|invalid)/i.test(String(body || ''));
}

export function isHardNetworkErrorReason(reason) {
  const s = String(reason || '');
  return /ERR_SSL|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT|ERR_NETWORK|ERR_TUNNEL|ERR_PROXY|ERR_CERT|ERR_EMPTY|ERR_INTERNET|ERR_ADDRESS|ERR_HTTP2|chrome-error|无法提供安全连接|安全连接|响应无效|title:.*安全|probe-inject-failed|content-error-page|webNavigation-error|too\s*many\s*requests|请求过多|rate\s*limit|throttl|http\s*429/i.test(s);
}

export function isLikelyPageErrorBlob(errorText, url, title) {
  const blob = `${errorText || ''} ${url || ''} ${title || ''}`.toLowerCase();
  if (/chrome-error:\/\/|chromewebdata/i.test(blob)) return true;
  if (/err_ssl|err_connection|err_timed_out|err_name_not_resolved|err_network|err_tunnel|err_proxy|err_cert|err_empty_response|err_connection_reset|err_connection_closed|err_connection_refused|err_internet_disconnected|err_address_unreachable|err_ssl_protocol_error|err_ssl_version|err_bad_ssl|err_http2|dns_probe|net::err_/i.test(blob)) return true;
  if (/无法提供安全连接|此网站无法提供安全连接|安全连接|响应无效|无法访问此网站|网页无法打开|连接已重置|连接超时|暂时无法访问|没有互联网连接|privacy error|your connection is not private|this site can.?t (be reached|provide a secure connection)|err_ssl_protocol_error/i.test(blob)) return true;
  return false;
}

/** Aggregate batch results into stats for UI. */
export function summarizeResults(results = []) {
  const list = Array.isArray(results) ? results : [];
  const success = list.filter((r) => r.success).length;
  const failed = list.length - success;
  const reasons = {};
  for (const r of list) {
    if (r.success) continue;
    const key = normalizeFailReason(r.error || '未知错误');
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const topReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
  return {
    total: list.length,
    success,
    failed,
    successRate: list.length ? Math.round((success / list.length) * 1000) / 10 : 0,
    topReasons,
  };
}

function normalizeFailReason(err) {
  const s = String(err || '').replace(/\s+/g, ' ').trim();
  if (/密码登录失败|password/i.test(s)) return '密码/登录失败';
  if (/请求过多|too many requests|rate limit/i.test(s)) return '限流/请求过多';
  if (/人机|机器人|robot/i.test(s)) return '人机验证';
  if (/锁定|locked/i.test(s)) return '帐户锁定';
  if (/人脸|指纹|生物|biometric|passkey|安全密钥/i.test(s)) return '生物识别/密钥';
  if (/稍后重试|try again later|无法使你登录/i.test(s)) return '请稍后重试';
  if (/硬错误|SSL|网络|proxy|ERR_/i.test(s)) return '网络/SSL/代理';
  if (/备用邮箱|匹配/i.test(s)) return '备用邮箱问题';
  if (/验证码|code/i.test(s)) return '验证码相关';
  if (/PKCE|token|授权/i.test(s)) return '授权/换票失败';
  if (/用户手动|跳过|切换/i.test(s)) return '用户跳过';
  return s.slice(0, 40) || '其他';
}

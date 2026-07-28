/**
 * Lightweight pure-function tests (no Chrome APIs).
 * Run: npm test
 */
import { parseAccountLines, parseFixedBackupList, resolveBackupEmail } from '../chrome-extension/shared/accounts.js';
import { extractCodeFromText, maskCode, sanitizeLogMessage } from '../chrome-extension/shared/code-extract.js';
import {
  detectRateLimitFromText,
  detectPasswordFailureFromText,
  detectTryLaterFromText,
  detectCodeExpiredFromText,
  summarizeResults,
  isHardNetworkErrorReason,
} from '../chrome-extension/shared/page-detect.js';
import { resolveClientId, getScopes } from '../chrome-extension/shared/oauth.js';
import { resolvePace, humanDelay } from '../chrome-extension/shared/delays.js';
import { getAdapter, normalizeApiBase } from '../chrome-extension/shared/temp-email-adapters.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('\n== accounts ==');
{
  const r = parseAccountLines([
    'a@outlook.com----pass1',
    'badline',
    'not-email----x',
    'a@outlook.com----dup',
    'b@live.com:secret',
  ]);
  assert(r.validCount === 2, `validCount=2 got ${r.validCount}`);
  assert(r.invalidCount === 3, `invalidCount=3 got ${r.invalidCount}`);
  assert(r.accounts[0].email === 'a@outlook.com', 'first account email');
}

{
  const list = parseFixedBackupList({ backupEmailList: 'x@a.com\ny@b.com' });
  assert(list.length === 2, 'parseFixedBackupList');
  const state = { cursor: 0 };
  const e1 = resolveBackupEmail({ backupEmailMode: 'fixed', backupEmailList: list }, state);
  const e2 = resolveBackupEmail({ backupEmailMode: 'fixed', backupEmailList: list }, state);
  assert(e1 === 'x@a.com' && e2 === 'y@b.com', 'round-robin backup');
}

console.log('\n== code extract ==');
{
  assert(extractCodeFromText('你的一次性代码为：123456') === '123456', 'zh code');
  assert(extractCodeFromText('Security code: 654321') === '654321', 'en code');
  assert(maskCode('123456') === '12****', 'maskCode');
  const s = sanitizeLogMessage('匹配到验证码: 123456');
  assert(!s.includes('123456') && s.includes('12'), 'sanitize log code');
}

console.log('\n== page detect ==');
{
  assert(!!detectRateLimitFromText('Too Many Requests', ''), 'rate limit');
  assert(!!detectPasswordFailureFromText('帐户或密码不正确'), 'pwd fail');
  assert(!!detectTryLaterFromText('', '请稍后重试'), 'try later');
  assert(detectCodeExpiredFromText('所有以前的代码都已失效'), 'code expired');
  assert(isHardNetworkErrorReason('ERR_SSL_PROTOCOL_ERROR'), 'hard net');
  const st = summarizeResults([
    { success: true },
    { success: false, error: '密码登录失败: x' },
    { success: false, error: '请求过多: Too Many Requests' },
  ]);
  assert(st.success === 1 && st.failed === 2, 'summarize counts');
  assert(st.topReasons.length >= 1, 'top reasons');
}

console.log('\n== oauth / pace / adapter ==');
{
  assert(getScopes('graph').includes('graph.microsoft.com'), 'graph scopes');
  assert(getScopes('imap').includes('IMAP'), 'imap scopes');
  const id = resolveClientId({ clientIdMode: 'random' });
  assert(!!id && id.length > 10, 'default client id');
  const custom = resolveClientId({ clientIdMode: 'custom', customClientId: 'abc-123' });
  assert(custom === 'abc-123', 'custom client id');
  const poolId = resolveClientId({
    clientIdMode: 'random',
    clientIdPool: 'id-one\nid-two',
  });
  assert(poolId === 'id-one' || poolId === 'id-two', 'pool client id');
  const pace = resolvePace({ paceAdvanceDelayMs: 5000, paceCleanupEveryN: 3 });
  assert(pace.advanceDelayMs === 5000 && pace.cleanupEveryN === 3, 'pace settings');
  assert(humanDelay(1000, 0) === 1000, 'humanDelay no jitter');
  const ad = getAdapter('admin');
  assert(ad.buildUrl('https://x.dev', { address: 'a@b.com' }).includes('address='), 'adapter url');
  assert(normalizeApiBase('example.com') === 'https://example.com', 'normalize api');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

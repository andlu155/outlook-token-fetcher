/** Account line parsing & validation (pure). */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {string[]|string} lines
 * @returns {{ valid: object[], invalid: object[], accounts: {email:string,password:string}[], validCount: number, invalidCount: number }}
 */
export function parseAccountLines(lines) {
  const valid = [];
  const invalid = [];
  const accounts = [];
  const seen = new Set();
  const list = Array.isArray(lines) ? lines : String(lines || '').split('\n');

  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i] ?? '').trim();
    if (!raw) continue;
    const p = raw.split(/----|:|\|/);
    const email = (p[0] || '').trim();
    const password = (p[1] || '').trim();
    const lineNo = i + 1;
    if (!email || !password) {
      invalid.push({ line: lineNo, raw: raw.slice(0, 80), reason: '缺少邮箱或密码（需 邮箱----密码）' });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      invalid.push({ line: lineNo, raw: raw.slice(0, 80), reason: '邮箱格式无效' });
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      invalid.push({ line: lineNo, raw: email, reason: '重复邮箱（已忽略）' });
      continue;
    }
    seen.add(key);
    valid.push({ line: lineNo, email });
    accounts.push({ email, password });
  }
  return { valid, invalid, accounts, validCount: valid.length, invalidCount: invalid.length };
}

export function parseFixedBackupList(settingsObj = {}) {
  const raw = settingsObj.backupEmailList;
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map((s) => String(s || '').trim()).filter(Boolean);
  } else if (typeof raw === 'string' && raw.trim()) {
    list = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!list.length && settingsObj.backupEmail) {
    list = String(settingsObj.backupEmail).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  return list.slice(0, 100);
}

export function randomBackupLocalPart(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * @param {object} settingsObj
 * @param {{ cursor: number }} state mutates state.cursor for fixed round-robin
 */
export function resolveBackupEmail(settingsObj, state) {
  const mode = settingsObj.backupEmailMode === 'random' ? 'random' : 'fixed';
  if (mode === 'random') {
    const domain = (settingsObj.backupEmailDomain || '').trim().replace(/^@/, '');
    if (!domain) return '';
    return `${randomBackupLocalPart()}@${domain}`;
  }
  const list = parseFixedBackupList(settingsObj);
  if (!list.length) return '';
  let cursor = typeof state?.cursor === 'number' ? state.cursor : 0;
  const idx = ((cursor % list.length) + list.length) % list.length;
  const email = list[idx];
  if (state) state.cursor = (idx + 1) % list.length;
  return email;
}

export function describeFixedBackupPick(settingsObj, picked) {
  const list = parseFixedBackupList(settingsObj);
  if (!list.length || !picked) return '';
  const pos = list.indexOf(picked);
  if (pos < 0) return `固定备用邮箱: ${picked}`;
  return `固定备用邮箱 (${pos + 1}/${list.length}): ${picked}`;
}

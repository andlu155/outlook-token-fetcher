/** Extract 6-digit security codes from mail text (pure). */

const PATTERNS = [
  /你的一次性代码为[：:]\s*(\d{6})/,
  /安全代码[：:]\s*(\d{6})/,
  /一次性代码[：:]\s*(\d{6})/,
  /security code[：:]\s*(\d{6})/i,
  /code[：:\s]+(\d{6})/i,
  /(\d{6})(?:\s|$)(?!.*\d{6})/m,
];

export function extractCodeFromText(fullText) {
  const text = String(fullText || '');
  for (const p of PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function extractCodeFromMailObject(mail) {
  let fullText = '';
  for (const key of Object.keys(mail || {})) {
    if (typeof mail[key] === 'string') fullText += mail[key] + '\n';
  }
  return extractCodeFromText(fullText);
}

/** Mask code for logs: 12**** */
export function maskCode(code) {
  const c = String(code || '');
  if (c.length <= 2) return '****';
  return `${c.slice(0, 2)}${'*'.repeat(Math.min(4, c.length - 2))}`;
}

export function sanitizeLogMessage(message) {
  let s = String(message ?? '');
  s = s.replace(/(验证码|安全代码|一次性代码|security code|code)\s*[：:]\s*(\d{4,8})/gi, (_, label, code) => {
    return `${label}: ${maskCode(code)}`;
  });
  s = s.replace(/\b(\d{6})\b/g, (full, code, offset, whole) => {
    const prev = whole.slice(Math.max(0, offset - 24), offset).toLowerCase();
    if (/http|port|status|延迟|ms\b|第\s*\d|\/\d/.test(prev) && !/验证|code|码/.test(prev)) return full;
    if (/验证|code|码|匹配|填写|获取/.test(prev) || /验证|code|码/.test(whole.slice(offset, offset + 20).toLowerCase())) {
      return maskCode(code);
    }
    return full;
  });
  s = s.replace(/\b([0-9a-zA-Z._-]{40,})\b/g, (tok) => {
    if (/^https?:\/\//i.test(tok)) return tok;
    if (tok.includes('@')) return tok;
    if (/^[0-9.]+$/.test(tok)) return tok;
    return `${tok.slice(0, 6)}…(${tok.length} chars)`;
  });
  return s;
}

/** PKCE / OAuth helpers (pure + WebCrypto). */

import { AUTH_ENDPOINT, REDIRECT_URI, DEFAULT_CLIENT_IDS } from './constants.js';

export function base64URLEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

export async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64URLEncode(new Uint8Array(hash));
}

export function getRandomState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getScopes(apiMode) {
  const mode = String(apiMode || 'graph').toLowerCase();
  if (mode === 'imap') {
    return 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
  }
  return 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send';
}

/**
 * Resolve client ID from settings + optional multi-id pool.
 * @param {object} settings
 * @param {{ failedClientIds?: Set<string> }} [opts]
 */
export function resolveClientId(settings = {}, opts = {}) {
  if (settings.clientIdMode === 'custom' && settings.customClientId) {
    return String(settings.customClientId).trim();
  }

  let pool = [];
  const raw = settings.clientIdPool;
  if (typeof raw === 'string' && raw.trim()) {
    pool = raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw)) {
    pool = raw.map((s) => String(s || '').trim()).filter(Boolean);
  }
  if (!pool.length) pool = DEFAULT_CLIENT_IDS.slice();

  const failed = opts.failedClientIds;
  const available = failed?.size
    ? pool.filter((id) => !failed.has(id))
    : pool;
  const list = available.length ? available : pool;
  return list[Math.floor(Math.random() * list.length)];
}

export function buildAuthUrl(clientId, codeChallenge, state, apiMode) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: getScopes(apiMode),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export async function exchangeToken(authCode, clientId, codeVerifier, apiMode, tokenEndpoint) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: getScopes(apiMode),
    code: authCode,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg = j.error_description || j.error || msg;
    } catch (_) {
      msg = text ? `${msg} - ${text.substring(0, 200)}` : msg;
    }
    throw new Error(msg);
  }
  return res.json();
}

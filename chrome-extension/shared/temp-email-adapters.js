/**
 * Temp-mail API adapters. Default: Admin API (GET /admin/mails + x-admin-auth).
 * Add more adapters here without touching the SW poll loop.
 */

import { extractCodeFromMailObject } from './code-extract.js';

export const ADAPTERS = {
  admin: {
    id: 'admin',
    label: 'Admin API（默认）',
    buildUrl(apiBase, { address, limit = 10, offset = 0 } = {}) {
      let url = `${apiBase}/admin/mails?limit=${limit}&offset=${offset}`;
      if (address) url += `&address=${encodeURIComponent(address)}`;
      return url;
    },
    headers(adminPass) {
      return {
        'x-admin-auth': adminPass,
        'Content-Type': 'application/json',
      };
    },
    parseMails(data) {
      const mails = data?.results || data?.mails || data || [];
      return Array.isArray(mails) ? mails : [];
    },
    extractCode: extractCodeFromMailObject,
  },
};

export function getAdapter(name) {
  return ADAPTERS[name] || ADAPTERS.admin;
}

export function normalizeApiBase(raw) {
  let url = (raw || '').trim().replace(/\/$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/$/, '');
}

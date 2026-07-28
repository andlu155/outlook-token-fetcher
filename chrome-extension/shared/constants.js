/** Shared constants — used by SW (ESM) and tests. */

export const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
export const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Built-in public client IDs (rotatable pool). */
export const DEFAULT_CLIENT_IDS = [
  '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
];

export const MS_BROWSING_ORIGINS = [
  'https://login.microsoftonline.com',
  'https://login.live.com',
  'https://account.live.com',
  'https://account.microsoft.com',
  'https://signup.live.com',
  'https://outlook.live.com',
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://www.office.com',
  'https://www.microsoft.com',
  'https://microsoft.com',
  'https://www.live.com',
  'https://live.com',
];

export const MS_COOKIE_DOMAIN_SUFFIXES = [
  'login.microsoftonline.com',
  'microsoftonline.com',
  'login.live.com',
  'account.live.com',
  'account.microsoft.com',
  'live.com',
  'microsoft.com',
  'office.com',
  'office365.com',
  'outlook.live.com',
  'outlook.office.com',
  'msn.com',
];

export const PAGE_RECOVER_MAX = 2;
export const PAGE_FULL_RERUN_MAX = 1;
export const PAGE_RECOVER_COOLDOWN_MS = 2500;
export const PAGE_ANOMALY_SUSTAIN_MS = 3000;
export const PAGE_STUCK_MS = 10000;
export const PAGE_NAV_GRACE_MS = 6000;

export const DEFAULT_PACE = {
  advanceDelayMs: 2800,
  advanceJitterMs: 1200,
  step4AutoDelayMs: 900,
  authUiReadyMs: 2200,
  cleanupEveryN: 5,
  codeWaitMs: 3000,
  codePollIntervalMs: 3000,
  codePollMax: 20,
};

export const ALARM = {
  ADVANCE: 'otf_advance',
  STEP4: 'otf_step4',
  AUTH_READY: 'otf_auth_ready',
};

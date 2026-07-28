/** Pacing helpers. */

import { DEFAULT_PACE } from './constants.js';

export function humanDelay(baseMs, jitterMs = 400) {
  return baseMs + Math.floor(Math.random() * Math.max(0, jitterMs));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Merge stored pace settings with defaults. */
export function resolvePace(settings = {}) {
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : d;
  };
  return {
    advanceDelayMs: n(settings.paceAdvanceDelayMs, DEFAULT_PACE.advanceDelayMs),
    advanceJitterMs: n(settings.paceAdvanceJitterMs, DEFAULT_PACE.advanceJitterMs),
    step4AutoDelayMs: n(settings.paceStep4DelayMs, DEFAULT_PACE.step4AutoDelayMs),
    authUiReadyMs: n(settings.paceAuthUiReadyMs, DEFAULT_PACE.authUiReadyMs),
    cleanupEveryN: Math.max(1, Math.floor(n(settings.paceCleanupEveryN, DEFAULT_PACE.cleanupEveryN))),
    codeWaitMs: n(settings.paceCodeWaitMs, DEFAULT_PACE.codeWaitMs),
    codePollIntervalMs: n(settings.paceCodePollIntervalMs, DEFAULT_PACE.codePollIntervalMs),
    codePollMax: Math.max(1, Math.floor(n(settings.paceCodePollMax, DEFAULT_PACE.codePollMax))),
  };
}

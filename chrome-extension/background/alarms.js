/**
 * Durable delays via chrome.alarms (survives SW sleep better than setTimeout).
 * Falls back to setTimeout when alarms API is unavailable.
 */

import { ALARM } from '../shared/constants.js';

const pending = new Map(); // name -> { resolve, timer }

export function clearAlarm(name) {
  try { chrome.alarms?.clear(name); } catch (_) {}
  const p = pending.get(name);
  if (p?.timer) clearTimeout(p.timer);
  pending.delete(name);
}

export function clearAllTaskAlarms() {
  clearAlarm(ALARM.ADVANCE);
  clearAlarm(ALARM.STEP4);
  clearAlarm(ALARM.AUTH_READY);
}

/**
 * Schedule a one-shot callback after delayMs.
 * Uses chrome.alarms when delay >= ~1s (alarms min granularity ~1 min historically,
 * but Chrome now supports shorter delays in many builds; we still dual-path).
 */
export function scheduleOnce(name, delayMs, onFire) {
  clearAlarm(name);
  const ms = Math.max(50, Number(delayMs) || 0);

  // Always keep a setTimeout for short delays and as primary path.
  // Alarms act as a wake-up backup when SW is suspended longer than expected.
  const timer = setTimeout(() => {
    pending.delete(name);
    try { chrome.alarms?.clear(name); } catch (_) {}
    onFire();
  }, ms);
  pending.set(name, { timer, onFire });

  // Backup alarm for delays >= 15s (more reliable across SW lifecycle)
  if (ms >= 15000 && chrome.alarms?.create) {
    const when = Date.now() + ms;
    try {
      chrome.alarms.create(name, { when });
    } catch (_) {}
  }
}

export function installAlarmListener() {
  if (!chrome.alarms?.onAlarm) return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    const p = pending.get(alarm.name);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(alarm.name);
    try { p.onFire(); } catch (e) { console.warn('[alarms] fire error', e); }
  });
}

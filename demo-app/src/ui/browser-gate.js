import { Capacitor } from '@capacitor/core';
import { Egnss } from 'egnss-capacitor';

/**
 * Decide whether the current runtime is allowed to use the demo.
 *
 * Supported:
 *   - Any Capacitor native build (Android / iOS) — bypasses all browser checks.
 *   - Chromium-based browsers with Web Bluetooth (Chrome, Edge, Opera, Brave, Vivaldi).
 *
 * Unsupported:
 *   - Safari, Firefox, any iOS browser (they force WebKit, no Web Bluetooth).
 *
 * When unsupported, fills the #browser-gate element and returns false so the
 * caller stops bootstrap.
 *
 * @returns {Promise<boolean>} true if the app may run, false otherwise.
 */
export async function checkBrowserOrGate() {
  if (Capacitor.isNativePlatform()) {
    return true;
  }

  const gate = document.getElementById('browser-gate');
  const detail = document.getElementById('gate-detail');

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
  const isSafari =
    /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent) ||
    isIOS;
  const isFirefox = /firefox|fxios/i.test(navigator.userAgent);
  const hasWebBluetooth = 'bluetooth' in navigator;

  if (isSafari || isFirefox || !hasWebBluetooth) {
    const cap = await Egnss.checkCapability().catch(() => null);
    gate.hidden = false;
    detail.textContent =
      `userAgent: ${navigator.userAgent}\n` +
      `capability: ${cap ? JSON.stringify(cap) : 'unavailable'}`;
    return false;
  }

  return true;
}

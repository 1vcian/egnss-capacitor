import { controller } from './gnss-controller.js';
import { toast } from '../ui/toast.js';
import { openAntennaPicker } from '../ui/antenna-picker.js';

/**
 * Wire the "recenter on my position" FAB.
 *
 * State machine (driven by GnssController):
 *   - idle     → tap starts the GNSS stream, shows loading spinner
 *   - starting → permission prompt + plugin init, loading spinner shown
 *   - waiting  → stream is live but no fix yet, spinner keeps pulsing
 *   - active   → tap recenters the map; long-press or double-tap opens the
 *                details panel.
 */
export function wireGnssButton(button, mapCtx, fixPanel) {
  let pressTimer = null;
  let longPressed = false;

  const handleClick = async () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    try {
      if (!controller.started) {
        await controller.start();
        toast('GNSS started — waiting for first fix…', { level: 'info' });
      } else if (controller.lastFix) {
        mapCtx.recenterOnPosition();
      } else {
        toast('Waiting for first fix… (try outdoors)', { level: 'info' });
      }
    } catch (err) {
      console.error('[gnss] start failed', err);
      toast(err.message ?? 'GNSS failed to start', { level: 'error' });
    }
  };

  button.addEventListener('click', handleClick);

  // Long-press opens the fix details panel (450ms).
  const cancelLongPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  button.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      fixPanel?.toggle?.();
    }, 450);
  });
  button.addEventListener('pointerup', cancelLongPress);
  button.addEventListener('pointerleave', cancelLongPress);
  button.addEventListener('pointercancel', cancelLongPress);

  // Visual state driven by the controller state machine.
  controller.addEventListener('state', (e) => {
    const { state } = e.detail;
    button.classList.toggle('fab--loading', state === 'starting' || state === 'waiting');
    button.classList.toggle('fab--active', state === 'active');
  });
  controller.addEventListener('firstFix', () => {
    toast('First fix received!', { level: 'success' });
  });
}

/** Wire the "pair Bluetooth antenna" FAB. */
export function wireAntennaButton(button) {
  const refresh = () => {
    if (controller.antenna) {
      button.classList.add('fab--active');
      button.title = `Disconnect ${controller.antenna.name}`;
    } else {
      button.classList.remove('fab--active');
      button.title = 'Pair Bluetooth antenna';
    }
  };

  button.addEventListener('click', async () => {
    try {
      if (controller.antenna) {
        await controller.unpairAntenna();
        toast('Antenna disconnected', { level: 'info' });
        return;
      }

      button.classList.add('fab--loading');
      // The picker handles the whole scan → classify → choose → connect
      // flow so we don't blindly pair with the first bonded device
      // (that's how we ended up pairing with WH-1000XM4 headphones).
      const device = await openAntennaPicker();
      if (!device) {
        toast('Pairing cancelled', { level: 'info' });
      }
    } catch (err) {
      console.error('[antenna]', err);
      if (err?.code === 'UNSUPPORTED') {
        toast('This browser does not support Web Bluetooth.', { level: 'error' });
      } else {
        toast(err.message ?? 'Antenna operation failed', { level: 'error' });
      }
    } finally {
      button.classList.remove('fab--loading');
      refresh();
    }
  });

  controller.addEventListener('antenna', refresh);
  refresh();
}

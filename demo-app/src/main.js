import 'ol/ol.css';

import { checkBrowserOrGate } from './ui/browser-gate.js';
import { createMap } from './map/map.js';
import { controller } from './gnss/gnss-controller.js';
import { wireGnssButton, wireAntennaButton } from './gnss/gnss-controls.js';
import { wireCameraButton } from './camera/camera-controls.js';
import { initStatusBar } from './ui/status-bar.js';
import { initFixPanel } from './ui/fix-panel.js';
import { attachPhotoPopup } from './ui/photo-popup.js';

async function bootstrap() {
  if (!(await checkBrowserOrGate())) {
    return;
  }

  const mapCtx = createMap(document.getElementById('map'));
  attachPhotoPopup(mapCtx);

  initStatusBar({
    platform: document.getElementById('status-platform'),
    state: document.getElementById('status-state'),
    source: document.getElementById('status-source'),
    integrity: document.getElementById('status-integrity'),
    accuracy: document.getElementById('status-accuracy'),
  });

  const fixPanel = initFixPanel({
    panel: document.getElementById('fix-panel'),
    body: document.getElementById('fix-panel-body'),
    toggle: document.getElementById('fix-panel-toggle'),
    closeBtn: document.getElementById('fix-panel-close'),
  });

  // One shared controller drives every UI component.
  await controller.init();
  controller.addEventListener('fix', (e) => mapCtx.updatePosition(e.detail));

  wireGnssButton(document.getElementById('fab-gps'), mapCtx, fixPanel);
  wireAntennaButton(document.getElementById('fab-antenna'));
  wireCameraButton(document.getElementById('fab-camera'), mapCtx);

  // Clean shutdown on page hide, so geolocation / BT are released promptly.
  window.addEventListener('pagehide', () => {
    controller.destroy().catch(() => {});
  });
}

bootstrap().catch((err) => {
  console.error('demoPosition bootstrap failed:', err);
});

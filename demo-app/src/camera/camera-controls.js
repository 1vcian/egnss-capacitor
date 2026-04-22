import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

import { controller } from '../gnss/gnss-controller.js';
import { savePhoto, listPhotos } from '../storage/photo-store.js';
import { toast } from '../ui/toast.js';

/**
 * Wire the "take geotagged photo" FAB.
 *
 * Flow:
 *   1. Abort unless we have a fix AND its integrity is HIGH or STANDARD.
 *   2. Call Camera.getPhoto to capture (base64 + JPEG).
 *   3. Save to Filesystem + Preferences via photo-store.
 *   4. Drop a marker on the map.
 */
export function wireCameraButton(button, mapCtx) {
  // Restore previously saved photos on boot.
  hydrate(mapCtx).catch((err) => console.error('[camera] hydrate failed', err));

  button.addEventListener('click', async () => {
    const fix = controller.getLastFix();
    if (!fix) {
      if (!controller.started) {
        toast('Tap the G button first to start GNSS.', { level: 'warn' });
      } else {
        toast('Still waiting for the first fix — try outdoors.', { level: 'warn' });
      }
      return;
    }
    if (fix.integrityLevel === 'UNTRUSTED' || fix.integrityLevel === 'LOW') {
      const proceed = confirm(
        `Integrity is ${fix.integrityLevel}. The position may be inaccurate or spoofed. Continue?`,
      );
      if (!proceed) return;
    }

    try {
      button.classList.add('fab--loading');
      const photo = await Camera.getPhoto({
        quality: 75,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        correctOrientation: true,
        saveToGallery: false,
      });

      if (!photo.base64String) {
        toast('Camera returned no data.', { level: 'error' });
        return;
      }

      const record = await savePhoto({
        base64: photo.base64String,
        fix,
        mime: photo.format === 'png' ? 'image/png' : 'image/jpeg',
        options: {
          minAccuracyMeters: controller.options.minAccuracyMeters,
          requireOsnma: controller.options.requireOsnma,
        },
      });
      mapCtx.addPhotoMarker(record);
      toast('Photo saved at current position', { level: 'success' });
    } catch (err) {
      if (err?.message?.toLowerCase().includes('cancelled')) {
        // User backed out of the camera UI — no toast.
        return;
      }
      console.error('[camera]', err);
      toast(err.message ?? 'Camera failed', { level: 'error' });
    } finally {
      button.classList.remove('fab--loading');
    }
  });
}

async function hydrate(mapCtx) {
  const records = await listPhotos();
  for (const r of records) {
    mapCtx.addPhotoMarker(r);
  }
}

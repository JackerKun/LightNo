/**
 * Native AE anchors exposure at a point. Use the preview only for the
 * relative distance from that point to the requested metering region.
 */
import { evFromExposure, log2 } from './exposure.js';

export function estimateNativeExposure({ exposure, mode, luma, anchor, zoneValue, calibration }) {
  if (!exposure || exposure.adjusting) return { ev: null, settling: true };
  if (!Number.isFinite(exposure.offset) || Math.abs(exposure.offset) > 0.5) {
    return { ev: null, reason: 'offset' };
  }
  if ((mode === 'spot' || mode === 'area') && !exposure.pointSupported) {
    return { ev: null, reason: 'point' };
  }
  const cameraEv = evFromExposure(exposure);
  if (!Number.isFinite(cameraEv)) return { ev: null, reason: 'metadata' };

  let correction = 0;
  if (mode !== 'spot') {
    if (!Number.isFinite(anchor?.mean) || anchor.mean < 0.005 || anchor.clip > 0.05
        || !Number.isFinite(luma) || luma < 0.005 || luma >= 0.95) {
      return { ev: null, reason: 'preview' };
    }
    correction = log2(luma / anchor.mean);
  }
  return { ev: cameraEv + correction + calibration - (zoneValue - 5) };
}

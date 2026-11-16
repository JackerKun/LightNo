/** 从取景用的轨道读取间隔拍摄的单张照片。原图和 EXIF 只在本次取样中使用。 */
import { parseJpegExif, hasExposureExif } from './exif.js';

const SAMPLE_INTERVAL = 2000;
const CAPTURE_TIMEOUT = 5000;

export function watchPreviewExif(track, { getContext, onSample, onError }) {
  const capture = new ImageCapture(track);
  let stopped = false;
  let failures = 0;
  let nextTimer;
  let timeoutTimer;

  function stop() {
    stopped = true;
    clearTimeout(nextTimer);
    clearTimeout(timeoutTimer);
  }

  function fail(message) {
    stop();
    onError(message);
  }

  async function sample() {
    if (stopped) return;
    if (track.readyState !== 'live') {
      fail('相机已停止');
      return;
    }

    const context = getContext();
    if (context === null || track.muted) {
      nextTimer = setTimeout(sample, 350);
      return;
    }

    let bitmap;
    const sampledAt = performance.now();
    timeoutTimer = setTimeout(() => fail('自动取样超时'), CAPTURE_TIMEOUT);
    try {
      const photo = await capture.takePhoto({ fillLightMode: 'off' });
      if (stopped || context !== getContext()) return;
      const exif = parseJpegExif(await photo.arrayBuffer());
      if (!hasExposureExif(exif)) throw new Error('取样照片缺少曝光 EXIF');
      if (stopped || context !== getContext()) return;

      bitmap = await createImageBitmap(photo);
      if (stopped || context !== getContext()) return;
      const { exposureTime: shutter, fNumber: aperture, iso } = exif;
      onSample(bitmap, { shutter, aperture, iso }, sampledAt);
      failures = 0;
    } catch (error) {
      if (!stopped && context === getContext() && ++failures >= 2) {
        fail(error.message === '取样照片缺少曝光 EXIF' ? error.message : '无法取得自动测光样本');
      }
    } finally {
      bitmap?.close();
      clearTimeout(timeoutTimer);
      if (!stopped) nextTimer = setTimeout(sample, SAMPLE_INTERVAL);
    }
  }

  nextTimer = setTimeout(sample, 600);
  return stop;
}

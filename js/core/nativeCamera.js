/** Versioned transport shared by native camera hosts. All preview frames are transient. */
import { CameraError } from './camera.js';

const host = globalThis.LightNoHost;
const eventName = 'lightno-native-camera';
let nextSession = 0;

export const hasNativeCamera = host?.version === 1 && typeof host.send === 'function';

export function setNativeKeepAwake(enabled) {
  host.send({ type: 'keepAwake', enabled });
}

export class NativeCamera {
  constructor(canvas, { onFrame, onStale, onError }) {
    this.canvas = canvas;
    canvas.width = canvas.height = 0;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onFrame = onFrame;
    this.onStale = onStale;
    this.onError = onError;
    this.isActive = false;
    this.hardwareZoomMax = 1;
    this.exposure = null;
    this.frameEpoch = 0;
    this.handleEvent = ({ detail }) => this.receive(detail);
  }

  start({ previewFps = 10 } = {}) {
    this.previewFps = previewFps;
    this.session = ++nextSession;
    this.point = { x: 0.5, y: 0.5 };
    this.pointRevision = 0;
    window.addEventListener(eventName, this.handleEvent);
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.send('start', { fps: previewFps });
    });
  }

  stop() {
    if (!this.session) return;
    this.send('stop');
    this.session = null;
    this.isActive = false;
    this.exposure = null;
    clearTimeout(this.staleTimer);
    window.removeEventListener(eventName, this.handleEvent);
    this.rejectStart?.(new CameraError('CANCELLED', '相机已停止'));
    this.resolveStart = this.rejectStart = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  send(type, payload = {}) {
    host.send({ type, session: this.session, ...payload });
  }

  setPreviewRate(fps) {
    if (!this.session || fps === this.previewFps) return;
    this.previewFps = fps;
    this.send('previewRate', { fps });
  }

  setMeterPoint(x, y) {
    if (!this.isActive || Math.hypot(x - this.point.x, y - this.point.y) < 0.01) return;
    this.point = { x, y };
    this.exposure = null;
    this.send('meterPoint', { x, y, revision: ++this.pointRevision });
    return true;
  }

  async setZoom() {
    return { applied: 1, hardware: false };
  }

  receive(event) {
    if (!event || event.session !== this.session) return;
    if (event.type === 'ready') {
      this.isActive = true;
      this.exposure = null;
      this.resolveStart?.({ capabilities: {}, manual: false, hardwareZoomMax: 1 });
      this.resolveStart = this.rejectStart = null;
      if (this.pointRevision) this.send('meterPoint', { ...this.point, revision: this.pointRevision });
      this.send('nextFrame');
    } else if (event.type === 'error') {
      const error = new CameraError(event.code, event.message, event.hint);
      if (this.rejectStart) this.rejectStart(error);
      else this.onError(error);
    } else if (event.type === 'paused') {
      this.invalidateReading();
    } else if (event.type === 'frame') {
      void this.draw(event);
    }
  }

  invalidateReading() {
    this.frameEpoch++;
    clearTimeout(this.staleTimer);
    this.exposure = null;
    this.onStale();
  }

  async draw({ session, jpeg, frameURL, exposure, revision }) {
    const epoch = this.frameEpoch;
    try {
      const image = new Image();
      if (typeof frameURL === 'string' && /^lightno:\/\/app\/__preview\/\d+\.jpg$/.test(frameURL)) {
        image.src = frameURL;
      } else {
        image.src = 'data:image/jpeg;base64,' + jpeg;
      }
      await image.decode();
      if (this.session !== session || epoch !== this.frameEpoch) return;

      if (this.canvas.width !== image.naturalWidth || this.canvas.height !== image.naturalHeight) {
        this.canvas.width = image.naturalWidth;
        this.canvas.height = image.naturalHeight;
      }
      this.ctx.drawImage(image, 0, 0);
      this.exposure = revision === this.pointRevision ? exposure : null;
      clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => this.invalidateReading(), 1500);
      this.onFrame();
    } catch {
      if (this.session === session) this.invalidateReading();
    } finally {
      if (this.session === session) this.send('nextFrame');
    }
  }
}

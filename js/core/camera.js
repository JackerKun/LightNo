/**
 * LIGHTNO · 相机控制
 *
 * 在浏览器和镜头允许时启用手动快门和 ISO。
 */

// Chromium 的 MediaStream 曝光单位为 100 µs。应用内使用秒。
const SECONDS_PER_EXPOSURE_UNIT = 1e-4;
export const isAndroid = typeof navigator !== 'undefined' &&
  (/Android/i.test(navigator.userAgent) || navigator.userAgentData?.platform === 'Android');

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class CameraError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.hint = hint;
  }
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.startVersion = 0;
    this.stream = null;
    this.track = null;
    this.capabilities = {};
    this.exposureRange = null;
    this.isoRange = null;
    this.zoomRange = null;
    this.manual = false;
    this.settings = {};
    this._listeners = new Set();
  }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type, detail = {}) {
    for (const fn of this._listeners) {
      try {
        fn(type, detail);
      } catch (err) {
        console.error('[LIGHTNO] camera listener error', err);
      }
    }
  }

  get isActive() {
    return !!(this.stream && this.track && this.track.readyState === 'live');
  }

  get hardwareZoomMax() {
    return this.zoomRange && Number.isFinite(this.zoomRange.max) ? this.zoomRange.max : 1;
  }

  get hasTorch() {
    return !!(this.capabilities && this.capabilities.torch);
  }

  async start({ allowManual = true } = {}) {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new CameraError('INSECURE', '当前页面不是安全上下文', '请使用 https:// 或 http://localhost 打开');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new CameraError('UNSUPPORTED', '浏览器不支持摄像头访问', '请使用 Chrome / Safari 最新版');
    }

    this.stop();
    const version = this.startVersion;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
    } catch (err) {
      throw translateError(err);
    }

    if (version !== this.startVersion) {
      for (const track of stream.getTracks()) track.stop();
      throw new CameraError('CANCELLED', '相机已停止');
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    if (!this.track) throw new CameraError('NO_TRACK', '未获取到视频轨道');

    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    try {
      await this.video.play();
    } catch {
      /* 自动播放被拦截时，由后续用户手势继续 */
    }

    await this.waitForFrame();
    if (version !== this.startVersion) throw new CameraError('CANCELLED', '相机已停止');
    this.readCapabilities();

    if (!allowManual) this.manual = false;
    if (this.manual) {
      try {
        await this.enableManual();
      } catch (err) {
        console.warn('[LIGHTNO] 手动曝光开启失败，降级为图像测光', err);
        this.manual = false;
      }
    }

    if (version !== this.startVersion) throw new CameraError('CANCELLED', '相机已停止');
    this.syncSettings();
    this.emit('ready', {
      manual: this.manual,
      capabilities: this.capabilities,
      hardwareZoomMax: this.hardwareZoomMax
    });
    return {
      manual: this.manual,
      capabilities: this.capabilities,
      hardwareZoomMax: this.hardwareZoomMax
    };
  }

  stop() {
    this.startVersion++;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      if (this.video?.srcObject === this.stream) this.video.srcObject = null;
    }
    this.stream = null;
    this.track = null;
    this.manual = false;
    this.settings = {};
    this.emit('stopped');
  }

  readCapabilities() {
    const caps = this.track?.getCapabilities?.() || {};
    this.capabilities = caps;
    this.exposureRange = Number.isFinite(caps?.exposureTime?.min) && caps.exposureTime.min > 0 &&
      Number.isFinite(caps.exposureTime.max) && caps.exposureTime.max >= caps.exposureTime.min
      ? {
          min: caps.exposureTime.min * SECONDS_PER_EXPOSURE_UNIT,
          max: caps.exposureTime.max * SECONDS_PER_EXPOSURE_UNIT
        }
      : null;
    this.isoRange = Number.isFinite(caps?.iso?.min) && caps.iso.min > 0 &&
      Number.isFinite(caps.iso.max) && caps.iso.max >= caps.iso.min ? caps.iso : null;
    this.zoomRange = caps.zoom || null;
    const modes = caps.exposureMode;
    this.manual = !!(
      this.exposureRange &&
      this.isoRange &&
      Array.isArray(modes) &&
      modes.includes('manual')
    );
    return this.capabilities;
  }

  syncSettings() {
    this.settings = (this.track && this.track.getSettings && this.track.getSettings()) || {};
    return this.settings;
  }

  /** 当前相机实际使用的曝光参数（仅在手动模式下可靠） */
  getExposure() {
    const s = this.syncSettings();
    return {
      shutter: Number.isFinite(s.exposureTime) && s.exposureTime > 0
        ? s.exposureTime * SECONDS_PER_EXPOSURE_UNIT
        : null,
      iso: Number.isFinite(s.iso) && s.iso > 0 ? s.iso : null,
      mode: s.exposureMode || 'continuous',
      zoom: Number.isFinite(s.zoom) ? s.zoom : 1
    };
  }

  getManualExposure() {
    if (!this.manual) return null;
    const ex = this.getExposure();
    // Chrome's Android Camera2 backend can return "none" with auto exposure off.
    const manualMode = ex.mode === 'manual' || (isAndroid && ex.mode === 'none');
    return manualMode && ex.shutter !== null && ex.iso !== null ? ex : null;
  }

  async enableManual() {
    if (!this.manual || !this.track) return false;
    const shutter = clamp(1 / 60, this.exposureRange.min, this.exposureRange.max);
    const iso = clamp(100, this.isoRange.min, this.isoRange.max);
    await this.track.applyConstraints({
      advanced: [{ exposureMode: 'manual', exposureTime: shutter / SECONDS_PER_EXPOSURE_UNIT, iso }]
    });
    const ex = this.getManualExposure();
    if (!ex) {
      this.manual = false;
      return false;
    }
    this.emit('manual', ex);
    return true;
  }

  /** 设置相机曝光（仅手动模式）。返回实际生效的 settings */
  async setExposure({ shutter, iso }) {
    if (!this.manual || !this.track) return null;
    const t = clamp(Number(shutter) || 1 / 60, this.exposureRange.min, this.exposureRange.max);
    const s = clamp(Number(iso) || 100, this.isoRange.min, this.isoRange.max);
    const settings = { exposureMode: 'manual', exposureTime: t / SECONDS_PER_EXPOSURE_UNIT, iso: s };
    const zoom = this.syncSettings().zoom;
    if (Number.isFinite(zoom) && this.zoomRange) settings.zoom = zoom;
    try {
      await this.track.applyConstraints({ advanced: [settings] });
    } catch (err) {
      console.warn('[LIGHTNO] setExposure failed', err);
      return null;
    }
    return this.syncSettings();
  }

  /**
   * 设置变焦。优先使用硬件变焦，返回实际生效的硬件倍率。
   * @returns {Promise<{applied:number, hardware:boolean}>}
   */
  async setZoom(value) {
    if (!this.track) return { applied: 1, hardware: false };
    if (!this.zoomRange || !Number.isFinite(this.zoomRange.max) || this.zoomRange.max <= 1.02) {
      return { applied: 1, hardware: false };
    }
    const min = Number.isFinite(this.zoomRange.min) ? this.zoomRange.min : 1;
    const target = clamp(Number(value) || 1, min, this.zoomRange.max);
    const settings = { zoom: target };
    const exposure = this.getManualExposure();
    if (exposure) {
      settings.exposureMode = 'manual';
      settings.exposureTime = exposure.shutter / SECONDS_PER_EXPOSURE_UNIT;
      settings.iso = exposure.iso;
    }
    try {
      await this.track.applyConstraints({ advanced: [settings] });
    } catch (err) {
      console.warn('[LIGHTNO] setZoom failed', err);
      return { applied: 1, hardware: false };
    }
    const s = this.syncSettings();
    return { applied: Number.isFinite(s.zoom) ? s.zoom : target, hardware: true };
  }

  async setTorch(on) {
    if (!this.hasTorch || !this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch {
      return false;
    }
  }

  waitForFrame(timeout = 4000) {
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new CameraError('TIMEOUT', '相机启动超时', '请关闭其他占用相机的应用后重试'));
      }, timeout);
      const onReady = () => {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('loadeddata', onReady);
        this.video.removeEventListener('canplay', onReady);
      };
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('loadeddata', onReady);
      this.video.addEventListener('canplay', onReady);
    });
  }
}

export function translateError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('DENIED', '相机权限被拒绝', '请在浏览器地址栏的权限设置中允许摄像头');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('NOT_FOUND', '未找到可用摄像头', '请确认设备有摄像头');
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError('BUSY', '相机被其他应用占用', '请关闭相机 / 视频通话应用后重试');
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('CONSTRAINT', '摄像头不支持所需参数', '');
    case 'AbortError':
      return new CameraError('ABORTED', '相机启动被中断', '请重试');
    default:
      return new CameraError('UNKNOWN', (err && err.message) || '相机启动失败', '');
  }
}
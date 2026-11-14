/**
 * LIGHTNO · 相机控制
 *
 * 默认「图像分析」引擎不修改相机曝光，只读取视频帧。
 * 只有用户在设置里选择「硬件曝光」且设备支持时，才尝试启用手动曝光，
 * 用已知的 t / ISO 反推绝对 EV。
 */

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
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
    this.track = null;
    this.manual = false;
    this.settings = {};
    if (this.video) this.video.srcObject = null;
    this.emit('stopped');
  }

  readCapabilities() {
    const caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {};
    this.capabilities = caps || {};
    this.exposureRange = caps.exposureTime || null;
    this.isoRange = caps.iso || null;
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
      shutter: Number.isFinite(s.exposureTime) ? s.exposureTime : null,
      iso: Number.isFinite(s.iso) ? s.iso : null,
      mode: s.exposureMode || 'continuous',
      zoom: Number.isFinite(s.zoom) ? s.zoom : 1
    };
  }

  async enableManual() {
    if (!this.manual || !this.track) return false;
    const shutter = clamp(1 / 60, this.exposureRange.min, this.exposureRange.max);
    const iso = clamp(100, this.isoRange.min, this.isoRange.max);
    await this.track.applyConstraints({
      advanced: [{ exposureMode: 'manual', exposureTime: shutter, iso }]
    });
    const s = this.syncSettings();
    if (s.exposureMode !== 'manual') {
      this.manual = false;
      return false;
    }
    this.emit('manual', { shutter: s.exposureTime, iso: s.iso });
    return true;
  }

  /** 设置相机曝光（仅手动模式）。返回实际生效的 settings */
  async setExposure({ shutter, iso }) {
    if (!this.manual || !this.track) return null;
    const t = clamp(Number(shutter) || 1 / 60, this.exposureRange.min, this.exposureRange.max);
    const s = clamp(Number(iso) || 100, this.isoRange.min, this.isoRange.max);
    try {
      await this.track.applyConstraints({
        advanced: [{ exposureMode: 'manual', exposureTime: t, iso: s }]
      });
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
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: target }] });
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
/**
 * LIGHTNO · 演示场景
 *
 * 没有摄像头（或在桌面浏览器预览）时，用一张程序绘制的风景充当取景画面。
 * 场景固定相机曝光，因此不同区域的亮度差会真实换算成不同 EV，
 * 便于验证点测光 / 区域测光的相对关系。
 */

export function createDemoScene() {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const ctx = canvas.getContext('2d');

  function render(time = 0) {
    const w = canvas.width;
    const h = canvas.height;
    const t = time / 1000;
    const horizon = h * 0.58;

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#0d2347');
    sky.addColorStop(0.45, '#2a6c9e');
    sky.addColorStop(0.78, '#d98a58');
    sky.addColorStop(1, '#f7cd93');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon + 2);

    // 太阳
    const sunX = w * 0.72;
    const sunY = h * 0.19;
    const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, w * 0.42);
    glow.addColorStop(0, 'rgba(255,249,224,0.98)');
    glow.addColorStop(0.08, 'rgba(255,236,180,0.85)');
    glow.addColorStop(0.32, 'rgba(255,190,120,0.28)');
    glow.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, horizon);

    // 云
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const y = h * (0.12 + i * 0.085);
      const drift = ((t * (8 + i * 3) + i * 260) % (w + 520)) - 260;
      const grad = ctx.createLinearGradient(0, y, 0, y + 46);
      grad.addColorStop(0, 'rgba(255,255,255,0.16)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(drift, y, w * 0.30, 46, 0, 0, Math.PI * 2);
      ctx.ellipse(drift + w * 0.22, y + 8, w * 0.20, 34, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 远山
    const makeRidge = (baseY, amp, color, phase) => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, baseY);
      for (let x = 0; x <= w; x += 24) {
        const n =
          Math.sin(x / 180 + phase) * amp +
          Math.sin(x / 71 + phase * 2.3) * amp * 0.35 +
          Math.sin(x / 41 + phase * 4.1) * amp * 0.12;
        ctx.lineTo(x, baseY + n);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    makeRidge(horizon - h * 0.075, h * 0.045, 'rgba(38,52,74,0.92)', 1.2);
    makeRidge(horizon - h * 0.02, h * 0.035, 'rgba(22,33,46,0.96)', 3.6);

    // 地面
    const ground = ctx.createLinearGradient(0, horizon, 0, h);
    ground.addColorStop(0, '#1b2a24');
    ground.addColorStop(0.45, '#0f1a16');
    ground.addColorStop(1, '#070d0b');
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, w, h - horizon);

    // 地面纹理（草叶）
    ctx.save();
    ctx.strokeStyle = 'rgba(90,120,90,0.20)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 260; i++) {
      const x = ((i * 137.5) % w) + Math.sin(i) * 20;
      const y = horizon + ((i * 97) % (h - horizon));
      const len = 8 + ((i * 13) % 26);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(i) * 8, y - len);
      ctx.stroke();
    }
    ctx.restore();

    // 18% 灰卡（校准参考）
    const cardW = w * 0.22;
    const cardH = cardW * 0.66;
    const cardX = w * 0.11;
    const cardY = horizon + h * 0.10;
    ctx.save();
    ctx.fillStyle = '#b3b3b3';
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX, cardY, cardW, cardH);
    ctx.fillStyle = 'rgba(20,24,30,0.85)';
    ctx.font = '600 22px "SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('18% GREY', cardX + 12, cardY + cardH - 12);
    ctx.restore();

    // 暗部：前景石块
    ctx.fillStyle = '#05090a';
    ctx.beginPath();
    ctx.ellipse(w * 0.82, h * 0.95, w * 0.30, h * 0.09, -0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  render(0);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    exposure: { shutter: 1 / 1000, iso: 100 },
    render,
    destroy() {
      /* nothing */
    }
  };
}
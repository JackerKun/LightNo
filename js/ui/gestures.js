/**
 * LIGHTNO · 取景台手势
 * - 单指拖动测光框；空白处点按立即把测光框移过去
 * - 右下角手柄调整框大小
 * - 双指捏合变焦
 */

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function attachStageGestures(stage, opts) {
  const {
    getZone,
    isPositionable = () => true,
    isResizable = () => true,
    onZoneChange = () => {},
    onZoomChange = () => {},
    getZoom = () => 1,
    maxZoom = () => 8,
    onTap = () => {},
    onDoubleTap = () => {},
    onGestureEnd = () => {}
  } = opts;

  const pointers = new Map();
  let mode = null;
  let rect = null;
  let startZone = null;
  let startPoint = null;
  let startDistance = 0;
  let startZoom = 1;
  let moved = false;
  let lastTap = 0;
  let zoomFrame = null;
  let pendingZoom = null;

  function geometry() {
    rect = stage.getBoundingClientRect();
    return rect;
  }

  function zonePx() {
    const zone = getZone();
    const minDim = Math.min(rect.width, rect.height);
    return {
      cx: zone.cx * rect.width,
      cy: zone.cy * rect.height,
      size: clamp((zone.size || 0.14) * minDim, 18, minDim * 0.94)
    };
  }

  function clampCenter(cx, cy, sizePx) {
    const half = sizePx / 2;
    return {
      cx: clamp(cx, half, rect.width - half) / rect.width,
      cy: clamp(cy, half, rect.height - half) / rect.height
    };
  }

  function applyCenter(px, py) {
    const { size } = zonePx();
    const c = clampCenter(px, py, size);
    onZoneChange({ cx: c.cx, cy: c.cy });
  }

  function applySize(sizePx) {
    const minDim = Math.min(rect.width, rect.height);
    const size = clamp(sizePx / minDim, 0.04, 0.94);
    const zone = getZone();
    const c = clampCenter(zone.cx * rect.width, zone.cy * rect.height, size * minDim);
    onZoneChange({ cx: c.cx, cy: c.cy, size });
  }

  function scheduleZoom(z) {
    pendingZoom = z;
    if (zoomFrame) return;
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = null;
      if (pendingZoom != null) onZoomChange(pendingZoom);
      pendingZoom = null;
    });
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    if (!rect) geometry();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    if (pointers.size === 2) {
      mode = 'pinch';
      moved = true;
      const [a, b] = Array.from(pointers.values());
      startDistance = Math.max(1, distance(a, b));
      startZoom = getZoom();
      stage.classList.add('is-pinching');
      return;
    }
    if (pointers.size > 2) return;

    moved = false;
    startPoint = { x: event.clientX, y: event.clientY };
    const zoneEl = event.target.closest ? event.target.closest('.zone') : null;

    if (zoneEl && event.target.closest('[data-handle="size"]') && isResizable()) {
      mode = 'resize';
      startZone = getZone();
      stage.classList.add('is-dragging');
      return;
    }

    if (isPositionable()) {
      if (zoneEl && zoneEl.contains(event.target)) {
        mode = 'drag';
      } else if (!event.target.closest('.zoom') && !event.target.closest('.shutter')) {
        // 点按空白处：立即把测光框移动过去后继续拖动
        applyCenter(event.clientX - rect.left, event.clientY - rect.top);
        mode = 'drag';
        moved = true;
      }
      if (mode) {
        startZone = getZone();
        stage.classList.add('is-dragging');
      }
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = Array.from(pointers.values());
      const factor = distance(a, b) / startDistance;
      scheduleZoom(clamp(startZoom * factor, 1, maxZoom()));
      return;
    }

    if (!startPoint || !rect) return;
    const dx = event.clientX - startPoint.x;
    const dy = event.clientY - startPoint.y;
    if (Math.hypot(dx, dy) > 4) moved = true;

    if (mode === 'drag' && startZone) {
      const size = clamp((startZone.size || 0.14) * Math.min(rect.width, rect.height), 18, 1e5);
      const cx = startZone.cx * rect.width + dx;
      const cy = startZone.cy * rect.height + dy;
      const c = clampCenter(cx, cy, size);
      onZoneChange({ cx: c.cx, cy: c.cy });
    } else if (mode === 'resize' && startZone) {
      const cx = startZone.cx * rect.width;
      const cy = startZone.cy * rect.height;
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const rectShape = getZone().shape === 'rect';
      const sizePx = rectShape
        ? 2 * Math.max(Math.abs(px - cx), Math.abs(py - cy))
        : 2 * Math.hypot(px - cx, py - cy);
      applySize(sizePx);
    }
  }

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const wasSingle = pointers.size === 1;
    pointers.delete(event.pointerId);

    if (mode === 'pinch') {
      if (pointers.size < 2) {
        mode = null;
        stage.classList.remove('is-pinching');
        onGestureEnd();
      }
      return;
    }

    if (wasSingle) {
      const isTap = !moved && event.type === 'pointerup';
      if (isTap) {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          onDoubleTap();
        } else {
          lastTap = now;
          onTap();
        }
      }
      mode = null;
      startPoint = null;
      startZone = null;
      stage.classList.remove('is-dragging');
      onGestureEnd();
    }
  }

  stage.addEventListener('pointerdown', onPointerDown, { passive: true });
  stage.addEventListener('pointermove', onPointerMove, { passive: true });
  stage.addEventListener('pointerup', endPointer, { passive: true });
  stage.addEventListener('pointercancel', endPointer, { passive: true });

  const invalidate = () => {
    rect = null;
  };
  window.addEventListener('orientationchange', invalidate);
  window.addEventListener('resize', invalidate);

  return {
    refresh() {
      rect = null;
    },
    destroy() {
      window.removeEventListener('orientationchange', invalidate);
      window.removeEventListener('resize', invalidate);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', endPointer);
      stage.removeEventListener('pointercancel', endPointer);
    }
  };
}
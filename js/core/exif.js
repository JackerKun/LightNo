/**
 * LIGHTNO · JPEG EXIF 读取（纯 JS，无依赖）
 *
 * iPhone 通过 <input type="file"> 拍的照片带有 EXIF：
 * ExposureTime / FNumber / ISO，可反推拍摄时的绝对 EV。
 * 这不是硬件 API，而是图像文件自带的元数据。
 */

const TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  DATE_TIME: 0x0132,
  EXIF_IFD: 0x8769,
  EXPOSURE_TIME: 0x829a,
  F_NUMBER: 0x829d,
  ISO: 0x8827,
  FOCAL_LENGTH: 0x920a,
  PIXEL_X: 0xa002,
  PIXEL_Y: 0xa003
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export function parseJpegExif(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset++;
        continue;
      }
      const marker = view.getUint8(offset + 1);
      offset += 2;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > view.byteLength) break;
      const length = view.getUint16(offset);
      if (length < 2) break;

      if (marker === 0xe1) {
        const start = offset + 2;
        if (
          start + 6 <= view.byteLength &&
          view.getUint32(start) === 0x45786966 &&
          view.getUint16(start + 4) === 0x0000
        ) {
          return parseTiff(view, start + 6);
        }
      }
      offset += length;
    }
  } catch {
    return null;
  }
  return null;
}

function readAscii(view, offset, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function parseTiff(view, start) {
  if (start + 8 > view.byteLength) return null;
  const endian = view.getUint16(start);
  const le = endian === 0x4949;
  if (!le && endian !== 0x4d4d) return null;
  if (view.getUint16(start + 2, le) !== 0x2a) return null;

  const ifd0 = start + view.getUint32(start + 4, le);
  if (ifd0 + 2 > view.byteLength) return null;

  const out = {};
  let exifIfd = null;
  const firstCount = view.getUint16(ifd0, le);
  for (let i = 0; i < firstCount; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, le);
    if (tag === TAG.EXIF_IFD) {
      exifIfd = start + view.getUint32(entry + 8, le);
    } else {
      readEntry(view, start, le, entry, tag, out);
    }
  }

  if (exifIfd && exifIfd + 2 <= view.byteLength) {
    const count = view.getUint16(exifIfd, le);
    for (let i = 0; i < count; i++) {
      const entry = exifIfd + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      readEntry(view, start, le, entry, view.getUint16(entry, le), out);
    }
  }

  return out;
}

function readEntry(view, tiffStart, le, entry, tag, out) {
  const type = view.getUint16(entry + 2, le);
  const count = view.getUint32(entry + 4, le);
  const size = TYPE_SIZE[type] || 0;
  const total = size * count;
  const valueOffset = total <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, le);
  if (!total || valueOffset + total > view.byteLength) return;

  const rational = (o) => {
    const num = view.getUint32(o, le);
    const den = view.getUint32(o + 4, le);
    return den ? num / den : 0;
  };

  switch (tag) {
    case TAG.EXPOSURE_TIME:
      out.exposureTime = rational(valueOffset);
      break;
    case TAG.F_NUMBER:
      out.fNumber = rational(valueOffset);
      break;
    case TAG.ISO:
      out.iso = type === 3 ? view.getUint16(valueOffset, le) : view.getUint32(valueOffset, le);
      break;
    case TAG.FOCAL_LENGTH:
      out.focalLength = rational(valueOffset);
      break;
    case TAG.ORIENTATION:
      out.orientation = view.getUint16(valueOffset, le);
      break;
    case TAG.DATE_TIME:
      out.dateTime = readAscii(view, valueOffset, count);
      break;
    case TAG.MAKE:
      out.make = readAscii(view, valueOffset, count);
      break;
    case TAG.MODEL:
      out.model = readAscii(view, valueOffset, count);
      break;
    case TAG.PIXEL_X:
      out.pixelWidth = type === 3 ? view.getUint16(valueOffset, le) : view.getUint32(valueOffset, le);
      break;
    case TAG.PIXEL_Y:
      out.pixelHeight = type === 3 ? view.getUint16(valueOffset, le) : view.getUint32(valueOffset, le);
      break;
    default:
      break;
  }
}

/** EXIF 是否包含可用的曝光三要素 */
export function hasExposureExif(exif) {
  return !!(
    exif &&
    Number.isFinite(exif.exposureTime) &&
    exif.exposureTime > 0 &&
    Number.isFinite(exif.fNumber) &&
    exif.fNumber > 0 &&
    Number.isFinite(exif.iso) &&
    exif.iso > 0
  );
}
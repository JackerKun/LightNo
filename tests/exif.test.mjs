/**
 * EXIF 解析测试：构造一张带 Exif APP1 的 JPEG，验证曝光三要素读取。
 * 运行：node tests/exif.test.mjs
 */
import { parseJpegExif, hasExposureExif } from '../js/core/exif.js';

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg, tol = 1e-9) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) {
    throw new Error(`${msg || 'value'}: expected ${b}, got ${a}`);
  }
}
function near(a, b, tol, msg) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) {
    throw new Error(`${msg || 'value'}: expected ${b} ±${tol}, got ${a}`);
  }
}
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

/** 生成最小 Exif JPEG（Little-endian TIFF） */
function buildExifJpeg() {
  const tiff = Buffer.alloc(128);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);

  // IFD0：2 个条目 + 下一个 IFD 指针
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x8769, 10); // ExifIFD pointer
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(38, 18); // ExifIFD 偏移

  tiff.writeUInt16LE(0x0112, 22); // Orientation
  tiff.writeUInt16LE(3, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt16LE(6, 30);
  tiff.writeUInt32LE(0, 34);

  // ExifIFD：4 个条目
  tiff.writeUInt16LE(4, 38);
  const exifEntry = (index) => 40 + index * 12;

  // ExposureTime 1/125
  tiff.writeUInt16LE(0x829a, exifEntry(0));
  tiff.writeUInt16LE(5, exifEntry(0) + 2);
  tiff.writeUInt32LE(1, exifEntry(0) + 4);
  tiff.writeUInt32LE(92, exifEntry(0) + 8);

  // FNumber 18/10
  tiff.writeUInt16LE(0x829d, exifEntry(1));
  tiff.writeUInt16LE(5, exifEntry(1) + 2);
  tiff.writeUInt32LE(1, exifEntry(1) + 4);
  tiff.writeUInt32LE(100, exifEntry(1) + 8);

  // ISO 80（SHORT，内联）
  tiff.writeUInt16LE(0x8827, exifEntry(2));
  tiff.writeUInt16LE(3, exifEntry(2) + 2);
  tiff.writeUInt32LE(1, exifEntry(2) + 4);
  tiff.writeUInt16LE(80, exifEntry(2) + 8);

  // DateTime（ASCII 20 字节）
  tiff.writeUInt16LE(0x0132, exifEntry(3));
  tiff.writeUInt16LE(2, exifEntry(3) + 2);
  tiff.writeUInt32LE(20, exifEntry(3) + 4);
  tiff.writeUInt32LE(108, exifEntry(3) + 8);

  tiff.writeUInt32LE(0, 38 + 2 + 4 * 12);

  tiff.writeUInt32LE(1, 92);
  tiff.writeUInt32LE(125, 96);
  tiff.writeUInt32LE(18, 100);
  tiff.writeUInt32LE(10, 104);
  tiff.write('2026:05:18 14:32:07', 108, 'ascii');

  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = app1.length + 2;
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1;
  header.writeUInt16BE(length, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, app1, Buffer.from([0xff, 0xd9])]);
}

const jpeg = buildExifJpeg();
const buffer = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);

test('读取 ExposureTime / FNumber / ISO', () => {
  const exif = parseJpegExif(buffer);
  ok(exif, 'exif should parse');
  eq(exif.exposureTime, 1 / 125, 'exposureTime');
  eq(exif.fNumber, 1.8, 'fNumber');
  eq(exif.iso, 80, 'iso');
  ok(hasExposureExif(exif), 'should have exposure data');
});

test('读取 Orientation 与 DateTime', () => {
  const exif = parseJpegExif(buffer);
  eq(exif.orientation, 6, 'orientation');
  ok(String(exif.dateTime).startsWith('2026:05:18'), 'dateTime=' + exif.dateTime);
});

test('非 JPEG 返回 null', () => {
  const notJpeg = Buffer.from('not a jpeg at all').buffer;
  ok(parseJpegExif(notJpeg) === null, 'should return null');
});

test('无曝光信息的 EXIF 判定', () => {
  ok(!hasExposureExif({ exposureTime: 0, fNumber: 1.8, iso: 80 }), 'time 0');
  ok(!hasExposureExif({ exposureTime: 1 / 125, fNumber: 0, iso: 80 }), 'f 0');
  ok(!hasExposureExif({ exposureTime: 1 / 125, fNumber: 1.8, iso: 0 }), 'iso 0');
  ok(!hasExposureExif(null), 'null');
});

console.log('\n' + (failures.length ? 'FAILED' : 'All EXIF tests passed') + ` — ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(f.name, f.err.stack);
  process.exit(1);
}
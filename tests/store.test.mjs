/**
 * 数据层测试（用内存版 IndexedDB 替身）
 * 运行：node tests/store.test.mjs
 */
import { installFakeIndexedDB } from './fake-idb.mjs';

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'value'}: expected ${b}, got ${a}`);
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

async function main() {
  installFakeIndexedDB();
  const store = await import('../js/core/store.js');

  await test('初始为空', async () => {
    eq(await store.countShots(), 0);
    const list = await store.listShots();
    ok(Array.isArray(list) && list.length === 0, 'empty list');
  });

  await test('写入并按时间倒序读取', async () => {
    await store.putShot({ id: 'a', createdAt: 1000, ev: 12.1, photo: { size: 1 } });
    await store.putShot({ id: 'b', createdAt: 3000, ev: 13.2 });
    await store.putShot({ id: 'c', createdAt: 2000, ev: 9.5 });
    const list = await store.listShots();
    eq(list.length, 3);
    eq(list[0].id, 'b', 'newest first');
    eq(list[1].id, 'c');
    eq(list[2].id, 'a');
    eq(await store.countShots(), 3);
  });

  await test('按 id 覆盖更新（备注 / 收藏）', async () => {
    await store.putShot({ id: 'a', createdAt: 1000, ev: 12.1, note: '逆光人像', favorite: true });
    const shot = await store.getShot('a');
    eq(shot.note, '逆光人像');
    eq(shot.favorite, true);
    eq(await store.countShots(), 3, 'count unchanged');
  });

  await test('删除单条', async () => {
    await store.deleteShot('c');
    const list = await store.listShots();
    eq(list.length, 2);
    ok(!list.some((s) => s.id === 'c'), 'c removed');
  });

  await test('清空全部', async () => {
    await store.clearShots();
    eq(await store.countShots(), 0);
    const list = await store.listShots();
    eq(list.length, 0);
  });

  console.log('\n' + (failures.length ? 'FAILED' : 'All store tests passed') + ` — ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(f.name, f.err.stack);
    process.exit(1);
  }
}

main();
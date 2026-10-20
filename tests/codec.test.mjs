import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  decodePayload,
  fromBase64Url,
  inflate,
  intervalsToMask,
  maskToIntervals,
  unpack,
} from '../codec.js';

// Общий вектор: пишет Python-тест бота test_vector_file_is_current (см. README).
const vector = JSON.parse(await readFile(new URL('./vector.json', import.meta.url), 'utf8'));

/** Сырые байты среза через zlib самого Node — независимо от inflate в codec.js. */
const rawBytes = () => new Uint8Array(inflateRawSync(fromBase64Url(vector.payload)));

/** Подменяет globalThis.DecompressionStream на время теста. */
function withDecompressionStream(t, value) {
  const saved = globalThis.DecompressionStream;
  globalThis.DecompressionStream = value;
  t.after(() => {
    globalThis.DecompressionStream = saved;
  });
}

test('decodes the shared vector exactly', async () => {
  assert.deepEqual(await decodePayload(vector.payload), vector.expected);
});

test('mask helpers', () => {
  const evening = (0b1111 << 22) >>> 0; // 18:00–20:00: слоты 22..25
  assert.deepEqual(maskToIntervals(evening), [[1080, 1200]]);
  assert.equal(intervalsToMask([[1080, 1200]]), evening);
});

test('mask helpers: edges of the window and unsigned bit 31', () => {
  assert.deepEqual(maskToIntervals(0), []);
  assert.deepEqual(maskToIntervals(0b1101), [[420, 450], [480, 540]]);
  assert.deepEqual(maskToIntervals((1 << 31) >>> 0), [[1350, 1380]]);
  assert.deepEqual(maskToIntervals(0xffffffff), [[420, 1380]]);
  assert.equal(intervalsToMask([[0, 1440]]), 0xffffffff); // «весь день» → всё окно
  assert.equal(intervalsToMask([[1350, 1500]]), (1 << 31) >>> 0); // после 23:00 отброшено
  assert.equal(intervalsToMask([[360, 450]]), 0b1); // до 07:00 отброшено
  assert.equal(intervalsToMask([[1095, 1140]]), (1 << 23) >>> 0); // только целые получасы
  assert.equal(intervalsToMask([[0, 420], [1380, 1440]]), 0);
  assert.deepEqual(maskToIntervals(intervalsToMask([[600, 660], [660, 720]])), [[600, 720]]);
});

test('falls back to tiny-inflate', async (t) => {
  withDecompressionStream(t, undefined);
  assert.deepEqual(await decodePayload(vector.payload), vector.expected);
});

test('tiny-inflate fallback grows its buffer for highly compressible data', async (t) => {
  withDecompressionStream(t, undefined);
  const raw = new Uint8Array(300 * 1024).fill(7); // сжимается в сотни байт — больше буфера 64 КБ
  const out = await inflate(new Uint8Array(deflateRawSync(raw, { level: 9 })));
  assert.equal(out.length, raw.length);
  assert.ok(out.every((byte) => byte === 7));
});

test('uses DecompressionStream when the runtime has deflate-raw', async (t) => {
  // В Node 20 нет 'deflate-raw' — подставляем поток поверх node:zlib, чтобы проверить
  // браузерную ветку decodePayload (pipeThrough и сборку результата).
  const formats = [];
  class FakeDecompressionStream extends TransformStream {
    constructor(format) {
      formats.push(format);
      const chunks = [];
      super({
        transform: (chunk) => void chunks.push(chunk),
        flush: (controller) => controller.enqueue(inflateRawSync(Buffer.concat(chunks))),
      });
    }
  }
  withDecompressionStream(t, FakeDecompressionStream);
  assert.deepEqual(await decodePayload(vector.payload), vector.expected);
  assert.deepEqual(formats, ['deflate-raw']);
});

test('unpack of node:zlib output matches the vector', () => {
  assert.deepEqual(unpack(rawBytes()), vector.expected);
});

test('unpack rejects an unknown format version', () => {
  const bytes = rawBytes();
  bytes[0] = 2;
  assert.throws(() => unpack(bytes), /версия/);
});

test('unpack rejects a player index outside the table', () => {
  const bytes = rawBytes();
  bytes[9] = 0; // u8 me: заголовок 1+1+4+2+1 байт, затем me
  assert.throws(() => unpack(bytes), /индекс/);
});

test('unpack rejects ids beyond Number.MAX_SAFE_INTEGER', () => {
  const bytes = rawBytes();
  bytes[12] = 0x01; // старший байт u64 id первого игрока (таблица начинается с байта 12)
  assert.throws(() => unpack(bytes), /MAX_SAFE_INTEGER/);
});

test('unpack rejects truncated and padded data', () => {
  const bytes = rawBytes();
  assert.throws(() => unpack(bytes.subarray(0, bytes.length - 1)), RangeError);
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  assert.throws(() => unpack(padded), /лишние байты/);
});

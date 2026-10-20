import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  decodePayload,
  fromBase64Url,
  inflate,
  intervalsToMask,
  maskToIntervals,
  maskToStarts,
  SLOT_START,
  SLOT_STEP,
  unpack,
} from '../codec.js';

// Общий вектор: пишет Python-тест бота test_vector_file_is_current (см. README).
const vector = JSON.parse(await readFile(new URL('./vector.json', import.meta.url), 'utf8'));

/** Сырые байты среза через zlib самого Node — независимо от inflate в codec.js. */
const rawBytes = () => new Uint8Array(inflateRawSync(fromBase64Url(vector.payload)));

const CODEC_URL = new URL('../codec.js', import.meta.url).href;

// Вызов функции codec.js в отдельном потоке: синхронное зависание (бесконечный цикл inflate)
// не блокирует тесты, а роняет их по таймеру.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.codec)
  .then((codec) => codec[workerData.fn](workerData.input))
  .then(
    () => parentPort.postMessage({ ok: true }),
    (error) => parentPort.postMessage({ ok: false, message: String(error && error.message) }),
  );
`;

function runInWorker(fn, input, ms = 2000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { codec: CODEC_URL, fn, input } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${fn} не завершился за ${ms} мс — зависание`));
    }, ms);
    worker.once('message', (result) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Сырой срез 20 игроков × 14 дней с псевдослучайной доступностью — размером с настоящий. */
function syntheticRaw() {
  const players = 20;
  const days = 14;
  const names = Array.from({ length: players }, (_, i) => new TextEncoder().encode(`@player${i + 1}`));
  const size = 12 + names.reduce((n, name) => n + 9 + name.length, 0) + players * days * 8 + 2;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let pos = 0;
  const u8 = (v) => view.setUint8((pos += 1) - 1, v);
  const u16 = (v) => view.setUint16((pos += 2) - 2, v);
  const u32 = (v) => view.setUint32((pos += 4) - 4, v);
  u8(1); // version
  u8(0); // flags
  u32(29874860); // stamp
  u16(2484); // 2026-10-20
  u8(days);
  u8(1); // me
  u16(players);
  names.forEach((name, i) => {
    u32(0); // старшее слово u64 id
    u32(1000 + i);
    u8(name.length);
    bytes.set(name, pos);
    pos += name.length;
  });
  let seed = 20261020;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const run = (r) => {
    const from = SLOT_START + SLOT_STEP * (r % 24);
    return intervalsToMask([[from, from + SLOT_STEP * (2 + ((r >>> 8) % 8))]]);
  };
  for (let k = 0; k < players * days; k++) {
    const r = next();
    u32(r & 1 ? run(r) : 0); // free
    u32(r & 2 ? run(next()) : 0); // rule
  }
  u16(0); // ngames
  assert.equal(pos, size);
  return bytes;
}

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

test('вектор v2 читается целиком, включая корты', async () => {
  const snapshot = await decodePayload(vector.payload);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.courts.clubs.length, 2);
  assert.deepEqual(snapshot, vector.expected);
});

test('v1 без секции кортов даёт пустые клубы', () => {
  assert.deepEqual(unpack(syntheticRaw()).courts, { stamp: 0, clubs: [] }); // syntheticRaw пишет версию 1
});

test('maskToStarts', () => {
  assert.deepEqual(maskToStarts((1 << 22) | (1 << 31)), [1080, 1350]);
  assert.deepEqual(maskToStarts(0), []);
  assert.deepEqual(maskToStarts(0b101), [420, 480]);
  assert.deepEqual(maskToStarts(0xffffffff).length, 32);
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
  for (const version of [0, 3]) {
    const bytes = rawBytes();
    bytes[0] = version;
    assert.throws(() => unpack(bytes), /версия/, `версия ${version}`);
  }
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
  assert.throws(() => unpack(bytes.subarray(0, bytes.length - 1)), RangeError); // обрыв внутри секции кортов
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  assert.throws(() => unpack(padded), /лишние байты/);
});

test('stream decode errors reject instead of falling back to tiny-inflate', async (t) => {
  class BrokenDecompressionStream extends TransformStream {
    constructor() {
      super({
        transform() {
          throw new TypeError('повреждённые данные deflate');
        },
      });
    }
  }
  withDecompressionStream(t, BrokenDecompressionStream);
  await assert.rejects(decodePayload(vector.payload));
});

test('truncated real-size payload fails fast instead of hanging', async () => {
  const packed = new Uint8Array(deflateRawSync(syntheticRaw(), { level: 9 }));
  assert.equal((packed[0] >> 1) & 0b11, 2, 'нужен блок с динамическими деревьями Хаффмана');
  const text = (bytes) => Buffer.from(bytes).toString('base64url');
  assert.deepEqual(await runInWorker('decodePayload', text(packed)), { ok: true });
  for (const length of [Math.floor(packed.length * 0.8), Math.floor(packed.length / 2), 100, 40]) {
    const cut = packed.slice(0, length);
    const decoded = await runInWorker('decodePayload', text(cut));
    assert.equal(decoded.ok, false, `decodePayload принял срез, обрезанный до ${length} байт`);
    assert.deepEqual(await runInWorker('inflateWithTiny', cut), { ok: false, message: 'Data error' });
  }
});

test('player references resolve to real ids, not table indexes', () => {
  // Те же байты, что _timed_game_bytes() в tests/webapp/test_codec.py бота
  // (test_pack_layout_timed_game_with_big_player_id): индекс 1 → id 5, индекс 2 → 8917023925.
  const hex = [
    '01', // version
    '00', // flags
    '0a0b0c0d', // stamp
    '0000', // start_date = 2020-01-01
    '01', // days
    '02', // me: индекс 2 — игрок с id > 2**32
    '0002', // nplayers
    '0000000000000005', // игрок 1: u64 id
    '06', // len имени
    'd090d0bdd18f', // «Аня»
    '00000002137efcb5', // игрок 2: u64 id 8_917_023_925
    '02', // len имени
    '426f', // «Bo»
    '00c00000', // игрок 1: free
    '00000000', // игрок 1: rule
    '00000000', // игрок 2: free
    '80000000', // игрок 2: rule
    '0001', // ngames
    '00000102', // id игры
    '00', // day
    '0438', // start = 1080
    '04b0', // end = 1200
    '00', // flags: без брони
    '01', // creator: индекс 1
    '03', // len корта
    'd09a31', // «К1»
    '02 01 02', // nyes + индексы
    '01', // nguests
    '02', // host: индекс 2
    '03', // n гостей
    '01 01', // nwaiting + индексы
  ].join('').replace(/ /g, '');
  const BIG = 8_917_023_925;
  assert.deepEqual(unpack(new Uint8Array(Buffer.from(hex, 'hex'))), {
    version: 1,
    stamp: 0x0a0b0c0d,
    me: BIG,
    start_date: '2020-01-01',
    days: 1,
    flags: 0,
    dates: ['2020-01-01'],
    players: [
      { id: 5, name: 'Аня' },
      { id: BIG, name: 'Bo' },
    ],
    availability: {
      5: [{ free: [[1080, 1140]], rule: [] }],
      [BIG]: [{ free: [], rule: [[1350, 1380]] }],
    },
    courts: { stamp: 0, clubs: [] },
    games: [
      {
        id: 0x102,
        date: '2020-01-01',
        start: 1080,
        end: 1200,
        court: 'К1',
        booked: false,
        creator: 5,
        yes: [5, BIG],
        guests: [[BIG, 3]],
        waiting: [5],
      },
    ],
  });
});

// Те же байты по раскладке v2 из шапки codec.js, собранные вручную, а не взятые у кодека бота:
// секция кортов идёт сразу после игр, у каждого клуба на каждый день — три маски стартов.
const V2_HEX = [
  '02', // version
  '00', // flags
  '0a0b0c0d', // stamp
  '0000', // start_date = 2020-01-01
  '01', // days
  '01', // me
  '0001', // nplayers
  '0000000000000005', // игрок 1: u64 id
  '02', // len имени
  '426f', // «Bo»
  '00c00000', // free: слоты 22 и 23
  '00000000', // rule
  '0000', // ngames
  '0000012c', // courts_stamp = 300
  '02', // nclubs
  '03', // len имени клуба
  'd09a31', // «К1»
  '00400000', // 60 минут: бит 22 → 18:00
  '00000000', // 90 минут
  '80000000', // 120 минут: бит 31 → 22:30
  '02', // len имени клуба
  '4142', // «AB»
  '00000000', // 60 минут
  '00000005', // 90 минут: биты 0 и 2 → 07:00 и 08:00
  '00000000', // 120 минут
].join('');
const v2Bytes = () => new Uint8Array(Buffer.from(V2_HEX, 'hex'));

test('unpack v2: секция кортов собрана вручную', () => {
  const snapshot = unpack(v2Bytes());
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.games, []);
  assert.deepEqual(snapshot.courts, {
    stamp: 300,
    clubs: [
      { name: 'К1', days: [{ 60: [1080], 90: [], 120: [1350] }] },
      { name: 'AB', days: [{ 60: [], 90: [420, 480], 120: [] }] },
    ],
  });
});

test('unpack v2: обрыв и лишние байты в секции кортов', () => {
  const bytes = v2Bytes();
  assert.throws(() => unpack(bytes.subarray(0, bytes.length - 1)), RangeError);
  assert.throws(() => unpack(bytes.subarray(0, bytes.length - 12)), RangeError); // нет масок второго клуба
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes);
  assert.throws(() => unpack(padded), /лишние байты/);
});

test('unpack v2: срез без клубов — пустой список, но штамп читается', () => {
  // заголовок 12 + игрок 11 + free/rule 8 + ngames 2 + courts_stamp 4 = 37 байт, дальше nclubs
  const bytes = v2Bytes().slice(0, 38);
  bytes[37] = 0;
  assert.deepEqual(unpack(bytes).courts, { stamp: 300, clubs: [] });
});

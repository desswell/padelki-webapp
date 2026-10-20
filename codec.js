// Декодер среза, который бот кладёт в адрес кнопки (`?d=`).
// Контракт — padelbot/webapp/codec.py в репозитории бота (pack/unpack, encode):
// base64url без `=` → сырой deflate → байты, всё big-endian:
//   u8 version · u8 flags · u32 stamp (unix-минуты) · u16 дней от 2020-01-01 · u8 days · u8 me
//   u16 nplayers · {u64 id · u8 len · utf8 name}…
//   для каждого игрока, для каждого дня: u32 free · u32 rule
//   u16 ngames · {u32 id · u8 day · u16 start · u16 end (0xFFFF = нет) · u8 flags (bit0 booked)
//     · u8 creator (0 = нет) · u8 len · utf8 court · u8 n · u8 yes… · u8 n · {u8 host · u8 count}…
//     · u8 n · u8 waiting…}…
//   версия 2 добавляет после игр секцию кортов (в версии 1 её нет — страница читает обе):
//   u32 courts_stamp (unix-минуты, 0 — клубов нет) · u8 nclubs
//     · {u8 len · utf8 name · для каждого дня: u32 m60 · u32 m90 · u32 m120}…
//   бит i маски — у клуба есть свободный корт со стартом SLOT_START + 30·i на ровно 60/90/120 минут.
// Ссылки на игроков (me, creator, yes, host, waiting) — индексы в таблице игроков с 1.
// Общий тест-вектор: tests/vector.json (его пишет Python-тест бота).
import tinfUncompress from './vendor/tiny-inflate.js';

export const FORMAT_VERSIONS = [1, 2]; // читаются обе: в клавиатурах у людей остались кнопки со срезом v1
export const FLAG_SHORT_WINDOW = 1; // окно урезано до 7 дней
export const FLAG_NO_OTHERS = 2; // маски чужих игроков нулевые и значат «неизвестно», а не «занят»
export const FLAG_NO_WAITING = 4; // у игр не передан список ожидающих
export const FLAG_NO_COURTS = 8; // секция кортов не поместилась в срез и пуста: «нет клубов» ≠ «корты неизвестны»
export const DURATIONS = [60, 90, 120]; // классы слотов, которые продают клубы, минуты
export const SLOT_START = 420; // 07:00: бит i маски — получас SLOT_START + 30·i
export const SLOT_END = 1380; // 23:00
export const SLOT_STEP = 30;
export const SLOTS = 32;

const NO_TIME = 0xffff;
const BOOKED = 1;
const EPOCH_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Слитые интервалы [start, end] (минуты от полуночи) подряд идущих установленных бит. */
export function maskToIntervals(mask) {
  const result = [];
  let runStart = -1;
  for (let i = 0; i <= SLOTS; i++) { // лишний шаг закрывает серию, дошедшую до бита 31
    if (i < SLOTS && ((mask >>> i) & 1) === 1) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      result.push([SLOT_START + SLOT_STEP * runStart, SLOT_START + SLOT_STEP * i]);
      runStart = -1;
    }
  }
  return result;
}

/** Старты по маске: минуты от полуночи (`SLOT_START + 30·i`) для каждого установленного бита i, по возрастанию. */
export function maskToStarts(mask) {
  const result = [];
  for (let i = 0; i < SLOTS; i++) if (((mask >>> i) & 1) === 1) result.push(SLOT_START + SLOT_STEP * i);
  return result;
}

/** Маска получасов окна, целиком покрытых интервалами; всегда беззнаковая (`>>> 0`). */
export function intervalsToMask(intervals) {
  let mask = 0;
  for (const [start, end] of intervals) {
    const first = Math.max(0, Math.ceil((start - SLOT_START) / SLOT_STEP));
    const last = Math.min(SLOTS, Math.floor((end - SLOT_START) / SLOT_STEP));
    for (let i = first; i < last; i++) mask |= 1 << i;
  }
  return mask >>> 0;
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('срез: в base64url недопустимые символы');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

// tiny-inflate пишет в буфер заданного размера и молча отбрасывает то, что не влезло, а размер
// распакованного среза в payload не передаётся. Берём буфер с запасом (реальный срез — единицы
// КБ; 255 игроков × 14 дней — около 40 КБ); заполненный до конца буфер может означать обрезку,
// тогда распаковываем заново в вчетверо больший.
const FALLBACK_MAX = 16 * 1024 * 1024;

export function inflateWithTiny(bytes) {
  for (let size = Math.max(64 * 1024, bytes.length * 20); size <= FALLBACK_MAX; size *= 4) {
    const out = tinfUncompress(bytes, new Uint8Array(size));
    if (out.length < size) return out;
  }
  throw new Error('срез: распакованные данные больше 16 МБ');
}

/**
 * Сырой deflate → байты: DecompressionStream('deflate-raw') (Chrome 103+, Safari 16.4+), а где
 * его нет — tiny-inflate. Запасной путь — только когда поток нельзя создать; ошибка распаковки
 * повреждённых данных в потоке отклоняет промис, а не уходит в tiny-inflate.
 */
export async function inflate(bytes) {
  let decompressor;
  try {
    decompressor = new DecompressionStream('deflate-raw');
  } catch {
    return inflateWithTiny(bytes); // нет DecompressionStream или 'deflate-raw' (Node 20, старые WebView)
  }
  const stream = new Blob([bytes]).stream().pipeThrough(decompressor);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  take(size) {
    const at = this.pos;
    if (at + size > this.bytes.length) throw new RangeError(`срез обрывается на байте ${at}`);
    this.pos += size;
    return at;
  }

  u8() { return this.view.getUint8(this.take(1)); }
  u16() { return this.view.getUint16(this.take(2)); }
  u32() { return this.view.getUint32(this.take(4)); }

  /** u64 без BigInt (getBigUint64 нет в WebView iOS до 15): старшее слово ≤ 2^21 − 1. */
  u64() {
    const high = this.u32();
    const low = this.u32();
    if (high > 0x1fffff) throw new RangeError('id игрока больше Number.MAX_SAFE_INTEGER');
    return high * 2 ** 32 + low;
  }

  str() {
    const size = this.u8();
    const at = this.take(size);
    return utf8.decode(this.bytes.subarray(at, at + size));
  }
}

const isoDay = (daysFromEpoch) => new Date(EPOCH_MS + daysFromEpoch * DAY_MS).toISOString().slice(0, 10);

/** Байты среза → Snapshot (та же структура, что `expected` в tests/vector.json). */
export function unpack(bytes) {
  const r = new Reader(bytes);
  const version = r.u8();
  if (!FORMAT_VERSIONS.includes(version)) throw new Error(`неподдерживаемая версия среза: ${version}`);
  const flags = r.u8();
  const stamp = r.u32();
  const startDays = r.u16();
  const days = r.u8();
  const meRef = r.u8();
  const players = Array.from({ length: r.u16() }, () => ({ id: r.u64(), name: r.str() }));

  const player = (index, role) => {
    if (index < 1 || index > players.length) {
      throw new Error(`${role}: индекс игрока ${index} вне 1..${players.length}`);
    }
    return players[index - 1].id;
  };
  const playerList = (role) => Array.from({ length: r.u8() }, () => player(r.u8(), role));

  const availability = {};
  for (const { id } of players) {
    availability[id] = Array.from({ length: days }, () => ({
      free: maskToIntervals(r.u32()),
      rule: maskToIntervals(r.u32()),
    }));
  }
  const me = player(meRef, 'me');

  const games = Array.from({ length: r.u16() }, () => {
    const id = r.u32();
    const day = r.u8();
    const start = r.u16();
    const end = r.u16();
    const gameFlags = r.u8();
    const creator = r.u8();
    return {
      id,
      date: isoDay(startDays + day),
      start: start === NO_TIME ? null : start,
      end: end === NO_TIME ? null : end,
      court: r.str(),
      booked: (gameFlags & BOOKED) !== 0,
      creator: creator === 0 ? null : player(creator, 'creator'),
      yes: playerList('yes'),
      guests: Array.from({ length: r.u8() }, () => [player(r.u8(), 'guest host'), r.u8()]),
      waiting: playerList('waiting'),
    };
  });

  // Версия 1 корты не несёт: «клубов нет», штамп 0.
  const courts = { stamp: 0, clubs: [] };
  if (version >= 2) {
    courts.stamp = r.u32();
    courts.clubs = Array.from({ length: r.u8() }, () => ({
      name: r.str(),
      days: Array.from({ length: days }, () => ({
        60: maskToStarts(r.u32()),
        90: maskToStarts(r.u32()),
        120: maskToStarts(r.u32()),
      })),
    }));
  }
  if (r.pos !== bytes.length) throw new Error(`срез: лишние байты в конце (${bytes.length - r.pos})`);

  return {
    version,
    stamp,
    me,
    start_date: isoDay(startDays),
    days,
    flags,
    dates: Array.from({ length: days }, (_, i) => isoDay(startDays + i)),
    players,
    availability,
    games,
    courts,
  };
}

/** Строка из `?d=` → Snapshot. */
export async function decodePayload(text) {
  return unpack(await inflate(fromBase64Url(text)));
}

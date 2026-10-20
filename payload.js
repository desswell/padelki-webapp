// Сообщения для бота: JSON для Telegram.WebApp.sendData. Чистые функции без DOM.
// Контракт — padelbot/webapp/inbound.py в репозитории бота: {v: 1, t: штамп среза, action, …},
// не больше 4096 байт UTF-8; минуты кратны 30 и лежат в 07:00–23:00, start < end.
import { DURATIONS, FLAG_NO_COURTS, SLOT_END, SLOT_START, SLOT_STEP } from './codec.js';

export const PROTOCOL_VERSION = 1;
export const MAX_BYTES = 4096; // Telegram режет sendData на 4096 байтах
export const MAX_DAYS = 14;
export const GAME_OPS = ['yes', 'no', 'gplus', 'gminus'];

const utf8 = new TextEncoder();

/** Минута суток по часам устройства. */
export const dayMinutes = (now) => now.getHours() * 60 + now.getMinutes();

/** Получас уже начался: только у сегодня (первый день среза) и раньше текущей минуты устройства.
 * Только для сетки (серые запертые ячейки); в отправку не вмешивается — см. desiredDays. */
export const isPast = (snapshot, date, m, now) => date === snapshot.dates[0] && m < dayMinutes(now);

/** Начала получасов сетки, которые целиком покрыты интервалами. */
export function halfHours(intervals) {
  const out = new Set();
  for (const [start, end] of intervals) {
    const first = SLOT_START + Math.max(0, Math.ceil((start - SLOT_START) / SLOT_STEP)) * SLOT_STEP;
    for (let m = first; m + SLOT_STEP <= Math.min(end, SLOT_END); m += SLOT_STEP) out.add(m);
  }
  return out;
}

/** Начала получасов → слитые интервалы [start, end] по возрастанию. */
export function toSlots(minutes) {
  const out = [];
  for (const m of [...minutes].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === m) last[1] = m + SLOT_STEP;
    else out.push([m, m + SLOT_STEP]);
  }
  return out;
}

/** Получасы, когда игрок свободен на дату по срезу: разовые и из правил (free ∪ rule). */
export function freeCells(snapshot, id, date) {
  const day = snapshot.availability[id]?.[snapshot.dates.indexOf(date)];
  return day ? halfHours([...day.free, ...day.rule]) : new Set();
}

/**
 * Получасы, когда игрок свободен на дату на самом деле — для «Расписания». Чужая доступность в
 * срезе уже эффективная (бот вычел их игры); у `me` срез несёт объявленную (её правит сетка
 * «Моё время»), поэтому здесь вычитаются получасы, задетые играми дня со временем, где `me` в «да».
 * Игры без времени и игры, где `me` только в ожидающих, не вычитаются.
 */
export function effectiveCells(snapshot, id, date) {
  const cells = freeCells(snapshot, id, date);
  if (id !== snapshot.me) return cells;
  for (const game of snapshot.games) {
    if (game.date !== date || game.start === null || game.end === null || !game.yes.includes(id)) continue;
    for (const m of [...cells]) if (game.start < m + SLOT_STEP && m < game.end) cells.delete(m);
  }
  return cells;
}

/** Получасы, закрашенные у `me` в срезе на дату. */
export const painted = (snapshot, date) => freeCells(snapshot, snapshot.me, date);

/**
 * Желаемое состояние изменённых дней для `set_availability`.
 *
 * `edited` — дата → начала закрашенных получасов (сетка «Моё время»). В день попадает вся
 * редактируемая область 07:00–23:00, у сегодня тоже: начавшиеся получасы в сетке заперты и равны
 * срезу, а отсекает их бот по своим часам. Часы устройства здесь не участвуют — если они спешат,
 * отброшенные получасы бот счёл бы снятыми и молча стёр бы доступность. Ячейки правила, оставленные
 * закрашенными, тоже желаемые. День, чья область совпадает со срезом, не изменён и не отправляется;
 * очищенный день — `slots: []`.
 */
export function desiredDays(original, edited) {
  const out = [];
  for (const [date, cells] of edited) {
    if (!original.dates.includes(date)) throw new Error(`День ${date} вне окна календаря`);
    const editable = (m) => m >= SLOT_START && m < SLOT_END && m % SLOT_STEP === 0;
    const before = [...painted(original, date)].filter(editable);
    const after = [...cells].filter(editable);
    const same = before.length === after.length && before.every((m) => cells.has(m));
    if (!same) out.push({ date, slots: toSlots(after) });
  }
  return out.sort((a, b) => original.dates.indexOf(a.date) - original.dates.indexOf(b.date));
}

/**
 * Клубы, у которых на дату есть корт, подходящий игре `start`–`end`: старт совпадает с началом
 * продаваемого слота, а его класс (60/90/120 минут) не короче игры — на часовую игру годится и
 * слот на полтора часа. Состояние: `trimmed` — секция кортов не поместилась в срез, `off` — клубов
 * в срезе нет, `too_long` — игра длиннее самого длинного слота, `none` — подходящих нет, `ok` —
 * `names` (в порядке среза). Во всех остальных состояниях `names` пуст.
 */
export function courtsForGame(snapshot, date, start, end) {
  const state = (name, names = []) => ({ state: name, names });
  if (snapshot.flags & FLAG_NO_COURTS) return state('trimmed');
  if (snapshot.courts.clubs.length === 0) return state('off');
  const length = end - start;
  if (length > Math.max(...DURATIONS)) return state('too_long');
  const dayIndex = snapshot.dates.indexOf(date);
  const names = snapshot.courts.clubs
    .filter((club) => {
      const day = club.days[dayIndex]; // вне среза dayIndex = −1 → undefined → корта нет
      return Boolean(day) && DURATIONS.some((duration) => duration >= length && day[duration].includes(start));
    })
    .map((club) => club.name);
  return names.length ? state('ok', names) : state('none');
}

// ------------------------------------------------------------------ сообщения

function encode(snapshot, action, fields) {
  const json = JSON.stringify({ v: PROTOCOL_VERSION, t: snapshot.stamp, action, ...fields });
  const size = utf8.encode(json).length;
  if (size > MAX_BYTES) throw new Error(`Слишком много данных: ${size} байт, Telegram пропускает ${MAX_BYTES}`);
  return json;
}

const isMinute = (m) => Number.isInteger(m) && m >= SLOT_START && m <= SLOT_END && m % SLOT_STEP === 0;

function checkInterval(start, end) {
  if (!isMinute(start) || !isMinute(end) || start >= end) {
    throw new Error(`Неверное время ${start}–${end}: нужны получасы с 07:00 до 23:00`);
  }
}

function checkDate(snapshot, date) {
  if (!snapshot.dates.includes(date)) throw new Error(`Дата ${date} вне окна календаря`);
}

/** `days` — из desiredDays: [{date, slots: [[start, end], …]}, …]. */
export function buildSetAvailability(snapshot, days) {
  if (!Array.isArray(days) || days.length > MAX_DAYS) throw new Error(`В одном сообщении — не больше ${MAX_DAYS} дней`);
  const seen = new Set();
  const clean = days.map(({ date, slots }) => {
    checkDate(snapshot, date);
    if (seen.has(date)) throw new Error(`День ${date} указан дважды`);
    seen.add(date);
    if (!Array.isArray(slots)) throw new Error(`Нет интервалов дня ${date}`);
    for (const slot of slots) {
      if (!Array.isArray(slot) || slot.length !== 2) throw new Error(`Неверный интервал дня ${date}`);
      checkInterval(slot[0], slot[1]);
    }
    return { date, slots: slots.map(([start, end]) => [start, end]) };
  });
  return encode(snapshot, 'set_availability', { days: clean });
}

/** Новая игра; пустой корт не передаётся. */
export function buildCreateGame(snapshot, { date, start, end, court = '' }) {
  checkDate(snapshot, date);
  checkInterval(start, end);
  if (typeof court !== 'string') throw new Error('Корт — это текст');
  const label = court.trim();
  return encode(snapshot, 'create_game', { date, start, end, ...(label ? { court: label } : {}) });
}

export function buildGameOp(snapshot, id, op) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Неверный номер игры: ${id}`);
  if (!GAME_OPS.includes(op)) throw new Error(`Неизвестное действие с игрой: ${op}`);
  return encode(snapshot, 'game', { id, op });
}

export function buildRefresh(snapshot) {
  return encode(snapshot, 'refresh', {});
}

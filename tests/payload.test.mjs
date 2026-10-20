import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCreateGame,
  buildGameOp,
  buildRefresh,
  buildSetAvailability,
  desiredDays,
  MAX_BYTES,
} from '../payload.js';

// Срез — `expected` общего вектора: ровно то, что возвращает decodePayload.
// me = 1 (@ivan); 2026-10-20 (сегодня, первый день): free 18:00–19:00, rule 18:00–20:00 и 22:30–23:00;
// 2026-10-22: free 18:00–20:00 и игра 101 18:00–20:00, где ivan в «да».
const vector = JSON.parse(await readFile(new URL('./vector.json', import.meta.url), 'utf8'));
const snapshot = () => structuredClone(vector.expected);

const TODAY = '2026-10-20';
const at = (h, m = 0) => new Date(2026, 9, 20, h, m); // местное время устройства
const MORNING = at(7); // 07:00 — у сегодня ещё не прошло ни одного получаса
const halfHours = (from, to) => {
  const out = [];
  for (let m = from; m < to; m += 30) out.push(m);
  return out;
};
const TODAY_PAINTED = [1080, 1110, 1140, 1170, 1350]; // free ∪ rule у me на сегодня
const parse = (json) => JSON.parse(json);
const bytes = (text) => new TextEncoder().encode(text).length;

// ------------------------------------------------------------------ desiredDays

test('изменённый день даёт слитые интервалы', () => {
  const edited = new Map([['2026-10-21', new Set([600, 630, 660, 900])]]);
  assert.deepEqual(desiredDays(snapshot(), edited, MORNING), [
    { date: '2026-10-21', slots: [[600, 690], [900, 930]] },
  ]);
});

test('сегодня: начавшиеся получасы не попадают в желаемое состояние', () => {
  // 13:20 — получас 13:00 уже начался, 13:30 ещё нет
  const edited = new Map([[TODAY, new Set([600, 630, 780, 810, ...TODAY_PAINTED])]]);
  assert.deepEqual(desiredDays(snapshot(), edited, at(13, 20)), [
    { date: TODAY, slots: [[810, 840], [1080, 1200], [1350, 1380]] },
  ]);
});

test('сегодня: правка только прошедших получасов — день не изменён', () => {
  const edited = new Map([[TODAY, new Set([600, 780, ...TODAY_PAINTED])]]);
  assert.deepEqual(desiredDays(snapshot(), edited, at(13, 20)), []);
});

test('отсечка прошлого — только у первого дня среза', () => {
  const edited = new Map([['2026-10-21', new Set([420])]]);
  assert.deepEqual(desiredDays(snapshot(), edited, at(22, 0)), [
    { date: '2026-10-21', slots: [[420, 450]] },
  ]);
});

test('неизменённые дни не отправляются', () => {
  const edited = new Map([
    [TODAY, new Set(TODAY_PAINTED)],
    ['2026-10-21', new Set()],
    ['2026-10-22', new Set([1080, 1110, 1140, 1170])],
  ]);
  assert.deepEqual(desiredDays(snapshot(), edited, MORNING), []);
});

test('оставленные закрашенными ячейки правила входят в желаемое состояние', () => {
  // сняли одну разовую ячейку 18:00; 18:30–20:00 и 22:30 — из правила, остаются желаемыми
  const edited = new Map([[TODAY, new Set([1110, 1140, 1170, 1350])]]);
  assert.deepEqual(desiredDays(snapshot(), edited, MORNING), [
    { date: TODAY, slots: [[1110, 1200], [1350, 1380]] },
  ]);
});

test('очищенный день отправляется с пустым slots', () => {
  const edited = new Map([['2026-10-22', new Set()]]);
  assert.deepEqual(desiredDays(snapshot(), edited, MORNING), [{ date: '2026-10-22', slots: [] }]);
});

test('дни идут в порядке среза, а не в порядке правки', () => {
  const edited = new Map([
    ['2026-10-24', new Set([420])],
    ['2026-10-21', new Set([450])],
  ]);
  assert.deepEqual(
    desiredDays(snapshot(), edited, MORNING).map((day) => day.date),
    ['2026-10-21', '2026-10-24'],
  );
});

test('вся сетка закрашена — один интервал 07:00–23:00', () => {
  const edited = new Map([['2026-10-21', new Set(halfHours(420, 1380))]]);
  assert.deepEqual(desiredDays(snapshot(), edited, MORNING), [
    { date: '2026-10-21', slots: [[420, 1380]] },
  ]);
});

test('день вне среза — ошибка', () => {
  const edited = new Map([['2026-11-03', new Set([420])]]);
  assert.throws(() => desiredDays(snapshot(), edited, MORNING), Error);
});

// ------------------------------------------------------------------ сборка сообщений

test('buildSetAvailability → ожидаемый JSON', () => {
  const days = [
    { date: TODAY, slots: [[1110, 1200]] },
    { date: '2026-10-22', slots: [] },
  ];
  assert.deepEqual(parse(buildSetAvailability(snapshot(), days)), {
    v: 1,
    t: 29874860,
    action: 'set_availability',
    days,
  });
});

test('buildSetAvailability проверяет дни и минуты', () => {
  const bad = [
    [{ date: TODAY, slots: [[1095, 1200]] }], // не кратно 30
    [{ date: TODAY, slots: [[390, 480]] }], // раньше 07:00
    [{ date: TODAY, slots: [[1350, 1410]] }], // позже 23:00
    [{ date: TODAY, slots: [[1200, 1200]] }], // start == end
    [{ date: TODAY, slots: [[1080.5, 1200]] }], // не целое
    [{ date: TODAY, slots: [[1080]] }], // не пара
    [{ date: '2026-11-03', slots: [] }], // вне среза
    [{ date: TODAY, slots: [] }, { date: TODAY, slots: [] }], // дубль даты
  ];
  for (const days of bad) assert.throws(() => buildSetAvailability(snapshot(), days), Error, JSON.stringify(days));
});

test('buildCreateGame → ожидаемый JSON', () => {
  const json = buildCreateGame(snapshot(), { date: '2026-10-21', start: 1080, end: 1200, court: ' Заряд, корт 3 ' });
  assert.deepEqual(parse(json), {
    v: 1,
    t: 29874860,
    action: 'create_game',
    date: '2026-10-21',
    start: 1080,
    end: 1200,
    court: 'Заряд, корт 3',
  });
});

test('buildCreateGame: пустой корт не передаётся', () => {
  const json = buildCreateGame(snapshot(), { date: '2026-10-21', start: 420, end: 1380, court: '   ' });
  assert.deepEqual(parse(json), { v: 1, t: 29874860, action: 'create_game', date: '2026-10-21', start: 420, end: 1380 });
});

test('buildCreateGame проверяет дату и время', () => {
  const bad = [
    { date: '2026-10-21', start: 1200, end: 1080, court: '' },
    { date: '2026-10-21', start: 1095, end: 1200, court: '' },
    { date: '2026-10-21', start: 1350, end: 1410, court: '' },
    { date: '2026-11-03', start: 1080, end: 1200, court: '' },
    { date: '2026-10-21', start: 1080, end: 1200, court: 3 },
  ];
  for (const game of bad) assert.throws(() => buildCreateGame(snapshot(), game), Error, JSON.stringify(game));
});

test('buildGameOp → ожидаемый JSON и проверка op/id', () => {
  for (const op of ['yes', 'no', 'gplus', 'gminus']) {
    assert.deepEqual(parse(buildGameOp(snapshot(), 101, op)), { v: 1, t: 29874860, action: 'game', id: 101, op });
  }
  assert.throws(() => buildGameOp(snapshot(), 101, 'maybe'), Error);
  for (const id of [0, -1, 1.5, '101', null]) assert.throws(() => buildGameOp(snapshot(), id, 'yes'), Error, String(id));
});

test('buildRefresh → только v, t и action', () => {
  assert.deepEqual(parse(buildRefresh(snapshot())), { v: 1, t: 29874860, action: 'refresh' });
});

test('t берётся из среза', () => {
  const snap = { ...snapshot(), stamp: 30000000 };
  assert.equal(parse(buildRefresh(snap)).t, 30000000);
  assert.equal(parse(buildGameOp(snap, 101, 'yes')).t, 30000000);
  assert.equal(parse(buildSetAvailability(snap, [])).t, 30000000);
  assert.equal(parse(buildCreateGame(snap, { date: TODAY, start: 1080, end: 1200, court: '' })).t, 30000000);
});

test('сообщение длиннее 4096 байт — ошибка, ровно 4096 — проходит', () => {
  assert.equal(MAX_BYTES, 4096);
  const game = (court) => ({ date: '2026-10-21', start: 1080, end: 1200, court });
  const base = bytes(buildCreateGame(snapshot(), game('x'))); // корт из одного байта
  const fit = buildCreateGame(snapshot(), game('x'.repeat(4096 - base + 1)));
  assert.equal(bytes(fit), 4096);
  assert.throws(() => buildCreateGame(snapshot(), game('x'.repeat(4097 - base + 1))), /4096/);
});

test('предел считается в байтах UTF-8, а не в символах', () => {
  const court = 'ж'.repeat(2100); // 2100 символов, 4200 байт
  assert.throws(() => buildCreateGame(snapshot(), { date: '2026-10-21', start: 1080, end: 1200, court }), /4096/);
});

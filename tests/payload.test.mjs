import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCreateGame,
  buildGameOp,
  buildRefresh,
  buildSetAvailability,
  courtsForGame,
  desiredDays,
  effectiveCells,
  freeCells,
  MAX_BYTES,
} from '../payload.js';

// Срез — `expected` общего вектора (формат v2): ровно то, что возвращает decodePayload.
// me = 1 (@ivan); 2026-10-20 (сегодня, первый день): free 18:00–19:00, rule 18:00–20:00 и 22:30–23:00;
// 2026-10-22: free 18:00–20:00 и игра 101 18:00–20:00, где ivan в «да».
// Корты на 2026-10-22: «Заряд Падел» — 18:00 на 60 и на 120 минут; «Падел Хаб Сколково» — 18:30 на 90
// и 22:30 на 120. На 2026-10-23 свободных кортов нет.
const vector = JSON.parse(await readFile(new URL('./vector.json', import.meta.url), 'utf8'));
const snapshot = () => structuredClone(vector.expected);

const TODAY = '2026-10-20';
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
  assert.deepEqual(desiredDays(snapshot(), edited), [
    { date: '2026-10-21', slots: [[600, 690], [900, 930]] },
  ]);
});

// Прошлое у сегодня отсекает бот по своим часам. Если часы устройства спешат, отброшенные страницей
// получасы [часы бота, часы устройства) бот принял бы за снятые и молча стёр бы доступность.
test('сегодня: часы устройства не отбрасывают получасы — прошлое отсекает бот', () => {
  const snap = snapshot();
  snap.availability[1][0] = { free: [[780, 840]], rule: [] }; // объявлено 13:00–14:00
  // на устройстве 13:20, у бота может быть раньше: получас 13:00 уходит как есть
  const edited = new Map([[TODAY, new Set([780, 810, 1080, 1110])]]); // докрасили 18:00–19:00
  assert.deepEqual(desiredDays(snap, edited), [
    { date: TODAY, slots: [[780, 840], [1080, 1140]] },
  ]);
});

test('сегодня: начавшиеся получасы отправляются как в срезе, отсекает их бот', () => {
  // в 19:10 получасы 18:00–19:30 уже начались (в сетке заперты); докрасили 20:00
  const edited = new Map([[TODAY, new Set([...TODAY_PAINTED, 1200])]]);
  assert.deepEqual(desiredDays(snapshot(), edited), [
    { date: TODAY, slots: [[1080, 1230], [1350, 1380]] },
  ]);
});

test('неизменённые дни не отправляются', () => {
  const edited = new Map([
    [TODAY, new Set(TODAY_PAINTED)],
    ['2026-10-21', new Set()],
    ['2026-10-22', new Set([1080, 1110, 1140, 1170])],
  ]);
  assert.deepEqual(desiredDays(snapshot(), edited), []);
});

test('оставленные закрашенными ячейки правила входят в желаемое состояние', () => {
  // сняли одну разовую ячейку 18:00; 18:30–20:00 и 22:30 — из правила, остаются желаемыми
  const edited = new Map([[TODAY, new Set([1110, 1140, 1170, 1350])]]);
  assert.deepEqual(desiredDays(snapshot(), edited), [
    { date: TODAY, slots: [[1110, 1200], [1350, 1380]] },
  ]);
});

test('очищенный день отправляется с пустым slots', () => {
  const edited = new Map([['2026-10-22', new Set()]]);
  assert.deepEqual(desiredDays(snapshot(), edited), [{ date: '2026-10-22', slots: [] }]);
});

test('дни идут в порядке среза, а не в порядке правки', () => {
  const edited = new Map([
    ['2026-10-24', new Set([420])],
    ['2026-10-21', new Set([450])],
  ]);
  assert.deepEqual(
    desiredDays(snapshot(), edited).map((day) => day.date),
    ['2026-10-21', '2026-10-24'],
  );
});

test('вся сетка закрашена — один интервал 07:00–23:00', () => {
  const edited = new Map([['2026-10-21', new Set(halfHours(420, 1380))]]);
  assert.deepEqual(desiredDays(snapshot(), edited), [
    { date: '2026-10-21', slots: [[420, 1380]] },
  ]);
});

test('день вне среза — ошибка', () => {
  const edited = new Map([['2026-11-03', new Set([420])]]);
  assert.throws(() => desiredDays(snapshot(), edited), Error);
});

// ------------------------------------------------------------------ effectiveCells

// 2026-10-22: у me (id 1) объявлено 18:00–20:00; игры дня подставляются в каждом тесте
const GAME_DAY = '2026-10-22';
const withGames = (...games) => {
  const snap = snapshot();
  snap.games = games.map((g, i) => ({
    id: 900 + i, date: GAME_DAY, start: null, end: null, court: '', booked: false,
    creator: null, yes: [], guests: [], waiting: [], ...g,
  }));
  return snap;
};
const sorted = (set) => [...set].sort((a, b) => a - b);

test('effectiveCells: своя игра со временем вычитается из своей доступности', () => {
  const snap = withGames({ start: 1080, end: 1140, yes: [1, 3] });
  assert.deepEqual(sorted(freeCells(snap, 1, GAME_DAY)), [1080, 1110, 1140, 1170]); // срез — объявленная
  assert.deepEqual(sorted(effectiveCells(snap, 1, GAME_DAY)), [1140, 1170]);
});

test('effectiveCells: игра, где me только в ожидающих, не вычитается', () => {
  const snap = withGames({ start: 1080, end: 1200, yes: [3], waiting: [1] });
  assert.deepEqual(sorted(effectiveCells(snap, 1, GAME_DAY)), [1080, 1110, 1140, 1170]);
});

test('effectiveCells: игра без времени не вычитается', () => {
  const snap = withGames({ yes: [1] });
  assert.deepEqual(sorted(effectiveCells(snap, 1, GAME_DAY)), [1080, 1110, 1140, 1170]);
});

test('effectiveCells: игры других дней не вычитаются', () => {
  const snap = withGames({ date: '2026-10-21', start: 1080, end: 1200, yes: [1] });
  assert.deepEqual(sorted(effectiveCells(snap, 1, GAME_DAY)), [1080, 1110, 1140, 1170]);
});

test('effectiveCells: на векторе игра 101 (18:00–20:00, me в «да») закрывает весь свободный отрезок', () => {
  assert.deepEqual(sorted(effectiveCells(snapshot(), 1, GAME_DAY)), []);
});

test('effectiveCells: чужая доступность в срезе уже эффективная и не меняется', () => {
  const snap = withGames({ start: 420, end: 1380, yes: [1, 3, 5123456789] });
  for (const id of [3, 5123456789]) {
    for (const date of snap.dates) assert.deepEqual(sorted(effectiveCells(snap, id, date)), sorted(freeCells(snap, id, date)));
  }
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

// ------------------------------------------------------------------ courtsForGame

test('courtsForGame объединяет классы не короче игры', () => {
  const s = snapshot();
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1080, 1140), { state: 'ok', names: ['Заряд Падел'] });
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1080, 1200), { state: 'ok', names: ['Заряд Падел'] });
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1110, 1170), { state: 'ok', names: ['Падел Хаб Сколково'] });
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1080, 1260), { state: 'too_long', names: [] });
  assert.deepEqual(courtsForGame(s, '2026-10-23', 1080, 1140), { state: 'none', names: [] });
  assert.equal(courtsForGame({ ...s, flags: s.flags | 8, courts: { stamp: 0, clubs: [] } }, '2026-10-22', 1080, 1140).state, 'trimmed');
  assert.equal(courtsForGame({ ...s, courts: { stamp: 0, clubs: [] } }, '2026-10-22', 1080, 1140).state, 'off');
});

test('courtsForGame: старт обязан совпасть, более длинный класс подходит, более короткий нет', () => {
  const s = snapshot();
  // Сколково: 90 минут с 18:30 — годится для игры на час и на полтора, но не на два часа
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1110, 1200).names, ['Падел Хаб Сколково']);
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1110, 1230), { state: 'none', names: [] });
  // 120 минут с 22:30 — игра на полчаса тоже помещается
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1350, 1380).names, ['Падел Хаб Сколково']);
  // Заряд, 18:00: класс на 60 минут не годится для игры на 90, но класс на 120 — годится
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1080, 1170).names, ['Заряд Падел']);
  // 18:30 у Заряда нет ни в одном классе
  assert.equal(courtsForGame(s, '2026-10-22', 1110, 1140).names.includes('Заряд Падел'), false);
});

test('courtsForGame: клубы идут в порядке среза, каждый один раз', () => {
  const s = snapshot();
  s.courts.clubs[1].days[2][90].push(1080); // у Сколково тоже появился старт 18:00
  s.courts.clubs[1].days[2][120].push(1080); // и в двух классах сразу
  assert.deepEqual(courtsForGame(s, '2026-10-22', 1080, 1140).names, ['Заряд Падел', 'Падел Хаб Сколково']);
});

test('courtsForGame: «обрезано» важнее «нет клубов», а слишком длинная игра — важнее поиска', () => {
  const s = snapshot();
  assert.equal(courtsForGame({ ...s, flags: s.flags | 8 }, '2026-10-22', 1080, 1140).state, 'trimmed');
  assert.equal(courtsForGame({ ...s, flags: s.flags | 8 }, '2026-10-22', 1080, 1260).state, 'trimmed');
  assert.equal(courtsForGame({ ...s, courts: { stamp: 0, clubs: [] } }, '2026-10-22', 1080, 1260).state, 'off');
  assert.equal(courtsForGame(s, '2026-10-22', 420, 1380).state, 'too_long');
});

test('courtsForGame: дата вне среза — «нет», а не ошибка', () => {
  assert.deepEqual(courtsForGame(snapshot(), '2030-01-01', 1080, 1140), { state: 'none', names: [] });
});

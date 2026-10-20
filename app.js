// Страница календаря: срез из `?d=` (codec.js) → три экрана макета; действия собирает payload.js,
// отправляет send() через Telegram.WebApp.sendData. Экраны перенесены из утверждённого макета
// (webapp/index.html в репозитории бота, коммит 0dd4b61) и читают данные только из `snapshot`.
import {
  decodePayload,
  FLAG_NO_OTHERS,
  FLAG_NO_WAITING,
  FLAG_SHORT_WINDOW,
  SLOT_END,
  SLOT_START,
  SLOT_STEP,
} from './codec.js';
import {
  buildCreateGame,
  buildGameOp,
  buildRefresh,
  buildSetAvailability,
  dayMinutes,
  desiredDays,
  effectiveCells,
  freeCells,
  halfHours,
  isPast,
  painted,
  toSlots,
} from './payload.js';

const APP_VERSION = '0.1.0'; // версия страницы (спека §4.1)

let snapshot = null; // Snapshot из codec.js — единственный источник данных экранов
let days = []; // локальные Date для snapshot.dates (тот же порядок)
let names = new Map(); // id игрока → имя

const $ = (id) => document.getElementById(id);
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // локальная дата
const fromIso = (text) => {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const tm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const timeRange = (start, end) => (start === null ? 'Время не указано' : `${tm(start)}–${tm(end)}`);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ESC[c]); // имена и корт — ввод игроков
const nameOf = (id) => names.get(id) ?? String(id);
const playerIds = () => snapshot.players.map((p) => p.id);
const noOthers = () => Boolean(snapshot.flags & FLAG_NO_OTHERS); // чужие нулевые маски — «неизвестно»
const dayTitle = (d) => `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

function node(tag, className, html) {
  const el = document.createElement(tag);
  el.className = className;
  el.innerHTML = html;
  return el;
}

// ------------------------------------------------------------------ данные среза

/**
 * Состав игры по id: игроки «да» и их гости («@vasya +1», «@vasya +2»…); `host` — чей это слот.
 * Гости игрока, который не в «да», не показываются (как на карточке бота).
 */
function lineup(game) {
  const out = [];
  for (const id of game.yes) {
    out.push({ host: id, label: nameOf(id) });
    for (const [host, count] of game.guests) {
      if (host === id) for (let k = 1; k <= count; k++) out.push({ host: id, label: `${nameOf(id)} +${k}` });
    }
  }
  return out;
}

/**
 * Отрезки дня, на которых свободен один и тот же набор игроков. У всех — эффективная доступность
 * (effectiveCells): у чужих это free ∪ rule из среза, у `me` — объявленная минус свои игры со
 * временем (иначе `me` «свободен» во время своей игры); `me` помечается при показе.
 */
function spans(date) {
  const cells = playerIds().map((id) => [id, effectiveCells(snapshot, id, date)]);
  const out = [];
  for (let m = SLOT_START; m < SLOT_END; m += SLOT_STEP) {
    const ids = cells.filter(([, set]) => set.has(m)).map(([id]) => id);
    if (!ids.length) continue;
    const last = out[out.length - 1];
    if (last && last.end === m && last.ids.join() === ids.join()) last.end = m + SLOT_STEP;
    else out.push({ start: m, end: m + SLOT_STEP, ids });
  }
  return out;
}

// ------------------------------------------------------------------ отправка

/** Telegram открыл страницу (а не обычный браузер): SDK грузится всегда, но вне Telegram platform = 'unknown'. */
const insideTelegram = (tg) => typeof tg?.sendData === 'function' && (tg.platform !== 'unknown' || Boolean(tg.initData));

/**
 * В Telegram — toast «Отправлено», затем sendData (Telegram сразу закрывает приложение, ответ
 * бота придёт в чат). В браузере (dev.html) — JSON в консоль и в toast.
 */
function send(json) {
  const tg = window.Telegram?.WebApp;
  if (insideTelegram(tg)) {
    toast('Отправлено');
    tg.sendData(json);
    return;
  }
  console.log('sendData:', json);
  toast(json.length > 300 ? `${json.slice(0, 300)}…` : json, 6000);
}

/** Собрать сообщение и отправить; ошибка сборки (неверное поле, больше 4096 байт) — toast. */
function act(build) {
  try {
    send(build());
  } catch (error) {
    toast(error.message);
  }
}

// ------------------------------------------------------------------ шапка

function renderStamp() {
  const at = new Date(snapshot.stamp * 60_000); // unix-минуты → местное время
  const lines = [`данные на ${tm(at.getHours() * 60 + at.getMinutes())}`];
  if (snapshot.flags & FLAG_SHORT_WINDOW) lines.push('показаны 7 дней');
  if (noOthers()) lines.push('без чужой доступности');
  $('stamp').textContent = lines.join('\n');
}

// ------------------------------------------------------------------ экран 1: расписание

function renderSchedule() {
  const el = $('s-schedule');
  el.innerHTML = noOthers()
    ? '<p class="note">Чужая доступность не поместилась в данные — видно только ваше время и игры.</p>'
    : '';
  days.forEach((d, i) => {
    const date = snapshot.dates[i];
    const items = [
      ...spans(date).map((s) => ({ t: s.start, rows: spanRows(date, s) })),
      ...snapshot.games.filter((g) => g.date === date).map((g) => ({ t: g.start ?? Infinity, rows: gameRows(g) })), // без времени — в конце дня
    ].sort((a, b) => a.t - b.t);
    if (!items.length) return;
    const day = node('div', 'day', `<h2>${dayTitle(d)}</h2>`);
    day.firstChild.onclick = () => {
      // тап по дню раскрывает все его строки (или сворачивает, если раскрыты все)
      const rows = [...day.querySelectorAll('.row')];
      const open = rows.some((r) => !r.classList.contains('open'));
      rows.forEach((r) => r.classList.toggle('open', open));
    };
    for (const it of items) day.append(...it.rows);
    el.appendChild(day);
  });
  if (!el.querySelector('.day')) el.insertAdjacentHTML('beforeend', '<p class="empty">На эти дни пока никто не отметился.</p>');
}

/** Отрезок «свободны» и раскрытие: кто именно и в какие часы. */
function spanRows(date, s) {
  const me = snapshot.me;
  const onlyMe = s.ids.length === 1 && s.ids[0] === me;
  const row = node(
    'div',
    'row',
    `<span class="t">${timeRange(s.start, s.end)}</span><span class="meta">${onlyMe ? 'только вы' : 'свободны'}</span><span class="cnt">${s.ids.length} чел.</span><span class="chev">›</span>`,
  );
  const chips = s.ids.map((id) => {
    const own = toSlots(effectiveCells(snapshot, id, date))
      .filter(([a, b]) => a < s.end && b > s.start)
      .map(([a, b]) => timeRange(a, b))
      .join(', ');
    const mark = id === me ? ' me' : '';
    return `<span class="chip${mark}"><b>${esc(nameOf(id))}</b>${mark ? '<i>вы</i>' : ''}<span>${own}</span></span>`;
  });
  row.onclick = () => row.classList.toggle('open');
  return [row, node('div', 'detail', chips.join(''))];
}

/** Игра: строка дня и карточка с составом, резервом, ожидающими и кнопками по составу. */
function gameRows(g) {
  const me = snapshot.me;
  const lu = lineup(g);
  const main = lu.slice(0, 4);
  const reserve = lu.slice(4);
  const playing = g.yes.includes(me);
  const myGuests = g.guests.some(([host, count]) => host === me && count > 0);
  const row = node(
    'div',
    'row game',
    `<span class="t">${timeRange(g.start, g.end)}</span><span class="meta">🎾 ${esc(main.map((e) => e.label).join(' '))}${reserve.length ? ' …' : ''}</span><span class="cnt">${main.length}/4</span><span class="chev">›</span>`,
  );
  let waiting = '';
  if (snapshot.flags & FLAG_NO_WAITING) waiting = '<div class="reserve">❓ Список ожидающих не передан — он есть на карточке в чате</div>';
  else if (g.waiting.length) waiting = `<div class="reserve">❓ Требуется подтверждение: ${esc(g.waiting.map(nameOf).join(', '))}</div>`;
  const buttons = [
    playing ? ['no', 'Не играю', 'ghost'] : ['yes', 'Играю', ''],
    ...(playing ? [['gplus', '+1', 'ghost']] : []),
    ...(myGuests ? [['gminus', '−1', 'ghost']] : []),
  ];
  const det = node(
    'div',
    'detail',
    `<div class="card"><div class="line"><span>📍 ${esc(g.court || 'Корт не указан')}</span><span>${g.booked ? '✅ бронь' : '⚠️ нет брони'}</span></div>` +
      (main.length
        ? main.map((e) => `<div class="line${e.host === me ? ' me' : ''}"><span>${esc(e.label)}</span><span>✅</span></div>`).join('')
        : '<div class="line"><span class="empty">Пока никто не записался</span></div>') +
      (reserve.length ? `<div class="reserve">🕓 Резерв: ${esc(reserve.map((e) => e.label).join(', '))}</div>` : '') +
      waiting +
      `<div class="actions">${buttons.map(([op, text, cls]) => `<button class="btn ${cls}" data-op="${op}">${text}</button>`).join('')}</div></div>`,
  );
  row.onclick = () => row.classList.toggle('open');
  det.querySelectorAll('[data-op]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      act(() => buildGameOp(snapshot, g.id, b.dataset.op));
    };
  });
  return [row, det];
}

// ------------------------------------------------------------------ экран 2: сетка «Моё время»

let week = 0;
let origin = new Map(); // дата → {free, rule}: получасы me в срезе (цвет ячеек и «не сохранено»)
let mine = new Map(); // дата → закрашенные получасы; правит сетка, «Отменить» возвращает срез
let painting = null;
let lastPaint = null;
const weeks = () => Math.ceil(days.length / 7);

function initMine() {
  origin = new Map(
    snapshot.dates.map((date, i) => {
      const day = snapshot.availability[snapshot.me]?.[i];
      return [date, { free: halfHours(day?.free ?? []), rule: halfHours(day?.rule ?? []) }];
    }),
  );
  mine = new Map(snapshot.dates.map((date) => [date, painted(snapshot, date)]));
}

/** Своя игра (me в «да»), задевающая получас m. */
function myGameAt(date, m) {
  return snapshot.games.find(
    (g) => g.date === date && g.yes.includes(snapshot.me) && g.start !== null && g.start < m + SLOT_STEP && m < g.end,
  );
}

/** Прошедшие получасы и свои игры не редактируются. */
const locked = (date, m, now = new Date()) => isPast(snapshot, date, m, now) || Boolean(myGameAt(date, m));

function renderGrid() {
  const now = new Date();
  const g = $('grid');
  g.innerHTML = '';
  const shown = days.slice(week * 7, week * 7 + 7);
  const first = shown[0];
  const last = shown[shown.length - 1];
  g.style.gridTemplateColumns = `44px repeat(${shown.length}, 1fr)`;
  $('range').textContent = `${first.getDate()}.${pad(first.getMonth() + 1)} – ${last.getDate()}.${pad(last.getMonth() + 1)}`;
  $('prev').disabled = week === 0;
  $('next').disabled = week >= weeks() - 1;
  g.appendChild(node('div', 'hd', ''));
  for (const d of shown) {
    g.appendChild(node('div', 'hd' + (iso(d) === snapshot.dates[0] ? ' today' : ''), `${WD[d.getDay()]}<b>${d.getDate()}</b>`));
  }
  for (let m = SLOT_START; m < SLOT_END; m += SLOT_STEP) {
    const t = node('div', 'tm' + (m % 60 === 0 ? ' hour' : ''), '');
    t.textContent = m % 60 === 0 ? tm(m) : '';
    g.appendChild(t);
    for (const d of shown) {
      const date = iso(d);
      const { free, rule } = origin.get(date);
      const on = mine.get(date).has(m);
      const c = node('div', 'cell' + (m % 60 === 0 ? ' hour' : ''), '');
      c.dataset.date = date;
      c.dataset.m = m;
      const past = isPast(snapshot, date, m, now);
      if (past) c.classList.add('past');
      const game = myGameAt(date, m);
      if (game) {
        c.classList.add('game');
        if (m === Math.max(SLOT_START, game.start - ((game.start - SLOT_START) % SLOT_STEP))) {
          c.classList.add('first');
          c.dataset.label = '🎾 ' + (game.court || 'игра').split(',')[0]; // атрибут для CSS attr(), не HTML
        }
      } else if (on) c.classList.add(rule.has(m) && !free.has(m) ? 'rule' : 'free');
      if (!past && !game && on !== (free.has(m) || rule.has(m))) c.classList.add('changed');
      g.appendChild(c);
    }
  }
}

// Жесты на сетке. Мышь красит сразу. Палец: свайп листает страницу, короткое нажатие
// отмечает одну клетку, удержание LONG_PRESS мс без движения включает закраску протяжкой —
// иначе на телефоне сетку невозможно пролистать (любое касание красило).
const LONG_PRESS = 350; // мс
const TAP_SLOP = 8; // px — дальше этого палец «поехал», значит это прокрутка
let touch = null; // { cell, x, y, id, timer, mode: 'pending' | 'paint' | 'scroll' }

function bindGridGestures(grid) {
  const finish = (e) => {
    if (e.pointerType !== 'mouse' && touch) {
      clearTimeout(touch.timer);
      if (touch.mode === 'pending' && e.type === 'pointerup') paint(touch.cell); // тап
      touch = null;
    }
    painting = null;
    lastPaint = null;
  };
  grid.addEventListener('pointerdown', (e) => {
    painting = null;
    lastPaint = null;
    if (e.pointerType === 'mouse') {
      paint(e.target);
      return;
    }
    const cell = e.target.closest?.('.cell');
    if (!cell) return;
    touch = { cell, x: e.clientX, y: e.clientY, id: e.pointerId, mode: 'pending', timer: 0 };
    touch.timer = setTimeout(() => {
      if (!touch || touch.mode !== 'pending') return;
      touch.mode = 'paint';
      try {
        grid.setPointerCapture(touch.id);
      } catch {
        /* старые WebView без захвата указателя — закраска всё равно работает */
      }
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('light');
      paint(touch.cell);
    }, LONG_PRESS);
  });
  grid.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      if (e.buttons !== 1 || painting === null) return;
      paint(document.elementFromPoint(e.clientX, e.clientY));
      return;
    }
    if (!touch) return;
    if (touch.mode === 'pending') {
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > TAP_SLOP) {
        touch.mode = 'scroll';
        clearTimeout(touch.timer);
      }
      return;
    }
    if (touch.mode === 'paint') paint(document.elementFromPoint(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  // Пока идёт закраска, не отдаём жест прокрутке страницы (слушатель обязан быть не passive).
  grid.addEventListener('touchmove', (e) => {
    if (touch?.mode === 'paint') e.preventDefault();
  }, { passive: false });
  grid.addEventListener('contextmenu', (e) => e.preventDefault()); // долгое нажатие — не меню
}

function paint(cell) {
  if (!cell || !cell.classList.contains('cell')) return;
  const date = cell.dataset.date;
  const m = +cell.dataset.m;
  if (locked(date, m)) return;
  const set = mine.get(date);
  if (painting === null) painting = !set.has(m);
  // протяжка: заполняем промежуток между прошлой и текущей ячейкой, минуя закрытые
  const [a, b] = lastPaint?.date === date ? [Math.min(lastPaint.m, m), Math.max(lastPaint.m, m)] : [m, m];
  for (let x = a; x <= b; x += SLOT_STEP) {
    if (locked(date, x)) continue;
    if (painting) set.add(x);
    else set.delete(x);
  }
  lastPaint = { date, m };
  renderGrid();
  updateSave();
}

/** Панель «Сохранить» — только на экране «Моё время» и только когда есть изменённые дни. */
function updateSave() {
  const n = desiredDays(snapshot, mine).length;
  $('savebar').hidden = !n || !$('s-mine').classList.contains('active');
  $('save').textContent = `Сохранить · ${n} ${n === 1 ? 'день' : n < 5 ? 'дня' : 'дней'}`;
}

// ------------------------------------------------------------------ экран 3: новая игра

let gdate = null;

/** Самое раннее начало игры на дату: у сегодня — ближайший не начавшийся получас. */
const firstStart = (date) =>
  date === snapshot.dates[0] ? Math.max(SLOT_START, Math.ceil(dayMinutes(new Date()) / SLOT_STEP) * SLOT_STEP) : SLOT_START;

/** Варианты времени с шагом 30 минут; выбранное сохраняется, если оно ещё в диапазоне. */
function fillTimes(select, from, to, fallback) {
  const keep = select.value === '' ? NaN : +select.value;
  select.innerHTML = '';
  for (let m = from; m <= to; m += SLOT_STEP) select.add(new Option(tm(m), m));
  select.value = String(keep >= from && keep <= to ? keep : Math.min(Math.max(fallback, from), to));
}

function renderGame() {
  const open = snapshot.dates.filter((date) => firstStart(date) < SLOT_END); // сегодня после 22:30 — уже нельзя
  if (!open.includes(gdate)) gdate = open[0] ?? null;
  const dd = $('gdates');
  dd.innerHTML = '';
  days.forEach((d, i) => {
    const date = snapshot.dates[i];
    if (!open.includes(date)) return;
    const b = node('button', date === gdate ? 'sel' : '', `${WD[d.getDay()]}<b>${d.getDate()}</b>`);
    b.onclick = () => {
      gdate = date;
      renderGame();
    };
    dd.appendChild(b);
  });
  $('gcreate').disabled = !gdate;
  if (!gdate) {
    $('gwho').innerHTML = '<span class="empty">В этих данных не осталось дней для новой игры</span>';
    return;
  }
  const s = $('gstart');
  const e = $('gend');
  fillTimes(s, firstStart(gdate), SLOT_END - SLOT_STEP, 18 * 60);
  fillTimes(e, +s.value + SLOT_STEP, SLOT_END, +s.value + 120);
  if (noOthers()) {
    $('gwho').innerHTML = '<span class="empty">Неизвестно: чужая доступность не поместилась в данные</span>';
    return;
  }
  const need = [];
  for (let m = +s.value; m < +e.value; m += SLOT_STEP) need.push(m);
  const ids = playerIds().filter((id) => {
    if (id === snapshot.me) return false;
    const cells = freeCells(snapshot, id, gdate);
    return need.every((m) => cells.has(m));
  });
  $('gwho').innerHTML = ids.length
    ? ids.map((id) => `<span class="chip"><b>${esc(nameOf(id))}</b></span>`).join('')
    : '<span class="empty">Пока никто не отметил это время</span>';
}

// ------------------------------------------------------------------ общее

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function bindUi() {
  bindGridGestures($('grid'));
  $('save').onclick = () =>
    act(() => {
      const changed = desiredDays(snapshot, mine);
      if (!changed.length) throw new Error('Изменений нет');
      return buildSetAvailability(snapshot, changed);
    });
  $('undo').onclick = () => {
    initMine();
    renderGrid();
    updateSave();
  };
  $('prev').onclick = () => {
    if (week > 0) {
      week--;
      renderGrid();
    }
  };
  $('next').onclick = () => {
    if (week < weeks() - 1) {
      week++;
      renderGrid();
    }
  };
  ['gstart', 'gend'].forEach((id) => {
    $(id).onchange = renderGame;
  });
  $('gcreate').onclick = () =>
    act(() => buildCreateGame(snapshot, { date: gdate, start: +$('gstart').value, end: +$('gend').value, court: $('gcourt').value }));

  const titles = { schedule: 'Расписание', mine: 'Моё время', game: 'Новая игра' };
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + b.dataset.s));
      $('title').textContent = titles[b.dataset.s];
      if (b.dataset.s === 'mine') renderGrid(); // прошедшие получасы могли добавиться
      if (b.dataset.s === 'game') renderGame();
      updateSave();
    };
  });
  $('refresh').onclick = () => act(() => buildRefresh(snapshot));
}

/** Страница без среза (открыта не из бота или срез битый): короткая подсказка вместо экранов. */
function showNotice(text) {
  document.querySelector('main').innerHTML = `<p class="notice">${esc(text)}</p>`;
  for (const el of [$('stamp'), $('refresh'), document.querySelector('.tabs'), $('savebar')]) el.remove();
}

/** Тема страницы = тема Telegram (светлая/тёмная); вне Telegram — системная. Шапка WebView — в цвет фона. */
function applyTheme(tg) {
  const scheme = insideTelegram(tg)
    ? tg.colorScheme
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = scheme;
  try {
    tg?.setHeaderColor?.('bg_color');
    tg?.setBackgroundColor?.('secondary_bg_color');
  } catch {
    /* старые клиенты без этих методов */
  }
}

async function main() {
  document.documentElement.dataset.version = APP_VERSION;
  const tg = window.Telegram?.WebApp;
  applyTheme(tg);
  tg?.onEvent?.('themeChanged', () => applyTheme(tg));
  tg?.ready();
  tg?.expand();
  tg?.disableVerticalSwipes?.(); // иначе мазок вниз от верхней строки сворачивает приложение (Bot API 7.7+)
  const payload = new URLSearchParams(location.search).get('d');
  if (!payload) {
    showNotice('Откройте календарь из бота');
    return;
  }
  try {
    snapshot = await decodePayload(payload);
  } catch (error) {
    console.error('срез не разобран:', error);
    showNotice('Не получилось прочитать данные календаря. Откройте календарь из бота заново.');
    return;
  }
  if (!snapshot.days) {
    showNotice('В срезе нет ни одного дня. Откройте календарь из бота заново.');
    return;
  }
  days = snapshot.dates.map(fromIso);
  names = new Map(snapshot.players.map((p) => [p.id, p.name]));
  gdate = snapshot.dates[Math.min(1, snapshot.dates.length - 1)];
  try {
    bindUi();
    renderStamp();
    initMine();
    renderSchedule();
    renderGrid();
    renderGame();
  } catch (error) {
    console.error('экраны не отрисованы:', error);
    showNotice('Не получилось показать календарь. Откройте его из бота заново.');
  }
}

main();

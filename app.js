// Страница календаря: срез из `?d=` (codec.js) → три экрана макета.
// Экраны перенесены из утверждённого макета (webapp/index.html в репозитории бота) и читают
// данные только из `snapshot`. Смысл экранов и отправку действий доделывает Задача 8 —
// места помечены TODO(Task 8).
import {
  decodePayload,
  FLAG_NO_OTHERS,
  FLAG_SHORT_WINDOW,
  SLOT_END,
  SLOT_START,
  SLOT_STEP,
} from './codec.js';

const APP_VERSION = '0.1.0'; // версия страницы (спека §4.1)

let snapshot = null; // Snapshot из codec.js — единственный источник данных экранов
let days = []; // локальные Date для snapshot.dates
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

// ------------------------------------------------------------------ данные среза

/** Интервалы игрока на дату: [start, end, 'free' | 'rule']. */
function slotsFor(id, date) {
  // TODO(Task 8): при FLAG_NO_OTHERS нулевые маски чужих — «неизвестно», а не «занят»;
  // чужая доступность = free ∪ rule (эффективная), своя — объявленная.
  const day = snapshot.availability[id]?.[snapshot.dates.indexOf(date)];
  if (!day) return [];
  return [...day.free.map(([s, e]) => [s, e, 'free']), ...day.rule.map(([s, e]) => [s, e, 'rule'])];
}

/** Состав игры: игроки «да» и их гости («@vasya +1», «@vasya +2»…). */
function lineup(game) {
  const out = [];
  for (const id of game.yes) {
    out.push(nameOf(id));
    for (const [host, count] of game.guests) {
      if (host === id) for (let k = 1; k <= count; k++) out.push(`${nameOf(id)} +${k}`);
    }
  }
  return out;
}

/** Отрезки дня, на которых свободен один и тот же набор игроков. */
function spans(date) {
  const ids = playerIds();
  const bounds = new Set();
  ids.forEach((id) => slotsFor(id, date).forEach(([s, e]) => bounds.add(s).add(e)));
  const b = [...bounds].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < b.length - 1; i++) {
    const [a, e] = [b[i], b[i + 1]];
    const free = ids.filter((id) => slotsFor(id, date).some(([s, f]) => s <= a && f >= e));
    if (!free.length) continue;
    const last = out[out.length - 1];
    if (last && last.end === a && last.ids.join() === free.join()) last.end = e;
    else out.push({ start: a, end: e, ids: free });
  }
  return out;
}

function isPast(date, m) {
  // TODO(Task 8): редактируемая область — 07:00–23:00, для сегодня только будущие получасы.
  const now = new Date();
  const today = iso(now);
  return date < today || (date === today && m < now.getHours() * 60 + now.getMinutes());
}

// ------------------------------------------------------------------ действия

// TODO(Task 8): payload.js собирает JSON {v: 1, t: snapshot.stamp, action, …}; toast «Отправлено»,
// затем Telegram.WebApp.sendData(json); без Telegram (dev.html) — console.log + toast с JSON.
function pending(action, fields = {}) {
  console.log('действие (отправка подключается в Задаче 8):', action, fields);
  toast(`Отправка «${action}» пока не подключена`);
}

// ------------------------------------------------------------------ шапка

function renderStamp() {
  const at = new Date(snapshot.stamp * 60_000); // unix-минуты → местное время
  const lines = [`данные на ${tm(at.getHours() * 60 + at.getMinutes())}`];
  if (snapshot.flags & FLAG_SHORT_WINDOW) lines.push('показаны 7 дней');
  if (snapshot.flags & FLAG_NO_OTHERS) lines.push('без чужой доступности');
  $('stamp').textContent = lines.join('\n');
}

// ------------------------------------------------------------------ экран 1: расписание

function renderSchedule() {
  const el = $('s-schedule');
  el.innerHTML = '';
  for (const d of days) {
    const date = iso(d);
    const sp = spans(date);
    const gs = snapshot.games.filter((g) => g.date === date);
    if (!sp.length && !gs.length) continue;
    const day = document.createElement('div');
    day.className = 'day';
    day.innerHTML = `<h2>${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}</h2>`;
    const items = [
      ...sp.map((s) => ({ t: s.start, kind: 'span', s })),
      ...gs.map((g) => ({ t: g.start ?? Infinity, kind: 'game', g })), // без времени — в конце дня
    ].sort((a, b) => a.t - b.t);
    for (const it of items) {
      const row = document.createElement('div');
      const det = document.createElement('div');
      det.className = 'detail';
      if (it.kind === 'span') {
        row.className = 'row';
        row.innerHTML = `<span class="t">${timeRange(it.s.start, it.s.end)}</span><span class="meta">свободны</span><span class="cnt">${it.s.ids.length} чел.</span><span class="chev">›</span>`;
        det.innerHTML = it.s.ids
          .map((p) => {
            const own = slotsFor(p, date)
              .filter(([s, e]) => s < it.s.end && e > it.s.start)
              .map(([s, e]) => timeRange(s, e))
              .join(', ');
            return `<span class="chip"><b>${esc(nameOf(p))}</b><span>${own}</span></span>`;
          })
          .join('');
      } else {
        const g = it.g;
        const lu = lineup(g);
        const meName = nameOf(snapshot.me);
        row.className = 'row game';
        row.innerHTML = `<span class="t">${timeRange(g.start, g.end)}</span><span class="meta">🎾 ${esc(lu.slice(0, 4).join(' '))}${lu.length > 4 ? ' …' : ''}</span><span class="cnt">${Math.min(4, lu.length)}/4</span><span class="chev">›</span>`;
        det.innerHTML =
          `<div class="card"><div class="line"><span>📍 ${esc(g.court || 'Корт не указан')}</span><span>${g.booked ? '✅ бронь' : '⚠️ нет брони'}</span></div>` +
          lu.slice(0, 4).map((n) => `<div class="line ${n.startsWith(meName) ? 'me' : ''}"><span>${esc(n)}</span><span>✅</span></div>`).join('') +
          (lu.length > 4 ? `<div class="reserve">🕓 Резерв: ${esc(lu.slice(4).join(', '))}</div>` : '') +
          // TODO(Task 8): резерв — ещё и g.waiting; кнопки по составу и правилам бота
          `<div class="actions">${g.yes.includes(snapshot.me) ? '<button class="btn ghost" data-op="no">Откажусь</button>' : '<button class="btn" data-op="yes">Играю</button>'}<button class="btn ghost" data-op="gplus">+1</button></div></div>`;
      }
      row.onclick = () => row.classList.toggle('open');
      det.querySelectorAll('[data-op]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          pending('game', { id: it.g.id, op: b.dataset.op });
        };
      });
      day.append(row, det);
    }
    el.appendChild(day);
  }
  if (!el.children.length) el.innerHTML = '<p class="empty">На эти дни пока никто не отметился.</p>';
}

// ------------------------------------------------------------------ экран 2: сетка «Моё время»

let week = 0;
let mine = {}; // date → Set('минуты:free' | 'минуты:rule')
let changed = new Set(); // 'date' и 'date:минуты' изменённых ячеек
let painting = null;
let lastPaint = null;
const weeks = () => Math.ceil(days.length / 7);

function initMine() {
  mine = {};
  for (const d of days) {
    const date = iso(d);
    mine[date] = new Set();
    for (const [s, e, kind] of slotsFor(snapshot.me, date)) {
      for (let m = s; m < e; m += SLOT_STEP) mine[date].add(`${m}:${kind}`);
    }
  }
}

function myGameAt(date, m) {
  return snapshot.games.find(
    (g) => g.date === date && g.yes.includes(snapshot.me) && g.start !== null && g.start <= m && m < g.end,
  );
}

function renderGrid() {
  const g = $('grid');
  g.innerHTML = '';
  const shown = days.slice(week * 7, week * 7 + 7);
  const first = shown[0];
  const last = shown[shown.length - 1];
  $('range').innerText = `${first.getDate()}.${pad(first.getMonth() + 1)} – ${last.getDate()}.${pad(last.getMonth() + 1)}`;
  g.appendChild(Object.assign(document.createElement('div'), { className: 'hd' }));
  const today = iso(new Date());
  for (const d of shown) {
    const h = document.createElement('div');
    h.className = 'hd' + (iso(d) === today ? ' today' : '');
    h.innerHTML = `${WD[d.getDay()]}<b>${d.getDate()}</b>`;
    g.appendChild(h);
  }
  for (let m = SLOT_START; m < SLOT_END; m += SLOT_STEP) {
    const t = document.createElement('div');
    t.className = 'tm' + (m % 60 === 0 ? ' hour' : '');
    t.textContent = m % 60 === 0 ? tm(m) : '';
    g.appendChild(t);
    for (const d of shown) {
      const date = iso(d);
      const c = document.createElement('div');
      c.className = 'cell' + (m % 60 === 0 ? ' hour' : '');
      c.dataset.date = date;
      c.dataset.m = m;
      if (isPast(date, m)) c.classList.add('past');
      const game = myGameAt(date, m);
      if (game) {
        c.classList.add('game');
        if (game.start === m) {
          c.classList.add('first');
          c.dataset.label = '🎾 ' + (game.court || 'игра').split(',')[0];
        }
      } else if (mine[date].has(`${m}:free`)) c.classList.add('free');
      else if (mine[date].has(`${m}:rule`)) c.classList.add('rule');
      if (changed.has(`${date}:${m}`)) c.classList.add('changed');
      g.appendChild(c);
    }
  }
}

function applyPaint(date, m) {
  const set = mine[date];
  if (painting) set.add(`${m}:free`);
  else set.delete(`${m}:free`);
  set.delete(`${m}:rule`);
  changed.add(`${date}:${m}`);
  changed.add(date);
}

function paint(cell) {
  if (!cell || !cell.classList.contains('cell') || cell.classList.contains('past') || cell.classList.contains('game')) return;
  const date = cell.dataset.date;
  const m = +cell.dataset.m;
  const set = mine[date];
  if (painting === null) painting = !(set.has(`${m}:free`) || set.has(`${m}:rule`));
  if (lastPaint && lastPaint.date === date) {
    // протяжка: заполняем промежуток между прошлой и текущей ячейкой
    const [a, b] = lastPaint.m < m ? [lastPaint.m, m] : [m, lastPaint.m];
    for (let x = a; x <= b; x += SLOT_STEP) applyPaint(date, x);
  } else applyPaint(date, m);
  lastPaint = { date, m };
  renderGrid();
  updateSave();
}

const changedDays = () => [...changed].filter((k) => !k.includes(':'));

function updateSave() {
  const n = changedDays().length;
  $('savebar').hidden = !n;
  $('save').textContent = `Сохранить · ${n} ${n === 1 ? 'день' : n < 5 ? 'дня' : 'дней'}`;
}

// ------------------------------------------------------------------ экран 3: новая игра

let gdate = null;

function renderGame() {
  const dd = $('gdates');
  dd.innerHTML = '';
  for (const d of days) {
    const b = document.createElement('button');
    b.innerHTML = `${WD[d.getDay()]}<b>${d.getDate()}</b>`;
    if (iso(d) === gdate) b.classList.add('sel');
    b.onclick = () => {
      gdate = iso(d);
      renderGame();
    };
    dd.appendChild(b);
  }
  const s = $('gstart');
  const e = $('gend');
  if (!s.options.length) {
    for (let m = SLOT_START; m <= SLOT_END; m += 60) {
      s.add(new Option(tm(m), m));
      e.add(new Option(tm(m), m));
    }
    s.value = 1080;
    e.value = 1200;
  }
  const [a, b] = [+s.value, +e.value];
  const ids = playerIds().filter((p) => p !== snapshot.me && slotsFor(p, gdate).some(([x, y]) => x <= a && y >= b));
  $('gwho').innerHTML = ids.length
    ? ids.map((p) => `<span class="chip"><b>${esc(nameOf(p))}</b></span>`).join('')
    : '<span class="empty">Пока никто не отметил это время</span>';
}

// ------------------------------------------------------------------ общее

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function bindUi() {
  const grid = $('grid');
  grid.addEventListener('pointerdown', (e) => {
    painting = null;
    lastPaint = null;
    paint(e.target);
  });
  grid.addEventListener('pointermove', (e) => {
    if (e.buttons !== 1 && e.pointerType === 'mouse') return;
    if (painting === null) return;
    paint(document.elementFromPoint(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', () => {
    painting = null;
    lastPaint = null;
  });
  $('save').onclick = () => {
    pending('set_availability', { days: changedDays() }); // TODO(Task 8): desiredDays из payload.js
    changed = new Set();
    renderGrid();
    updateSave();
  };
  $('undo').onclick = () => {
    initMine();
    changed = new Set();
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
    pending('create_game', { date: gdate, start: +$('gstart').value, end: +$('gend').value, court: $('gcourt').value.trim() });

  const titles = { schedule: 'Расписание', mine: 'Моё время', game: 'Новая игра' };
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + b.dataset.s));
      $('title').textContent = titles[b.dataset.s];
      $('savebar').hidden = b.dataset.s !== 'mine' || !changedDays().length;
    };
  });
  $('refresh').onclick = () => pending('refresh');
}

/** Страница без среза (открыта не из бота или срез битый): короткая подсказка вместо экранов. */
function showNotice(text) {
  document.querySelector('main').innerHTML = `<p class="notice">${esc(text)}</p>`;
  for (const el of [$('stamp'), $('refresh'), document.querySelector('.tabs'), $('savebar')]) el.remove();
}

async function main() {
  document.documentElement.dataset.version = APP_VERSION;
  const tg = window.Telegram?.WebApp;
  tg?.ready();
  tg?.expand();
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
  gdate = iso(days[Math.min(1, days.length - 1)]);
  bindUi();
  renderStamp();
  initMine();
  renderSchedule();
  renderGrid();
  renderGame();
}

main();

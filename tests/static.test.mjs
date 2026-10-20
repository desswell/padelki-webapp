// Сторожа регрессий, которые без DOM не проверить: простые строковые проверки исходников.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

/** Тело CSS-правила ровно с этим селектором (строка начинается с него). */
function rule(css, selector) {
  const match = css.match(new RegExp(`^${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `нет правила ${selector}`);
  return match[1];
}

test('сетка «Моё время» листается пальцем: ячейки разрешают вертикальный свайп', async () => {
  // touch-action: none на ячейках красил при любом касании и не давал пролистать сетку
  const css = await source('style.css');
  assert.match(rule(css, '.cell'), /touch-action:\s*pan-y/);
  assert.doesNotMatch(rule(css, '.grid'), /touch-action/);
});

test('закраска пальцем — только после удержания, прокрутка на время закраски блокируется', async () => {
  const js = await source('app.js');
  assert.match(js, /const LONG_PRESS = \d+/);
  assert.match(js, /pointercancel/);
  assert.match(js, /touchmove[\s\S]*passive:\s*false/);
});

test('свайп вниз не сворачивает приложение: disableVerticalSwipes, если клиент его знает', async () => {
  assert.match(await source('app.js'), /tg\?\.disableVerticalSwipes\?\.\(\)/);
});

test('тёмная тема: цвета только через токены, тёмный набор и переключение по теме Telegram', async () => {
  const css = await source('style.css');
  const body = css.slice(css.indexOf('* { box-sizing'));
  assert.doesNotMatch(body, /#[0-9a-f]{3,6}\b/i, 'в правилах не должно быть захардкоженных цветов');
  assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
  assert.match(await source('index.html'), /dataset\.theme\s*=/);
  assert.match(await source('app.js'), /onEvent\?\.\('themeChanged'/);
});

test('«Корты в это время»: скрытая подпись реально исчезает, а блок стоит в форме «Игра»', async () => {
  // `.form label { display: block }` перебивает встроенное [hidden] — без своего правила подпись осталась бы
  assert.match(await source('style.css'), /^\.form label\[hidden\]\s*\{\s*display:\s*none/m);
  assert.match(await source('index.html'), /id="gwho"[\s\S]*id="gcourts-label"[^>]*>[^<]*<\/label><div class="who" id="gcourts"><\/div>[\s\S]*id="gcreate"/);
});

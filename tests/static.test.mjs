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

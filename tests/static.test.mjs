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

test('сетка «Моё время» листается пальцем: touch-action: none только у ячеек', async () => {
  // у .grid он запрещал прокрутку всем потомкам — и колонке времени, и заголовкам дней
  const css = await source('style.css');
  assert.match(rule(css, '.cell'), /touch-action:\s*none/);
  assert.doesNotMatch(rule(css, '.grid'), /touch-action/);
});

test('свайп вниз не сворачивает приложение: disableVerticalSwipes, если клиент его знает', async () => {
  assert.match(await source('app.js'), /tg\?\.disableVerticalSwipes\?\.\(\)/);
});

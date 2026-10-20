# padelki-webapp

Telegram Mini App «Календарь» для бота Паделкин: расписание игроков на 14 дней, своё
время на сетке получасов и создание игры.

Это статическая страница (HTML/CSS/JS без сборки и без зависимостей) — **бэкенда нет**.
Бот присылает в личке кнопку, в адресе которой лежит срез данных: `index.html?v=1&d=<срез>`.
Страница разбирает срез у себя, а действия отправляет боту через
`Telegram.WebApp.sendData` (подключается позже). В странице нет ни токенов, ни адресов бота.

## Файлы

- `index.html`, `style.css`, `app.js` — страница: три экрана (Расписание, Моё время, Игра).
- `codec.js` — декодер среза: `decodePayload(text)` → объект `Snapshot`; `maskToIntervals`,
  `intervalsToMask`.
- `vendor/tiny-inflate.js` — запасной распаковщик deflate (см. ниже).
- `dev.html` — открывает страницу со срезом из тестового вектора.
- `tests/codec.test.mjs`, `tests/vector.json` — тесты декодера и общий с ботом тест-вектор.

## Тесты

Нужен Node 20+:

```sh
npm test        # то же, что node --test
```

## Ручная проверка в браузере

ES-модули и `fetch` не работают с `file://`, поэтому папку нужно отдать по HTTP:

```sh
python3 -m http.server 8080
```

и открыть <http://localhost:8080/dev.html> — она загрузит `tests/vector.json` и откроет
`index.html` с его срезом. Без `?d=` страница просит открыть календарь из бота.

## Формат среза и общий тест-вектор

Контракт формата — `padelbot/webapp/codec.py` в репозитории бота (`pack`/`unpack`,
`encode`): бинарный срез big-endian → сырой deflate → base64url без `=`. Краткая раскладка —
в шапке `codec.js`.

`tests/vector.json` пишет тест бота `test_vector_file_is_current` из детерминированного
среза `sample_snapshot`: `payload` — строка, которую выдал Python, `expected` — то, что
должен вернуть `decodePayload`. Чтобы обновить вектор после изменения формата или фикстуры:

```sh
# в репозитории бота
.venv/bin/pytest tests/webapp/test_codec.py -q   # при расхождении тест перепишет файл и упадёт
.venv/bin/pytest tests/webapp/test_codec.py -q   # второй прогон зелёный
cp tests/fixtures/snapshot_vector.json ../padelki-webapp/tests/vector.json
```

и затем `npm test` здесь.

## Распаковка и tiny-inflate

Срез распаковывает `DecompressionStream('deflate-raw')` (Chrome 103+, Safari 16.4+). Где
его нет — старые WebView и Node 20, на котором идут тесты, — работает
`vendor/tiny-inflate.js`: [tiny-inflate](https://github.com/devongovett/tiny-inflate) 1.0.3
Devon Govett под лицензией **MIT** (текст лицензии — в шапке файла), переведённый в ES-модуль,
плюс одна строка защиты: на повреждённых данных он падает с `Data error`, а не зацикливается
(изменения перечислены в шапке файла). Если поток `deflate-raw` есть, но данные повреждены,
запасной путь не используется — страница показывает, что срез не прочитан.

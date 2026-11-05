# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# transit-alert

Застосунок для громадського транспорту Любліна: Kotlin/Ktor бекенд + PWA фронтенд,
поєднує реальні розклади/GPS (GTFS) з crowdsourced-звітами про контролерів.

Репозиторій: https://github.com/artemechanik/transit-alert

## Архітектура

- **Backend**: Kotlin + Ktor, PostgreSQL через Exposed ORM + HikariCP
- **Frontend**: PWA, MapLibre GL. Локальні стилі `frontend/style-light.json` і
  `frontend/style-dark.json` на основі OSM Liberty перемикаються по темі;
  векторні тайли — MapTiler (`v3-openmaptiles`). Клієнтський ключ `MAPTILER_KEY`
  задається у `frontend/config.js`, який підключається перед `js/main.js`;
  шаблон — `frontend/config.example.js`.
- **Frontend-модулі**: точка входу — `frontend/js/main.js` (ES-модуль). Вона
  створює модулі карти, мінікарти рейсу, планувальника, зупинок, звітів і
  навігації та передає їм спільні залежності. Стилі розділені між
  `frontend/css/*.css`.
- **Геокодинг адрес**: робиться напряму з фронтенду через MapTiler Geocoding API
  (`frontend/js/planner.js`, автокомпліт полів "звідки/куди"), НЕ через
  бекенд-проксі. При вводі
  паралельно (`Promise.all`) летять запит до свого `/stops/search` (зупинки) і
  запит до `api.maptiler.com/geocoding/...` (адреси, обмежено bbox Любліна
  `22.35,51.11,22.75,51.36`). Результати показуються в одному дропдауні:
  зупинки → `{name, ids}` (масив stopId), адреси → `{name, lat, lon}`
  (з `feature.center`).
- **GTFS дані**: zbiorkom.live api6-open, оператор `default`:
  static — `https://api.zbiorkom.live/api6-open/lublin/gtfs/default`,
  realtime — `https://api.zbiorkom.live/api6-open/lublin/gtfsRealtime/default/vehiclePositions,tripUpdates`.
  LIVE опитується з паузою 15с, static — 6 годин через `GtfsStaticSync.kt`
  (idempotent, 304-aware, FK-safe UPSERT). Обидва завантаження вимагають HTTP 200;
  для static HTTP 304 пропускає імпорт. Окремої перевірки Content-Type немає.
- **Довіра до LIVE**: `updatePositions()` не додає до спільного live-кешу
  записи з розрахованою `delaySeconds > 7200`. Рівно 7200 с і `null`
  залишаються. Відсікаються GPS, затримка та поточний sequence для всіх
  споживачів кешу; статичний рейс і граф зберігаються. Bearing і нерухомість
  не є критеріями: підтверджено рухомий транспорт без bearing.
- **Назви платформ**: новий фід не має `stop_code`; імпортер виділяє кінцевий
  двозначний номер із `stop_name`, зберігаючи API `name`/`code` та початкові нулі.
  Явний `stop_code` старого формату має пріоритет; інакше використовується
  непорожній `platform_code` або суфікс назви. NŻ додається за
  `pickup_type == "3"` або `drop_off_type == "3"` у stop_times, без дублювання.
  Одна назва використовується в `stops`, `trip_stops` та напрямках.
- **Роутинг**: Dijkstra-based (`RoutingGraph.kt`) — свідомо не мігрували на
  RAPTOR, бо мережа Любліна невелика і немає ресурсів на повну реалізацію
- **Report-скрапер**: `fb.py` (google-genai SDK, модель `gemini-3.5-flash-lite`)
  парсить пости з Facebook про контролерів у структурований JSON
  (stopName/route/direction/comment)

## Важливі нюанси / "гострі кути"

- `stop_id` і `trip_id` використовуються напряму з фіда, без таблиці відповідностей.
  Static і realtime мають бути узгоджені; зміна ID рейсів без static sync ламає join'и.
- `stop_id` має довжину 64 у `stops`, `reports`, `stop_departures`, `trip_stops`.
  `SchemaUtils.create()` не розширює старі колонки: наявна БД потребує окремої
  міграції з 16 до 64. Звичайний імпорт не видаляє відсутні зупинки або звіти.
- **Відкрито: bearing.** Алгоритм не виправлений: відсутнє protobuf-поле зараз
  читається як 0, а частина наявних значень джерела не узгоджується з GPS-рухом.
  Не додавати кутову корекцію, фільтр за моделлю або заміну на GPS-курс без погодження.
- MUNICOM/sip.zdtm.lublin.eu (live GPS) — навмисно НЕ використовується:
  обфускований anti-bot JS, юридичний ризик. Не пропонувати як рішення.
- Dworzec Lublin (залізничний вокзал) має нестандартну нумерацію платформ
  (51, 52... замість звичного 01/02) — це особливість зупинки, не помилка
  в даних. Враховувати при валідації/матчингу platformCode.
- Матчинг ланок маршруту робиться через `stopId`, а не назву зупинки —
  матчинг за назвою ламався на дублікатах/близьких назвах
- Пересадки в `RoutingGraph.kt` перебираються в графі з урахуванням розкладу,
  живих затримок, мінімального часу й обмеження кількості пересадок.
  Ранжування враховує час прибуття, кількість пересадок і штрафи;
  `findRouteAlternatives` також шукає прямі та надійніші альтернативи.

## Команди

Усі бекенд-команди виконуються з каталогу `backend/`.

- **Postgres (dev):** `docker compose up -d` (образ `postgres:16-alpine`, порт 5432,
  db/user/pass = `transit_alert`/`transit`/`transit`). Стан: `docker compose ps`.
- **Запуск бекенда:** `./gradlew run` — Netty на `http://localhost:8080`.
  При старті `DatabaseFactory.init()` робить `SchemaUtils.create(...)` (авто-створення
  таблиць, не міграції), потім будується routing-граф і стартують фонові поллери
  (live GPS + GTFS static sync).
- **Збірка:** `./gradlew build`; fat-jar через Ktor plugin: `./gradlew buildFatJar`.
- **Тести:** `./gradlew test`. У `backend/src/test/kotlin/com/artem/transitalert/GtfsTimeTest.kt`
  є класи `GtfsTimeTest` і `GtfsSearchStartTest`: перевіряють час GTFS та старт
  пошуку маршрутів, зокрема в дні переходу між літнім і зимовим часом.
  Окремий клас: `./gradlew test --tests "com.artem.transitalert.GtfsTimeTest"`.
  `GtfsStopTest` перевіряє формати назв/платформ і NŻ;
  `NearbyPlatformOrderTest` — числове сортування платформ у групі nearby.
  `LiveVehiclesBearingTest` перевіряє збереження позицій без bearing,
  явного нуля й звичайного кута; `LiveVehiclesDelayTest` — межу 7200 с,
  відсутні дані, оновлення кешу, GPS/delays API та вплив на перший рейс і пересадки.
  Загалом — 35 backend-тестів.
- **Frontend-тести:** `node frontend/tests/planner-polling.test.mjs` і
  `node frontend/tests/trip-map.test.mjs` — 12 тестів із контрольованими API,
  таймерами та замінами DOM/MapLibre, без живого фіда. Це не браузерні тести.
- **Життєвий цикл LIVE фронтенду:** вихід із Trasa зупиняє її таймер і
  скасовує запит delays; повернення одразу оновлює дані й відновлює polling.
  HTTP 404 у відкритій мінікарті видаляє лише транспортний маркер; наступний
  200 відновлює його. Мережеві та інші HTTP-помилки зберігають маркер.
  Відкрито: зміна теми мінікарти видаляє карту без повного очищення сесії й таймера.
- **Frontend:** статика, віддається будь-яким HTTP-сервером:
  `cd frontend && python3 -m http.server 8000` → `http://localhost:8000`.
  `frontend/js/main.js` б'є у бекенд напряму (CORS `anyHost()`).
  `transport-history.js` один раз скидає три `ta_recent_*` історії зі старими ID;
  маркер `ta_gtfs_id_format=zbiorkom-api6` зберігає нову історію при наступних стартах.
- **Дані GTFS:** seed-файлів немає — `GtfsStaticSync` сам заповнює `stops`, `service_calendar`,
  `trip_headsigns`, `stop_departures`, `trip_stops` з фіду при першому старті. Щоб примусово
  перезалити: `DELETE FROM gtfs_feed_meta;` і перезапуск бекенда.
- **Config через env** (усе має дефолти для localhost):
  `DB_URL`, `DB_USER`, `DB_PASSWORD` (див. `DatabaseFactory.kt`).
- **JVM:** toolchain 17 (`build.gradle.kts`).

### Ендпоінти (перевіряти цей список перед додаванням нового — легко задублювати)

- Reports/CRUD (`ReportRoutes.kt`): `GET/POST /reports`, `GET /reports/{id}`,
  `POST /reports/{id}/confirm`, `POST /reports/{id}/deny`,
  `GET /stops/dictionary`
- Risk (`RiskRoutes.kt`): `GET /reports/{id}/risk-routes`
- Upcoming stops (`UpcomingStops.kt`): `GET /reports/{id}/upcoming-stops`,
  `GET /trips/{tripId}/upcoming-stops`
- Routing/forms (`FormRoutes.kt`): `GET /route/search`, `GET /route/complex`,
  `GET /routes`, `GET /routes/{route}/directions`, `GET /stops/search`.
  Алгоритм пошуку — у `RoutingGraph.kt`.
- Stops (`StopRoutes.kt`): `GET /stops/nearby`, `GET /api/trip-stops/{tripId}`
- Live GPS (`LiveVehiclesRoutes.kt`): `GET /live-vehicles`, `/live-vehicles/delays`,
  `/live-vehicles/{tripId}`, `/stops/{stopId}/departures`

### Scraper (`scraper/`, gitignored)

Окремий Python-модуль (не збирається з Gradle). `fb.py` — парсер постів через
google-genai (`gemini-3.5-flash-lite`), тягне словник зупинок з
`GET /stops/dictionary` і постить у `/reports`. Поруч є `main.py.` та `auth.py`
(Playwright-логін у FB). `venv/` уже присутній; секрети в `scraper/.env`
(`GEMINI_API_KEY`, `BACKEND_URL`). Весь каталог у `.gitignore`.

## Конвенції коду

- Ендпоінти повертають `stopId`+`platformCode`, не лише назву — уникати
  регресій типу "match by name" (див. вище)
- Не додавати нову routing-логіку без явного обговорення (рішення про
  Dijkstra vs RAPTOR вже прийняте)

## Важливо для AI-асистента

- Не ламати робочий код і не звинувачувати користувача в помилках —
  якщо щось незрозуміло в поточній логіці, питати, а не переписувати
  мовчки.

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
  задається у `frontend/config.js`, який підключається перед `app.js`;
  шаблон — `frontend/config.example.js`.
- **Геокодинг адрес**: робиться напряму з фронтенду через MapTiler Geocoding API
  (`app.js`, автокомпліт полів "звідки/куди"), НЕ через бекенд-проксі. При вводі
  паралельно (`Promise.all`) летять запит до свого `/stops/search` (зупинки) і
  запит до `api.maptiler.com/geocoding/...` (адреси, обмежено bbox Любліна
  `22.35,51.11,22.75,51.36`). Результати показуються в одному дропдауні:
  зупинки → `{name, ids}` (масив stopId), адреси → `{name, lat, lon}`
  (з `feature.center`).
- **GTFS дані**: реальний час через zbiorkom.live (`lublin.pb`, ~80–190 позицій
  кожні 15с, MIT-ліцензія, легально). Статичні дані GTFS синхронізуються
  через `GtfsStaticSync.kt` (idempotent, 304-aware, FK-safe UPSERT).
- **Роутинг**: Dijkstra-based (`RoutingGraph.kt`) — свідомо не мігрували на
  RAPTOR, бо мережа Любліна невелика і немає ресурсів на повну реалізацію
- **Report-скрапер**: `fb.py` (google-genai SDK, модель `gemini-3.5-flash-lite`)
  парсить пости з Facebook про контролерів у структурований JSON
  (stopName/route/direction/comment)

## Важливі нюанси / "гострі кути"

- `zbiorkom.live` регенерує trip_id префікси кожні 1–2 тижні — це ламає
  статичні join'и в БД, якщо забути про auto-sync job
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
- **Frontend:** статика, віддається будь-яким HTTP-сервером:
  `cd frontend && python3 -m http.server 8000` → `http://localhost:8000`.
  `frontend/app.js` б'є у бекенд напряму (CORS `anyHost()`).
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

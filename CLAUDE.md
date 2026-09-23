# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# transit-alert

Застосунок для громадського транспорту Любліна: Kotlin/Ktor бекенд + PWA фронтенд,
поєднує реальні розклади/GPS (GTFS) з crowdsourced-звітами про контролерів.

Репозиторій: https://github.com/artemechanik/transit-alert

## Архітектура

- **Backend**: Kotlin + Ktor, PostgreSQL через Exposed ORM + HikariCP
- **Frontend**: PWA, Leaflet-карта. Тайли — MapTiler (`streets-v4`/`streets-v4-dark`,
  перемикання по темі), ключ захардкоджений у `frontend/app.js` (`MAPTILER_KEY`,
  клієнтський, тож публічно видимий — це очікувано для MapTiler free-tier)
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
- Евристика пересадки в `RoutingGraph.kt` — "перша спільна зупинка";
  не завжди оптимально (іноді краще остання спільна), але свідомо
  залишено як є через невеликий розмір мережі Любліна

## Команди

Усі бекенд-команди виконуються з каталогу `backend/`.

- **Postgres (dev):** `docker compose up -d` (образ `postgres:16-alpine`, порт 5432,
  db/user/pass = `transit_alert`/`transit`/`transit`). Стан: `docker compose ps`.
- **Запуск бекенда:** `./gradlew run` — Netty на `http://localhost:8080`.
  При старті `DatabaseFactory.init()` робить `SchemaUtils.create(...)` (авто-створення
  таблиць, не міграції), потім будується routing-граф і стартують фонові поллери
  (live GPS + GTFS static sync).
- **Збірка:** `./gradlew build`; fat-jar через Ktor plugin: `./gradlew buildFatJar`.
- **Тести:** `./gradlew test` — але **тестів у репо зараз немає** (`backend/src/test/`
  відсутній, хоча `ktor-server-test-host` + `kotlin-test` вже у залежностях).
  Один тест після появи: `./gradlew test --tests "com.artem.transitalert.ClassName.method"`.
- **Frontend:** статика, віддається будь-яким HTTP-сервером:
  `cd frontend && python3 -m http.server 8000` → `http://localhost:8000`.
  `frontend/app.js` б'є у бекенд напряму (CORS `anyHost()`).
- **Seed даних (одноразово, після першого старту застосунку):** залити SQL по
  порядку через psql у контейнер, напр.
  `docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_stops.sql`
  (порядок: `seed_stops` → `seed_service_calendar` → `seed_trip_headsign` →
  `seed_stop_departures` → `seed_trip_stops`; останні два — ~225к рядків кожен).
- **Config через env** (усе має дефолти для localhost):
  `DB_URL`, `DB_USER`, `DB_PASSWORD` (див. `DatabaseFactory.kt`).
- **JVM:** toolchain 17 (`build.gradle.kts`).

### Ендпоінти (перевіряти цей список перед додаванням нового — легко задублювати)

- Reports/CRUD (`ReportRoutes.kt`): `GET/POST /reports`, `GET /reports/{id}`,
  `POST /reports/{id}/confirm`, `POST /reports/{id}/deny`,
  `GET /reports/{id}/risk-routes`, `GET /reports/{id}/upcoming-stops`
- Routing (`RoutingGraph.kt`): `GET /route/search`, `GET /route/complex`
- Stops (`StopRoutes.kt`): `GET /stops/search`, `/stops/nearby`, `/stops/dictionary`,
  `/stops/{stopId}/departures`
- Routes/trips: `GET /routes`, `/routes/{route}/directions`,
  `/trips/{tripId}/upcoming-stops`
- Live GPS (`LiveVehiclesRoutes.kt`): `GET /live-vehicles`, `/live-vehicles/delays`,
  `/live-vehicles/{tripId}`

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

## У розробці / наступні кроки

- ~~Address-based routing через Nominatim-проксі~~ — вже не актуально: геокодинг
  адрес реалізований напряму на фронтенді через MapTiler Geocoding API (див.
  "Архітектура" вище), без бекенд-проксі та без `/route/by-address`. Якщо
  знову зʼявиться потреба у геокодингу на бекенді — узгодити окремо, а не
  повертатись до цього старого плану.
- Позиція користувача як маркер у route accordion (Leaflet,
  geolocation watchPosition)
- Два відкриті UI-баги: контраст input-полів у темній темі PWA + ще один
  (уточнити при наступній сесії)

## Важливо для AI-асистента

- Проєкт будується фрагментами — легко загубити/задублювати ендпоінти.
  Перед додаванням нового ендпоінту — перевіряти, чи такий уже не існує.
- Не ламати робочий код і не звинувачувати користувача в помилках —
  якщо щось незрозуміло в поточній логіці, питати, а не переписувати
  мовчки.

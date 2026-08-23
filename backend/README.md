# transit-alert — Етап 1: бекенд-основа

## Що тут є
- Ktor-сервер (Netty), Kotlin
- Exposed + Postgres (через HikariCP)
- Ендпоінти:
  - `GET /stops/search?q=abra` — автокомпліт зупинок
  - `GET /reports` — стрічка (новіші зверху, TTL 45 хв, приховані виключені)
  - `POST /reports` — новий допис (rate-limit 5 хв на fingerprint)
  - `POST /reports/{id}/flag` — скарга (автоприховування після 3 скарг)

## Кроки запуску на Chromebook (Lubuntu)

### 1. Встанови залежності (якщо ще нема)
```bash
sudo apt update
sudo apt install -y openjdk-17-jdk docker.io docker-compose-v2
sudo usermod -aG docker $USER   # потім перелогінься
```

### 2. Підніми Postgres
```bash
cd transit-alert
docker compose up -d
```
Перевір що піднялось: `docker compose ps`

### 3. Завантаж дані зупинок і розкладу у БД (одноразово)
Спочатку запусти застосунок хоч раз (нижче), щоб Exposed створив таблиці —
`SchemaUtils.create()` в `DatabaseFactory.kt` робить це автоматично при старті.
Потім залий seed-файли по порядку:
```bash
docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_stops.sql
docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_service_calendar.sql
docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_trip_headsign.sql
docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_stop_departures.sql
docker exec -i $(docker compose ps -q postgres) psql -U transit -d transit_alert < seed_trip_stops.sql
```
Останні два файли великі (225к рядків кожен, ~13 МБ) — заливка займе трохи довше, це нормально.

### 4. Запусти застосунок
Gradle wrapper (`gradlew`) у архіві немає — треба згенерувати один раз
(потребує системного Gradle, `sudo apt install gradle`):
```bash
gradle wrapper --gradle-version 8.9
./gradlew run
```
(перший запуск довший — Gradle качає залежності)

Сервер підніметься на `http://localhost:8080`

### 5. Перевір що працює
```bash
# Автокомпліт
curl "http://localhost:8080/stops/search?q=abra"

# Створити допис (стрічка порожня спочатку)
curl -X POST http://localhost:8080/reports \
  -H "Content-Type: application/json" \
  -d '{"stopId":"3951","comment":"контролер на вході","fingerprint":"test-device-1"}'

# Стрічка
curl http://localhost:8080/reports

# Створити допис, вказавши лінію напряму (напрямок визначиться сам)
curl -X POST http://localhost:8080/reports \
  -H "Content-Type: application/json" \
  -d '{"stopId":"3951","comment":"2 контролери","route":"38","fingerprint":"test-1"}'

# Ризикові лінії для конкретного допису, тепер з напрямками (Етап 2)
curl http://localhost:8080/reports/1/risk-routes

# Наступні зупинки конкретного рейсу (коли лінія вказана явно)
curl http://localhost:8080/reports/2/upcoming-stops

# Live-позиції автобусів (Etap 2.5, дані від zbiorkom.live)
curl http://localhost:8080/live-vehicles
curl "http://localhost:8080/live-vehicles?route=153"
```

## Live GPS (zbiorkom.live)
Фоновий сервіс раз на 15 сек тягне `https://cdn.zbiorkom.live/gtfs-rt/lublin.pb`
(стандартний GTFS-Realtime), кешує позиції в пам'яті за `trip_id` — той самий
формат ID, що і в нашому статичному GTFS, тому мапиться напряму без конвертації.
Перші кілька секунд після старту застосунку `/live-vehicles` може бути порожнім,
поки не відбудеться перший поллінг.

## Наступні кроки (не зараз, для контексту)
- Етап 2: ендпоінт ризикових ліній (`stop_departures.json` + `service_calendar.json` → Postgres)
- Етап 3: PWA-клієнт, що б'є в ці ендпоінти
- Етап 4: деплой на VPS

## Нотатки з дизайну (щоб не забути "чому так")
- `fingerprint` генерується на клієнті (напр. `crypto.randomUUID()` в localStorage),
  сервер його не верифікує криптографічно — це навмисно проста антиспам-міра, не auth
- `hidden` не видаляє допис з БД, просто ховає зі стрічки — можна пізніше додати
  адмінський ендпоінт для перегляду прихованого
- CORS зараз `anyHost()` — звузити перед продом до домену PWA

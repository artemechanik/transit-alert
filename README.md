# transit-alert

Веб-застосунок для громадського транспорту Любліна: реальні GTFS-розклади +
live GPS позиції транспорту + crowdsourced звіти про контролерів.

⚠️ Проєкт в активній розробці, структура та фічі можуть швидко змінюватись.

## Стек

- **Backend:** Kotlin + Ktor, Exposed ORM, PostgreSQL
- **Frontend:** PWA (vanilla JS), Leaflet карта
- **Дані:** GTFS static (авто-синк) + GTFS-Realtime (live позиції)

## Структура
```
transit-alert/
├── backend/ # Kotlin/Ktor API
└── frontend/ # PWA клієнт
```

## Запуск локально

**1. База даних:**
```bash
cd ~/transit-alert/backend
docker compose up -d
```

**2. Backend:**
```bash
cd ~/transit-alert/backend
./gradlew run
```

**3. Frontend:**
```bash
cd ~/transit-alert/frontend
python3 -m http.server 8000
```

Відкрити `http://localhost:8000`.

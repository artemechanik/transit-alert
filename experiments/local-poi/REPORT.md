# POI — фінальне очищення перед інтеграцією

Дата: 09.11.2026. Зміни лише в experiments/local-poi; інтеграції немає.

## Результат

**406 місць доступні в пошуку**, **411 канонічних місць**,
**542 джерельні об'єкти**. Порівняно з 414: три підтверджені
об'єднання дають 411 місць; п'ять із них приховані — не вилучені.
Порівняння з попередньою SQLite підтвердило незмінність усіх 542 вихідних
payload, геометрій, версій, причин включення й ліцензійного походження;
джерельні aliases також збережено. Результат — `data/final-preservation.json`.

| Група аудиту | Дія |
|---|---|
| 1 Politechnika, кампус / бібліотека | Одне канонічне місце, усі джерела збережені |
| 2 UMCS, кампус / бібліотечна група | Одне канонічне місце, усі джерела збережені |
| 3 Дитяча лікарня | Одне канонічне місце, обидві адреси залишаються в raw_json |
| 4 UM, лікарняна будівля / освітня територія | Обидва видимі з уточненнями функцій BDOT |
| 5 UP, дві будівлі | Перша видима, друга прихована до перевірки |
| 6 UP, навчальна будівля / бібліотека | Обидві видимі з уточненнями функцій BDOT |
| 7 UM, корпуси за 193 м | Фізично окремі; другий тимчасово прихований |
| 8 UP, суміжні будівлі | Другий прихований |
| 9 UMCS, суміжні частини | Другий прихований |
| 10 UP, суміжні корпуси | Другий прихований |

Уточнення — «budynek szpitalny», «teren szkoły wyższej»,
«budynek szkoły wyższej», «biblioteka». Це функції вихідних записів,
не вигадані власні назви корпусів чи адреси. Старі назви залишені як aliases.
Наявність функції не встановлює самостійності установи — групи 4 і 6
залишаються предметом ручної перевірки, але підказки вже розрізняються.

## Модель і відтворення

`features` — вихідні об'єкти з власними ID, геометріями, координатами,
версіями та raw_json (з адресами); `provenance` — ліцензії кожного запису.
`pois` — канонічні місця. Нова невелика таблиця `search_presentations`
керує видимістю, посиланням на тимчасового представника й причиною.
`names`/FTS зберігають назви також прихованих місць; пошук фільтрує visible=1.
Приховані aliases не переносяться на інший фізичний корпус.

Точні члени всіх десяти груп і рішення — `presentation-rules.json`.
Невідповідність кількості знайдених груп зупиняє побудову.
Файл правил зберігається також у metadata SQLite.
Попередній `data/cleanup-comparison.json` залишається історичним аудитом 414,
а не описом поточного стану. Поточний CSV містить visible і representative_id.
Бібліотечні будівлі з груп 1–2 не видаляються й можуть згодом отримати
самостійні канонічні місця за їхніми вихідними ID.

Не послаблено категорійні фільтри. Збережено окремі майданчики підприємств;
бренд чи однакова назва з близькими координатами не дозволяє їх зливати.
28 невизначених університетських корпусів залишаються review.
Konfrontacje Teatralne виключено; Projekt Kultura — ручна перевірка.
Усі 16 раніше повернених місць перевірені регресійними тестами в пошуку.
Джерела, версії та NOTICE — за sources.json і licenses/; побудова перевіряє SHA256.

| Категорія | Канонічні місця | Видимі |
|---|---:|---:|
| culture | 68 | 68 |
| education | 102 | 97 |
| government | 38 | 38 |
| health | 29 | 29 |
| industry | 74 | 74 |
| landmark | 13 | 13 |
| park | 24 | 24 |
| shopping | 24 | 24 |
| sport | 31 | 31 |
| transport | 8 | 8 |

## Контрольні запити

Показано до 50 результатів на запит; однакові загальні назви в різних
районах не доводять дублікатів. Вирішено саме десять погоджених груп.

| Запит | Результати |
|---|---|
| `ork` | Galeria Orkana |
| `olimp` | Olimp Kino; Galeria Olimp; Nowy Basen Olimpijski W Lublinie |
| `szpital` | Szpital SPZOZ; Szpital Jaczewskiego; Szpital Kliniczny nr 4; Szpital Neuropsychiatryczny; Szpital im. Stefana Wyszyńskiego; Szpital MSWiA; Chodźki Szpital; Samodzielny Publiczny Szpital Wojewódzki im. Jana Bożego; Samodzielny Publiczny Szpital Kliniczny nr 1; ARION Szpitale; Wojewódzki Szpital Specjalistyczny im. Stefana Kardynała Wyszyńskiego; 1 Wojskowy Szpital Kliniczny z Polikliniką SPZOZ w Lublinie; Uniwersytecki Szpital Dziecięcy w Lublinie; Wojewódzki Szpital Specjalistyczny im. Stefana Kardynała Wyszyńskiego; Wojewodzki Szpital Specjalistyczny; Samodzielny Publiczny Szpital Wojewódzki im. J. Bożego; Wojewódzki Szpital Specjalistyczny im. Stefana Kardynała Wyszyńskiego; Wojewódzki Szpital Specjalistyczny im. Kardynała Stefana Wyszyńskiego; Samodzielny Publiczny Szpital Kliniczny nr 1; Uniwersytet Medyczny w Lublinie — budynek szpitalny; Allmedica — Tetmajera 21 |
| `uniwersytet` | Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Medyczny w Lublinie; Uniwersytet Medyczny w Lublinie; Uniwersytet Medyczny w Lublinie; Uniwersytet Medyczny w Lublinie — teren szkoły wyższej; Uniwersytet Medyczny w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Przyrodniczy w Lublinie — biblioteka; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Medyczny w Lublinie — budynek szpitalny; Uniwersytet Przyrodniczy w Lublinie — budynek szkoły wyższej; Uniwersytet Medyczny w Lublinie; Uniwersytet Marii Curie-Skłodowskiej w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Uniwersytet Przyrodniczy w Lublinie; Klinika Okulistyki Uniwersytetu Lubelskiego; Centrum Symulacji Medycznej Uniwersytetu Medycznego w Lublinie; Katolicki Uniwersytet Lubelski Jana Pawła II; Katolicki Uniwersytet Lubelski Jana Pawła II; Hala Sportowo-Widowiskowa Uniwersytetu Medycznego w Lublinie; Katolicki Uniwersytet Lubelski Jana Pawła II; Katolicki Uniwersytet Lubelski Jana Pawła II; Katolicki Uniwersytet Lubelski Jana Pawła II; Ogród Botaniczny Uniwersytetu Marii Curie-Skłodowskiej w Lublinie |
| `politechnika` | Politechnika Lubelska |
| `umcs` | Muzeum UMCS; Uniwersytet Marii Curie-Skłodowskiej w Lublinie |

## Перевірки й ресурси

- 17 тестів: усі десять груп за джерельними ID, видимість, три злиття,
  функціональні назви, 16 повернень, aliases, префікси, діакритика,
  окремі майданчики/бренди, цілісність, ліцензійне походження, межі й offline.
- Повторна побудова SQLite/decisions/review побайтово ідентична: **True**.
- SQLite: **2,039,808 байтів**, 1.95 MiB.
- Пошук: 1085 вимірювань; p50 1.017 мс,
  **p95 1.814 мс**, максимум 32.697 мс.
- Peak RSS процесу пошуку 26.26 MiB;
  побудови 137.41 MiB, час побудови 14.04 с.
- Новий read-only connection на запит; кеш ОС не очищався;
  RSS — весь Python-процес. Це заміри цієї машини, не гарантія Chromebook.
- PRG SHA256 до/після demo: `5b8ec52103d46b87b0dc36efbf1aa7920d07eb7677a15c21a6e10735fe630237` — без змін.
- Входи не вигадані: entrances порожня, arrival NULL.

## Ручна перевірка та межі

Потрібні власні назви/адреси корпусів груп 4–10, визначення незалежних
призначень і надійних входів. Перший видимий представник у неоднозначній
парі — тимчасове правило за порядком аудиту, не оцінка популярності.
Покриття незмінне: Overture у 16 ґмінах, BDOT лише пакетів Lublin/Świdnik,
Wikidata — альтернативні назви трьох установ. Нових завантажень немає.
Frontend/Kotlin/PostgreSQL/PRG/GPS/маршрутизатор не змінювалися;
їхні тести не запускалися. Комітів і push немає.
Інструкції побудови — README.md; після перевірок роботу зупинено.


## Доповнення промислових адрес — 10.11.2026

Додано 26 підтверджених поштових уточнень з окремого address-overrides.json.
Кількості незмінні: 411 канонічних / 406 видимих / 74 промислові POI,
542 джерельні об'єкти. Нових фізичних майданчиків — 0. Промислові адреси:
44 повні, 2 часткові, 28 без адресного рядка. Дані source/features/provenance,
усі координати й names побайтово за значеннями таблиць збережені.
Поточні рішення та питання власнику — INDUSTRY_ADDRESS_DECISIONS.md.


## Місцеві підтвердження власника

Додано решту 28 адрес як local_knowledge: тепер усі 54 початкові випадки мають уточнення. Промислові адреси: 72 повні / 2 часткові / 0 відсутніх. Всього видимих POI: 406 (261 / 17 / 128 за адресним покриттям), канонічних 411, промислових 74, джерельних features 542. Art Bed перейменовано на Art-Bet з тим самим ID та старою назвою в пошуку. Координати й джерельні ліцензії збережено. Нових майданчиків 0. Пройшли 18 Python, 60 Kotlin і frontend-тести; повторна побудова побайтова. Деталі — INDUSTRY_ADDRESS_DECISIONS.md.

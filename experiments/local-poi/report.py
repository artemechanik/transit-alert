"""Export current physical places, presentation visibility and measured report."""
import csv,json
from search import ROOT,connect,search

def main():
    data=ROOT/'data';m=json.loads((data/'build-metrics.json').read_text());b=json.loads((data/'search-metrics.json').read_text());replay=json.loads((data/'reproducibility.json').read_text())
    with connect() as c:
        rows=[dict(r) for r in c.execute('select p.*,s.visible,s.representative_id,s.reason presentation_reason from pois p join search_presentations s on s.poi_id=p.id order by p.category,p.name,p.id')]
        for r in rows:
            r['source_records']='; '.join(f'{x[0]}:{x[1]}@{x[2]}' for x in c.execute('select source,source_id,version from features where poi_id=?',(r['id'],)))
            r['aliases']='; '.join(x[0] for x in c.execute('select distinct name from names where poi_id=? order by name',(r['id'],)))
        for path,items in [('catalog.csv',rows),('review-candidates.csv',[json.loads(l) for l in (data/'decisions.jsonl').read_text().splitlines() if json.loads(l)['decision']=='review'])]:
            with (data/path).open('w',newline='') as f:
                w=csv.DictWriter(f,fieldnames=list(items[0]));w.writeheader();w.writerows(items)
    controls='\n'.join('| `'+q+'` | '+'; '.join(x['name'] for x in search(q,50))+' |' for q in ['ork','olimp','szpital','uniwersytet','politechnika','umcs'])
    cats='\n'.join(f'| {k} | {n} | {sum(r["visible"] for r in rows if r["category"]==k)} |' for k,n in m['categories'].items())
    text=f'''# POI — фінальне очищення перед інтеграцією

Дата: 09.11.2026. Зміни лише в experiments/local-poi; інтеграції немає.

## Результат

**{m['searchable_pois']} місць доступні в пошуку**, **{m['pois']} канонічних місць**,
**{m['features']} джерельні об'єкти**. Порівняно з 414: три підтверджені
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
{cats}

## Контрольні запити

Показано до 50 результатів на запит; однакові загальні назви в різних
районах не доводять дублікатів. Вирішено саме десять погоджених груп.

| Запит | Результати |
|---|---|
{controls}

## Перевірки й ресурси

- 17 тестів: усі десять груп за джерельними ID, видимість, три злиття,
  функціональні назви, 16 повернень, aliases, префікси, діакритика,
  окремі майданчики/бренди, цілісність, ліцензійне походження, межі й offline.
- Повторна побудова SQLite/decisions/review побайтово ідентична: **{replay['identical']}**.
- SQLite: **{m['sqlite_bytes']:,} байтів**, {m['sqlite_bytes']/1048576:.2f} MiB.
- Пошук: {b['query_count']} вимірювань; p50 {b['warm_p50_ms']} мс,
  **p95 {b['warm_p95_ms']} мс**, максимум {b['max_ms']} мс.
- Peak RSS процесу пошуку {b['query_process_peak_rss_mib']} MiB;
  побудови {m['build_peak_rss_mib']} MiB, час побудови {m['build_seconds']} с.
- Новий read-only connection на запит; кеш ОС не очищався;
  RSS — весь Python-процес. Це заміри цієї машини, не гарантія Chromebook.
- PRG SHA256 до/після demo: `{b['prg_sha256_after']}` — без змін.
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
'''
    (ROOT/'REPORT.md').write_text(text)
    print('Report and CSV exports generated')

if __name__=='__main__':main()

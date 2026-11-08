"""Offline PRG search. Runtime uses only the Python standard library."""
import re
import sqlite3
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'data' / 'addresses.sqlite'


def normalize(value):
    value = value.lower().replace('ł', 'l')
    value = ''.join(c for c in unicodedata.normalize('NFKD', value) if not unicodedata.combining(c))
    return ' '.join(re.findall(r'[a-z0-9]+', value))


def text_normalize(value):
    return ' '.join(t for t in normalize(value).split()
                    if t not in {'ul', 'ulica', 'al', 'aleja', 'aleje', 'pl', 'plac'})


def house_normalize(value):
    return ''.join(normalize(part) if part not in {'/', '-'} else part
                   for part in re.split(r'([/-])', value)).replace(' ', '')


def parse_query(query):
    if not isinstance(query, str) or len(query) > 200 or any(ord(c) < 32 for c in query):
        raise ValueError('Запит має бути текстом до 200 символів без керівних знаків.')
    warning = None
    unit = re.search(r'\s+(?:m\.?|mieszkanie|lok\.?|lokal)\s*\d+\w*\s*$', query, re.I)
    if unit:
        query = query[:unit.start()]
        warning = 'Номер квартири пропущено: результат указує на адресну точку будинку.'
    match = re.search(r'(?:^|\s)(\d[\w/-]*)\s*$', query.strip())
    house = house_normalize(match.group(1)) if match else ''
    text = text_normalize(query.strip()[:match.start()] if match else query)
    if '/' in house:
        warning = 'Шукаємо точний номер із «/» у PRG, не квартиру. Квартиру позначайте «m.».'
    if not text and not house:
        return '', '', warning
    if len(text.split()) > 12:
        raise ValueError('Запит має містити не більше 12 слів.')
    if not text or not any(c.isalpha() for c in text):
        raise ValueError('Додайте назву вулиці або населеного пункту.')
    if len(text.replace(' ', '')) < 2:
        raise ValueError('Введіть щонайменше дві літери.')
    return text, house, warning


def rank(street, city, house, text, wanted_house):
    # Purely textual rank. A future spatial tie-break can follow this score.
    words = text.split()
    if text in {street, city, street + ' ' + city, city + ' ' + street}:
        tier = 0
    elif street and (street.endswith(' ' + text)):
        tier = 1
    elif street.startswith(text) or city.startswith(text):
        tier = 2
    elif all(any(w.startswith(t) for w in (street + ' ' + city).split()) for t in words):
        tier = 3
    else:
        tier = 4
    # Exact building before a partially typed building, within textual tier.
    number_penalty = int(bool(wanted_house) and house != wanted_house)
    return tier * 10 + number_penalty


def connect(path=DB):
    conn = sqlite3.connect(f'file:{Path(path).resolve()}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.create_function('text_rank', 5, rank, deterministic=True)
    return conn


def search_rows(conn, text, house, limit, kind):
    table = 'streets' if kind == 'street' else 'addresses'
    word_table = 'street_words' if kind == 'street' else 'words'
    fragment_table = 'street_fragments' if kind == 'street' else 'fragments'
    tokens = text.split()
    prefix = ' AND '.join('"' + t + '"*' for t in tokens)
    # The trigram index adds true infix matches, including those absent in the
    # prefix index. Short tokens are verified after the indexed shortlist.
    long_tokens = [t for t in tokens if len(t) >= 3]
    params = [prefix]
    candidates = f'SELECT rowid FROM {word_table} WHERE {word_table} MATCH ?'
    if long_tokens:
        candidates += f' UNION SELECT rowid FROM {fragment_table} WHERE {fragment_table} MATCH ?'
        params.append(' AND '.join('"' + t + '"' for t in long_tokens))
    filters = ['instr(a.text_norm, ?) > 0' for _ in tokens]
    params += [text, house]  # rank parameters
    params += tokens
    if house and '/' in house:
        filters.append('a.house_norm = ?')
        params.append(house)
    elif house:
        filters.append('(a.house_norm = ? OR a.house_norm GLOB ?)')
        params += [house, house + '[a-z]*']
    params += [limit]
    sql = f"""
      WITH candidates AS ({candidates})
      SELECT a.*, text_rank(a.street_norm,a.city_norm,a.house_norm,?,?) AS rank
      FROM candidates JOIN {table} a ON a.rowid=candidates.rowid
      WHERE {' AND '.join(filters)}
      ORDER BY rank, (a.city_norm = 'lublin') DESC, length(a.street_norm), a.city_norm, a.street_norm,
        cast(a.house_norm AS INTEGER), a.house_norm, a.id LIMIT ?
    """
    results = []
    for row in conn.execute(sql, params):
        r = dict(row)
        results.append(dict(type=kind, ulic=r.get('ulic', ''),
            coordinate_kind='street_representative' if kind == 'street' else 'address_point',
            origin=r.get('origin', 'PRG_PunktyAdresowe'),
            representative_method=r.get('representative_method'), id=r['id'], source_id=r['source_id'],
            display_name=r['display_name'], locality=r['locality'], simc=r['simc'],
            terc=r['terc'], street=r['street'], house_number=r['house_number'],
            lat=r['lat'], lon=r['lon'], match_rank=r['rank']))
    return results


def search(conn, query, limit=10):
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError('limit має бути додатним цілим числом.')
    limit = min(limit, 50)
    text, house, warning = parse_query(query)
    if not text:
        return dict(query=query, results=[], warning=warning)
    # A complete official street name can itself end in a number (Dywizjonu 303).
    # Recognize it before assuming the last number is a building.
    if house and '/' not in house:
        full = text_normalize(query)
        exact_street = conn.execute('SELECT 1 FROM streets WHERE street_norm=? LIMIT 1', (full,)).fetchone()
        if exact_street:
            text, house = full, ''
    if house:
        results = search_rows(conn, text, house, limit, 'address')
    else:
        results = search_rows(conn, text, '', limit, 'street')
        if len(results) < limit:
            # Keep street-less settlement searches useful, without flooding the
            # list with buildings on streets already represented above.
            addresses = search_rows(conn, text, '', 50, 'address')
            results += [r for r in addresses if not r['street']][:limit-len(results)]
    return dict(query=query, results=results, warning=warning)


def stats(conn):
    import json
    data = json.loads(conn.execute("SELECT value FROM metadata WHERE key='build'").fetchone()[0])
    return dict(**data, sqlite_bytes=DB.stat().st_size, offline=True)

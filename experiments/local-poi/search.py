"""Offline POI query; Python standard library only. Never opens PRG for writing."""
import argparse
import json
import re
import sqlite3
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'data' / 'poi.sqlite'


def normalize(value):
    value = unicodedata.normalize('NFKD', value.casefold().replace('ł', 'l'))
    return ' '.join(re.findall(r'[a-z0-9]+', ''.join(c for c in value if not unicodedata.combining(c))))


class ReadOnlyConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect(path=DB):
    c = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, factory=ReadOnlyConnection)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    c.execute('PRAGMA cache_size=-2048')
    return c


def text_rank(name, query):
    if name == query:
        return 0
    if name.startswith(query):
        return 1
    words, tokens = name.split(), query.split()
    if all(any(w.startswith(t) for w in words) for t in tokens):
        return 2
    return 3


def search(query, limit=10, path=DB):
    if not isinstance(query, str) or len(query) > 200 or any(ord(x) < 32 for x in query):
        raise ValueError('Query must be text, at most 200 characters, without controls')
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
        raise ValueError('limit must be 1..50')
    q = normalize(query)
    if not q or len(q.replace(' ', '')) < 2:
        return []
    if len(q.split()) > 12:
        raise ValueError('At most 12 query words')
    # Only normalized alphanumeric tokens enter FTS syntax. Number 4 remains part of a POI name.
    match = ' AND '.join('"' + t + '"*' for t in q.split())
    with connect(path) as c:
        c.create_function('text_rank', 2, text_rank, deterministic=True)
        # SQL ranks the full matching set; no arbitrary candidate cut before ranking.
        rows = c.execute('''
          WITH matches AS (
            SELECT a.poi_id, a.name matched_name, a.kind,
                   text_rank(a.normalized, ?) tier,
                   row_number() OVER (PARTITION BY a.poi_id ORDER BY
                     text_rank(a.normalized, ?), CASE a.kind WHEN 'canonical' THEN 0 ELSE 1 END,
                     length(a.name), a.name) rn
            FROM names_fts JOIN names a ON a.rowid=names_fts.rowid
            WHERE names_fts MATCH ?
          )
          SELECT p.*, m.matched_name, m.kind matched_kind, m.tier text_rank
          FROM matches m JOIN pois p ON p.id=m.poi_id JOIN search_presentations sp ON sp.poi_id=p.id WHERE m.rn=1 AND sp.visible=1
          ORDER BY m.tier, CASE m.kind WHEN 'canonical' THEN 0 ELSE 1 END, p.relevance DESC,
                   CASE WHEN p.nearest_stop_m IS NULL THEN 1 ELSE 0 END,
                   p.nearest_stop_m, p.name, p.id LIMIT ?
        ''', (q, q, match, limit)).fetchall()
        return [dict(x) for x in rows]


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('query')
    p.add_argument('--limit', type=int, default=10)
    p.add_argument('--db', type=Path, default=DB)
    args = p.parse_args()
    print(json.dumps(search(args.query, args.limit, args.db), ensure_ascii=False, indent=2))

"""Build exclusively from locally cached PRG packages. No network code."""
import argparse
import hashlib
import json
import math
import os
import re
import resource
import sqlite3
import struct
import sys
import time
import zipfile
from pathlib import Path
from geocoder import DB, normalize, text_normalize, house_normalize

UUID = re.compile(r'^(.*?)[_.]([0-9a-f]{8}-[0-9a-f-]{27,})_', re.I)


def records(package):
    with zipfile.ZipFile(package['path']) as z:
        name = next(n for n in z.namelist() if n.startswith('PRG_PunktyAdresowe') and n.endswith('.dbf'))
        encoding = z.read(name[:-4] + '.cpg').decode().strip()
        if encoding.upper() in {'65001', 'UTF-8'}:
            encoding = 'utf-8'
        from pyproj import CRS, Transformer
        crs = CRS.from_wkt(z.read(name[:-4] + '.prj').decode())
        assert crs.to_dict() == CRS(2180).to_dict(), crs
        transform = Transformer.from_crs(2180, 4326, always_xy=True)
        with z.open(name) as dbf, z.open(name[:-4] + '.shp') as shp:
            head = dbf.read(32)
            count = struct.unpack_from('<I', head, 4)[0]
            header_size, size = struct.unpack_from('<HH', head, 8)
            desc = dbf.read(header_size - 32)
            fields = []
            for i in range(0, len(desc), 32):
                if desc[i] == 13:
                    break
                f = desc[i:i+32]
                fields.append((f[:11].split(b'\0')[0].decode(), f[16]))
            shp.read(100)
            for _ in range(count):
                raw = dbf.read(size)
                assert len(raw) == size and raw[0] != 42
                a, pos = {}, 1
                for field, length in fields:
                    a[field] = raw[pos:pos+length].decode(encoding).strip()
                    pos += length
                header = shp.read(8)
                _, length = struct.unpack('>ii', header)
                point = shp.read(length * 2)
                assert struct.unpack_from('<i', point)[0] == 1
                x, y = struct.unpack_from('<dd', point, 4)
                lon, lat = transform.transform(x, y)
                assert math.isfinite(lon + lat) and 14 < lon < 25 and 49 < lat < 55
                yield a, x, y, lon, lat
            assert not shp.read(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--study', type=Path, default=Path('/tmp/transit-geocoder-study'))
    args = parser.parse_args()
    # Reuse the existing small projection library only during the build.
    try:
        import pyproj
    except ImportError:
        sys.path.insert(0, str(args.study / 'lib'))
    packages = json.loads((args.study / 'step3-download.json').read_text())['packages']
    assert len(packages) == 16
    for p in packages:
        path = Path(p['path'])
        if not path.is_file():
            raise SystemExit(f"Missing local package: {path}. Nothing downloaded.")
        assert hashlib.sha256(path.read_bytes()).hexdigest() == p['sha256'], path
    started = time.perf_counter()
    DB.parent.mkdir(exist_ok=True)
    temp = DB.with_suffix('.building')
    if temp.exists():
        temp.unlink()
    c = sqlite3.connect(temp)
    c.executescript("""
      CREATE TABLE addresses (
        id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL UNIQUE,
        locality TEXT NOT NULL, simc TEXT NOT NULL, terc TEXT NOT NULL,
        street TEXT NOT NULL, house_number TEXT NOT NULL,
        lon REAL NOT NULL, lat REAL NOT NULL, x_cs92 REAL, y_cs92 REAL,
        raw_prg TEXT NOT NULL, package TEXT NOT NULL, display_name TEXT NOT NULL,
        street_norm TEXT, city_norm TEXT, house_norm TEXT, text_norm TEXT
      );
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
      CREATE VIRTUAL TABLE words USING fts5(text, tokenize='unicode61', prefix='2 3 4');
      CREATE VIRTUAL TABLE fragments USING fts5(text, tokenize='trigram');
    """)
    for p in packages:
        for a, x, y, lon, lat in records(p):
            source = a['ID_IIP']
            m = UUID.match(source)
            if not m:
                raise ValueError(f'Unrecognized PRG identifier: {source}')
            # PRG namespace + UUID are stable; original versioned ID is retained.
            identifier = m[1] + '.' + m[2].lower()
            city, street, house = a['NAZWA_MSC'], a['NAZWA_ULC'], a['NUMER_PORZ']
            label = f'{street} {house}, {city}' if street else f'{city} {house}'
            sn, cn = text_normalize(street), text_normalize(city)
            values = (identifier, source, city, a['ID_SIMC'], a['TERYT_GMI'], street,
                      house, lon, lat, x, y, json.dumps(a, ensure_ascii=False), p['code'],
                      label, sn, cn, house_normalize(house), (sn + ' ' + cn).strip())
            c.execute('INSERT INTO addresses VALUES (' + ','.join('?' * len(values)) + ')', values)
    count, simcs = c.execute('SELECT count(*),count(distinct simc) FROM addresses').fetchone()
    assert count == 96009
    c.executescript("""
      CREATE INDEX simc_idx ON addresses(simc);
      INSERT INTO words(rowid,text) SELECT rowid,text_norm FROM addresses;
      INSERT INTO fragments(rowid,text) SELECT rowid,text_norm FROM addresses;
      INSERT INTO words(words) VALUES('optimize');
      INSERT INTO fragments(fragments) VALUES('optimize');
    """)
    from streets import build_streets
    street_metrics = build_streets(c, packages)
    c.commit()
    c.execute('VACUUM')
    assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    for table in ('words', 'fragments'):
        c.execute(f"INSERT INTO {table}({table}) VALUES('integrity-check')")
    metrics = dict(**street_metrics, addresses=count, unique_simc=simcs, packages=len(packages),
                   build_seconds=time.perf_counter()-started,
                   build_peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
                   source_bytes=sum(p['bytes'] for p in packages),
                   sources=[{k: p[k] for k in ('path','sha256','code')} for p in packages])
    c.execute('INSERT INTO metadata VALUES (?,?)', ('build', json.dumps(metrics)))
    c.commit()
    c.close()
    os.replace(temp, DB)
    metrics['sqlite_bytes'] = DB.stat().st_size
    (DB.parent / 'build-metrics.json').write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k:v for k,v in metrics.items() if k!='sources'}, indent=2))


if __name__ == '__main__':
    main()

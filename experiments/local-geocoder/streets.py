"""Build-time street import; never called by the HTTP runtime."""
import collections
import hashlib
import json
import math
import struct
import zipfile
from geocoder import text_normalize


def layer_records(package):
    """Read PRG_Ulice polylines and DBF side by side, retaining all source fields."""
    with zipfile.ZipFile(package['path']) as z:
        names = [n for n in z.namelist() if n.startswith('PRG_Ulice') and n.endswith('.dbf')]
        if not names:
            return
        name = names[0]
        from pyproj import CRS
        assert CRS.from_wkt(z.read(name[:-4]+'.prj').decode()).to_dict() == CRS(2180).to_dict()
        encoding = z.read(name[:-4]+'.cpg').decode().strip()
        if encoding.upper() in {'65001', 'UTF-8'}:
            encoding = 'utf-8'
        with z.open(name) as db, z.open(name[:-4]+'.shp') as shp:
            header = db.read(32)
            count = struct.unpack_from('<I', header, 4)[0]
            h, size = struct.unpack_from('<HH', header, 8)
            desc = db.read(h-32)
            fields = []
            for i in range(0, len(desc), 32):
                if desc[i] == 13:
                    break
                f = desc[i:i+32]
                fields.append((f[:11].split(b'\0')[0].decode(), f[16]))
            shp.read(100)
            for _ in range(count):
                raw = db.read(size)
                assert len(raw) == size and raw[0] != 42
                pos, a = 1, {}
                for key, length in fields:
                    a[key] = raw[pos:pos+length].decode(encoding).strip()
                    pos += length
                sh = shp.read(8)
                _, length = struct.unpack('>ii', sh)
                geom = shp.read(length*2)
                assert struct.unpack_from('<i', geom)[0] == 3
                nparts, npoints = struct.unpack_from('<ii', geom, 36)
                starts = list(struct.unpack_from('<'+'i'*nparts, geom, 44)) + [npoints]
                pts = [struct.unpack_from('<dd', geom, 44+4*nparts+i*16) for i in range(npoints)]
                assert all(math.isfinite(x+y) for x,y in pts)
                parts = [pts[starts[i]:starts[i+1]] for i in range(nparts)]
                yield a, parts
            assert not shp.read(1)


def key(terc, simc, ulic, name):
    return (terc, simc, ulic or 'name:'+text_normalize(name))


def identifier(k):
    return 'prg-street:' + ':'.join(k)


def midpoint(parts):
    """Half the aggregate line length, always on an actual source segment."""
    segments = [(a,b,math.hypot(b[0]-a[0], b[1]-a[1]))
                for part in parts for a,b in zip(part,part[1:])]
    total = sum(d for _,_,d in segments)
    if not segments or not total:
        return parts[0][0]
    remaining = total/2
    for a,b,d in segments:
        if remaining <= d and d:
            t = remaining/d
            return (a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]))
        remaining -= d
    return segments[-1][1]


def build_streets(c, packages):
    from pyproj import Transformer
    transform = Transformer.from_crs(2180,4326,always_xy=True)
    c.executescript("""
      CREATE TABLE streets (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_ids TEXT NOT NULL,
        locality TEXT NOT NULL, simc TEXT NOT NULL, terc TEXT NOT NULL, ulic TEXT NOT NULL,
        street TEXT NOT NULL, house_number TEXT NOT NULL DEFAULT '',
        lon REAL NOT NULL, lat REAL NOT NULL, display_name TEXT NOT NULL,
        street_norm TEXT NOT NULL, city_norm TEXT NOT NULL, house_norm TEXT NOT NULL DEFAULT '',
        text_norm TEXT NOT NULL, geometry_cs92 TEXT, raw_prg TEXT NOT NULL,
        origin TEXT NOT NULL, representative_method TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE street_words USING fts5(text, tokenize='unicode61', prefix='2 3 4');
      CREATE VIRTUAL TABLE street_fragments USING fts5(text, tokenize='trigram');
    """)
    grouped = collections.defaultdict(list)
    missing = []
    source_count = 0
    for p in packages:
        records = list(layer_records(p))
        if not records:
            missing.append(p['name'])
        for a,parts in records:
            assert a['TERYT_GMI'] and a['ID_SIMC'] and a['NAZWA_ULC']
            grouped[key(a['TERYT_GMI'],a['ID_SIMC'],a['ID_ULIC'],a['NAZWA_ULC'])].append((a,parts))
            source_count += 1
    values = []
    for k, records in sorted(grouped.items()):
        records.sort(key=lambda r:r[0]['ID_IIP'])
        a = records[0][0]
        parts = [part for _,ps in records for part in ps]
        x,y = midpoint(parts)
        lon,lat = transform.transform(x,y)
        ids = [r['ID_IIP'] for r,_ in records]
        sn,cn = text_normalize(a['NAZWA_ULC']),text_normalize(a['NAZWA_MSC'])
        values.append((identifier(k),ids[0],json.dumps(ids),a['NAZWA_MSC'],a['ID_SIMC'],
                       a['TERYT_GMI'],a['ID_ULIC'],a['NAZWA_ULC'],'',lon,lat,
                       a['NAZWA_ULC']+', '+a['NAZWA_MSC'],sn,cn,'',sn+' '+cn,
                       json.dumps(dict(type='MultiLineString',coordinates=parts)),
                       json.dumps([r for r,_ in records],ensure_ascii=False),
                       'PRG_Ulice','line_length_midpoint'))
    official_count = len(values)
    # A few packages contain no street layer. Explicitly marked fallback groups
    # preserve street search where official PRG address points provide the identity.
    fallback = collections.defaultdict(list)
    for row in c.execute("SELECT id,source_id,locality,simc,terc,street,lon,lat,x_cs92,y_cs92,raw_prg FROM addresses WHERE street<>'' ORDER BY id"):
        iid,source,city,simc,terc,street,lon,lat,x,y,raw = row
        a = json.loads(raw)
        k = key(terc,simc,a.get('ID_ULIC',''),street)
        if k not in grouped:
            fallback[k].append((source,city,street,lon,lat,x,y,a.get('ID_ULIC','')))
    for k, points in sorted(fallback.items()):
        meanx = sum(p[5] for p in points)/len(points)
        meany = sum(p[6] for p in points)/len(points)
        p = min(points,key=lambda p:((p[5]-meanx)**2+(p[6]-meany)**2,p[0]))
        source,city,street,lon,lat,x,y,ulic = p
        sn,cn = text_normalize(street),text_normalize(city)
        values.append((identifier(k),source,json.dumps([p[0] for p in points]),city,k[1],k[0],
                       ulic,street,'',lon,lat,street+', '+city,sn,cn,'',sn+' '+cn,None,
                       json.dumps(dict(address_source_ids=[p[0] for p in points],representative_source_id=source)),
                       'PRG_address_group','existing_address_nearest_mean'))
    c.executemany('INSERT INTO streets VALUES ('+','.join('?'*20)+')',values)
    for table in ('street_words','street_fragments'):
        c.execute(f'INSERT INTO {table}(rowid,text) SELECT rowid,text_norm FROM streets')
        c.execute(f"INSERT INTO {table}({table}) VALUES('optimize')")
        c.execute(f"INSERT INTO {table}({table}) VALUES('integrity-check')")
    return dict(streets=len(values),official_streets=official_count,
                address_derived_streets=len(fallback),street_source_records=source_count,
                packages_without_street_layer=missing)

"""Deterministic offline build from checksum-pinned local snapshots. No network calls."""
import argparse
import collections
import csv
import difflib
import hashlib
import io
import json
import math
import resource
import sqlite3
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from search import ROOT, normalize
from rules import decide
from curation import override as audit_override, education_building_decision

RELEASE = '2026-10-21.0'
DATE = '2026-11-08'


def js(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def distance(a, b):
    # Haversine, metres. Used only for proximity signals and candidate matching.
    lat1, lon1, lat2, lon2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def identity(name):
    n = normalize(name)
    for words, target in [
        (['medical university of lublin', 'uniwersytet medyczny w lublinie'], 'Uniwersytet Medyczny w Lublinie'),
        (['maria curie sklodowska university', 'uniwersytet marii curie sklodowskiej'], 'Uniwersytet Marii Curie-Skłodowskiej w Lublinie'),
        (['the john paul ii catholic university', 'katolicki uniwersytet lubelski'], 'Katolicki Uniwersytet Lubelski Jana Pawła II'),
        (['dworzec lublin', 'dworzec metropolitalny'], 'Dworzec Lublin'),
        (['szpital wojskowy', 'wojskowy szpital kliniczny'], '1 Wojskowy Szpital Kliniczny z Polikliniką SPZOZ w Lublinie'),
        (['uniwersytecki szpital dzieciecy', 'dzieciecy szpital kliniczny'], 'Uniwersytecki Szpital Dziecięcy w Lublinie'),
        (['szpital neuropsychiatryczny'], 'Szpital Neuropsychiatryczny'),
        (['browar perla', 'browary lubelskie'], 'Perła — Browary Lubelskie'),
        (['stock polska'], 'Stock Polska'),
        (['ogrod saski'], 'Ogród Saski'),
        (['lublin airport', 'port lotniczy lublin'], 'Port Lotniczy Lublin'),
        (['vivo', 'tarasy zamkowe'], 'VIVO! Lublin'),
        (['centre for the meeting of cultures', 'csk lublin', 'centrum spotkania kultur'], 'Centrum Spotkania Kultur'),
        (['spsk4', 'szpital kliniczny nr 4'], 'Szpital Kliniczny nr 4'),
        (['augusta westland pzl swidnik', 'pzl swidnik'], 'PZL-Świdnik'),
    ]:
        if any(w in n for w in words):
            return target
    return None


def match_key(name):
    n = normalize(name)
    n = re_sub(r'\b(w lublinie|lublin|swidnik|sp z o o|s a|samodzielny publiczny|centrum handlowe)\b', '', n)
    return ' '.join(n.split())


def re_sub(pattern, repl, value):
    import re
    return re.sub(pattern, repl, value)


def can_merge(a, b):
    if a['category'] != b['category']:
        return False
    d = distance((a['lon'], a['lat']), (b['lon'], b['lat']))
    if a.get('site') and b.get('site'):
        return a['site']==b['site'] and d<250
    ia, ib = identity(a['name']), identity(b['name'])
    sensitive=a['category'] in {'industry','education','health'}
    # Explicit site identity groups remain geographically constrained.
    if not sensitive and ia and ia == ib and d <= (1500 if ia == 'Port Lotniczy Lublin' else (500 if ia == 'PZL-Świdnik' else 200)):
        return True
    ka, kb = match_key(ia or a['name']), match_key(ib or b['name'])
    similar = bool(ka and kb and (ka == kb or (min(len(ka), len(kb)) >= 12 and difflib.SequenceMatcher(None, ka, kb).ratio() >= .92)))
    if not similar:
        return False
    if not sensitive and d <= (350 if a['category']=='park' else 80):
        return True
    # Same named physical site: building inside a campus/area. Never merge by distance alone.
    from shapely.geometry import shape, Point
    for area, point in [(a, b), (b, a)]:
        if area['geometry_kind'] != 'point' and shape(area['geometry']).covers(Point(point['lon'], point['lat'])):
            return True
    return False


def can_join(group, feature):
    # An unreviewed area must not bridge two explicitly different physical sites.
    if feature.get('site') and any(x.get('site') and x['site'] != feature['site'] for x in group):
        return False
    return can_merge(group[0], feature) or any(x['geometry_kind']=='area' and can_merge(x,feature) for x in group)


def boundaries(src):
    from shapely.geometry import shape
    from shapely import make_valid
    return [(f['properties']['JPT_KOD_JE'].replace('_', ''), f['properties']['JPT_NAZWA_'], make_valid(shape(f['geometry'])))
            for f in json.loads((src/'boundary.json').read_text())['features']]


def local(point, bounds):
    from shapely.geometry import Point
    p = Point(*point)
    return next(((code, name) for code, name, g in bounds if g.covers(p)), None)


def overture(src, bounds, audit):
    overrides=json.loads((ROOT/'overrides.json').read_text())
    import pyarrow.parquet as pq
    from shapely import from_wkb
    for batch in pq.ParquetFile(src/f'overture-{RELEASE}.parquet').iter_batches(batch_size=512):
        for r in batch.to_pylist():
            g = from_wkb(r.pop('geometry')); loc = local((g.x, g.y), bounds)
            if not loc:
                continue
            name = (r.get('names') or {}).get('primary') or ''
            action, category, score, why = decide(name, r.get('basic_category'))
            override=overrides.get(r['id'],{})
            if override:
                action=override['decision'];category=override.get('category',category);score=override.get('relevance',score);why=override['reason']
            reviewed=audit_override('overture',r['id'],name)
            if reviewed:
                action=reviewed['decision'];category=reviewed.get('category',category);score=reviewed.get('relevance',score);why=reviewed['reason']
            if not name.strip() or not math.isfinite(g.x + g.y):
                action, why = 'reject', 'invalid_name_or_coordinates'
            if r.get('operating_status') == 'permanently_closed':
                action, why = 'reject', 'source_permanently_closed'
            audit.append({'source': 'overture', 'source_id': r['id'], 'name': name, 'decision': action, 'reason': why, 'gmina': loc[1]})
            if action != 'include':
                continue
            flags = []
            if r.get('confidence') is not None and r['confidence'] < .5:
                flags.append('low_confidence_not_rejection')
            if category == 'industry':
                flags.append('workplace_scale_and_current_operation_unverified')
            if not r.get('operating_status'):
                flags.append('operation_status_unknown')
            if not all(s.get('license') for s in r.get('sources') or []):
                raise ValueError('Missing Overture source license: '+r['id'])
            yield dict(source='overture', source_id=r['id'], version=str(r.get('version', 'release:'+RELEASE)), release=RELEASE,
                       name=name, category=category, relevance=score, reason=why, lon=g.x, lat=g.y,
                       geometry_kind='point', geometry=g.__geo_interface__, gmina=loc[1], terc=loc[0],
                       flags=flags, raw=r, licenses=r['sources'], site=reviewed.get('site'), curated_name=reviewed.get('name'))


def bdot(src, bounds, audit):
    from shapely.geometry import Polygon, MultiPolygon, Point
    from shapely import make_valid
    from shapely import transform as shapely_transform
    from pyproj import Transformer
    tr = Transformer.from_crs(2180, 4326, always_xy=True).transform
    mapping = {'OT_KUHU_A': ('shopping', 75), 'OT_KUOZ_A': ('health', 85),
               'OT_KUOS_A': ('education', 75), 'OT_KUSK_A': ('park', 60),
               'OT_KUKO_A': ('transport', 90), 'OT_KUKO_P': ('transport', 90),
               'OT_KUPG_A': ('industry', 80), 'OT_BUBD_A': (None, 60)}
    for package in sorted(src.glob('*_GML.zip')):
        with zipfile.ZipFile(package) as z:
            for filename in sorted(z.namelist()):
                typ = filename.split('__')[-1].removesuffix('.xml')
                if typ not in mapping:
                    continue
                with z.open(filename) as stream:
                    for _, member in ET.iterparse(stream, events=('end',)):
                        if member.tag.split('}')[-1] != 'featureMember':
                            continue
                        f = list(member)[0]
                        a = {x.tag.split('}')[-1]: x.text for x in f if x.tag.split('}')[-1] != 'geometria'}
                        name = (a.get('nazwa') or '').strip()
                        if not name:
                            member.clear(); continue
                        gg = f.find('{*}geometria'); polys=[]; geom=None
                        for p in gg.findall('.//{*}Polygon') if gg is not None else []:
                            def ring(e):
                                v = list(map(float, e.find('.//{*}posList').text.split()))
                                return list(zip(v[::2], v[1::2]))
                            polys.append(Polygon(ring(p.find('{*}exterior')), [ring(e) for e in p.findall('{*}interior')]))
                        if polys:
                            geom = make_valid(MultiPolygon(polys))
                        elif gg is not None and gg.find('.//{*}pos') is not None:
                            geom = Point(list(map(float, gg.find('.//{*}pos').text.split())))
                        if geom is None or geom.is_empty:
                            member.clear(); continue
                        # EPSG:2180 metric area before transformation, as a documented physical-size signal.
                        area = geom.area
                        geom = shapely_transform(geom, tr, interleaved=False); rep = geom.representative_point(); loc = local((rep.x, rep.y), bounds)
                        if not loc:
                            member.clear(); continue
                        category, score = mapping[typ]; kind = a.get('rodzaj') or a.get('funkcjaSzczegolowaBudynku') or ''
                        n, k = normalize(name), normalize(kind)
                        action, why = 'include', 'named_bdot_destination'
                        if typ == 'OT_KUPG_A':
                            if kind != 'zakład produkcyjny, usługowy lub remontowy' or area < 10000:
                                action, why = 'review', 'industrial_scale_or_purpose_not_established'
                            if any(w in n for w in ['serwis', 'dealer', 'autoryzowany', 'auto bendiks', 'car service', 'meble stylowe']) or n=='volvo':
                                action, why = 'reject', 'retail_or_repair_not_industrial_destination'
                            if 'lublin airport' in n: category='transport'
                            if 'policji' in n: category='government'
                        elif typ == 'OT_KUOS_A':
                            if kind != 'szkoła wyższa' and not any(w in n for w in ['liceum', 'technikum', 'zespol szkol']):
                                action, why = 'review', 'school_size_not_established'
                        elif typ == 'OT_KUSK_A':
                            if kind == 'kompleks sportowo-rekreacyjny':
                                category='sport'
                                if area<5000 or 'stowarzyszenie' in n:
                                    action, why = 'review', 'sports_site_size_or_identity_not_established'
                            elif kind not in ['park lub skwer', 'ogród botaniczny', 'ogród zoologiczny']:
                                action, why = 'review', 'recreation_destination_needs_review'
                        elif typ in ['OT_KUKO_A', 'OT_KUKO_P']:
                            if kind not in ['dworzec autobusowy', 'stacja kolejowa', 'port lotniczy']:
                                action, why = 'reject', 'parking_or_depot_not_passenger_hub'
                        elif typ == 'OT_BUBD_A':
                            if any(w in k for w in ['muze', 'teatr', 'bibliotek']): category='culture'
                            elif any(w in k for w in ['szpital']): category='health'
                            elif any(w in k for w in ['szkola wyzsza']): category='education'
                            else: action, why = 'review', 'named_building_purpose_not_in_scope'
                        if typ == 'OT_KUOZ_A' and kind != 'zespół szpitalny lub sanatoryjny':
                            action, why = 'review', 'care_facility_scale_not_established'
                        component=education_building_decision(name,kind) if typ=='OT_BUBD_A' and action=='review' else None
                        if component:
                            category,action,why=component
                        sid = a.get('lokalnyId') or f.get('{http://www.opengis.net/gml/3.2}id')
                        reviewed=audit_override('bdot',sid,name)
                        if reviewed:
                            action=reviewed['decision'];category=reviewed.get('category',category);score=reviewed.get('relevance',score);why=reviewed['reason']
                        if a.get('kategoriaIstnienia') in ['nieczynny', 'zniszczony', 'w ruinie']:
                            action, why = 'review', 'bdot_existence_needs_review'
                        audit.append(dict(source='bdot', source_id=sid, name=name, decision=action, reason=why, gmina=loc[1]))
                        if action == 'include':
                            yield dict(source='bdot', source_id=sid, version=a['wersja'], release=package.name,
                              name=name, category=category, relevance=score, reason=why, lon=rep.x, lat=rep.y,
                              geometry_kind='building' if typ=='OT_BUBD_A' else ('point' if geom.geom_type=='Point' else 'area'),
                              geometry=geom.__geo_interface__, gmina=loc[1], terc=loc[0], raw=a,
                              flags=['representative_point_not_entrance'] + (['source_age_requires_review'] if a['wersja'][:4]<'2025' else []) + (['workplace_scale_and_current_operation_unverified'] if category=='industry' else []),
                              site=reviewed.get('site'), curated_name=reviewed.get('name'), licenses=[{'dataset':'GUGiK BDOT10k','license':'PL-PGiK-40a-40c','property':'','record_id':sid}], area_m2=area)
                        member.clear()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sources', type=Path, default=ROOT/'data/sources')
    parser.add_argument('--output', type=Path, default=ROOT/'data/poi.sqlite')
    args = parser.parse_args(); src=args.sources; started=time.perf_counter()
    manifest=json.loads((src/'manifest.json').read_text())
    if manifest!=json.loads((ROOT/'sources.json').read_text()):
        raise ValueError('Source manifest differs from pinned sources.json')
    for artifact in manifest['license_artifacts']:
        if hashlib.sha256((ROOT/'licenses'/artifact['file']).read_bytes()).hexdigest()!=artifact['sha256']:
            raise ValueError('Licence/NOTICE checksum mismatch: '+artifact['file'])
    for f in manifest['files']:
        if hashlib.sha256((src/f['file']).read_bytes()).hexdigest()!=f['sha256']:
            raise ValueError('Snapshot checksum mismatch: '+f['file'])
    bounds=boundaries(src); audit=[]
    features=sorted([*overture(src,bounds,audit),*bdot(src,bounds,audit)],key=lambda r:(r['source']!='overture',r['geometry_kind']=='building',r['source_id']))
    # Compare against the representative feature, avoiding transitive proximity chains.
    groups=[]
    for f in features:
        group=next((g for g in groups if can_join(g,f)),None)
        if group is None:groups.append([f])
        else:group.append(f)
    presentation_rules=json.loads((ROOT/'presentation-rules.json').read_text())
    def find_group(keys):
        matches=[g for g in groups if any(x['source']+':'+x['source_id'] in keys for x in g)]
        if len(matches)!=1:raise ValueError('Presentation rule has missing or ambiguous members')
        return matches[0]
    for rule in presentation_rules:
        if rule['action']=='merge':
            a,b=[find_group(keys) for keys in rule['members']]
            if a is not b:
                a.extend(b);groups.remove(b)
    stops=[]
    with zipfile.ZipFile(src/'gtfs.zip') as z:
        for r in csv.DictReader(io.StringIO(z.read('stops.txt').decode('utf-8-sig'))):
            stops.append((r['stop_id'], (float(r['stop_lon']),float(r['stop_lat']))))
    import numpy as np
    stop_points=np.radians(np.array([p for sid,p in stops]))
    def nearest(lon,lat):
        if not stops:return (None,None)
        lo,la=math.radians(lon),math.radians(lat)
        h=np.sin((stop_points[:,1]-la)/2)**2+math.cos(la)*np.cos(stop_points[:,1])*np.sin((stop_points[:,0]-lo)/2)**2
        i=int(np.argmin(h))
        return (distance((lon,lat),stops[i][1]),stops[i][0])
    wd=json.loads((src/'wikidata-controls.json').read_text())['entities']
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temp=args.output.with_suffix('.building')
    if temp.exists():temp.unlink()
    c=sqlite3.connect(temp)
    c.executescript('''
      PRAGMA page_size=4096;
      CREATE TABLE pois(id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,relevance INTEGER NOT NULL,
        lon REAL NOT NULL,lat REAL NOT NULL,geometry_kind TEXT NOT NULL,arrival_lon REAL,arrival_lat REAL,
        arrival_status TEXT NOT NULL,gmina TEXT NOT NULL,terc TEXT NOT NULL,nearest_stop_m REAL,nearest_stop_id TEXT,
        review_flags TEXT NOT NULL);
      CREATE TABLE features(id INTEGER PRIMARY KEY,poi_id TEXT NOT NULL REFERENCES pois(id),source TEXT NOT NULL,
        source_id TEXT NOT NULL,version TEXT NOT NULL,release TEXT NOT NULL,name TEXT NOT NULL,
        geometry_kind TEXT NOT NULL,geometry_json TEXT NOT NULL,raw_json TEXT NOT NULL,reason TEXT NOT NULL,
        UNIQUE(source,source_id,release));
      CREATE TABLE provenance(feature_id INTEGER NOT NULL REFERENCES features(id),dataset TEXT NOT NULL,
        license TEXT NOT NULL,property TEXT,record_id TEXT,details_json TEXT NOT NULL);
      CREATE TABLE names(poi_id TEXT NOT NULL REFERENCES pois(id),name TEXT NOT NULL,normalized TEXT NOT NULL,
        kind TEXT NOT NULL,source TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,
        UNIQUE(poi_id,name,source,source_id));
      CREATE VIRTUAL TABLE names_fts USING fts5(normalized,content='names',content_rowid='rowid',tokenize='unicode61',prefix='2 3 4');
      CREATE TABLE entrances(poi_id TEXT NOT NULL REFERENCES pois(id),lon REAL NOT NULL,lat REAL NOT NULL,
        source TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,license TEXT NOT NULL);
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX names_poi ON names(poi_id);
      CREATE INDEX features_poi ON features(poi_id);
    ''')
    totals=collections.Counter(); review=[]
    for group in groups:
        f=group[0]; pid='poi:'+hashlib.sha256((f['source']+':'+f['source_id']).encode()).hexdigest()[:20]
        canonical=f.get('curated_name') or identity(f['name']) or f['name']
        coordinate_conflict=False
        if f['geometry_kind']=='point' and f['category']!='transport':
            from shapely.geometry import shape,Point
            areas=[x for x in group if x['geometry_kind']=='area']
            if areas and not any(shape(x['geometry']).covers(Point(f['lon'],f['lat'])) for x in areas):
                coordinate_conflict=True
                f=areas[0]
        near=nearest(f['lon'],f['lat'])
        flags=sorted({flag for x in group for flag in x['flags']})
        if coordinate_conflict:flags.append('source_point_outside_matching_area_used_area_representative')
        if len(group)>1:flags.append('merged_identity_check')
        if f['category']=='education':flags.append('campus_building_identity_review')
        # No supplied, reliable entrances. NULL arrival is intentional, not an invented gate.
        c.execute('INSERT INTO pois VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          (pid,canonical,f['category'],max(x['relevance'] for x in group),f['lon'],f['lat'],f['geometry_kind'],None,None,'unresolved',f['gmina'],f['terc'],None if near[0] is None else round(near[0],1),near[1],js(flags)))
        def add_name(name,kind,source,sid,version):
            if name and normalize(name):c.execute('INSERT OR IGNORE INTO names VALUES(?,?,?,?,?,?,?)',(pid,name,normalize(name),kind,source,sid,version))
        add_name(canonical,'canonical','local-curation',f['source_id'],'rules-v2')
        if canonical=='Centrum Spotkania Kultur':add_name('CSK','alias','local-curation','initials-of-canonical','rules-v2')
        if canonical=='Szpital Kliniczny nr 4':add_name('SPSK4','alias','local-curation','source-Spsk4','rules-v2')
        if canonical=='Uniwersytet Medyczny w Lublinie':add_name('UM Lublin','alias','local-curation','initials-of-canonical','rules-v2')
        for x in group:
            if x.get('curated_name'):add_name(x['curated_name'],'alias','local-curation',x['source_id'],'rules-v2')
            cur=c.execute('INSERT INTO features(poi_id,source,source_id,version,release,name,geometry_kind,geometry_json,raw_json,reason) VALUES(?,?,?,?,?,?,?,?,?,?)',
              (pid,x['source'],x['source_id'],x['version'],x['release'],x['name'],x['geometry_kind'],js(x['geometry']),js(x['raw']),x['reason']))
            fid=cur.lastrowid
            for s in x['licenses']:
                c.execute('INSERT INTO provenance VALUES(?,?,?,?,?,?)',(fid,s['dataset'],s['license'],s.get('property'),s.get('record_id'),js(s)))
            add_name(x['name'],'source','feature',x['source']+':'+x['source_id'],x['version'])
            if x['source']=='overture':
                for rule in (x['raw'].get('names') or {}).get('rules') or []:
                    add_name(rule.get('value'),'alias','feature','overture:'+x['source_id'],x['version'])
        # Associate Wikidata names only by both identity text and location, never proximity alone.
        for q,e in wd.items():
            labels=[v['value'] for v in e.get('labels',{}).values()]
            names=labels+[v['value'] for vs in e.get('aliases',{}).values() for v in vs]
            coords=[v['mainsnak'].get('datavalue',{}).get('value') for v in e.get('claims',{}).get('P625',[])]
            coords=[v for v in coords if isinstance(v,dict) and v.get('globe','').endswith('/Q2')]
            if not any(distance((f['lon'],f['lat']),(v['longitude'],v['latitude']))<180 for v in coords):continue
            if not any((identity(n) and identity(n)==identity(canonical)) or match_key(n)==match_key(canonical) for n in labels):continue
            version=str(e.get('lastrevid','snapshot-'+DATE))
            for n in names:add_name(n,'alias','wikidata',q,version)
        totals[f['category']]+=1
        review.append(dict(id=pid,name=canonical,category=f['category'],flags=flags,sources=[x['source']+':'+x['source_id'] for x in group]))
    # Physical places remain in pois/features; this layer alone controls autocomplete.
    c.execute('CREATE TABLE search_presentations(poi_id TEXT PRIMARY KEY REFERENCES pois(id), visible INTEGER NOT NULL, representative_id TEXT NOT NULL REFERENCES pois(id), reason TEXT NOT NULL)')
    c.execute("INSERT INTO search_presentations SELECT id,1,id,'default' FROM pois")
    for rule in presentation_rules:
        if rule['action']=='represent':
            ids=[]
            for keys in rule['members']:
                found={row[0] for key in keys for row in c.execute('SELECT poi_id FROM features WHERE source=? AND source_id=?',key.split(':',1))}
                if len(found)!=1:raise ValueError('Unresolved presentation member')
                ids.append(next(iter(found)))
            if rule.get('labels'):
                for pid,label in zip(ids,rule['labels']):
                    c.execute('UPDATE pois SET name=? WHERE id=?',(label,pid))
                    c.execute('INSERT OR IGNORE INTO names VALUES(?,?,?,?,?,?,?)',(pid,label,normalize(label),'canonical','local-curation','audit-group-'+str(rule['audit_group']),'rules-v3'))
                    for item in review:
                        if item['id']==pid:item['name']=label
                continue
            # No reliable distinguishing address/corpus name in these BDOT records.
            # Keep the first audited representation; preserve other places and all names.
            c.execute('UPDATE search_presentations SET visible=0,representative_id=?,reason=? WHERE poi_id=?',(ids[0],rule['reason'],ids[1]))
    c.execute('INSERT INTO metadata VALUES(?,?)',('presentation_rules',js(presentation_rules)))
    c.execute("INSERT INTO names_fts(names_fts) VALUES('rebuild')")
    c.execute('INSERT INTO metadata VALUES(?,?)',('manifest',js(manifest)))
    c.execute('INSERT INTO metadata VALUES(?,?)',('build_rules','v3'))
    c.execute('INSERT INTO metadata VALUES(?,?)',('audit_overrides',(ROOT/'audit-overrides.json').read_text()))
    c.execute('INSERT INTO metadata VALUES(?,?)',('wikidata_license','CC0-1.0; see names source/version and pinned snapshot'))
    c.execute('INSERT INTO metadata VALUES(?,?)',('bdot_coverage','Lublin city and selected gminas of powiat swidnicki; Overture covers all 16'))
    c.commit(); assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; c.close()
    temp.replace(args.output)
    (args.output.parent/'decisions.jsonl').write_text('\n'.join(js(x) for x in audit)+'\n')
    (args.output.parent/'review.json').write_text(json.dumps(review,ensure_ascii=False,indent=2))
    metrics=dict(searchable_pois=sqlite3.connect(args.output).execute('SELECT count(*) FROM search_presentations WHERE visible=1').fetchone()[0],pois=sum(totals.values()),categories=dict(sorted(totals.items())),features=len(features),merged_features=len(features)-sum(totals.values()),decisions=dict(collections.Counter(x['decision'] for x in audit)),sqlite_bytes=args.output.stat().st_size,build_seconds=round(time.perf_counter()-started,3),build_peak_rss_mib=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,2))
    (args.output.parent/'build-metrics.json').write_text(json.dumps(metrics,indent=2))
    print(json.dumps(metrics,ensure_ascii=False,indent=2))

if __name__=='__main__':main()

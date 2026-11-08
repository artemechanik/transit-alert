"""Street behavior over HTTP and source-geometry checks."""
import json
import math
import statistics
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from geocoder import ROOT, connect, normalize
from contextlib import closing

study=Path('/tmp/transit-geocoder-study')
base=json.loads((ROOT/'run/server.json').read_text())['url']
def query(q,limit=50):
    start=time.perf_counter()
    with urllib.request.urlopen(base+'search?'+urllib.parse.urlencode(dict(q=q,limit=limit))) as r:
        data=json.load(r)
    return data['results'],(time.perf_counter()-start)*1000

results=[];times=[]
for q in ['li','lip','lipo','lipowa','LI',' LIPOWA ','ul. Lipowa','Racławickie','Raclawickie',
          'Krakowskie Przedmieście','krakowskie przedmiescie','3 Maja','Dywizjonu 303']:
    rs,ms=query(q);times.append(ms)
    assert rs and all(r['type']=='street' and r['house_number']=='' for r in rs),q
    assert len({r['id'] for r in rs})==len(rs)
    if q.strip().lower() in {'li','lip','lipo','lipowa'}:
        assert any(r['street']=='Lipowa' and r['locality']=='Lublin' for r in rs),q
    results.append(dict(query=q,count=len(rs),top=rs[:4],http_ms=ms))
a,_=query('Racławickie');b,_=query('Raclawickie')
assert [r['id'] for r in a]==[r['id'] for r in b]
rs,_=query('Lipowa')
assert len({r['simc'] for r in rs if r['street']=='Lipowa'})>=5
for q in ['Lipowa 12','bilgorajska 24','Motycz 69B','Kozubszczyzna 58','Piotrawin 5']:
    rs,ms=query(q);times.append(ms)
    assert rs and all(r['type']=='address' for r in rs),q
    if q=='Motycz 69B':
        assert rs[0]['street']=='' and rs[0]['house_number']=='69B'
    results.append(dict(query=q,count=len(rs),top=rs[:4],http_ms=ms))
# Reuse existing projection module only in this test; runtime remains stdlib-only.
sys.path.insert(0,str(study/'lib'))
from pyproj import Transformer
from streets import layer_records, key, identifier
forward=Transformer.from_crs(4326,2180,always_xy=True)
packages=json.loads((study/'step3-download.json').read_text())['packages']
sources={}
for p in packages:
    for a,parts in layer_records(p):
        sid=identifier(key(a['TERYT_GMI'],a['ID_SIMC'],a['ID_ULIC'],a['NAZWA_ULC']))
        sources.setdefault(sid,[]).append((a,parts))
def segment_distance(pt,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1]
    den=dx*dx+dy*dy
    t=max(0,min(1,((pt[0]-a[0])*dx+(pt[1]-a[1])*dy)/den)) if den else 0
    return math.hypot(pt[0]-a[0]-t*dx,pt[1]-a[1]-t*dy)
counts={'official':0,'fallback':0}
with closing(connect()) as c:
    assert c.execute('SELECT count(*) FROM addresses').fetchone()[0]==96009
    assert c.execute('SELECT count(*) FROM streets').fetchone()[0]==2580
    for r in c.execute('SELECT * FROM streets'):
        assert r['ulic'] and r['simc'] and r['terc']
        assert 'prg-street:' in r['id']
        if r['origin']=='PRG_Ulice':
            original=sources[r['id']]
            a=original[0][0]
            assert (r['street'],r['simc'],r['terc'],r['ulic'])==(a['NAZWA_ULC'],a['ID_SIMC'],a['TERYT_GMI'],a['ID_ULIC'])
            x,y=forward.transform(r['lon'],r['lat'])
            parts=[part for _,ps in original for part in ps]
            segments=[(a,b) for p in parts for a,b in zip(p,p[1:])]
            assert min(segment_distance((x,y),a,b) for a,b in segments)<.001,r['id']
            stored=json.loads(r['geometry_cs92'])['coordinates']
            assert stored==[[list(pt) for pt in p] for p in parts]
            counts['official']+=1
        else:
            assert r['origin']=='PRG_address_group' and r['geometry_cs92'] is None
            a=c.execute('SELECT * FROM addresses WHERE source_id=?',(r['source_id'],)).fetchone()
            assert a and (r['lat'],r['lon'],r['simc'],r['terc'])==(a['lat'],a['lon'],a['simc'],a['terc'])
            counts['fallback']+=1
    assert counts==dict(official=2570,fallback=10)
    assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
for _ in range(5):
    for q in ['li','lip','lipo','lipowa','Lipowa 12','Motycz 69B']:
        _,ms=query(q,10);times.append(ms)
report=dict(queries=results,source_geometry_checks=counts,http_samples=len(times),
            p50_http_ms=statistics.median(times),p95_http_ms=sorted(times)[math.ceil(len(times)*.95)-1])
(ROOT/'data/street-test-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='queries'},indent=2))
for r in results[:4]:
    print(r['query'],[(s['display_name'],s['type']) for s in r['top']])

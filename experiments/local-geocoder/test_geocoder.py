"""HTTP behavior, rank and independent source-record checks; no network beyond loopback."""
import csv
import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from geocoder import ROOT, connect, normalize

STUDY = Path('/tmp/transit-geocoder-study')
BASE = json.loads((ROOT/'run/server.json').read_text())['url']


def request(path, params=None):
    url = BASE + path + (('?' + urllib.parse.urlencode(params)) if params else '')
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            body, code = r.read(), r.status
    except urllib.error.HTTPError as e:
        body, code = e.read(), e.code
    return code, json.loads(body), (time.perf_counter()-started)*1000


# Explicit top-result expectations, determined against original PRG fields.
cases = [
 ('Biłgorajska 24','Biłgorajska','Lublin','24'),
 ('bilgorajska 24','Biłgorajska','Lublin','24'),
 ('  UL.  BILGORAJSKA   24  ','Biłgorajska','Lublin','24'),
 ('Biłgoraj','Biłgorajska','Lublin',None),
 ('gorajska 24','Biłgorajska','Lublin','24'),
 ('Narutowicza 12','Prezydenta Gabriela Narutowicza','Lublin','12'),
 ('narutowicza 12 m. 3','Prezydenta Gabriela Narutowicza','Lublin','12'),
 ('Lipowa','Lipowa','Lublin',None),
 ('Lipowa 12','Lipowa','Lublin','12'),
 ('Lublin Lipowa 12','Lipowa','Lublin','12'),
 ('lip','Lipowa','Lublin',None),
 ('Krakowskie Przedmieście','Krakowskie Przedmieście','Lublin',None),
 ('krakowskie przedmiescie','Krakowskie Przedmieście','Lublin',None),
 ('Krakowskie Przed','Krakowskie Przedmieście','Lublin',None),
 ('Raclawickie','aleje Racławickie','Lublin',None),
 ('al. Racławickie','aleje Racławickie','Lublin',None),
 ('ALEJE RACLAWICKIE 1','aleje Racławickie','Lublin','1'),
 ('Zamojska','Zamojska','Lublin',None),
 ('Zamojska 8','Zamojska','Lublin','8'),
 ('Motycz 69B','','Motycz','69B'),
 ('motycz 69b','','Motycz','69B'),
 ('Motycz 69','','Motycz','69'),
 ('Kozubszczyzna 58','','Kozubszczyzna','58'),
 ('Piotrawin 5','','Piotrawin','5'),
 ('Jakubowice Koninskie Brzozowa 25','Brzozowa','Jakubowice Konińskie','25'),
 ('Turka Akacjowa 10','Akacjowa','Turka','10'),
 ('Swidnik Drewniana 32','Drewniana','Świdnik','32'),
 ('Lublin Wyzwolenia 32','Wyzwolenia','Lublin','32'),
 ('Żabia Wola',None,'Żabia Wola',None),
 ('Sporniak',None,'Sporniak',None),
 ('Lublin',None,'Lublin',None),
 ('  ŚWIDNIK  ',None,'Świdnik',None),
 ('Dąbrowica',None,'Dąbrowica',None),
 ('Lublin pl. Litewski','Plac Litewski','Lublin',None),
 ('Biłgorajska 99999',None,None,None),
 ('Motycz 99999',None,None,None),
 ('NieistniejacaXYZ 123',None,None,None),
]
# Use genuine unusual building labels as additional fixtures.
with connect() as c:
    for row in c.execute("SELECT * FROM addresses WHERE house_number IN ('1-3','1/3') LIMIT 3"):
        cases.append((f"{row['locality']} {row['street']} {row['house_number']}",row['street'],row['locality'],row['house_number']))
results, timings, returned = [], [], {}
for q, street, city, house in cases:
    code, data, elapsed = request('search',dict(q=q,limit=10))
    assert code == 200, (q,code,data)
    found=data['results']
    if city is None:
        assert found == [], (q,found)
    else:
        assert found, q
        top=found[0]
        if street is not None: assert top['street']==street,(q,top)
        assert top['locality']==city,(q,top)
        if house is not None: assert top['house_number'].lower()==house.lower(),(q,top)
        assert [r['match_rank'] for r in found] == sorted(r['match_rank'] for r in found), q
        for r in found:
            assert r['type'] in {'street', 'address'}
            if r['type'] == 'address': returned[r['source_id']]=r
            assert r['id'] and r['simc'] and r['terc'] and r['display_name']
    results.append(dict(query=q,top=found[0] if found else None,result_count=len(found),http_ms=elapsed))
    timings.append(elapsed)
for params, expected in [
 ({'q':''},200),({'q':'   '},200),({'q':'24'},400),({'q':'a'},400),
 ({'q':'Lipowa','limit':0},400),({'q':'Lipowa','limit':-1},400),
 ({'q':'Lipowa','limit':'oops'},400),({'q':'Lipowa','limit':999},200),
 ({'q':'x'*201},400),({'q':'Lipowa\n12'},400),
 ({'q':'" OR *'},200),({'q':"'; DROP TABLE addresses;--"},200),
]:
    code,data,_=request('search',params)
    assert code==expected,(params,code,data)
    if expected==200: assert len(data['results'])<=50
# Compare every returned point to the ORIGINAL package values, not normalized search columns.
sys.path.insert(0,str(STUDY/'lib'))
from build import records
originals={}
packages=json.loads((STUDY/'step3-download.json').read_text())['packages']
for p in packages:
    for a,x,y,lon,lat in records(p):
        source=a['ID_IIP']
        if source in returned:
            r=returned[source]
            assert (r['locality'],r['street'],r['house_number'],r['simc'],r['terc']) == (
                a['NAZWA_MSC'],a['NAZWA_ULC'],a['NUMER_PORZ'],a['ID_SIMC'],a['TERYT_GMI'])
            assert abs(r['lat']-lat)<1e-10 and abs(r['lon']-lon)<1e-10
            originals[source]=True
assert len(originals)==len(returned)
# Independent earlier study coordinates (different import implementation).
prior={r['id_iip']:r for r in csv.DictReader(open(STUDY/'step3-addresses-in-zone.csv'))}
checked=0
for source,r in returned.items():
    old=prior.get(source)
    if old:
        assert abs(r['lat']-float(old['lat']))<1e-10 and abs(r['lon']-float(old['lon']))<1e-10
        checked+=1
# Repeat HTTP samples, including a broad locality query. Includes connect + JSON decoding.
for _ in range(4):
    for q,*_ in cases:
        code,data,elapsed=request('search',dict(q=q,limit=10)); assert code==200
        timings.append(elapsed)
stats=request('stats')[1]
assert stats['addresses']==96009 and stats['unique_simc']==290
with urllib.request.urlopen(BASE) as r:
    html=r.read().decode()
    assert r.status==200 and 'combobox' in html and '/app.js' in html
for asset in ['app.js','style.css']:
    with urllib.request.urlopen(BASE+asset) as r: assert r.status==200
ordered=sorted(timings)
metrics=dict(queries=len(cases),http_samples=len(timings),p50_http_ms=statistics.median(timings),
    p95_http_ms=ordered[math.ceil(len(ordered)*.95)-1],max_http_ms=max(timings),
    source_records_verified=len(originals),independent_prior_coordinate_checks=checked,stats=stats,results=results)
(ROOT/'data/test-results.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in metrics.items() if k not in ['results','stats']},indent=2))

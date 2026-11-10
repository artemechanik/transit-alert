import json
import sqlite3
import unittest
from pathlib import Path
from search import DB, ROOT, normalize, search, connect, text_rank
from rules import decide


class SearchTests(unittest.TestCase):
    def test_controls(self):
        expected={'ork':'Galeria Orkana','olimp':'Galeria Olimp','vivo':'VIVO! Lublin',
          'dworzec lublin':'Dworzec Lublin','uniwersytet medyczny':'Uniwersytet Medyczny w Lublinie',
          'ogrod saski':'Ogród Saski','szpital kliniczny nr 4':'Szpital Kliniczny nr 4',
          'centrum spotkania kultur':'Centrum Spotkania Kultur','pzl swidnik':'PZL-Świdnik'}
        for query,wanted in expected.items():
            with self.subTest(query=query):
                self.assertTrue(any(wanted.casefold() in x['name'].casefold() for x in search(query)),search(query))

    def test_diacritics(self):
        self.assertEqual([r['id'] for r in search('PZL Świdnik')],[r['id'] for r in search('pzl swidnik')])
        self.assertEqual(normalize('Łódź Żółć ĄĆĘŃÓŚŹŻ'),'lodz zolc acenoszz')

    def test_alias(self):
        self.assertTrue(any(r['name']=='Centrum Spotkania Kultur' for r in search('Teatr w Budowie')))
        self.assertTrue(any('Medyczny' in r['name'] for r in search('Akademia Medyczna w Lublinie')))
        self.assertTrue(any(r['name']=='VIVO! Lublin' for r in search('Tarasy Zamkowe')))
        self.assertTrue(any(r['name']=='Centrum Spotkania Kultur' for r in search('CSK')))
        self.assertTrue(any(r['name']=='Szpital Kliniczny nr 4' for r in search('SPSK4')))
        self.assertTrue(any('Medyczny' in r['name'] for r in search('UM Lublin')))
        self.assertFalse(any(r['name']=='Opera Lubelska' for r in search('centrum spotkania kultur')))

    def test_prefixes(self):
        self.assertEqual(search('ork')[0]['name'],'Galeria Orkana')
        self.assertTrue(any(x['name']=='Galeria Orkana' for x in search('gal ork')))
        self.assertTrue(any(x['name']=='Galeria Orkana' for x in search('ork gal')))

    def test_query_safety(self):
        self.assertEqual(search(''),[])
        self.assertLessEqual(len(search('"* OR ()')),10)
        for q in ['a'*201,'a\n','aa '*13]:
            with self.assertRaises(ValueError):search(q)
        for n in [0,51,True]:
            with self.assertRaises(ValueError):search('ork',n)
        search('" OR name:* - (vivo)')

    def test_text_before_relevance(self):
        self.assertLess(text_rank('galeria orkana','galeria orkana'),text_rank('inna galeria orkana','galeria orkana'))
        self.assertLess(text_rank('galeria orkana','galeria'),text_rank('inna galeria','galeria'))

    def test_no_duplicate_control(self):
        for query,name in [('vivo','VIVO! Lublin'),('centrum spotkania kultur','Centrum Spotkania Kultur'),('pzl','PZL-Świdnik')]:
            self.assertEqual(sum(x['name']==name for x in search(query,50)),1)
        with connect() as c:
            self.assertEqual({r[0] for r in c.execute("select name from features where poi_id=(select id from pois where name='VIVO! Lublin')")},{'VIVO! Lublin','VIVO Shopping Mall','Tarasy Zamkowe'})

    def test_offline(self):
        from unittest.mock import patch
        with patch('socket.socket', side_effect=AssertionError('Network forbidden')):
            self.assertTrue(search('ork'))
            self.assertTrue(search('csk'))

    def test_distinct_sites(self):
        from build import can_merge
        a={'name':'Uniwersytet Medyczny w Lublinie','category':'education','lon':22.5489,'lat':51.2483,'geometry_kind':'point'}
        b=dict(a,lon=22.5643,lat=51.262)
        self.assertFalse(can_merge(a,b))
        b=dict(a,name='Inny Uniwersytet',lon=22.54891)
        self.assertFalse(can_merge(a,b))
        a={'name':'VIVO! Lublin','category':'shopping','lon':22.5764,'lat':51.25017,'geometry_kind':'point'}
        self.assertTrue(can_merge(a,dict(a,name='Tarasy Zamkowe')))

    def test_nearby_sites_are_not_brands(self):
        from build import can_merge
        for category in ['industry','education','health']:
            a=dict(name='Ten Sam Zakład',category=category,lon=22.55,lat=51.25,geometry_kind='point')
            self.assertFalse(can_merge(a,dict(a,lon=22.5501)),category)
            self.assertFalse(can_merge(dict(a,site='site-a'),dict(a,site='site-b')),category)
            self.assertTrue(can_merge(dict(a,site='site-a'),dict(a,site='site-a')),category)
            self.assertFalse(can_merge(dict(a,site='site-a'),dict(a,site='site-a',lon=22.57)),category)
        area=dict(a,geometry_kind='area',geometry={'type':'Polygon','coordinates':[[[22.54,51.24],[22.56,51.24],[22.56,51.26],[22.54,51.26],[22.54,51.24]]]})
        self.assertTrue(can_merge(area,a))
        self.assertFalse(can_merge(area,dict(a,name='Inna Organizacja')))
        from build import can_join
        self.assertFalse(can_join([dict(a,site='site-a'),area],dict(a,site='site-b')))

    def test_audit_restorations_search(self):
        controls={'rap':'RAPA','verano':'VERANO GLOBAL','7r park':'7R Park Lublin East I',
          'elektrocieplownia wrot':'Elektrociepłownia Lublin-Wrotków','pcez':'PCEZ Świdnik',
          'lckziu':'LCKZiU','agrofiz':'Instytut Agrofizyki PAN','wsei':'WSEI — Projektowa 4',
          'womp':'WOMP — Nałęczowska 27','starost powiat swid':'Starostwo Powiatowe w Świdniku',
          'raben':'Raben Logistics Polska','filharm':'Filharmonia Lubelska',
          'lubelskie konfer':'Lubelskie Centrum Konferencyjne','bibliot lopac':'Wojewódzka Biblioteka Publiczna im. Hieronima Łopacińskiego',
          'allmed':'Allmedica — Tetmajera 21','mpwik':'MPWiK — Piłsudskiego 15'}
        for query,name in controls.items():
            with self.subTest(query=query):self.assertIn(name,[r['name'] for r in search(query,50)])
        for query,name in [('Verano Konwektory','VERANO GLOBAL'),('Higher School of Economics','WSEI — Projektowa 4'),
                           ('Lubelskie Centrum Kształcenia','LCKZiU'),('Powiatowe Centrum Edukacji','PCEZ Świdnik')]:
            self.assertIn(name,[r['name'] for r in search(query,50)])

    def test_audit_scoping_and_provenance(self):
        from curation import DECISIONS,override
        self.assertEqual(override('overture','unreviewed-id','RAPA'),{})
        with self.assertRaises(ValueError):override('overture','0e56884b-8bf5-4781-8b89-a8c8af711a3b','Renamed source')
        self.assertNotEqual(decide('Raben Logistics Polska','medical_service')[0],'include')
        sites={}
        with connect() as c:
            for key,r in DECISIONS.items():
                source,sid=key.split(':',1)
                features=c.execute('select poi_id,reason from features where source=? and source_id=?',(source,sid)).fetchall()
                if r['decision']!='include':self.assertEqual(features,[]);continue
                self.assertEqual(len(features),1,key)
                self.assertEqual(features[0]['reason'],r['reason'])
                sites.setdefault(r['site'],set()).add(features[0]['poi_id'])
            self.assertEqual(len(sites),16)
            self.assertTrue(all(len(ids)==1 for ids in sites.values()))
            self.assertEqual(len(set.union(*sites.values())),16)

    def test_audit_exclusions_and_bdot_review(self):
        audit=[json.loads(line) for line in (ROOT/'data/decisions.jsonl').read_text().splitlines()]
        by_name={r['name']:r for r in audit}
        self.assertEqual(by_name['Konfrontacje Teatralne']['decision'],'reject')
        self.assertEqual(by_name['Projekt Kultura Bogusław Byrski']['decision'],'review')
        self.assertFalse(search('Konfrontacje Teatralne'))
        self.assertFalse(search('Projekt Kultura'))
        pending=[r for r in audit if r['reason']=='campus_component_requires_site_review']
        self.assertEqual(len(pending),28)
        self.assertTrue(all(r['decision']=='review' for r in pending))
        with connect() as c:
            for r in pending:self.assertIsNone(c.execute("select id from features where source='bdot' and source_id=?",(r['source_id'],)).fetchone())
        from curation import education_building_decision
        self.assertEqual(education_building_decision('Uniwersytet Medyczny','inny budynek'),('education','review','campus_component_requires_site_review'))
        self.assertIsNone(education_building_decision('Uniwersytet Medyczny','szkoła wyższa'))

    def test_schema_and_provenance(self):
        with connect() as c:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
            self.assertEqual(c.execute('select count(*) from features f where not exists(select 1 from provenance p where p.feature_id=f.id)').fetchone()[0],0)
            self.assertEqual(c.execute("select count(*) from provenance where license='' or dataset='' ").fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from pois where arrival_lat is not null or arrival_lon is not null').fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from entrances').fetchone()[0],0)
            self.assertEqual(c.execute('select count(*) from pois where not(lat between 50 and 52 and lon between 22 and 23)').fetchone()[0],0)
            with self.assertRaises(sqlite3.OperationalError):c.execute("delete from pois")
            for raw, in c.execute("select raw_json from features where source='overture'"):
                self.assertNotEqual(json.loads(raw)['operating_status'],'permanently_closed')

    def test_boundaries(self):
        # Build dependency only; verify every destination against its recorded gmina, not bbox.
        from shapely.geometry import shape,Point
        bounds={f['properties']['JPT_KOD_JE'].replace('_',''):shape(f['geometry']) for f in json.loads((ROOT/'data/sources/boundary.json').read_text())['features']}
        self.assertEqual(len(bounds),16)
        with connect() as c:
            for r in c.execute('select * from pois'):self.assertTrue(bounds[r['terc']].covers(Point(r['lon'],r['lat'])),r['name'])

    def test_rejections(self):
        for name,cat in [('Fabryka Długich Włosów','personal_or_beauty_service'),('STS Zakłady Bukmacherskie','financial_service'),('Wyspa IQOS - Galeria Skende','shopping_mall'),('Zdrofit Lublin Galeria Gala','shopping_mall'),('Centrala w Lublinie - Aliplast Polska','b2b_service')]:
            self.assertNotEqual(decide(name,cat)[0],'include',name)
        # Low confidence is deliberately absent from exclusion rules.
        self.assertEqual(decide('Galeria Orkana','shopping_mall')[0],'include')




class PresentationTests(unittest.TestCase):
    def test_all_ten_groups(self):
        rules=json.loads((ROOT/'presentation-rules.json').read_text())
        self.assertEqual(len(rules),10)
        self.assertEqual({r['audit_group'] for r in rules if r['action']=='merge'},{1,2,3})
        self.assertEqual({r['audit_group'] for r in rules if r.get('labels')},{4,6})
        with connect() as c:
            for rule in rules:
                ids=[]
                for member in rule['members']:
                    found=set()
                    for key in member:
                        source,sid=key.split(':',1)
                        rows=c.execute('select poi_id from features where source=? and source_id=?',(source,sid)).fetchall()
                        self.assertEqual(len(rows),1,key)
                        found.add(rows[0][0])
                    self.assertEqual(len(found),1)
                    ids.append(next(iter(found)))
                if rule['action']=='merge':self.assertEqual(ids[0],ids[1])
                else:
                    self.assertNotEqual(ids[0],ids[1])
                    self.assertEqual([c.execute('select visible from search_presentations where poi_id=?',(pid,)).fetchone()[0] for pid in ids],[1,1] if rule.get('labels') else [1,0])
                    if rule.get('labels'):
                        self.assertEqual([c.execute('select name from pois where id=?',(pid,)).fetchone()[0] for pid in ids],rule['labels'])
                        continue
                    hidden_name=c.execute('select name from pois where id=?',(ids[1],)).fetchone()[0]
                    self.assertNotIn(ids[1],[r['id'] for r in search(hidden_name,50)])
            self.assertEqual(c.execute('select count(*) from features').fetchone()[0],542)
            self.assertEqual(c.execute('select count(*) from search_presentations where visible=0').fetchone()[0],5)

class AddressOverrideTests(unittest.TestCase):
    def test_curated_addresses_and_site_boundaries(self):
        curated=json.loads((ROOT/'address-overrides.json').read_text())
        with connect() as c:
            self.assertEqual(len(curated),c.execute('SELECT count(*) FROM address_overrides').fetchone()[0])
            for pid,r in curated.items():
                row=c.execute('SELECT address_line,locality,confidence,details_json FROM address_overrides WHERE poi_id=?',(pid,)).fetchone()
                self.assertEqual(tuple(row[:3]),(r['address_line'],r['locality'],'confirmed'))
                self.assertEqual(json.loads(row[3]),r)
                self.assertTrue(r['url'].startswith('local_knowledge:') if r['source']=='local_knowledge' else r['url'].startswith('https://'))
            self.assertEqual(c.execute("SELECT address_line FROM address_overrides WHERE poi_id='poi:81f12419d2966e9ba933'").fetchone()[0],'Działkowa 45')
            self.assertEqual(c.execute("SELECT address_line FROM address_overrides WHERE poi_id='poi:c13dd5d066d11f25638f'").fetchone()[0],'Wrotkowska 1')
            self.assertEqual(c.execute("SELECT address_line FROM address_overrides WHERE poi_id='poi:228e290fbc850db05464'").fetchone()[0],'ul. Energetyków 23')
            self.assertEqual(c.execute("SELECT count(*) FROM address_overrides WHERE source='local_knowledge'").fetchone()[0],28)
            for query in ['art bet','art bed']:
                self.assertTrue(any(x['id']=='poi:33f4b578e10e3774dec3' and x['name']=='Art-Bet Wytwórnia Betonu Sp. J.' for x in search(query,50)))
            self.assertEqual(c.execute("SELECT count(*) FROM pois WHERE category='industry'").fetchone()[0],74)

if __name__=='__main__':unittest.main()

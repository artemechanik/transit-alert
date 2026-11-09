"""Read-only mixed-search demonstration; no app server or frontend changes."""
import argparse
import csv
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path
from search import ROOT, normalize, search


def demo(q, prg=None):
    stops=[]
    with zipfile.ZipFile(ROOT/'data/sources/gtfs.zip') as z:
        for r in csv.DictReader(io.StringIO(z.read('stops.txt').decode('utf-8-sig'))):
            if any(w.startswith(normalize(q)) for w in normalize(r['stop_name']).split()) or normalize(r['stop_name']).startswith(normalize(q)):
                stops.append({'name':r['stop_name'],'id':r['stop_id']})
    addresses=[]
    if prg is not None:
        sys.dont_write_bytecode=True
        spec=importlib.util.spec_from_file_location('prg_demo',ROOT.parent/'local-geocoder/geocoder.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        c=module.connect(prg)
        try:addresses=module.search(c,q,4)['results']
        finally:c.close()
    # Separate groups: no global top-N that could displace PRG or stops.
    return {'query':q,'group_order':['stops','addresses','poi'],'stops':stops[:10],
            'addresses':addresses,'poi':search(q,4),
            'note':'Offline demonstration only; production planner unchanged. Group quotas require integration approval.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('query');p.add_argument('--prg',type=Path)
    a=p.parse_args();print(json.dumps(demo(a.query,a.prg),ensure_ascii=False,indent=2))

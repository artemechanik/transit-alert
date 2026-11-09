"""Measure query process RSS and latency; no build libraries imported."""
import hashlib
import json
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path
from search import ROOT, DB, search
from demo import demo

QUERIES=['ork','olimp','vivo','dworzec lublin','uniwersytet medyczny','ogrod saski',
         'szpital kliniczny nr 4','centrum spotkania kultur','csk','pzl swidnik',
         'sipma','aliplast','panattoni','intrograf','zzzzzzzz',
         'szpital','uniwersytet','politechnika','umcs','rap','verano','7r park','elektrocieplownia wrot','pcez','lckziu',
         'agrofiz','wsei','womp','starost powiat swid','raben','filharm',
         'lubelskie konfer','bibliot lopac','allmed','mpwik']


def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()


def main():
    prg=ROOT.parent/'local-geocoder/data/addresses.sqlite'
    before=sha(prg) if prg.exists() else None
    samples=[]; examples={}
    for q in QUERIES:
        t=time.perf_counter();result=search(q);samples.append((time.perf_counter()-t)*1000)
        examples[q]=[{'id':r['id'],'name':r['name'],'matched_name':r['matched_name'],'text_rank':r['text_rank']} for r in result[:5]]
    for _ in range(30):
        for q in QUERIES:
            t=time.perf_counter();search(q);samples.append((time.perf_counter()-t)*1000)
    # New Python process each time; OS filesystem cache is not flushed.
    fresh=[]
    for q in ['ork','szpital kliniczny nr 4','uniwersytet medyczny']:
        t=time.perf_counter()
        subprocess.run([sys.executable,str(ROOT/'search.py'),q],stdout=subprocess.DEVNULL,check=True)
        fresh.append((time.perf_counter()-t)*1000)
    # Capture runtime RSS before loading PRG for the mixed demonstration.
    runtime_rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024
    mixed=demo('ork',prg if prg.exists() else None)
    if prg.exists():assert sha(prg)==before,'PRG changed'
    data={'query_count':len(samples),'warm_p50_ms':round(statistics.median(samples),3),
      'warm_p95_ms':round(sorted(samples)[int(len(samples)*.95)],3),'max_ms':round(max(samples),3),
      'fresh_process_ms':list(map(lambda x:round(x,3),fresh)),
      'query_process_peak_rss_mib':round(runtime_rss,2),'sqlite_bytes':DB.stat().st_size,
      'prg_sha256_before':before,'prg_sha256_after':sha(prg) if prg.exists() else None,
      'notes':['Warm measurements include a new read-only connection per query.',
      'Fresh process includes Python startup; filesystem cache was not flushed.',
      'RSS is whole query Python process, not incremental SQLite memory. Build RSS is measured separately.',
      'No external calls during search; measurements are on this machine, not a Chromebook guarantee.']}
    (ROOT/'data/search-metrics.json').write_text(json.dumps(data,indent=2))
    (ROOT/'data/search-examples.json').write_text(json.dumps(examples,ensure_ascii=False,indent=2))
    (ROOT/'data/mixed-ork.json').write_text(json.dumps(mixed,ensure_ascii=False,indent=2))
    print(json.dumps(data,indent=2))


if __name__=='__main__':main()

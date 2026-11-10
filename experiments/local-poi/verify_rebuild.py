"""Rebuild from pinned local inputs into a temporary directory; compare bytes."""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from search import ROOT, DB


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    with tempfile.TemporaryDirectory(prefix='poi-rebuild-') as temp:
        output=Path(temp)/'poi.sqlite'
        subprocess.run([sys.executable,'-B',str(ROOT/'build.py'),'--output',str(output)],check=True)
        files={name:{'original':sha(ROOT/'data'/name),'rebuilt':sha(Path(temp)/name)}
               for name in ['poi.sqlite','decisions.jsonl','review.json']}
        identical=all(v['original']==v['rebuilt'] for v in files.values())
        result={'identical':identical,'files':files,'inputs':'sources.json + local source cache + rules + audit-overrides.json + presentation-rules.json + address-overrides.json'}
        (ROOT/'data/reproducibility.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))
        if not identical:raise SystemExit('Rebuild differs')


if __name__=='__main__':main()

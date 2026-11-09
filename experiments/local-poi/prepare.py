"""Populate a local source cache from the previous research; never downloads silently."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from search import ROOT


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache',type=Path,required=True,help='Directory containing the snapshot filenames from sources.json')
    p.add_argument('--destination',type=Path,default=ROOT/'data/sources')
    a=p.parse_args();manifest=json.loads((ROOT/'sources.json').read_text())
    # Validate every input before making any output.
    for f in manifest['files']:
        path=a.cache/f['file']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=f['sha256']:
            raise SystemExit('Missing or different pinned snapshot: '+str(path))
    a.destination.mkdir(parents=True,exist_ok=True)
    for f in manifest['files']:
        target=a.destination/f['file'];source=a.cache/f['file']
        if target.resolve()!=source.resolve():shutil.copyfile(source,target)
    (a.destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    print('Validated and prepared',len(manifest['files']),'local snapshots')


if __name__=='__main__':main()

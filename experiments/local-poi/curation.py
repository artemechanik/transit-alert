"""Source-ID-scoped decisions approved in the POI audit. No network."""
import json
from search import ROOT, normalize
DECISIONS = json.loads((ROOT/'audit-overrides.json').read_text())
def override(source, sid, name):
    record=DECISIONS.get(source+':'+sid,{})
    if record and record['expected_name']!=name:
        raise ValueError('Reviewed source name changed: '+source+':'+sid)
    return record

def education_building_decision(name, kind):
    # Generic university names do not identify a separate physical destination.
    if name.startswith(('Uniwersytet','Politechnika')) and 'szkola wyzsza' not in normalize(kind):
        return 'education','review','campus_component_requires_site_review'
    return None

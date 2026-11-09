# Source terms — snapshot 2026-11-08

These files preserve official texts and notices. Keep this directory with any distributed
catalogue, alongside `sources.json`. No single licence replaces the individual contributions.

| Contribution | Official terms / retained file | Handling |
|---|---|---|
| Overture, Meta, Microsoft, PinMeTo, Uberall, DAC, OpenTravel | https://cdla.dev/permissive-2-0/ — CDLA-Permissive-2.0.html | Use/modification/commercial use permitted; supply the agreement with shared data. No share-alike. |
| Foursquare contributions | https://www.apache.org/licenses/LICENSE-2.0.txt — Apache-2.0.txt | Preserve licence, applicable notices and modifications. No share-alike. |
| Foursquare NOTICE | https://opensource.foursquare.com/places-notice-txt/ — Foursquare-NOTICE.html | Full official page retained. For an API, expose NOTICE content prominently in API documentation. |
| AllThePlaces, Wikidata structured data | https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt — CC0-1.0.txt | No mandatory attribution or share-alike. |
| GUGiK BDOT10k | https://eli.gov.pl/api/acts/DU/2026/1389/text.pdf — PGiK-2026-1389.pdf | Articles 40a, 40c. Source acknowledgment in published work. `PL-PGiK-40a-40c` is a local identifier, not an SPDX licence name. |
| Overture per-provider attribution | https://docs.overturemaps.org/attribution/ — Overture-attribution.html | Retains the release-era attribution statement, including the Foursquare 2024 wording. The fetched upstream NOTICE page uses 2026. Both are preserved; do not overwrite either. |

Wikidata policy: https://www.wikidata.org/wiki/Wikidata:Licensing
BDOT official reuse statement: https://www.geoportal.gov.pl/pl/dane/baza-danych-obiektow-topograficznych-bdot10k/

Every imported Overture feature keeps **all** `sources[]` entries, including field-specific
Overture contributions. An AllThePlaces contribution does not make the entire feature CC0.
`provenance.details_json` preserves the original licence, provider, record ID, version,
property path, update timestamp and other supplied metadata.

BDOT feature source IDs, versions and geometries are kept separately. Wikidata names carry
QIDs and exact revisions in `names`; their pinned full source entities are in the source cache.
Wikidata names are CC0, as recorded in catalogue metadata. `local-curation` names identify
explicit transformations/initials in build.py; underlying source features remain attached.

No extracted photos, logos, Wikipedia prose, website descriptions or reviews are imported.
GTFS is only used to derive nearest-stop distances/IDs; the demo reads the local snapshot.
A public distribution of the GTFS source ZIP/demo would require a separate terms review.
This prototype's presence of that research cache does not assert a GTFS redistribution licence.

A future app/API integration needs a source/licence page and packaged licence texts;
no credit line is added to the production UI in this experiment. Avoid assuming that every
search response qualifies as CDLA's obligation-free computational “Results”.

"""Reviewable, conservative destination rules. Scores describe purpose, never observed demand."""
import re
from search import normalize

CATEGORY_RULES = {
 'airport': ('transport', 90, r'port lotniczy|lublin airport'),
 'shopping_mall': ('shopping', 80, r'galeria|centrum handlowe|shopping|\bvivo\b|\bskende\b|felicity|tarasy zamkowe|outlet cent|dom towarowy|diamentowa park|color park|mini.*galeria'),
 'farmers_market': ('shopping', 65, r'targ|rynek|gielda|market'),
 'market': ('shopping', 65, r'targ|rynek|gielda|market'),
 'hospital': ('health', 85, r'szpital|hospital|krwiodaw|instytut medycyny|centrum onkologii|uniwersyteckie centrum'),
 'college_university': ('education', 80, r'uniwersytet|university|politechnika|szkola wyzsza|akademia|college'),
 'high_school': ('education', 65, r'liceum|technikum|szkol|college'),
 'government_office': ('government', 75, r'urzad|starost|gmin|miasta|miasto|zus|krus|policj|wojew|skarbow|inspektorat|pracy|centrum pomocy|urz[eę]d'),
 'government_department': ('government', 75, r'urzad|starost|gmin|miasta|wojew|departament|inspektorat'),
 'courthouse': ('government', 80, r'sad '),
 'park': ('park', 60, r'\bpark\b|\bogrod\b|garden'),
 'national_park': ('park', 60, r'\bpark\b'),
 'stadium_arena': ('sport', 75, r'stadion|stadium|arena|hala|mosir|osir'),
 'sport_field': ('sport', 60, r'stadion|boisko|orlik|mosir|osir'),
 'museum': ('culture', 75, r'muze|museum|skansen|izba pamieci'),
 'theatre_venue': ('culture', 75, r'teatr|theat|opera|filharm|dom kultury|mok|centrum kultur'),
 'cultural_center': ('culture', 70, r'kultur|culture|mok|gok'),
 'movie_theater': ('culture', 65, r'kino|cinema|multikino'),
 'historic_site': ('landmark', 65, r'zamek|castle|brama|pomnik|palac|mauzoleum|majdanek|baszta|wieza|ruiny|cmentarz|synag|archikated|katedra|plac '),
 'public_transit_facility_or_service': ('transport', 90, r'dworzec|station|terminal|port lotniczy'),
 'travel_and_transportation': ('transport', 90, r'dworzec|stacja kolejowa|railway station|port lotniczy|lotnisko'),
}
# Exact source names: facility candidates grounded in the snapshot; no employee/shift claims.
EMPLOYERS = {
 'SIPMA', 'PZL-Świdnik', 'Centrala w Lublinie - Aliplast Polska', 'Aliplast Sp. z o.o.',
 'ABM Greiffenberger Polska', 'Intrograf', 'Stock Polska', 'Perła', 'Browar Perła',
 'Panattoni Park Lublin', 'Panattoni Park Lublin III', 'Centrum Dystrybucji Stokrotka Lublin',
 'Regionalny Park Przemysłowy Świdnik Sp z o.o.', 'TEMARED', 'NOYEN Sp. z o.o.',
 'BioMaxima S.A.', 'Kuźnia Matrycowa Sp. z o.o.', 'SMF Technology Poland Sp. z o.o.',
}
# Strong facility-name signals; manual review is still required for scale/current operation.
INDUSTRIAL = re.compile(r'\bfabryka\b|\bzaklady\b|centrum (dystrybucji|logistyczne)|park przemyslowy|strefa (ekonomiczna|przemyslowa)|\bcieplownia\b|\belektrocieplownia\b')
DENY = re.compile(r'komornik|kancelaria|samorzad|kolo naukowe|rekrutac|kariera|wydzial|katedra|klinika|poradnia|gabinet|biblioteka szkolna|przedszkol|oddzial|stowarzyszenie|fundacja|student|zlot |mistrzostwa|mlodziezowa rada')
SPECIAL = {'Spsk4': ('health', 85), 'Centre for the Meeting of Cultures in Lublin': ('culture', 80), 'Csk Lublin': ('culture', 80)}


def decide(name, category):
    n = normalize(name)
    if name in {'Lubelska Akademia IT', 'Botanik Park - Lublin', 'Gminny Ośrodek Kultury w Białej Podlaskiej', 'Kozłowiecki Park Krajobrazowy w obiektywie'}:
        return 'review', None, 0, 'name_or_location_does_not_establish_large_physical_destination'
    if name=='Uniwersytecki Szpital Dzieciecy w Lublinie':
        return 'review', None, 0, 'coordinates_disagree_with_other_childrens_hospital_records'
    if name in {'Centrala w Lublinie - Aliplast Polska', 'Aliplast Sp. z o.o.'}:
        return 'review', None, 0, 'point_in_city_centre_disagrees_with_factory_address_Moritza_3'
    if name in EMPLOYERS or (category in {'manufacturer', 'industrial_facility_or_service', 'b2b_transportation_and_storage_service', 'corporate_or_business_office'} and INDUSTRIAL.search(n)):
        return 'include', 'industry', 80, 'named_workplace_or_industrial_destination; scale_and_operation_unverified'
    reviewed = {'Lublin Plaza':('shopping',80), 'Pl 121 IKEA Lublin':('shopping',75),
        'E.Leclerc Turystyczna':('shopping',75), 'Hala Globus':('sport',75),
        'Aqua Lublin':('sport',75), 'Nowy Basen Olimpijski W Lublinie':('sport',75),
        'Basen UP':('sport',65), 'Basen przy Łabędziej. Centrum sportowo-rekreacyjne MOSiR':('sport',65),
        'Targi Lublin S.A.':('culture',80)}
    if name.strip() in reviewed:
        cat, score=reviewed[name.strip()]
        return 'include',cat,score,'reviewed_named_destination_despite_source_category'
    if name in SPECIAL:
        cat, score = SPECIAL[name]
        return 'include', cat, score, 'control_destination'
    if re.search(r'wyspa iqos|zdrofit|agencja pracy|mammografia|laboratorium|biuro karier|towarzystwo przyjaciol|katechetyka|european studies|architektura krajobrazu|studium praktycznej|zaklad farmakologii|mokradlowy|warzywa', n):
        return 'reject', None, 0, 'tenant_subunit_small_service_or_wrong_category'
    if DENY.search(n):
        return 'reject', None, 0, 'subunit_event_private_office_or_small_service'
    rule = CATEGORY_RULES.get(category)
    if rule and re.search(rule[2], n):
        return 'include', rule[0], rule[1], 'category_and_destination_name'
    if rule or category in {'manufacturer', 'industrial_facility_or_service', 'b2b_transportation_and_storage_service', 'specialized_medical_facility'}:
        return 'review', None, 0, 'category_alone_does_not_prove_destination_or_scale'
    return 'reject', None, 0, 'outside_destination_scope'

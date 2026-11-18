"""One-off coverage test: do free OSM-based geocoders know the neighborhood
for well-known spots around the world?  Polite: ~1 req/s to Nominatim.

For each point:
  1. Nominatim /reverse (zoom=18) -> the object at the point + address keys
  2. Nominatim /details on that object -> full address hierarchy, which tells
     us whether each sub-city place is a polygon (way/relation) or just a
     point (node) that Nominatim matched by proximity
  3. Photon /reverse -> district / locality fields (alternative OSM geocoder)

Usage:  pip install requests && python3 scripts/research/coverage_test.py out.csv
(~100 requests to the public Nominatim at 1/s, ~3 minutes. Results from
2026-11-18 are in docs/data/coverage-2026-11-18.csv.)
"""
import csv
import json
import sys
import time

import requests

UA = {"User-Agent": "wnit-research/0.1 (hobby project; one-off coverage test)"}
NOM = "https://nominatim.openstreetmap.org"
PHOTON = "https://photon.komoot.io"

# (region, city, lat, lon, expected neighborhood a local would say)
POINTS = [
    ("US", "Austin TX", 30.2468, -97.7501, "Bouldin Creek"),
    ("US", "Austin TX", 30.3060, -97.7290, "Hyde Park"),
    ("US", "Austin TX", 30.2600, -97.7130, "East Cesar Chavez"),
    ("US", "New York NY", 40.7140, -73.9566, "Williamsburg"),
    ("US", "New York NY", 40.7870, -73.9754, "Upper West Side"),
    ("US", "San Francisco CA", 37.7599, -122.4148, "Mission"),
    ("US", "Chicago IL", 41.9088, -87.6796, "Wicker Park"),
    ("US", "Los Angeles CA", 34.0869, -118.2702, "Silver Lake"),
    ("US", "Seattle WA", 47.6253, -122.3222, "Capitol Hill"),
    ("US", "Boston MA", 42.3097, -71.1151, "Jamaica Plain"),
    ("US", "Houston TX", 29.7457, -95.3910, "Montrose"),
    ("US", "Denver CO", 39.7605, -105.0115, "Highland"),
    ("US", "Atlanta GA", 33.7590, -84.3520, "Inman Park"),
    ("US", "Philadelphia PA", 39.9712, -75.1340, "Fishtown"),
    ("US", "Miami FL", 25.7663, -80.2190, "Little Havana"),
    ("US", "Minneapolis MN", 44.9485, -93.2980, "Uptown"),
    ("US", "Portland OR", 45.5590, -122.6450, "Alberta"),
    ("US", "Nashville TN", 36.1780, -86.7500, "East Nashville"),
    ("US", "Phoenix AZ", 33.4950, -111.9700, "Arcadia"),
    ("US", "Boise ID", 43.6300, -116.2050, "North End"),
    ("US", "Des Moines IA", 41.5930, -93.6340, "Sherman Hill"),
    ("US", "Albuquerque NM", 35.0800, -106.6180, "Nob Hill"),
    ("US", "Bozeman MT", 45.6793, -111.0386, "Downtown"),
    ("US", "Plano TX (suburb)", 33.0198, -96.6989, ""),
    ("US", "rural Iowa", 42.0000, -93.5000, ""),
    ("World", "Toronto CA", 43.6550, -79.4020, "Kensington Market"),
    ("World", "Vancouver CA", 49.2680, -123.1680, "Kitsilano"),
    ("World", "Mexico City MX", 19.4170, -99.1620, "Roma Norte"),
    ("World", "London UK", 51.5246, -0.0780, "Shoreditch"),
    ("World", "Dublin IE", 53.3220, -6.2650, "Rathmines"),
    ("World", "Paris FR", 48.8590, 2.3620, "Marais"),
    ("World", "Berlin DE", 52.4970, 13.4030, "Kreuzberg"),
    ("World", "Amsterdam NL", 52.3540, 4.8930, "De Pijp"),
    ("World", "Madrid ES", 40.4260, -3.7050, "Malasaña"),
    ("World", "Rome IT", 41.8890, 12.4700, "Trastevere"),
    ("World", "Istanbul TR", 40.9840, 29.0270, "Moda"),
    ("World", "Cairo EG", 30.0610, 31.2190, "Zamalek"),
    ("World", "Lagos NG", 6.5090, 3.3780, "Yaba"),
    ("World", "Nairobi KE", -1.2680, 36.8110, "Westlands"),
    ("World", "Cape Town ZA", -33.9380, 18.4720, "Observatory"),
    ("World", "Mumbai IN", 19.0600, 72.8300, "Bandra"),
    ("World", "Bangkok TH", 13.7320, 100.5830, "Khlong Tan Nuea"),
    ("World", "Jakarta ID", -6.2600, 106.8130, "Kemang"),
    ("World", "Shanghai CN", 31.2100, 121.4500, ""),
    ("World", "Seoul KR", 37.5560, 126.9230, "Hongdae"),
    ("World", "Tokyo JP", 35.6610, 139.6680, "Kitazawa"),
    ("World", "Sydney AU", -33.8860, 151.2110, "Surry Hills"),
    ("World", "Melbourne AU", -37.7980, 144.9780, "Fitzroy"),
    ("World", "Sao Paulo BR", -23.5530, -46.6910, "Vila Madalena"),
    ("World", "Buenos Aires AR", -34.5880, -58.4300, "Palermo"),
    ("World", "Lima PE", -12.1200, -77.0300, "Miraflores"),
]

SUBCITY_KEYS = [  # Nominatim address keys, most local first
    "neighbourhood", "quarter", "allotments", "residential", "city_block",
    "hamlet", "croft", "isolated_dwelling",
    "suburb", "borough", "city_district", "district", "subdivision",
]


def get(url, params, pause):
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=30)
            time.sleep(pause)
            if r.status_code == 200:
                return r.json()
            print(f"  HTTP {r.status_code} {url}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  error {e!r}", file=sys.stderr)
            time.sleep(3)
    return None


def main(out_csv):
    rows = []
    for region, city, lat, lon, expected in POINTS:
        rev = get(f"{NOM}/reverse", {"format": "jsonv2", "lat": lat, "lon": lon,
                                     "zoom": 18, "addressdetails": 1}, 1.1) or {}
        addr = rev.get("address", {})
        hood_key = next((k for k in SUBCITY_KEYS if k in addr), "")
        hood = addr.get(hood_key, "")
        all_sub = "; ".join(f"{k}={addr[k]}" for k in SUBCITY_KEYS if k in addr)

        # hierarchy w/ geometry type of each part
        sub_parts = []
        if rev.get("osm_type"):
            det = get(f"{NOM}/details", {
                "osmtype": rev["osm_type"][0].upper(), "osmid": rev["osm_id"],
                "class": rev.get("category"), "addressdetails": 1,
                "format": "json"}, 1.1) or {}
            for a in det.get("address", []):
                rank = a.get("rank_address") or 0
                if 17 <= rank <= 25 and a.get("isaddress"):
                    sub_parts.append((a.get("localname"), f"{a.get('class')}={a.get('type')}",
                                      a.get("osm_type") or "?", rank))
        polygon_parts = [p for p in sub_parts if p[2] in ("W", "R")]
        point_parts = [p for p in sub_parts if p[2] == "N"]

        ph = get(f"{PHOTON}/reverse", {"lat": lat, "lon": lon}, 0.6) or {}
        props = (ph.get("features") or [{}])[0].get("properties", {})
        photon_hood = props.get("district") or props.get("locality") or ""

        names_seen = " | ".join([hood, all_sub, photon_hood] + [p[0] or "" for p in sub_parts])
        match = bool(expected) and expected.lower() in names_seen.lower()
        row = {
            "region": region, "city": city, "lat": lat, "lon": lon,
            "expected": expected,
            "nominatim_hood": hood, "nominatim_key": hood_key,
            "nominatim_all_subcity": all_sub,
            "subcity_polygons": "; ".join(f"{n} ({t},{o})" for n, t, o, _ in polygon_parts),
            "subcity_points": "; ".join(f"{n} ({t})" for n, t, o, _ in point_parts),
            "photon_hood": photon_hood,
            "city_returned": addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality") or "",
            "expected_found": "yes" if match else ("n/a" if not expected else "no"),
        }
        rows.append(row)
        print(f"{city:22} | {hood_key:13} {hood[:28]:28} | poly:{len(polygon_parts)} pt:{len(point_parts)} | photon:{photon_hood[:22]:22} | exp:{row['expected_found']}")
        sys.stdout.flush()

    with open(out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main(sys.argv[1])

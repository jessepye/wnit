# WNIT research notes

_November 18, 2026. Prices and free tiers change, so re-check before you rely on one._

## TL;DR

- **Can this work anywhere on Earth? Yes**, with free OpenStreetMap (OSM) data. I tested 51 well-known spots on six continents, and OSM returned a sub-city name for 49 of them. The two blanks were a residential street in suburban Plano, TX and Iowa farmland.
- **America: yes.** Naming is good in big cities. The weak spot is outlines: about half of US neighborhoods exist in OSM only as a point, not an area. That makes the name a "nearest neighborhood" guess near borders, and leaves nothing to draw. There is extra free US polygon data (Zillow's 2017 set, city portals, Who's On First) to fill that gap later.
- **Austin-only: not needed.** Austin works fine: Hyde Park, Holly and South River City all came back. The city's own data isn't needed.
- **Cost for a hobby project: $0** to start. The MVP in this repo uses the free public Nominatim geocoder and free OpenFreeMap tiles, with no API keys. Paid options only matter if it gets popular. Even then, free tiers go a long way: LocationIQ gives 5,000 lookups a day and is a drop-in replacement.
- **Domain:** `wnit.com` has been registered since 2000 and is locked until 2033, so forget it. `wnit.website` and `wnit.ninja` look available, but their renewal prices are high. Better picks look available too: **`wnit.app`** (about $9 the first year, then $15/yr) and **`whatneighborhoodisthis.com`** (about $12/yr).
- **Similar sites exist**, in two kinds: SEO-style "what neighborhood am I in" utility pages that work globally, and polished apps that cover a single city (NYC, Chicago). Nothing I found does global + clean + phone + watch.

---

## 1. What already exists

| Name | What it is | Coverage | Data | Notes |
|---|---|---|---|---|
| [MapScaping "What Neighborhood Am I In?"](https://mapscaping.com/what-neighborhood-am-i-in/) | Web tool: use location or click the map; shows neighborhood, district, ZIP, city | Global | OpenStreetMap | Utility page on a GIS blog |
| [WhatIsMyElevation "What neighborhood am I in?"](https://whatismyelevation.com/what-is-my-neighborhood) | Web tool with map, address, ZIP, county (also a ["What barrio am I in?"](https://whatismyelevation.com/what-barrio-am-i-in) page) | Global | Not stated | One page on a multi-tool utility site |
| [GeoFan Neighborhood Finder](https://geofan.org/en/neighborhood-finder) | Web tool | Global | Mostly OpenStreetMap | |
| [What's My Hood?](https://www.producthunt.com/products/what-s-my-hood) | "Minimalist open source app" ([iOS](https://apps.apple.com/us/app/whats-my-hood/id1234734604) + web) | Unclear | Not stated | Closest in spirit to WNIT |
| [NYC Neighborhoods](https://chris-m-whong.medium.com/nyc-neighborhoods-a-mobile-reference-map-for-new-yorkers-on-the-go-ee1485a70fbe) (Chris Whong) | iOS / Android / web; map of every NYC neighborhood + "you're in" pill | NYC only | Started from Zillow's 2017 open data | Best-in-class single-city example |
| [Which Hood](https://apps.apple.com/app/id6761684567) | iOS, works offline (boundaries bundled), shows suburbs too | Chicago only | Bundled polygons | |
| [WhereAmINYC](https://apps.apple.com/mr/app/whereaminyc/id1605641684) | iOS, neighborhood + borough | NYC only | | |
| [Find My Hood 2](https://apps.apple.com/sb/app/find-my-hood-2/id6502993522) | iOS, "which neighborhood am I in while traveling", keeps a history | Not stated (pitched for travel) | Not stated | Has the history idea |
| ["What Neighborhood Is This"](https://bernalwood.com/2012/06/05/what-neighborhood-is-this-bernal-resident-creates-iphone-app-to-find-out/) (2012) | Web app at `isaa.ch/sf`, also showed distance to the nearest adjacent neighborhood ([Mission Local](https://missionlocal.org/2012/06/what-neighborhood-am-i-in/)) | San Francisco only | Dave Schweisguth's SF boundaries | **Same name as WNIT**, 14 years earlier |
| [What Hood Is This](https://codeforphilly.org/projects/What_Hood_Is_This) (Code for Philly) | Civic hack | Philadelphia | Philadelphia neighborhood boundaries | |
| [Hoodmaps](https://www.6sqft.com/crowd-sourced-maps-show-where-tourists-and-hipsters-land-in-every-big-city/) (Pieter Levels) | Crowdsourced paint-the-map stereotypes ("hipsters", "tourists") | ~2,000 cities | Crowdsourced | Proof people love drawing their city |
| [Click That 'Hood](https://github.com/codeforamerica/click_that_hood/wiki/How-to-add-a-city-to-Click-That-%E2%80%99Hood) (Code for America) | Quiz game: find the neighborhood on the map | Many cities, GeoJSON per city | City GeoJSON files | Its data folder is a handy polygon source |
| [Bostonography](https://bostonography.com/2015/map-your-neighborhood-again/), DNAinfo NYC/Chicago (2015) | "Draw your neighborhood" crowdsourcing | Single cities | Crowdsourced | DNAinfo is gone; [Chicago results survive on GitHub](https://awesome.ecosyste.ms/projects/github.com%2Fpjsier%2Fdnainfo_neighborhoods) |
| City "find your neighborhood" pages | e.g. Iowa City, Waterloo ON, Fargo | One city each | Official | Authoritative, but one city at a time |

**About "wnaii":** I couldn't find any trace of a site by that name in search results. However, `wnaii.com` is registered (since 2013-05-16, through Cloudflare, renewed until 2027-05-16), so the owner still holds the domain and the site is just broken or parked. If you send me the old URL or remember who made it, I can dig further.

**Where WNIT can stand out:** global coverage, no ads, fast, mobile-first, a neighborhood *outline* (not just a name), and eventually phone/watch glances. Later, a crowdsourced "what do *you* call this?" layer, which is the thing Bostonography, DNAinfo and Hoodmaps showed people enjoy.

---

## 2. Data sources

### Free and open

| Source | Coverage | Outlines? | Cost / limits | License | Verdict |
|---|---|---|---|---|---|
| **OpenStreetMap via public [Nominatim](https://nominatim.org/)** | Global | Often (see §3) | Free; [usage policy](https://operations.osmfoundation.org/policies/nominatim/): max 1 req/s **for the whole app**, attribution, no search-as-you-type, cache results | ODbL (share-alike for the data) | **Used by the MVP.** Fine for a hobby site; move to a cache/own server if traffic grows |
| OSM via [Photon](https://photon.komoot.io/) (komoot) | Global | No (points) | Free, "be fair" | ODbL | Good for search-as-you-type; its `district` field sometimes has the more colloquial name (Capitol Hill, Nob Hill, Le Marais) |
| Self-hosted Nominatim / Photon | Global or a country | Same as OSM | A server: small for one country, big for the planet | ODbL | When the public server isn't enough |
| [Overture Maps](https://docs.overturemaps.org/guides/divisions) `divisions` | Global | Some (`division_area`) | Free GeoParquet downloads | ODbL (OSM-derived) | Has `macrohood` / `neighborhood` / `microhood` subtypes, but its own docs call sub-city coverage "often spotty". Good raw material for the outline map |
| [Who's On First](https://whosonfirst.org/download) | Global | Yes, for many cities (Quattroshapes, Zetashapes, city data) | Free per-country downloads ([also via geocode.earth](https://geocode.earth/data/)) | Mostly CC-BY, varies per source ([licenses](https://whosonfirst.org/docs/licenses/)) | Best open source of neighborhood *polygons*, with macrohood/neighbourhood/microhood levels. Ex-Mapzen, still maintained, slower updates |
| [GeoNames](https://www.geonames.org/export/JSON-webservices.html) | Global | No (`PPLX` points) | Free account | CC-BY | Points only. Fallback for names |
| [Zillow neighborhoods (2017)](https://catalog.data.gov/dataset/neighborhoods-us-2017-zillow-segs9) | US: ~17,000 neighborhoods in 650+ cities | Yes | Free | Creative Commons (state files say CC BY-SA 3.0); credit Zillow | Frozen in 2017 but still the best free nationwide US polygon set. Mirrors: [zeke/hoods](https://github.com/zeke/hoods), [staeco/neighborhood-boundaries](https://github.com/staeco/neighborhood-boundaries) |
| City open-data portals | One city each | Yes (official) | Free | Varies | Austin, NYC, Chicago, SF, Seattle and others publish official boundaries |

### Free tiers of commercial geocoders (all return a "neighborhood"-type field)

| Service | Free allowance | Catch |
|---|---|---|
| [Google Geocoding](https://developers.google.com/maps/billing-and-pricing/march-2025) | 10,000 requests/month (since March 2025), then about $5 per 1,000 | Needs a billing account. [2024 terms](https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20240522) allow use without a Google map; older terms didn't, so re-check |
| [Mapbox Geocoding](https://mapbox.com/geocoding) | 100,000 requests/month ("temporary" mode) | Can't store results ([temporary vs permanent](https://docs.mapbox.com/help/dive-deeper/understand-temporary-vs-permanent-geocoding/)); [reportedly](https://geocod.io/geocodio-vs-mapbox-geocoding-comparison) must be shown on a Mapbox map |
| [Apple MapKit JS](https://developer.apple.com/maps/web/) | 25,000 service calls/day + 250,000 map views/day | Needs the $99/yr Apple Developer Program. In an iOS app, `CLGeocoder` (`subLocality`) is free on-device |
| [HERE](https://developers.here.com/plans) | 30,000 geocodes/month (Base plan) | Some third-party sites say 250k; HERE's own page said 30k |
| [Esri ArcGIS Location Platform](https://location.arcgis.com/pricing/) | 20,000 geocodes/month | Storing results costs extra |
| [LocationIQ](https://locationiq.com/pricing) | 5,000 requests/day (2 req/s) | OSM data with a Nominatim-compatible API, so it's a drop-in swap for the MVP |
| [Geoapify](https://www.geoapify.com/pricing/) | 3,000 credits/day | OSM-based, attribution required |
| [Stadia Maps](https://docs.stadiamaps.com/limits) | 200,000 credits/month | **Non-commercial only** on the free plan |
| [Radar](https://radar.com/pricing?type=consumer) | Unclear: old pages say 100k/month free, the current pricing page says no free tier | |

Android's built-in `Geocoder` (`Address.getSubLocality()`) is also free in native Android apps. On the phone itself, you don't need any of the above.

### Paid datasets (if you ever want "best possible US")

- [SimpleMaps US Neighborhoods](https://simplemaps.com/data/us-neighborhoods): free Basic tier (25 largest cities, CSV, link-back required); Pro is $499 (665 cities), Comprehensive $2,999 with shapes ([pricing](https://simplemaps.com/data/pricing)). You can't redistribute the raw file, but it can power a public app.
- [Precisely Neighborhood Boundaries](https://www.precisely.com/data-guide/products/neighborhood-boundaries) (formerly Maponics): roughly 100k–133k neighborhoods, 925 metros, 80–90+ countries, with macro/sub-neighborhood levels. Enterprise quote only. Overkill for a hobby.

---

## 3. Coverage test: what OSM actually returns

**Method.** For 51 spots in 50 cities (25 US, 26 elsewhere), I sent the public Nominatim one reverse lookup at street level. I then read the full address hierarchy from Nominatim's details endpoint to see which levels are real areas (polygons) and which are only points. I also asked Photon. The script is [`scripts/research/coverage_test.py`](../scripts/research/coverage_test.py) and the raw results are in [`docs/data/coverage-2026-11-18.csv`](data/coverage-2026-11-18.csv). The "what a local might say" column is my own guess, and a few of my guesses were off. Example: the first Austin point is just east of South Congress, which really is South River City.

**Results.**

| | US (25 spots) | Rest of world (26 spots) |
|---|---|---|
| Got a sub-city name | **23** (misses: a Plano suburb, rural Iowa) | **26** |
| Some sub-city level has an outline polygon | **13** | **24** |
| Matched my "local" guess somewhere in the answer | 17 of 23 | 20 of 25 (4 of the 5 misses were the right place, written in the local script) |

| Region | Place: what a local might say | OSM / Nominatim answer | Outline in OSM? | Photon answer |
|---|---|---|---|---|
| US | Austin TX: Bouldin Creek | neighbourhood=South River City | point only | South River City |
| US | Austin TX: Hyde Park | neighbourhood=Hyde Park | point only | Hyde Park |
| US | Austin TX: East Cesar Chavez | neighbourhood=Holly | yes | Paul O. Simms |
| US | New York NY: Williamsburg | quarter=Williamsburg · suburb=Brooklyn | yes | Brooklyn |
| US | New York NY: Upper West Side | neighbourhood=Manhattan Community Board 7 · quarter=Upper West Side · suburb=Manhattan | yes | Manhattan |
| US | San Francisco CA: Mission | suburb=Mission | point only | Mission |
| US | Chicago IL: Wicker Park | quarter=Wicker Park · suburb=West Town | yes | West Town |
| US | Los Angeles CA: Silver Lake | quarter=Silver Lake · suburb=Echo Park | point only | Echo Park |
| US | Seattle WA: Capitol Hill | suburb=Madison Valley | point only | Capitol Hill |
| US | Boston MA: Jamaica Plain | suburb=Jamaica Plain | yes | Jamaica Plain |
| US | Houston TX: Montrose | neighbourhood=Hyde Park · suburb=Montrose | yes | Montrose |
| US | Denver CO: Highland | neighbourhood=Lower Highland · suburb=Highland | yes | Highland |
| US | Atlanta GA: Inman Park | neighbourhood=Little Five Points | point only | – |
| US | Philadelphia PA: Fishtown | suburb=River Wards | yes | North Philadelphia |
| US | Miami FL: Little Havana | hamlet=Latin Quarter | point only | Latin Quarter |
| US | Minneapolis MN: Uptown | neighbourhood=Lowry Hill East · quarter=Uptown · suburb=Bde Maka Ska-Isles | yes | Bde Maka Ska-Isles |
| US | Portland OR: Alberta | neighbourhood=Alberta · suburb=Vernon | yes | Vernon |
| US | Nashville TN: East Nashville | suburb=East Nashville | point only | East Nashville |
| US | Phoenix AZ: Arcadia | quarter=Arcadia · suburb=Camelback East | yes | Camelback East |
| US | Boise ID: North End | residential=Brumback's Addition · suburb=North End | yes | North End |
| US | Des Moines IA: Sherman Hill | neighbourhood=Good Park | point only | Cheatom Park |
| US | Albuquerque NM: Nob Hill | residential=Southeast Heights4350 · suburb=Nob Hill | yes | Nob Hill |
| US | Bozeman MT: Downtown | neighbourhood=Downtown | point only | – |
| US | Plano TX (suburb) | **none** (city only) | – | – |
| US | rural Iowa | **none** (town only) | – | – |
| World | Toronto: Kensington Market | neighbourhood=Kensington Market · quarter=Downtown | yes | University—Rosedale |
| World | Vancouver: Kitsilano | suburb=Kitsilano | yes | Kitsilano |
| World | Mexico City: Roma Norte | neighbourhood=Roma Norte · suburb=Roma · borough=Cuauhtémoc | yes | Ciudad de México |
| World | London: Shoreditch | suburb=Shoreditch · city_district=London Borough of Hackney | yes | Shoreditch |
| World | Dublin: Rathmines | city_district=Rathmines West C Ward 1986 | yes | Rathmines West C Ward 1986 |
| World | Paris: Le Marais | city_block=Quartier des Archives · suburb=Paris 3e Arrondissement | yes | Le Marais |
| World | Berlin: Kreuzberg | quarter=Luisenstadt · suburb=Kreuzberg · borough=Friedrichshain-Kreuzberg | yes | Kreuzberg |
| World | Amsterdam: De Pijp | neighbourhood=Oude Pijp · suburb=Zuid | yes | Zuid |
| World | Madrid: Malasaña | neighbourhood=Malasaña · quarter=Universidad · city_district=Centro | yes | Centro |
| World | Rome: Trastevere | neighbourhood=Trastevere · suburb=Municipio Roma I | yes | Municipio Roma I |
| World | Istanbul: Moda | quarter=Moda · suburb=Caferağa Mahallesi | yes | Caferağa |
| World | Cairo: Zamalek | neighbourhood=الجبلايه · suburb=الزمالك (= Zamalek) | yes | الزمالك |
| World | Lagos: Yaba | suburb=Yaba | point only | Yaba |
| World | Nairobi: Westlands | neighbourhood=Highridge location · suburb=Highridge division · city_district=Westlands | yes | Highridge division |
| World | Cape Town: Observatory | suburb=Observatory | yes | Observatory |
| World | Mumbai: Bandra | neighbourhood=Adarsh Nagar · suburb=Khar · city_district=Mumbai Zone 3 | yes | Bandra West |
| World | Bangkok: Khlong Tan Nuea | quarter=แขวงคลองตันเหนือ (= Khlong Tan Nuea) · suburb=เขตวัฒนา | yes | วัฒนา |
| World | Jakarta: Kemang | city_block=RW 05 · suburb=Mampang Prapatan · city_district=Jakarta Selatan | yes | Mampang Prapatan |
| World | Shanghai: (no guess) | quarter=小木桥 · suburb=天平路街道 (Tianping Road Subdistrict) | yes | 天平路街道 |
| World | Seoul: Hongdae | neighbourhood=홍대거리 (Hongdae Street) · quarter=동교동 · suburb=서교동 | yes | 서교동 |
| World | Tokyo: Kitazawa | neighbourhood=北沢二丁目 · quarter=北沢 (= Kitazawa) | yes | 世田谷区 |
| World | Sydney: Surry Hills | neighbourhood=Strawberry Hills · suburb=Surry Hills | yes | Surry Hills |
| World | Melbourne: Fitzroy | suburb=Fitzroy | yes | Fitzroy |
| World | São Paulo: Vila Madalena | suburb=Vila Madalena | yes | Vila Madalena |
| World | Buenos Aires: Palermo | neighbourhood=Palermo Soho · suburb=Palermo | yes | Palermo |
| World | Lima: Miraflores | suburb=Miraflores | point only | Miraflores |

**What I learned (and built into `src/hood.js`):**

1. **Names come in several levels.** For example, Lowry Hill East (official) sits inside Uptown (what people say), inside Bde Maka Ska-Isles (planning community). So the app shows the most local good name big, with the broader ones under it ("in Kreuzberg · Friedrichshain-Kreuzberg").
2. **Admin codes need demoting.** OSM also returns "Manhattan Community Board 7", "RW 05", "Mumbai Zone 3", "Municipio Roma I", "Kitazawa 2" (a chōme block) and subdivision plats like "Brumback's Addition". `describePlace()` pushes these down so "Upper West Side", "North End" and "Kitazawa" win.
3. **Language matters.** Without a language preference you get الزمالك and 北沢. The app sends the browser's languages (`accept-language`), and with English you get "Zamalek" and "Kitazawa" (checked live).
4. **US neighborhoods are often only a point.** Nominatim assigns them by distance, so near borders it can be wrong. Seattle's Capitol Hill came back as "Madison Valley" at street level, while Photon and Nominatim's neighbourhood-level lookup both said Capitol Hill. This is the main quality gap to fix with real polygons: Zillow, Who's On First, city data, or crowdsourcing.
5. **Suburbs and small towns often have nothing.** The app then says so, shows the city, and links to OSM's "add a note" so locals can fix it.

---

## 4. Domains

I checked these on Nov 18, 2026: DNS NS records via Google's DNS-over-HTTPS, plus Verisign RDAP for `.com`. Prices are [Porkbun](https://porkbun.com/)'s current first-year / renewal prices. "Looks available" means the name doesn't exist in DNS. Confirm at a registrar: a few short names in new TLDs carry "premium" prices.

| Domain | Status | First year / renewal |
|---|---|---|
| wnit.com | **Taken**: registered 2000-03-19 (Tucows), locked, expires 2033 | – |
| wnit.net, wnit.org, wnit.io, wnit.live | Taken | – |
| wnit.xyz | Taken (parked at Afternic, i.e. for sale on the aftermarket) | – |
| **wnit.app** | Looks available | $8.75 / $14.93 |
| wnit.dev | Looks available | $8.75 / $12.87 |
| wnit.website | Looks available | $1.96 / **$21.11** |
| wnit.ninja | Looks available | $5.66 / **$28.32** |
| wnit.fyi | Looks available | $5.66 / $5.66 (cheapest to keep) |
| wnit.city | Looks available | $4.63 / $26.26 |
| wnit.co | Looks available | $15.76 / $31.20 |
| wnit.me | Looks available | $17.27 / $17.27 |
| wnit.place, wnit.zone, wnit.today, wnit.lol, wnit.wtf, wnit.world, wnit.earth, wnit.info, wnit.site, wnit.online | Look available | $1.54–$20 first year, $16–38 renewal |
| **whatneighborhoodisthis.com** | Looks available | $11.81 / $11.81 |
| whatneighborhood.app | Looks available | $8.75 / $14.93 |
| whatneighborhood.is, whathood.is, thishood.is | Look available | `.is` is sold by ISNIC, not Porkbun; price not checked |
| whatsmyhood.com | Taken (since 2014) | – |
| wnaii.com | Taken (since 2013, still renewed) | – |

**My pick:** `wnit.app` as the short, typeable name (and it reads like an app). Optionally add `whatneighborhoodisthis.com` (about $12/yr), because that's literally what people type into Google. It can redirect to the app. Skip `.website` and `.ninja`: cheap the first year, $21–28/yr after.

**Naming heads-up:** "WNIT" is also a PBS station in Indiana (wnit.org) and the Women's National Invitation Tournament (basketball). That doesn't block you, but searching "WNIT" will mostly show basketball, which is another reason to own the spelled-out .com.

---

## 5. Comparing sources on the same spot (added in v0.2)

Since "neighborhood" is a fuzzy idea, the app now shows what each source says, and the "?" panel explains its pick. These are live answers from Nov 18, 2026:

| Spot | OSM · Nominatim | OSM · Photon | Zillow (2015) | Esri | Best guess |
|---|---|---|---|---|---|
| Austin, Hyde Park | Hyde Park | Hyde Park | Hyde Park ✏️ | Hyde Park | **Hyde Park** (Zillow outline) |
| Seattle, E Roy St | Madison Valley | Madison Valley (district: Capitol Hill) | Capitol Hill ✏️ | Broadway | **Capitol Hill** (OSM only has points here, Zillow has a boundary) |
| Chicago, Wicker Park | Wicker Park | (not tested) | West Town ✏️ | (not tested) | **Wicker Park**, in West Town (names agree, so keep OSM's more local one) |
| Berlin, Prinzenstraße | Luisenstadt ✏️ | Tempelhofer Vorstadt (district: Kreuzberg) | – | Kreuzberg | **Luisenstadt** |
| Tokyo, Shimokitazawa | Kitazawa 2 → Kitazawa | Kitazawa 2 → Setagaya (the ward) | – | "2" → Kitazawa | **Kitazawa** (block numbers skipped) |
| Texas panhandle ranchland | Tascosa (a ghost town by proximity) | nothing | – | Vega (postal town) | **Oldham County**, near Tascosa ✏️ |
| Pacific, 5°N 140°W | nothing | nothing | – | Pacific Ocean | **North Pacific Ocean** (IHO) |
| Gulf of Mexico, 25°N 90°W | nothing | nothing | – | **"Gulf of America"** | **Gulf of Mexico** (IHO) |
| Lake Michigan, mid-lake | Michigan (state) | nothing | – | Oceana County | **Michigan** (no source names the lake yet) |

✏️ = an outline is drawn. Lessons:

- **In / near matters.** Out in the country, OSM and Esri both name a town that's miles away. WNIT checks whether that town's boundary actually contains the pin; if not, it names the county and says "near Tascosa". The same lookup returns the county outline.
- **Zillow fixes the US's biggest gap.** OSM often marks US neighborhoods only as points. Zillow's 2015 boundaries (151 cities) give real outlines and caught Seattle's Capitol Hill. Where Zillow is coarser (Chicago's "West Town"), the best guess keeps OSM's more local name inside it.
- **Even oceans are political.** Esri now says "Gulf of America", and the IHO sea areas say "Gulf of Mexico". The comparison makes that visible instead of hiding it.

Sources considered and skipped for now:

- **BigDataCloud's** free API may only be used for the device's own current location, not a draggable pin ([fair-use policy](https://www.bigdatacloud.com/support/fair-use-policy-for-free-client-side-reverse-geocoding-api)).
- **GeoNames** needs a username baked into the page.
- **Zillow's 2017 release** (about 17k neighborhoods, 650+ cities) sits on an EPA server under conflicting licenses (CC0 on data.gov, CC BY-NC on the mirror). The 2015 set is clean CC BY-SA, so we ship that.
- **Esri** works without a key, but Esri's docs are ambiguous about anonymous use ([reverseGeocode docs](https://developers.arcgis.com/rest/geocode/api-reference/geocoding-reverse-geocode.htm)), so it's labeled experimental and only called when you pick it or open the comparison.
- **Sea names:** the [IHO Sea Areas](https://www.marineregions.org/) arrive via the [`oceans-seas.geojson`](https://github.com/alvinometric/oceans-seas.geojson) package (CC BY 4.0). Lakes aren't covered yet.

### v0.4: the names on the map are the names people use

Testing the live site turned up two odd defaults:

- **Mueller, Austin → "Rmma".** Zillow's Austin neighborhoods are the City's planning areas, and this one is named after the old *Robert Mueller Municipal Airport*. OpenStreetMap says "Mueller Community".
- **Third Ward, Houston → "Southeast".** OpenStreetMap does say "Third Ward", but WNIT threw it away because a rule treated any name with "ward" in it as an administrative code (fixed). The best guess then trusted Zillow's coarse "Southeast".

The names you'd actually say were already on screen: the basemap's labels. They are OpenStreetMap place points (`place=neighbourhood/quarter/suburb`) inside OpenFreeMap's vector tiles. WNIT now reads them from the same tiles the map draws, and the label nearest the pin wins; suburb-sized labels count as a bit closer. Nearest labels in 13 cities:

| Spot | Nearest map label |
|---|---|
| Mueller, Austin | Mueller Community (410 m) |
| Third Ward, Houston | Third Ward (140 m) |
| E Roy St, Seattle | Capitol Hill (330 m), not "Madison Valley" |
| Hyde Park, Austin | Hyde Park (220 m) |
| Chicago | Wicker Park |
| NYC | Upper West Side |
| Berlin | Kreuzberg, not the historic "Luisenstadt" |
| Paris | Le Marais |
| Tokyo | Kitazawa (block numbers skipped) |
| London | Shoreditch |
| Mexico City | Colonia Roma Norte, in Roma |
| San Francisco | Mission District |
| South Congress, Austin | South River City |

Outlines still come from OSM or Zillow boundaries with the same name. When only a differently named boundary surrounds the pin, it's drawn as a labeled stand-in ("Zillow's boundary, which it calls “Rmma”"). The catch: labels are points, so near the line between two neighborhoods the nearest label can be the neighbor's.

## 6. Recommendation

1. **Ship the MVP as-is** on GitHub Pages (free, HTTPS, custom domain). It uses only free, keyless OSM services and covers the planet.
2. **When traffic grows** past a handful of people at once, add a tiny caching API (a Cloudflare Worker) between the app and Nominatim, or switch `baseUrl` to LocationIQ (Nominatim-compatible, 5k/day free). The same API then serves the phone and watch apps.
3. **For the "visual map of neighborhoods"**, build neighborhood vector tiles (PMTiles) from OSM/Overture polygons + Who's On First + Zillow 2017 (US). Then the app can draw every neighborhood and do point-in-polygon locally, with no geocoder calls at all.

See [ROADMAP.md](ROADMAP.md) for the step-by-step plan, including iOS/Android and the Garmin + Galaxy Watch options.

# WNIT roadmap

## Where things stand

**v0.1, the MVP:** open the page and it asks for your location, drops a pin, and says **"You're in Hyde Park · Austin, Texas"**. You can drag the pin, tap the map, search, share a link, and use dark mode. Outlines appear where OpenStreetMap has them, and a "Wrong? Tell OSM" link goes to OpenStreetMap.

**v0.2, "neighborhood is messy":**

- **Always an answer:** neighborhood → the town you're *in* → the county ("near Tascosa") → state → country → ocean or sea (IHO sea areas).
- **"?" panel:** why this name, every level the spot belongs to, and what each of 5 sources says (best guess, OSM Nominatim, OSM Photon, Zillow, Esri). Tap one to switch; the choice is remembered and shareable with `?source=`.
- **More outlines:** Zillow's 2015 boundaries for 6,957 neighborhoods in 151 US cities ship with the site. Towns and counties get outlined when they're the answer.

## Phase 1: put it online (an evening, about $10–15)

1. Merge this branch into `main`.
2. In the GitHub repo, go to **Settings → Pages → Deploy from a branch → `main` / root**. It's then live at `https://jessepye.github.io/wnit/`.
3. Buy the domain (my pick is `wnit.app`; see [RESEARCH.md](RESEARCH.md#4-domains)). Add a `CNAME` file containing the domain. At the registrar, create:
   - apex `A` records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `www` `CNAME` → `jessepye.github.io`

   Then tick **Enforce HTTPS**. `.app` only works over HTTPS, and GitHub Pages issues the certificate for you.
4. Try it on your phone while walking around. That's the real test.

## Phase 2: small web upgrades

- **Follow-me mode** (`watchPosition`). Re-check only after moving ~75 m and at most every ~10 s, to stay polite to the free geocoder. Toast "You just entered Montrose".
- **"Hoods I've been in"** history, kept on the device (`localStorage`).
- **PWA offline shell** (service worker), so it opens instantly and can be installed. The manifest and icons are already in place.
- **Search-as-you-type** using Photon, which allows it. The public Nominatim forbids autocomplete.
- **Lakes:** add Natural Earth's public-domain lakes, so mid–Lake Michigan says "Lake Michigan" instead of "Michigan".
- **More outlines:**
  - Who's On First neighbourhood polygons (global, CC BY)
  - Overpass `is_in`, which lists *every* OSM area containing the pin, not just the nearest point
  - the 2017 Zillow set, once its license is clear
- **"Best guess" tuning:** use the "?" comparisons you collect to decide which source should win where. A small "this one's right" button could log your vote locally.

## Phase 3: a tiny API (when traffic or the apps need it)

**Built (v0.3): the lookup cache in `server/`.** It runs on AWS (Lambda + DynamoDB, deploy with SAM; see [server/README.md](../server/README.md)) instead of a Cloudflare Worker, so this phase doubles as AWS practice. Still to do here: the compact `/v1/hood` answer for watches. The notes below are the original plan.

Why: Nominatim's 1 request/second limit applies to the whole app, not per user. A shared cache helps everyone, gives one place to merge better data, and lets watches get a tiny JSON answer.

- `GET /v1/hood?lat=30.306&lon=-97.729` returns `{"neighborhood":"Hyde Park","broader":[],"settlement":"Austin","region":"Texas","country":"United States","outline":true}`
- Run it as a **Cloudflare Worker** with its cache. The free plan allows 100k requests/day.
- `src/hood.js` is plain JavaScript with no browser code, so the same naming rules run in the Worker unchanged.
- Upstream: the public Nominatim with a real User-Agent, LocationIQ's free tier (Nominatim-compatible, 5k/day) as overflow, and later our own polygon index from Phase 4.

## Phase 4: the visual map of neighborhoods

The goal: see every neighborhood drawn and labeled, tap any of them, and look it up instantly and offline, with no geocoder at all.

1. **Collect polygons** in a monthly GitHub Action:
   - OSM areas tagged `place=neighbourhood|quarter|suburb` plus city sub-district boundaries (`admin_level` 9–10). Get them from Geofabrik extracts, or from Overture's `division_area` (`neighborhood` / `macrohood` / `microhood`) with DuckDB.
   - US gap-fillers: Zillow 2017 (about 17k US neighborhoods, CC BY-SA), Who's On First neighbourhoods, city open-data portals.
   - Neighborhoods that are only a point in OSM get an approximate area: Voronoi cells clipped to the city limits, drawn dashed and labeled "approximate".
2. **Merge** by name and overlap, then tile with `tippecanoe` into one **PMTiles** file.
3. **Host** it on Cloudflare R2 (10 GB free, no bandwidth fees) or GitHub Releases. MapLibre reads PMTiles directly.
4. **In the app:** draw all neighborhoods, and do the point-in-polygon check locally (`pointInGeometry()` already exists). Fall back to Nominatim where we have no polygon.
5. **Licensing:** OSM-derived tiles are ODbL (share-alike), so publish them openly with credit. Zillow-derived data is CC BY-SA. Keep a sources page.
6. **Later, crowdsourcing:** a "what do *you* call this spot?" vote, like Bostonography or Hoodmaps. That needs a small database and some moderation.

## Phase 5: phone apps

Cheapest first:

1. **PWA (free):** after Phase 2, "Add to Home Screen" gives an app icon on iPhone and Android with no app stores involved.
2. **Wrap the web app:**
   - Android: a Trusted Web Activity (Google's Bubblewrap tool) puts the PWA in the Play Store. Google Play costs $25 once.
   - iOS: Capacitor. The Apple Developer Program costs $99/yr. Apple sometimes rejects thin web wrappers (guideline 4.2), so add something native, such as a home-screen widget.
3. **Native** (most work, best results):
   - **iOS** (SwiftUI + MapKit): the built-in `CLGeocoder` returns `subLocality`, Apple's neighborhood name, free on the device. Add a WidgetKit lock-screen widget ("Hyde Park") and region monitoring for "you entered a new neighborhood" alerts.
   - **Android** (Kotlin + Compose + MapLibre Native): the built-in `Geocoder` returns `subLocality`, free. Add a home-screen widget.
   - Either app can also call the WNIT API, so names and outlines match the website.

## Phase 6: watches

- **Samsung Galaxy Watch.** Galaxy Watch4 and newer run Google's Wear OS, so check your model: older Galaxy watches run Tizen, which is a dead end.
  - Build a Kotlin Wear OS app with a **Tile** (swipe to "You're in Hyde Park") and a **complication** for watch faces.
  - Location comes from the watch's GPS or the phone. Names come from the WNIT API over Wi-Fi/LTE or through the phone; don't count on a geocoder being on the watch.
  - It ships through Google Play, covered by the same $25 account.
- **Garmin** (Connect IQ, Monkey C language, VS Code extension):
  - Build a **widget/glance**. GPS comes from `Position.enableLocationEvents`.
  - Internet goes through `Communications.makeWebRequest`, which relays through the Garmin Connect app on your phone over Bluetooth.
  - Watch memory is tight, so the API's ~100-byte JSON matters here.
  - There's already an open-source "Where Am I" Connect IQ app that shows your address via Nominatim, which is a useful reference.
  - Publishing to the Connect IQ Store is free.
- **Apple Watch** (if you ever get one): a WidgetKit complication that comes almost free with a native iOS app.

## Costs at hobby scale

| Item | Cost |
|---|---|
| GitHub Pages hosting | $0 |
| Domain (`wnit.app`) | ~$9 first year, then ~$15/yr |
| Map tiles (OpenFreeMap) + geocoding (Nominatim) | $0 (with attribution, polite usage) |
| Cloudflare Worker + R2 (Phases 3–4) | $0 within free tiers |
| Google Play (Android + Wear OS) | $25 once |
| Apple Developer Program | $99/yr, only to ship on the App Store |
| Garmin Connect IQ Store | $0 |

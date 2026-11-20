# Ahmedabad · Isometric City

A GTA-style isometric 3D map of Ahmedabad that runs in the browser (Three.js / WebGL), built from open data.

- ~150k real building footprints with surveyed heights, 73k road segments, the Sabarmati and lakes, parks, rail
- Flyovers and river bridges lifted onto decks where roads actually cross roads, rail or water
- Narendra Modi & Sardar Patel stadium bowls, Atal Bridge with its kite canopy
- Ahmedabad Metro: Blue, Red, Yellow and Violet line viaducts, 43 stations (4 underground), tunnel portals, trains running to the GTFS timetable
- Sabarmati Riverfront as a sunken channel from Vasna Barrage to the Acher barrage-cum-bridge: retaining walls, lower and upper promenades, stairs, ghats, lamps
- Janmarg BRTS: median busways with kerbs and railings (open at junctions), 183 island stations with ramps and zebra crossings, buses running to the GTFS timetable
- Hand-built landmarks: Patang revolving restaurant, ISKCON temple, Taj Skyline, Pinnacle Business Park, and Ellis Bridge's 1892 steel spans between the Swami Vivekananda Bridge wings
- Airport perimeter wall with anti-climb coil and watch towers; building outlines squared up from the traced data
- Day / golden hour / night (lit windows, street lamps), Q/E rotation, search, radar and city map

## Layout

- `public/` – the static site Vercel serves (`index.html`, `app.js`, `data/*.bin` gzip-packed geometry, `data/meta.json`)
- `tools/` – the data pipeline that produces `public/data`

## Rebuild the data

```bash
bash tools/build.sh   # needs Python 3.11+, downloads ~250 MB of open data, ~3 minutes
```

## Data sources & licences

| Layer | Source |
|---|---|
| Building footprints + heights | VEDAS / ISRO Space Applications Centre, republished by [ramSeraph/indian_buildings](https://github.com/ramSeraph/indian_buildings) (check its licence before commercial use) |
| Building footprints + heights (2nd source, gap fill, walled-city houses) | [Google Open Buildings](https://sites.research.google/open-buildings/) v3 polygons with Open Buildings 2.5D Temporal (2023) heights, CC BY 4.0 / ODbL, India extract republished by ramSeraph/indian_buildings (`GOBI-2023` release; only the row groups covering Ahmedabad are range-read by `tools/fetch_gobi.py`) |
| Walled-city outline | Polygon through the historic gates (Wikipedia, *Gates of Ahmedabad*) |
| Airport | Runway 05/23 thresholds from published aerodrome data (3505 x 45 m); taxiway offset and apron extent inferred from the empty band in the building data |
| Roads, parks, central water | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL — via OSMnx export in PalTrivedi/Smart-Route-Planner-Ahmedabad, jayprajapati009/ahmedabad-map, sandeshrajbhandari/urban-heat-ahmedabad |
| Rivers & lakes | India-WRIS, Swachh Bharat Mission (via ramSeraph/indian_water_features) |
| Railways | Indian Railways (via ramSeraph/indian_transport) |
| Ward boundaries | DataMeet Municipal_Spatial_Data |
| Metro alignments, stations, timetable | GTFS feed from [croyla/amd-gtfs](https://github.com/croyla/amd-gtfs) (ODbL), pinned copy in croyla/amd-metro-navigator |
| Riverfront channel | River outline above, cut at Vasna Barrage (Wikipedia coordinates) and the OSM barrage-cum-bridge at Acher; widths and levels from SRFDCL descriptions |

Procedural (not surveyed): trees, rooftop water tanks and stair rooms, the house-by-house split of merged old-city / industrial blocks, stadium tiers, flyover deck heights.

### Heights
VEDAS heights alone are heavily compressed (4-6 storey societies came out at 1-2 floors). Each footprint now takes the
higher of the VEDAS height and the area-weighted Google 2.5D height, after a calibration (`cal_height` in
`tools/common.py`) that stretches values above one storey, because the 2.5D rasters are footprint means of a 4 m
effective-resolution product and flatten mid/high-rise blocks. Treat individual heights as estimates (+-1-2 floors).

### Walled city (pols)
Inside the gate polygon every Google footprint becomes a house. Each gets a street facade (the edge that opens onto a
lane), a Mangalore-tile gable roof with the ridge parallel to the street (about two thirds) or a flat terrace (agasi),
a recessed ground floor behind an otla with wooden posts, carved/louvred upper windows and occasional jharokha
balconies. Pol gates with guard rooms sit at lane mouths on bigger streets; chabutros (bird feeders) stand in the lane
chowks. These are a typological reconstruction, not surveyed facades.

### Metro
Alignments are the GTFS shapes (smoothed, resampled every 4 m), so the viaduct follows the real route rather than
roads between stations. Rail level is about 9 m between stations and 12 m at stations (GMRC DPR: 8.5 m between
stations, 12 m where a concourse sits below), lifted to clear road flyovers by 7.5 m and railways, with 3 % ramps.
The Blue Line runs underground for ~6.5 km from a portal just east of the river to one before Apparel Park; the four
underground stations show only street entrances. At Old High Court the Red Line platforms sit above the Blue Line
station (the stacking is a reconstruction). Twin single-track U-girders sit on single-column piers with hammerhead caps
every ~28 m. Trains (3 cars) run on the left-hand track to the GTFS stop times: the timetable clock follows the
time-of-day buttons (morning 08:30, noon 12:30, golden hour 18:15, night 21:00 IST) and today's weekday/weekend service.
Zoomed out, line-coloured ribbons trace the routes (dashed underground).

### Sabarmati Riverfront
The river runs in a channel cut into the ground plane: water 5.6 m and the lower promenade 4.5 m below city level,
retaining walls between, the upper promenade paved along the top. The wall follows the river outline offset by a
10 m promenade, and steps back wherever a road runs closer, so the promenade narrows there. Stairs (~430 m apart),
ghats (~640 m apart) and lamp posts are placed procedurally along the walls. North of the old Subhash Bridge the
channel covers Phase 2 (under construction, ~82 % complete in Oct 2026) using the existing river edge, not the final
design line. A depth-only band around the channel lets the near bank hide the sunken parts while the ground layers
stay flat.

### Building outlines
VEDAS outlines are traced from a surface model, so many come out jagged, spurred or slightly skewed. Each is turned
to its own dominant axis; walls within 16 degrees of that axis are snapped onto it and corners re-intersected, and
outlines that are still irregular after that are rebuilt on a 1.5-4 m grid aligned with the building (closing and
opening remove notches and spurs). Procedural cells inside dense blocks are whole rectangles only, no clipped scraps.

### Landmarks
- **Patang** (Hasmukh Patel, 1980-84): concrete shaft with a chabutaro-style flared capital, the 62 ft revolving
  ring (18 ft glazing) at 221 ft and the 68 ft umbrella roof. Placed on the traced shaft at 23.0264 N 72.5722 E.
- **Ellis Bridge** (1892): 14 bowstring lattice-truss spans, 433.41 m long, 6.25 m wide, on paired piers, centred on
  the channel between the two 1997-99 concrete wings, which are pushed apart over the river to leave room for it.
- **ISKCON, Sri Sri Radha Govind Dham** (1997): stone platform, temple hall with mandapa domes and corner chhatris,
  and the three ~50 ft shikharas with their sub-spires at the rear. Sited on the 2,354 m2 traced temple footprint.
- **Taj Skyline / Sankalp Square III** (ARK Reza Kabul): two towers on one podium with the white box-frame façade.
- **Pinnacle Business Park** (Corporate Road, opposite Prahladnagar Garden): its own footprint, glazed. Façade
  treatment is approximate.

### Airport wall
The perimeter is the edge of the open airside land around runway 05/23: inside a runway-frame envelope, whatever no
building, through road or water occupies is airfield; the part holding the runway, opened and closed by 70 m and
30 m, is fenced. Terminal and hangar façades that form the boundary themselves get no wall.

### Janmarg BRTS
Stops, route stop sequences and the timetable come from the official Janmarg GTFS (packaged as SQLite in
str3939/Janmarg-BRTS-Guide). The GTFS has no shapes, so each route is routed station-to-station over the major road
graph (service roads penalised). On dual carriageways the corridor moves onto the median; parallel corridors within
12 m merge; corridors are smoothed so turns are arcs. Single carriageways that carry it are widened to 24 m. Lane paint
and barriers stop at junctions; bridges and flyovers carry buses in mixed traffic (no lane paint). Each station is an
island in the median (44 x 4.6 m, glass walls, arched roof, ramp to a zebra crossing); same-name stops within 300 m
share one. Limitation: Janmarg is ~160 km of routes but only ~89 km of dedicated corridor, and the routing paints
~144 km, so some stretches shown as busway run in mixed traffic in reality.

### Road paint
Wherever a road's edge line or lane paint would land on another carriageway (junctions, overlapping dual
carriageways, slip roads) the paint fades out; continuations of the same road through a node are not masked.

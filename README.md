# Ahmedabad · Isometric City

A GTA-style isometric 3D map of Ahmedabad that runs in the browser (Three.js / WebGL), built from open data.

- ~150k real building footprints with surveyed heights, 73k road segments, the Sabarmati and lakes, parks, rail
- Flyovers and river bridges lifted onto decks where roads actually cross roads, rail or water
- Narendra Modi & Sardar Patel stadium bowls, Atal Bridge with its kite canopy
- Ahmedabad Metro: Blue, Red, Yellow and Violet line viaducts, 43 stations (4 underground), tunnel portals, a train every few stations that turns back over a scissors crossover beyond each terminal
- Sabarmati Riverfront as a sunken channel from Vasna Barrage to the Acher barrage-cum-bridge: retaining walls, lower and upper promenades, stairs, ghats, lamps
- Janmarg BRTS: median busways with kerbs and railings (open at junctions), 183 island stations with ramps and zebra crossings, buses running to the GTFS timetable
- Street life: signals at 288 big crossroads (two-phase cycles, zebras, stop lines), cars, SUVs, autos, scooters, bikes, tempos and trucks that keep their lanes, follow, turn on curves and take turns through junctions (never through the BRTS lanes), and pedestrians who keep left and step round each other
- Hand-built landmarks: Patang revolving restaurant, ISKCON temple, Taj Skyline, and Ellis Bridge's 1892 steel spans between the Swami Vivekananda Bridge wings
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
| Metro alignments, stations | GTFS feed from [croyla/amd-gtfs](https://github.com/croyla/amd-gtfs) (ODbL), pinned copy in croyla/amd-metro-navigator |
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
every ~28 m. The viaduct runs on ~210 m past each terminal platform (Vastral Gam, Thaltej Gam, APMC, GIFT City), where
the two troughs open into one deck over a scissors crossover. Trains (3 cars, left-hand running) are a synthetic
service, not the GTFS timetable: the Blue Line runs a train every 2 stations; on the N-S line the Mahatma Mandir and
GIFT City services each run every 4 stations, half a headway apart, so the shared APMC-GNLU trunk sees one every 2.
At a terminal a train unloads, runs on to the siding crossing to the other track, changes ends, comes back into the
other platform, loads and departs. Each service's round trip is padded (dwells off the shared trunk) to a whole number
of headways, so trains never meet. Accelerate / cruise / brake runs, 25 s dwells; each car rides its two bogies, so
it swings through the crossover diagonals.
Past APMC the Red Line runs on to the Gyaspur depot as in the satellite view. It follows the 132 Ft Ring Road south
at platform level, crosses the Narol-Sarkhej highway, comes down at 3 % to grade, and curves west beside the canal into
a ten-road yard fanning into the depot shed. Five trains are stabled there. The line was traced from imagery and is
accurate to roughly 50 m.
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
share one. Each station has a ramp and a zebra crossing at both ends, the railing open where the zebra crosses. Each
side has two bus bays, front and rear, with sliding doors that line up with a bus's two doors and open about 1 s
after it docks.

The timetable is turned into a schedule in arrival order. A bus takes the front bay if the stop is clear, the rear bay
if only the front is taken (and leaves after the bus ahead), or queues behind. A bus pulling out blocks the stop for
14 s. Runs average at most ~9 m/s with gentle acceleration, and a bus is never faster than the one ahead on the same
leg. On top of that, a bus closing on the one ahead in its lane eases off and runs late rather than through it.
Duplicate trips (same run under several service calendars) are dropped. Every road the corridor runs beside (dual-carriageway halves, partner carriageways, service roads) records
how much width the busway and its barrier take from it and on which side, and traffic keeps out of that strip; the
OSM busway pieces themselves are closed to cars and walkers. Limitation: Janmarg is ~160 km of routes but only ~89 km of dedicated corridor, and the routing paints
~144 km, so some stretches shown as busway run in mixed traffic in reality.

### Road paint
Wherever a road's edge line or lane paint would land on another carriageway (junctions, overlapping dual
carriageways, slip roads) the paint fades out; continuations of the same road through a node are not masked.

### Street life
Signals go only where secondary-and-bigger roads meet from three or more directions (288 junctions; dual-carriageway
node clusters within 40 m count as one). Each inbound arm gets a zebra, a stop line and a pole on its left kerb, with a
cantilever head over roads wider than 10 m; arms run in two phases on a 72 s cycle.

Traffic is ambient and deliberately light (roughly 70-240 vehicles and 60-200 pedestrians around the view). Vehicles
appear and disappear only just outside the screen (or grow in, if a jump leaves the view empty). Lane offsets follow
per-vertex miter normals, so they bend smoothly instead of stepping at road joints. Speed follows the Intelligent
Driver Model behind whatever is ahead (separate parameters for cars, two-wheelers and heavy vehicles), and vehicles
slow for the bend ahead. Every move through a node is a cubic curve from lane to lane: left turns end in the kerb
lane, right turns in the inner lane, U-turns at dead ends. At junctions of three or more roads a vehicle reserves the
junction box before entering. It gets the box only if no vehicle inside, or waiting more than 4 s, has a path within a
car's width of its own; signals still apply on top. Each vehicle owns a fixed instance slot, so only matrices are
uploaded per frame.

Roads drawn on top of another carriageway for most of their length, and slip links through the busway, are closed
to traffic. At load, every road is also measured against the busway as drawn and gives up whatever width the bus
lanes, kerbs and railings take (or closes if none is left). Zoomed out past where single vehicles read, traffic
becomes moving dashes drawn by the road shader: lane-following, left-hand running, head and tail lights at night. It
costs nothing on the CPU. On the route map, trains show as pills on the line ribbons.

Road works: 18 wide roads, chosen with a fixed seed, have the kerb lane of one direction dug up behind a cone taper,
barricades, a sign, an excavator and two workers; traffic merges out of that lane in good time and only into a gap.
Rooftop life: on some flat roofs, beside a stair room or a water tank, there is a washing line with clothes and
somebody hanging them out, and often a plastic chair with someone sitting out. Street cricket: in 126 parks with
room for it, nine kids play on a worn pitch with stumps. The bowler walks back and runs in, the batsman and keeper
shuffle, and fielders and two others run about.
Construction sites: 26 mid-size plots beside big roads (picked in the data build) show a concrete frame part-way up
with brick infill below, a tower crane, tin hoarding and material heaps instead of the finished building.

People cross junction mouths only when no vehicle is on, or due to reach, the crossing (or after a long wait), and
drivers stop for anyone on the carriageway ahead. Pedestrians keep left, sidestep oncoming walkers, overtake slower ones on the right or slow behind them, and are
pushed apart when closer than 0.6 m. They cross junction mouths and turn back where a footpath would run along
another carriageway for a long way.

While nothing is being dragged the scene redraws at about 30 fps with traffic on screen, 20 fps with only trains or
buses and 12-15 fps otherwise; the simulation steps only on drawn frames. Moving things cast no shadows (the shadow map
only refreshes when the camera moves).

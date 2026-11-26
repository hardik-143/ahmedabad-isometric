# Ahmedabad · Isometric City

A GTA-style isometric 3D map of Ahmedabad that runs in the browser (Three.js / WebGL), built from open data.

> **This is the full-city branch: every layer is on.** On main: Buildings (and the rooftop details, pol gates, darwajas, construction sites and
> factories that go with them), weather and golden hour / night are switched off, there is no road traffic, and it
> opens straight on foot at the Patang Hotel; roads, the Sabarmati and its bridges, the metro, Janmarg BRTS, trees and the Patang Hotel stay. Every layer is still in the
> code: flip the switches in the `CFG` object at the top of `public/app.js`. The branch `full-city` has everything on,
> 

- ~150k real building footprints with surveyed heights, 73k road segments, the Sabarmati and lakes, parks, rail
- Flyovers and river bridges lifted onto decks where roads actually cross roads, rail or water
- Narendra Modi & Sardar Patel stadium bowls, Atal Bridge with its kite canopy
- Ahmedabad Metro: Blue, Red, Yellow and Violet line viaducts, 43 stations (4 underground), tunnel portals, a train every few stations that turns back over a scissors crossover beyond each terminal
- Sabarmati Riverfront as a sunken channel from Vasna Barrage to the Acher barrage-cum-bridge: retaining walls, lower and upper promenades, stairs, ghats, lamps
- Janmarg BRTS: median busways with kerbs and railings (open at junctions), 183 island stations with ramps and zebra crossings, buses running to the GTFS timetable
- Street life: signals at 288 big crossroads (two-phase cycles, zebras, stop lines), cars, SUVs, autos, scooters, bikes, tempos and trucks that keep their lanes, follow, turn on curves and take turns through junctions (never through the BRTS lanes), and pedestrians who keep left and step round each other
- Hand-built landmarks: Patang revolving restaurant, ISKCON temple, Taj Skyline, and Ellis Bridge's 1892 steel spans between the Swami Vivekananda Bridge wings
- Airport perimeter wall with anti-climb coil and watch towers; building outlines squared up from the traced data
- Industry and pollution: Naroda, Vatva, Odhav and Kathwada GIDC, the Danilimda-Behrampura dyeing units and the Torrent Sabarmati coal power station, with stacks, tanks, dye-house effluent tanks, smoke plumes and estate smog
- Day / golden hour / night (lit windows, street lamps) and five weathers (clear, cloudy, monsoon, fog, heatwave), Q/E rotation, search, radar and city map

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
a yard in front of the depot shed: a scissors crossover just outside the throat, then each running line feeds a ladder
of five stabling roads, all ten straight for the last ~80 m into the shed, where five trains are stabled. Buildings and
trees are cleared off the at-grade line and the yard. The line was traced from imagery and is accurate to roughly 50 m.
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

### Industry and pollution
`tools/p_industry.py` finds the estates in the footprint data: factory-sized low buildings (150 m2 and up, 13.6 m or
lower) are binned on a 40 m grid, the density is smoothed, and the patches that touch each estate's own roads (named
in the OSM graph, e.g. "Naroda GIDC factory road", "Vatva GIDC road", "Kathwada GIDC rd") are kept. Inside them the
sheds take the corrugated industrial palette and lose house-roof tanks and stair rooms. Estates and their character:
Naroda and Vatva GIDC (dyes, chemicals, pharma; CPCB counts Vatva-Narol and Naroda-Odhav among Gujarat's critically
polluted clusters), Odhav and Kathwada GIDC (engineering, plastics) and the Danilimda-Behrampura dyeing units.
Grid cells where small houses (under 150 m2) cover more than 7 % of the ground, or more than a third of what the
sheds cover, are residential pockets and stay out, so the chawls and societies between the estates keep their
houses. Narol is left out: its textile units sit inside a residential area. Labels sit on the GIDC roads.
Stacks are placed beside the sheds on free ground (or on the boiler-house roof): about one in five chemical units
(steel, 16-32 m), three in ten dye houses (brick or steel, 24-42 m) and a few workshops; process tanks stand beside chemical units, coloured effluent tanks
beside dye houses. The Torrent Sabarmati power station (coal, 362 MW, 23.0706 N 72.5939 E) gets two banded
105-120 m stacks with blinking aviation lights; the real stack heights are not published, these follow the CPCB
minimum-height rules. Smoke: every running stack sends a plume downwind (north-east, on the prevailing
south-westerly), near-black from dye-house boilers, grey-brown from chemical units, white from the power station,
computed entirely in the vertex shader from the clock; zoomed out, a grey smog sits over each estate.
Not modelled: Pirana landfill (biomining is reported complete and the site is being capped), CETPs, the Kharicut
canal.

### Weather
Five presets (buttons above the time bar, or R): clear, cloudy, monsoon, fog and heatwave; they combine with any time
of day and blend over 2.5 s. Every material in the scene gets a small shared shader pass for wet ground, cloud
shadows, height fog and heat haze, so nothing needs its own weather code.
Monsoon: rain never covers the whole city. Six storm cells (2.6-3.6 km across) drift south-west to north-east at
about 65 km/h, the direction the south-west monsoon winds carry the clouds, on a 36 km loop, so a given area gets a
shower of a few minutes roughly every half hour and the next area gets its turn after it. Under a cell: streaks of
rain and splashes up close, roads and roofs turn dark and wet, a grey veil at street level, and lightning when a
storm is overhead. Behind it the ground dries over a few minutes. Traffic slows in rain and crawls through standing
water. Water collects at 575 spots (`tools/p_weather.py`): the 36 road underpasses OSM tags as tunnels (Akhbarnagar,
Income Tax, Parimal, Usmanpura, Paldi, Thaltej, Gota Road and the rail underpasses), deep and slow to drain; a few
at-grade spots in 21 areas the AMC and the press keep reporting as waterlogged (Shivranjani, Sindhu Bhavan Road,
Prahladnagar, Vastrapur, Vejalpur, Bopal, Mithakhali, Maninagar, Khokhra-Hatkeshwar, Nikol, Odhav, Vatva, Kathwada,
Gota, Tragad, Isanpur, Vastral, Chandkheda, Shahibag); and 420 shallow puddles on minor roads that come and go
quickly. Each fills only while rain falls on it and drains at its own rate. Zoomed out, the storm cells show as a
cloud deck with moving shadows.
Fog: a ground fog about 35 m deep, so towers rise out of it. Heatwave: a strong, warm sun, washed-out colours and a
dusty haze.

### Explore on foot
Press F (or the button at the top) to drop into the street with a third-person camera that swings in behind you, GTA
style. People are Quaternius's CC0 Animated Men and Animated Women packs (`public/models/people`, six bodies, ~0.9 MB,
loaded only on foot): their clothes are real geometry with their own materials, so everyone is recoloured (shirt,
t-shirt, kurta, shirt & tie, suit, saree, salwar kameez, jacket & jeans; skin and hair colour), and saree / kurta /
kameez add a skirt on the hip bone. Each body carries its own clips: idle, walk, run, jump, running jump, sitting.
Walk, run and idle are motion capture: the three.js Soldier example's Mixamo clips, retargeted offline onto each body
(`tools/retarget`, written to `public/models/people/mocap.json`, 71 KB gzipped).
Smoothness: walk and run speeds were measured from the planted foot (3.82 and 10.6 model units a second for the mocap) and every
clip plays at ground speed / clip speed, so feet do not slide; walk and run switch with hysteresis (run above 2.8 m/s,
back to walk below 2.3) keeping the stride's phase; 0.18 s crossfades, a short pause before idling, a running jump
when moving; height eases onto ramps and kerbs; the camera target is eased. The nearest 24 pedestrians become these
people, dressed from their own colours.
Controls: WASD run, Shift sprint, Caps Lock walk, Space jump, mouse or drag to look, wheel to zoom. F gets you on the
auto rickshaw or scooter beside you (out of traffic, or one you left parked) and off again, where it stays parked;
C cycles through your own cycle, scooter and auto rickshaw and back on foot (on the cycle the sitting clip is leaned forward and two-bone IK puts the feet on the turning pedals and the hands on the bars; two-wheelers lean into turns); E boards a metro train or a Janmarg bus at a station (Q skips the wait). Flyover
ramps are solid from the side and can be driven up; decks keep you on with their parapets; piers and metro columns
block; you can pass under high decks. Walking into an area shows its name, getting on a vehicle shows its name, and the
radar turns round.
Nothing passes through anything: people, tree trunks, the Patang tower, BRTS station glass and busway railings and the
buses are solid (a bus brakes for you). The riverfront has its two levels: the lower promenade is 4.5 m down, the
wall-top railing stops you except at the stair landings, the stairs take you down, and you fall if you go over.
People nearby turn their heads to watch you pass; bump into one and they stop, face you and tell you off in a speech
bubble ("Hey, watch out!", "Arre, dhyaan thi!"), and they step round you on the footpath. Sign-in uses Clerk when a publishable key is set in `<meta name="clerk-key">`, otherwise the
profile is kept in localStorage.

### Streaming (on foot)
On foot nothing city-wide is downloaded for buildings, cell houses, rooftop props or trees: `tools/stream_pack.py`
(run at the end of `pack.py`) writes each 1 km chunk's slices of those layers to its own small file,
`public/data/s/<cx>_<cy>.bin` (1,330 files, ~15 KB each on average). The app fetches the chunks within ~1.6 km of you
(four at a time, nearest first), meshes one a frame, builds cell houses in slices of 400, and drops chunks once you
are ~2.6 km away; fog closes the view before the edge. A start at the Patang Hotel downloads ~3.4 MB in all (roads,
transit, meta and nine chunks) instead of ~24 MB. The map view still loads the whole-city files.

### Street dress
Ordinary blocks are painted in Ahmedabad colours (raspberry, coral, peach, cream, mustard, teal, sky, lilac, pink,
mint, brick) instead of the survey's pale tints. Within ~250 m of you, built per 60 m cell as you walk: every wall that
faces a road gets shops along its ground floor (a lit shop or a rolling shutter, a Gujarati signboard from a canvas
atlas, often a striped awning), and about 60% of residential blocks get balconies (slab, solid parapet in the
building's paint, steel rail) on the upper floors, lined up with the windows the facade shader draws.

### Riverfront furniture
The upper promenade's lamps are black poles with glowing globes; between them stand benches facing the river, a green
bin beside every third lamp, a makai lari (corn cart with a coal brazier and a striped umbrella) every ~14 lamps, and an
"I ❤ AMDAVAD" sign on the promenade nearest the Patang Hotel (three.js TextGeometry, letters in kite colours). All of
it is solid.

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
Buses are steered like buses: each path is moved into its lane and then driven by pure pursuit (a point 7 m ahead)
with a 9.5 m minimum turning radius, so corners are swept and reversals become wide loops; the ends are pulled back
onto the path so a bus still stops at its bay. Where the busway network has a gap, the build re-routes the leg over the
road graph instead of a long detour, and strips spurs and hairpins. At a terminus a bus does not vanish: it swings
round the end of the station island in a U-turn and waits in the first bay of the run back (2,892 of 3,940 runs);
the railings stand back from termini to leave room for the loop.
Duplicate trips (same run under several service calendars) are dropped. Every road the corridor runs beside (dual-carriageway halves, partner carriageways, service roads) records
how much width the busway and its barrier take from it and on which side, and traffic keeps out of that strip; the
OSM busway pieces themselves are closed to cars and walkers. Where a station sits over a junction opening (30 of 183),
the lane paint and railings carry on under it, the cross street through the island is closed, and the strip kept clear
widens to the station's full width. Limitation: Janmarg is ~160 km of routes but only ~89 km of dedicated corridor, and the routing paints
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
Every flat roof (houses, flats, flat-roofed pol houses, the procedural houses inside old-city blocks; not tiled roofs,
sheds or special structures) has a 1 m parapet in one of three kinds: a plastered wall in the building's colour with a
light coping, a cement jali with two rows of openings, or an MS railing (black, green or blue) on a low upstand.
Towers get a wall or a railing, pol houses a wall or a jali. Openings are cut in the shader (shadows included) and
the parapets are only built for chunks seen up close.
Every stair room has a painted steel door onto the terrace, with a frame, a chajja over it, a step and a vent window.
Rooftop life: on ~21,000 terraces there is a washing line in front of that door with clothes and somebody hanging
them out, and often a plastic chair with someone sitting out. It only goes on roofs reached by a stair room (two-storey
houses get a small one when their terrace is in use) and only where the whole layout clears the parapet. Street cricket: in 126 parks with
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

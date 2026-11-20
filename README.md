# Ahmedabad · Isometric City

A GTA-style isometric 3D map of Ahmedabad that runs in the browser (Three.js / WebGL), built from open data.

- ~150k real building footprints with surveyed heights, 73k road segments, the Sabarmati and lakes, parks, rail
- Flyovers and river bridges lifted onto decks where roads actually cross roads, rail or water
- Narendra Modi & Sardar Patel stadium bowls, Atal Bridge with its kite canopy
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

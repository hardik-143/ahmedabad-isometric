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
| Roads, parks, central water | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL — via OSMnx export in PalTrivedi/Smart-Route-Planner-Ahmedabad, jayprajapati009/ahmedabad-map, sandeshrajbhandari/urban-heat-ahmedabad |
| Rivers & lakes | India-WRIS, Swachh Bharat Mission (via ramSeraph/indian_water_features) |
| Railways | Indian Railways (via ramSeraph/indian_transport) |
| Ward boundaries | DataMeet Municipal_Spatial_Data |

Procedural (not surveyed): trees, rooftop water tanks and stair rooms, the house-by-house split of merged old-city / industrial blocks, stadium tiers, flyover deck heights.

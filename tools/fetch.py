"""Download the open source datasets and clip the national ones to Ahmedabad."""
import os, re, json, shutil, tempfile, time, urllib.request
import py7zr
from shapely.geometry import shape, box

DATA = os.environ['AMD_DATA']
os.makedirs(DATA, exist_ok=True)
GH = 'https://github.com/ramSeraph'
RAW = 'https://raw.githubusercontent.com'
SOURCES = {
    # building footprints + heights (VEDAS / ISRO-SAC), republished by ramSeraph
    'vedas_ahd.parquet': f'{GH}/indian_buildings/releases/download/urban/Vedas_Ahmedabad_Buildings.parquet',
    # OpenStreetMap drive network (OSMnx export, Jan 2026)
    'ahmedabad.graphml': f'{RAW}/PalTrivedi/Smart-Route-Planner-Ahmedabad/597c50cf48df8dbafa7e5a9c5ca087650ce1e85c/backend/ahmedabad.graphml',
    # OpenStreetMap water / waterways / parks for central Ahmedabad
    'city-data.json': f'{RAW}/jayprajapati009/ahmedabad-map/14728db7f2aa84fb6096cb19251181f93a25dddd/data/city-data.json',
    # OpenStreetMap parks for the whole city
    'parks_ahmedabad.geojson': f'{RAW}/sandeshrajbhandari/urban-heat-ahmedabad/d360075f32290617e750906ae59ad3b632bd7a54/outputs/parks_ahmedabad.geojson',
    # AMC ward boundaries (DataMeet)
    'wards.geojson': f'{RAW}/datameet/Municipal_Spatial_Data/9b4d1c2ece54cdeb6f5e8bad9ccad7844f783b17/Ahmedabad/Wards.geojson',
}
NATIONAL = {
    'WRIS_River_Polygons': f'{GH}/indian_water_features/releases/download/rivers/WRIS_River_Polygons.geojsonl.7z',
    'SBM_Water_bodies': f'{GH}/indian_water_features/releases/download/urban-water-features/SBM_Water_bodies.geojsonl.7z',
    'IR_Tracks': f'{GH}/indian_transport/releases/download/railways/IR_Tracks.geojsonl.7z',
    'IR_Stations': f'{GH}/indian_transport/releases/download/railways/IR_Stations.geojsonl.7z',
}
BB = box(72.40, 22.88, 72.75, 23.20)
PRE = re.compile(r'\[\s*72\.[3-8]')


def dl(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return
    for attempt in range(5):
        try:
            t = time.time()
            with urllib.request.urlopen(url, timeout=300) as r, open(dst + '.part', 'wb') as f:
                shutil.copyfileobj(r, f, 1 << 20)
            os.replace(dst + '.part', dst)
            print(f'  {os.path.basename(dst)}: {os.path.getsize(dst) / 1e6:.1f} MB in {time.time() - t:.0f}s', flush=True)
            return
        except Exception as e:
            print('  retry', url, e, flush=True)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError('download failed: ' + url)


def clip(src, out):
    tmp = tempfile.mkdtemp(dir=DATA)
    with py7zr.SevenZipFile(src, 'r') as z:
        z.extractall(tmp)
    feats = []
    for root, _, files in os.walk(tmp):
        for fn in files:
            with open(os.path.join(root, fn), encoding='utf-8', errors='replace') as f:
                for line in f:
                    if not PRE.search(line):
                        continue
                    try:
                        ft = json.loads(line)
                        if ft.get('geometry') and shape(ft['geometry']).intersects(BB):
                            feats.append(ft)
                    except Exception:
                        pass
    shutil.rmtree(tmp)
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(out, 'w'))
    print(f'  {os.path.basename(out)}: {len(feats)} features', flush=True)


if __name__ == '__main__':
    for name, url in SOURCES.items():
        dl(url, os.path.join(DATA, name))
    for name, url in NATIONAL.items():
        out = os.path.join(DATA, name + '.ahd.geojson')
        if os.path.exists(out):
            continue
        src = os.path.join(DATA, name + '.geojsonl.7z')
        dl(url, src)
        clip(src, out)
        os.remove(src)

"""Stage 4: pack everything into compact binary files + meta.json"""
import pickle, json, gzip, math, re, struct, time, numpy as np, shapely
import mapbox_earcut as earcut
from collections import defaultdict
from common import *

t0 = time.time()
B = pickle.load(open(f'{OUT}/buildings.pkl', 'rb'))
G = pickle.load(open(f'{OUT}/ground.pkl', 'rb'))
T = pickle.load(open(f'{OUT}/trees.pkl', 'rb'))
import os
os.makedirs(SITE + '/data', exist_ok=True)


class Buf:
    def __init__(self):
        self.b = bytearray()

    def pad(self, n=4):
        while len(self.b) % n:
            self.b.append(0)

    def arr(self, a, align=None):
        a = np.ascontiguousarray(a)
        if align is None:
            align = a.dtype.itemsize
        self.pad(align)
        self.b += a.tobytes()

    def u32(self, *v):
        self.pad(4)
        self.b += struct.pack('<%dI' % len(v), *v)


def chunk_origin(cx, cy):
    return (cx + 0.5) * CHUNK, -(cy + 0.5) * CHUNK  # three.js x, z


# ---------------- buildings ----------------
polys, hs, style, fab = B['polys'], B['hs'], B['style'], B['fabric']
floors = np.clip(np.round((hs - 0.5) / 3.1), 1, 60).astype(np.uint8)
# industrial-looking sheds inside the walled city get the old-city palette instead
_c = shapely.centroid(polys); _x, _y = shapely.get_x(_c), shapely.get_y(_c)
_ox, _oy = proj_xy(72.5895, 23.0255)
_old = ((_x - _ox) / (0.0175 * KX)) ** 2 + ((_y - _oy) / (0.0150 * KY)) ** 2 < 1.0
_ind = (style >= 23) & (style <= 27)
style = style.copy(); style[_old & _ind] = 28 + (style[_old & _ind] - 23) % 6
print('recoloured old-city sheds', int((_old & _ind).sum()))
cen = shapely.centroid(polys)
ccx, ccy = chunk_of(shapely.get_x(cen), shapely.get_y(cen))
groups = defaultdict(lambda: {0: [], 1: []})
for i in range(len(polys)):
    groups[(int(ccx[i]), int(ccy[i]))][1 if fab[i] == 2 else 0].append(i)


def enc_buildings(idx, cx, cy):
    ox, oz = chunk_origin(cx, cy)
    fl, stv, kd, rc, rl, co = [], [], [], [], [], []
    for i in idx:
        P = polys[i]
        rings = [np.asarray(P.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in P.interiors]
        rings = [r for r in rings if len(r) >= 3][:255]
        if not rings:
            continue
        fl.append(floors[i]); stv.append(style[i]); kd.append(1 if fab[i] == 1 else 0); rc.append(len(rings))
        for r in rings:
            X = np.round((r[:, 0] - ox) * 10).astype(np.int64)
            Z = np.round((-r[:, 1] - oz) * 10).astype(np.int64)
            assert np.abs(X).max() < 32767 and np.abs(Z).max() < 32767
            dX = np.diff(X, prepend=0); dZ = np.diff(Z, prepend=0)
            rl.append(len(r)); co.append(np.column_stack([dX, dZ]).ravel())
    b = Buf()
    co = np.concatenate(co).astype(np.int16) if co else np.zeros(0, np.int16)
    b.u32(len(fl), len(rl), len(co) // 2)
    b.arr(np.array(fl, np.uint8)); b.arr(np.array(stv, np.uint8)); b.arr(np.array(kd, np.uint8)); b.arr(np.array(rc, np.uint8))
    b.arr(np.array(rl, np.uint16), 2); b.arr(co, 2); b.pad(4)
    return bytes(b.b)


# ---------------- props / trees per chunk ----------------
props = B['props']
pcx, pcy = chunk_of(props[:, 0], props[:, 1])
pgroups = defaultdict(list)
for i in range(len(props)):
    pgroups[(int(pcx[i]), int(pcy[i]))].append(i)

tp, tk = T['pts'], T['kind']
tcx, tcy = chunk_of(tp[:, 0], tp[:, 1])
tgroups = defaultdict(list)
for i in range(len(tp)):
    tgroups[(int(tcx[i]), int(tcy[i]))].append(i)
rng = np.random.default_rng(3)
tscale = rng.uniform(0.75, 1.45, len(tp))
tscale[tk == 1] = rng.uniform(0.85, 1.3, (tk == 1).sum())
tvar = rng.choice([0, 1, 2, 3, 4], len(tp), p=[0.36, 0.31, 0.21, 0.03, 0.09])


def enc_props(idx, cx, cy):
    ox, oz = chunk_origin(cx, cy)
    p = props[idx]
    b = Buf(); b.u32(len(idx))
    b.arr(np.round((p[:, 0] - ox) * 10).astype(np.int16)); b.arr(np.round((-p[:, 1] - oz) * 10).astype(np.int16))
    b.arr(np.round(p[:, 2] * 10).astype(np.uint16)); b.arr(p[:, 3].astype(np.uint8))
    b.arr(np.round(p[:, 4] / math.pi * 255).astype(np.uint8)); b.arr(np.round(p[:, 5] * 20).astype(np.uint8)); b.pad(4)
    return bytes(b.b)


def enc_trees(idx, cx, cy):
    ox, oz = chunk_origin(cx, cy)
    p = tp[idx]
    b = Buf(); b.u32(len(idx))
    b.arr(np.round((p[:, 0] - ox) * 10).astype(np.int16)); b.arr(np.round((-p[:, 1] - oz) * 10).astype(np.int16))
    b.arr(np.round(tscale[idx] * 64).astype(np.uint8)); b.arr(tvar[idx].astype(np.uint8)); b.pad(4)
    return bytes(b.b)


keys = sorted(set(groups) | set(pgroups) | set(tgroups))
files = {k: bytearray() for k in ('bld', 'cells', 'props', 'trees')}
chunks = []
for (cx, cy) in keys:
    row = [cx, cy]
    for name, data in (('bld', enc_buildings(groups[(cx, cy)][0], cx, cy) if groups[(cx, cy)][0] else b''),
                       ('cells', enc_buildings(groups[(cx, cy)][1], cx, cy) if groups[(cx, cy)][1] else b''),
                       ('props', enc_props(pgroups[(cx, cy)], cx, cy) if pgroups[(cx, cy)] else b''),
                       ('trees', enc_trees(tgroups[(cx, cy)], cx, cy) if tgroups[(cx, cy)] else b'')):
        row += [len(files[name]), len(data)]
        files[name] += data
    chunks.append(row)
print('chunks', len(chunks), {k: len(v) // 1024 for k, v in files.items()}, 'KB', round(time.time() - t0, 1))

# ---------------- roads ----------------
roads = G['roads']
names = sorted({r['name'] for r in roads if r['name']})
nidx = {n: i for i, n in enumerate(names)}
b = Buf()
npts = sum(len(r['xy']) for r in roads)
b.u32(len(roads), npts, len(G['junctions']))
b.arr(np.array([r['cls'] for r in roads], np.uint8))
b.arr(np.array([1 if r['bridge'] else 0 for r in roads], np.uint8))
b.arr(np.array([round(r['hw'] * 10) for r in roads], np.uint8))
b.arr(np.array([round(r['sw'] * 10) for r in roads], np.uint8))
b.arr(np.array([nidx.get(r['name'], 65535) for r in roads], np.uint16))
b.arr(np.array([len(r['xy']) for r in roads], np.uint16))
xy = np.concatenate([r['xy'] for r in roads])
X = np.round(xy[:, 0] * 2); Z = np.round(-xy[:, 1] * 2)
assert np.abs(X).max() < 32767 and np.abs(Z).max() < 32767
b.arr(np.column_stack([X, Z]).ravel().astype(np.int16))
J = G['junctions']
jk = list(J.keys())
jx = np.array([k[0] for k in jk]); jy = np.array([k[1] for k in jk])
b.arr(np.column_stack([np.round(jx * 2), np.round(-jy * 2)]).ravel().astype(np.int16))
b.arr(np.array([round(J[k][0] * 10) for k in jk], np.uint8))
b.arr(np.array([round(J[k][1] * 10) for k in jk], np.uint8))
b.arr(np.array([J[k][2] for k in jk], np.uint8))
ZZ = [np.round(np.asarray(r['z']) * 10).clip(0, 255) for r in roads if r['bridge']]
b.arr((np.concatenate(ZZ) if ZZ else np.zeros(0)).astype(np.uint8))
b.pad(4)
files['roads'] = b.b


# ---------------- water / parks / rail ----------------
def tri_polys(pl):
    V, I = [], []
    off = 0
    for P in pl:
        rings = [np.asarray(P.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in P.interiors]
        rings = [r for r in rings if len(r) >= 3]
        verts = np.concatenate(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        t = earcut.triangulate_float64(verts.astype(np.float64), ends)
        V.append(verts); I.append(np.asarray(t, np.uint32) + off); off += len(verts)
    V = np.concatenate(V); I = np.concatenate(I)
    return V, I


b = Buf()
for pl in (G['water'], G['parks']):
    V, I = tri_polys(pl)
    b.u32(len(V), len(I))
    b.arr(np.column_stack([np.round(V[:, 0] * 2), np.round(-V[:, 1] * 2)]).ravel().astype(np.int16))
    b.arr(I.astype(np.uint32))
rail = G['rail']
b.u32(len(rail), sum(len(r) for r in rail))
b.arr(np.array([len(r) for r in rail], np.uint16))
RX = np.concatenate(rail)
b.arr(np.column_stack([np.round(RX[:, 0] * 2), np.round(-RX[:, 1] * 2)]).ravel().astype(np.int16))
for pl in (B['fields'], B['pitches']):
    if not pl:
        b.u32(0, 0); continue
    V, I = tri_polys(pl)
    b.u32(len(V), len(I))
    b.arr(np.column_stack([np.round(V[:, 0] * 2), np.round(-V[:, 1] * 2)]).ravel().astype(np.int16))
    b.arr(I.astype(np.uint32))
b.pad(4)
files['ground'] = b.b

for k, v in files.items():
    raw = bytes(v)
    gz = gzip.compress(raw, 9)
    if FMT == 'bin':
        open(f'{SITE}/data/{k}.bin', 'wb').write(gz)
    else:
        import base64; open(f'{SITE}/data/{k}.txt', 'wb').write(base64.b64encode(gz))
    print(k, len(raw) // 1024, 'KB raw ->', len(gz) // 1024, 'KB gz')


# ---------------- labels / meta ----------------


def m2three(x, y):
    return round(float(x), 1), round(float(-y), 1)


def clean_station(n):
    n = re.sub(r'^\[.*?\]\s*', '', n)
    n = re.sub(r'\s*;\s*$', '', n)
    n = re.sub(r'\s*[\[\(][^\]\)]*[\]\)]', '', n)
    n = re.sub(r'\s*-\s*\w+$', '', n)
    n = re.sub(r'\s+(Sbt|Sbi|Flag)$', '', n, flags=re.I)
    return n.strip()


ST = []
raw_st = sorted(G['stations'], key=lambda s: s[0].startswith('['))
for nm, x, y in raw_st:
    n = clean_station(nm)
    if len(n) <= 3 or n.lower().startswith('station building'):
        continue
    if n == 'Sardar Gram':
        n = 'Sardargram'
    if any(math.hypot(x - s[1], y - s[2]) < 800 for s in ST):
        continue
    ST.append((n, x, y))
stations = [dict(name=n + (' Jn' if n in ('Ahmedabad', 'Sabarmati') else ''), x=m2three(x, y)[0], z=m2three(x, y)[1]) for n, x, y in ST]

LANDMARKS = [
    ('Kankaria Lake', 23.0063, 72.6010, 'lake'), ('Sabarmati Riverfront', 23.0330, 72.5770, 'river'),
    ('Sabarmati Ashram', 23.0607, 72.5806, 'monument'), ('Narendra Modi Stadium', 23.0919, 72.5975, 'stadium'),
    ('Sardar Patel Stadium', 23.0418, 72.5645, 'stadium'), ('SVPI Airport', 23.0745, 72.6290, 'airport'),
    ('IIM Ahmedabad', 23.0329, 72.5468, 'campus'), ('Law Garden', 23.0262, 72.5598, 'park'),
    ('Bhadra Fort', 23.0244, 72.5811, 'monument'), ('Sidi Saiyyed Mosque', 23.0268, 72.5810, 'monument'),
    ('Jama Masjid', 23.0236, 72.5878, 'monument'), ('Teen Darwaza', 23.0238, 72.5838, 'monument'),
    ('Hutheesing Jain Temple', 23.0369, 72.5918, 'monument'), ('Vastrapur Lake', 23.0389, 72.5293, 'lake'),
    ('Chandola Lake', 22.9871, 72.5870, 'lake'), ('Atal Bridge', 23.01647, 72.57545, 'monument'),
]
lms = []
for nm, lat, lon, kind in LANDMARKS:
    x, y = proj_xy(lon, lat)
    X, Z = m2three(x, y)
    lms.append(dict(name=nm, x=X, z=Z, kind=kind))

wards = []
for w in G['wards']:
    X, Z = m2three(w['x'], w['y'])
    wards.append(dict(name=w['name'], x=X, z=Z, area=round(w['area']),
                      rings=[[[p[0], -p[1]] for p in r] for r in w['rings']]))

rl = [[nidx[n], round(x, 1), round(-y, 1), round(-a, 3)] for n, x, y, a in G['road_labels']]
sr = [[nidx[n], round(x, 1), round(-y, 1), round(L)] for n, x, y, L in G['search_roads']]
x0, y0, x1, y1 = bbox_m()
meta = dict(
    version=1, chunk=CHUNK, origin=dict(lon=LON0, lat=LAT0, kx=KX, ky=KY),
    bounds=dict(minX=round(x0), maxX=round(x1), minZ=round(-y1), maxZ=round(-y0)),
    chunks=chunks, palette=B['palette'], roadNames=names, roadLabels=rl, searchRoads=sr,
    wards=wards, stations=stations, landmarks=lms,
    piers=[[round(x, 1), round(-y, 1), round(ux, 3), round(-uy, 3), round(h, 1), round(hc, 1), ch] for x, y, ux, uy, h, hc, ch in G['piers']],
    deckChain=G['deck_chain'],
    atal=dict(x0=round(G['atal']['x0'], 1), z0=round(-G['atal']['y0'], 1), x1=round(G['atal']['x1'], 1), z1=round(-G['atal']['y1'], 1), w=G['atal']['w'], deck=G['atal']['deck'], ws0=round(G['atal']['ws0'], 1), ws1=round(G['atal']['ws1'], 1)),
    counts=dict(buildings=int((fab != 2).sum()), blocks=int((fab == 1).sum()), cells=int((fab == 2).sum()),
                props=int(len(props)), trees=int(len(tp)), roads=len(roads), water=len(G['water']), parks=len(G['parks'])),
    sizes={k: os.path.getsize(f'{SITE}/data/{k}.{FMT}') for k in files},
)
import hashlib
_h = hashlib.sha1()
for k in sorted(files):
    _h.update(open(f'{SITE}/data/{k}.{FMT}', 'rb').read())
meta['build'] = _h.hexdigest()[:12]   # bins are fetched as ?v=<build> so a cached copy can never mix with a new meta.json
json.dump(meta, open(f'{SITE}/data/meta.json', 'w'), separators=(',', ':'))
print('meta KB', os.path.getsize(f'{SITE}/data/meta.json') // 1024, 'stations', [s['name'] for s in stations])
print('done', round(time.time() - t0, 1))

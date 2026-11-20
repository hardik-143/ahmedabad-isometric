"""Stage 3: trees (parks, streets, neighbourhoods). Writes trees.pkl"""
import pickle, time, math, numpy as np, shapely
from common import *

t0 = time.time()
B = pickle.load(open(f'{OUT}/buildings.pkl', 'rb'))
G = pickle.load(open(f'{OUT}/ground.pkl', 'rb'))
rng = np.random.default_rng(7)

bpolys = B['polys'][B['fabric'] != 1]
btree = shapely.STRtree(bpolys)
decks = [shapely.LineString(r['xy']).buffer(r['hw'] + r['sw'] + 3.5) for r in G['roads'] if r['bridge']]
AF = airfield()   # no trees on the runway strip, taxiways or apron
_rw = shapely.LineString([(AF['x0'] - AF['u'][0] * 300, AF['y0'] - AF['u'][1] * 300), (AF['x1'] + AF['u'][0] * 300, AF['y1'] + AF['u'][1] * 300)])
airside = [_rw.buffer(300, cap_style='flat'), shapely.Polygon(AF['apron']).buffer(25)] + [shapely.LineString(t['xy']).buffer(45) for t in AF['twy']]
gates_ = [shapely.Point(d['x'], d['y']).buffer(d['W'] / 2 + 6) for d in B.get('darw', [])] + [shapely.Point(*PATANG).buffer(9)]
import os as _os
metro_ = []
if _os.path.exists(f'{OUT}/transit.pkl'):   # riverfront channel, under the metro viaduct, stations
    _TX = pickle.load(open(f'{OUT}/transit.pkl', 'rb'))['excl']
    metro_ = [_TX['hole'].buffer(1.5), _TX['band'].buffer(1.0), _TX['stations'], _TX['piers']]
APW, APW_LINES, APW_GATES = airport_wall(G, bpolys)
print(f'airport wall: {APW.area / 1e6:.2f} km2 inside, {len(APW_GATES)} gates, {sum(shapely.LineString(l).length for l in APW_LINES) / 1e3:.1f} km of wall')
wall_ = [shapely.LineString(l).buffer(3.0) for l in APW_LINES]
water = shapely.union_all(wall_ + list(G['water']) + [f.buffer(4) for f in B['fields']] + decks + airside + gates_ + metro_)
shapely.prepare(water)
parks = G['parks']
roads = G['roads']
rlines = np.array([shapely.LineString(r['xy']) for r in roads], dtype=object)
rclear = np.array([r['hw'] + r['sw'] + 0.9 for r in roads])
rtree = shapely.STRtree(rlines)


def clean(pts, bdist=2.2, road=True):
    if len(pts) == 0:
        return pts
    P = shapely.points(pts)
    ok = np.ones(len(pts), bool)
    q = btree.query(P, predicate='dwithin', distance=bdist)
    ok[q[0]] = False
    ok &= ~shapely.contains_xy(water, pts[:, 0], pts[:, 1])
    if road:
        q = rtree.query(P, predicate='dwithin', distance=16)
        if len(q[0]):
            d = shapely.distance(P[q[0]], rlines[q[1]])
            bad = q[0][d < rclear[q[1]]]
            ok[bad] = False
    return pts[ok]


def jgrid(minx, miny, maxx, maxy, s):
    xs = np.arange(minx, maxx, s); ys = np.arange(miny, maxy, s)
    X, Y = np.meshgrid(xs, ys)
    p = np.column_stack([X.ravel(), Y.ravel()])
    return p + rng.uniform(-s * 0.42, s * 0.42, p.shape)


# parks
pk = []
for p in parks:
    s = 8.5 if p.area < 200000 else 11.0
    pts = jgrid(*p.bounds, s)
    pts = pts[shapely.contains_xy(p, pts[:, 0], pts[:, 1])]
    keep = rng.random(len(pts)) < (0.72 if p.area < 60000 else 0.45)
    pk.append(pts[keep])
pk = clean(np.concatenate(pk), 2.0)
print('park trees', len(pk), round(time.time() - t0, 1))

# street trees
st = []
for r in roads:
    if r['cls'] not in (3, 5, 6, 8) or r['bridge']:
        continue
    ln = shapely.LineString(r['xy'])
    L = ln.length
    if L < 20:
        continue
    off = r['hw'] + r['sw'] + 1.3
    ds = np.arange(6, L - 3, 12.5) + rng.uniform(-2.5, 2.5, len(np.arange(6, L - 3, 12.5)))
    ds = np.clip(ds, 0, L)
    a = shapely.line_interpolate_point(ln, np.clip(ds - 1, 0, L)); b = shapely.line_interpolate_point(ln, np.clip(ds + 1, 0, L))
    c = shapely.line_interpolate_point(ln, ds)
    ax, ay, bx, by = shapely.get_x(a), shapely.get_y(a), shapely.get_x(b), shapely.get_y(b)
    dx, dy = bx - ax, by - ay
    n = np.hypot(dx, dy) + 1e-9
    nx, ny = -dy / n, dx / n
    cx, cy = shapely.get_x(c), shapely.get_y(c)
    for sgn in (1, -1):
        m = rng.random(len(ds)) < 0.78
        st.append(np.column_stack([cx + nx * off * sgn, cy + ny * off * sgn])[m])
st = clean(np.concatenate(st), 1.6)
print('street trees', len(st), round(time.time() - t0, 1))

# neighbourhood trees near buildings
cen = shapely.centroid(bpolys)
bx, by = shapely.get_x(cen), shapely.get_y(cen)
x0, y0, x1, y1 = bbox_m()
cs = 40.0
gx = ((bx - x0) // cs).astype(int); gy = ((by - y0) // cs).astype(int)
W, Hh = int((x1 - x0) // cs) + 2, int((y1 - y0) // cs) + 2
occ = np.zeros((Hh, W), bool)
occ[np.clip(gy, 0, Hh - 1), np.clip(gx, 0, W - 1)] = True
occ2 = occ.copy()
for dy_ in (-1, 0, 1):
    for dx_ in (-1, 0, 1):
        occ2 |= np.roll(np.roll(occ, dy_, 0), dx_, 1)
pts = jgrid(x0, y0, x1, y1, 13.0)
ix = ((pts[:, 0] - x0) // cs).astype(int); iy = ((pts[:, 1] - y0) // cs).astype(int)
inb = (ix >= 0) & (iy >= 0) & (ix < W) & (iy < Hh)
pts = pts[inb]; ix = ix[inb]; iy = iy[inb]
pts = pts[occ2[iy, ix]]
pts = pts[rng.random(len(pts)) < 0.30]
print('nbhd candidates', len(pts), round(time.time() - t0, 1))
nb = []
for i in range(0, len(pts), 200000):
    nb.append(clean(pts[i:i + 200000], 2.4))
nb = np.concatenate(nb)
print('nbhd trees', len(nb), round(time.time() - t0, 1))

allp = np.concatenate([pk, st, nb])
kind = np.concatenate([np.zeros(len(pk)), np.ones(len(st)), np.full(len(nb), 2)]).astype(np.uint8)
pickle.dump(dict(pts=allp, kind=kind, apwall=APW_LINES, apgates=APW_GATES), open(f'{OUT}/trees.pkl', 'wb'))
print('total trees', len(allp), round(time.time() - t0, 1))

"""Industrial estates: find the GIDC estates and textile clusters in the building data, mark their sheds as factories,
and place stacks, process tanks, effluent tanks and smoke sources. Runs after p_buildings; pack.py applies it.

Estates (anchored on named roads in the OSM graph and on published locations):
  Naroda GIDC, Vatva GIDC (dyes / chemicals: CPCB lists Vatva-Narol and Naroda-Odhav as critically polluted clusters),
  Odhav and Kathwada GIDC (engineering, plastics), the Narol textile-processing cluster and the Danilimda-Behrampura
  dyeing units, plus the Torrent Sabarmati coal-fired power station (23.070555 N, 72.593889 E).
"""
import pickle, time, math, numpy as np, shapely
from scipy import ndimage
from common import *

t0 = time.time()
B = pickle.load(open(f'{OUT}/buildings.pkl', 'rb'))
G = pickle.load(open(f'{OUT}/ground.pkl', 'rb'))
polys, hs, style, fab = B['polys'], np.asarray(B['hs']), np.asarray(B['style']), np.asarray(B['fabric'])
PAL = B['palette']
ws = np.array([PAL[s][2] for s in style])
area = shapely.area(polys)
cen = shapely.centroid(polys); CX, CY = shapely.get_x(cen), shapely.get_y(cen)
site = np.asarray(B.get('site', np.zeros(len(polys), bool)), bool)
rng = np.random.default_rng(1962)   # GIDC's founding year

ESTATES = [
    # name, kind, anchors (lat, lon), radius m
    ('Naroda GIDC', 'chem', [(23.0890, 72.6670), (23.0840, 72.6640), (23.0910, 72.6690)], 1700),
    ('Vatva GIDC', 'chem', [(22.9740, 72.6320), (22.9590, 72.6370), (22.9580, 72.6500), (22.9660, 72.6420)], 1800),
    ('Odhav GIDC', 'eng', [(23.0285, 72.6708), (23.0226, 72.6749), (23.0279, 72.6563)], 1300),
    ('Kathwada GIDC', 'eng', [(23.0390, 72.6845), (23.0350, 72.6860)], 900),
    ('Narol textile cluster', 'textile', [(22.9680, 72.6000), (22.9610, 72.5960), (22.9720, 72.5930)], 1300),
    ('Danilimda-Behrampura dyeing units', 'textile', [(22.9951, 72.5740), (22.9897, 72.5782)], 800),
]
KIND = {'chem': 0, 'textile': 1, 'eng': 2, 'power': 3}

cand = (area >= 150) & (hs <= 13.6) & (fab != 1) & (ws != 0) & ~site
CELL = 40.0
estates, factory, fac_est = [], np.zeros(len(polys), bool), np.full(len(polys), -1)
for ei, (name, kind, anchors, R) in enumerate(ESTATES):
    A = np.array([proj_xy(lo, la) for la, lo in anchors], float)
    x0, y0 = A.min(0) - R; x1, y1 = A.max(0) + R
    nx, ny = int((x1 - x0) / CELL) + 1, int((y1 - y0) / CELL) + 1
    sel = cand & (CX > x0) & (CX < x1) & (CY > y0) & (CY < y1)
    cov = np.zeros((ny, nx))
    ix = ((CX[sel] - x0) / CELL).astype(int); iy = ((CY[sel] - y0) / CELL).astype(int)
    np.add.at(cov, (iy, ix), area[sel])
    cov = ndimage.uniform_filter(cov / (CELL * CELL), 5)
    m = cov >= 0.11
    m = ndimage.binary_opening(ndimage.binary_closing(m, iterations=2), iterations=1)
    lab, nlab = ndimage.label(m)
    gx = x0 + (np.arange(nx) + 0.5) * CELL; gy = y0 + (np.arange(ny) + 0.5) * CELL
    GX, GY = np.meshgrid(gx, gy)
    dmin = np.min([np.hypot(GX - ax, GY - ay) for ax, ay in A], axis=0)
    keep = set(np.unique(lab[(dmin < 420) & m])) - {0}
    mask = np.isin(lab, list(keep)) & (dmin < R)
    cells = [shapely.box(gx[i] - CELL / 2, gy[j] - CELL / 2, gx[i] + CELL / 2, gy[j] + CELL / 2) for j, i in zip(*np.nonzero(mask))]
    if not cells:
        print('no estate found for', name); continue
    P = shapely.union_all(cells).buffer(25, quad_segs=2).buffer(-25, quad_segs=2).simplify(12)
    P = max(shapely.get_parts(P), key=lambda g: g.area) if P.geom_type == 'MultiPolygon' and kind != 'chem' else P
    inside = shapely.contains_xy(P, CX, CY) & cand & ~factory
    factory |= inside; fac_est[inside] = ei
    estates.append(dict(name=name, kind=kind, poly=P, lx=float(A[0][0]), ly=float(A[0][1])))   # label on the estate's own roads
    print(f'{name:36s} {P.area / 1e6:5.2f} km2  {int(inside.sum()):5d} factory buildings')

# ---- placement helpers: nothing on a road or inside another building
near = np.nonzero(np.isin(fac_est, range(len(estates))))[0]
bx0 = min(CX[near]) - 300; bx1 = max(CX[near]) + 300; by0 = min(CY[near]) - 300; by1 = max(CY[near]) + 300
road_geoms = []
for r in G['roads']:
    xy = r['xy']
    if xy[:, 0].max() < bx0 or xy[:, 0].min() > bx1 or xy[:, 1].max() < by0 or xy[:, 1].min() > by1:
        continue
    road_geoms.append(shapely.buffer(shapely.LineString(xy), r['hw'] + r['sw'] + 1.0, quad_segs=2))
RT = shapely.STRtree(road_geoms)
BT = shapely.STRtree(polys)
taken = []


def free(x, y, r):
    p = shapely.Point(x, y)
    if len(RT.query(p, predicate='dwithin', distance=r)) or len(BT.query(p, predicate='dwithin', distance=r + 0.6)):
        return False
    for tx, ty, tr in taken[-400:]:
        if (tx - x) ** 2 + (ty - y) ** 2 < (tr + r + 1.0) ** 2:
            return False
    return True


CHIM, TANKS, PONDS = [], [], []   # CHIM: x, y, base, h, r, kind, active, look
P_CH = {'chem': 0.22, 'textile': 0.30, 'eng': 0.07}
ACT = {'chem': 0.75, 'textile': 0.6, 'eng': 0.6}   # share of stacks running at any moment
P_TK = {'chem': 0.38, 'textile': 0.10, 'eng': 0.05}
P_PD = {'chem': 0.10, 'textile': 0.30, 'eng': 0.0}
for i in np.nonzero(factory)[0]:
    est = estates[fac_est[i]]; kind = est['kind']
    rr = np.asarray(shapely.minimum_rotated_rectangle(polys[i]).exterior.coords)[:4]
    e0, e1 = rr[1] - rr[0], rr[2] - rr[1]
    L0, L1 = np.hypot(*e0), np.hypot(*e1)
    u = e0 / L0 if L0 >= L1 else e1 / L1; v = np.array([-u[1], u[0]])
    c = rr.mean(0); hl, hw = max(L0, L1) / 2, min(L0, L1) / 2
    h = rng.random()
    if h < P_CH[kind] * (1.0 if area[i] > 400 else 0.5):
        r = {'chem': 0.45 + 0.35 * rng.random(), 'textile': 0.8 + 0.6 * rng.random(), 'eng': 0.4 + 0.2 * rng.random()}[kind]
        H = {'chem': 16 + 16 * rng.random(), 'textile': 24 + 18 * rng.random(), 'eng': 11 + 8 * rng.random()}[kind]
        look = int(rng.random() < (0.45 if kind == 'textile' else 0.08))      # 1 = brick, 0 = steel
        placed = False
        for su, sv in rng.permutation([(1, 1), (1, -1), (-1, 1), (-1, -1)]):
            x, y = c + u * su * (hl + r + 1.4) + v * sv * (hw * 0.55)
            if free(x, y, r + 0.4):
                CHIM.append((x, y, 0.0, H, r, KIND[kind], int(rng.random() < ACT[kind]), look)); taken.append((x, y, r)); placed = True; break
        if not placed and hl > 4 and hw > 3:   # on the roof of the boiler house instead
            x, y = c + u * (hl - r - 1.5) + v * (hw - r - 1.5) * (1 if rng.random() < 0.5 else -1)
            CHIM.append((x, y, float(hs[i]), H * 0.7, r, KIND[kind], int(rng.random() < ACT[kind]), look))
    if rng.random() < P_TK[kind]:
        n = 1 + int(rng.random() * 3); tr = 1.4 + 1.6 * rng.random(); th = 4 + 7 * rng.random(); col = int(rng.random() * 4)
        su = 1 if rng.random() < 0.5 else -1
        for k in range(n):
            x, y = c + v * su * (hw + tr + 1.2) + u * (k - (n - 1) / 2) * (2 * tr + 0.8)
            if free(x, y, tr):
                TANKS.append((x, y, tr, th, col)); taken.append((x, y, tr))
    if rng.random() < P_PD[kind] and area[i] > 300:
        w, d = 6 + 6 * rng.random(), 4 + 3 * rng.random()
        for su in (1, -1):
            x, y = c - v * su * (hw + d / 2 + 1.5)
            if free(x, y, max(w, d) / 2 + 0.5):
                PONDS.append((x, y, u[0], u[1], w, d, int(rng.random() * 4))); taken.append((x, y, max(w, d) / 2)); break

# ---- Torrent Sabarmati power station: two banded stacks beside the boiler houses
tx, ty = proj_xy(72.593889, 23.070555)
cand_b = np.nonzero((np.hypot(CX - tx, CY - ty) < 420) & (hs >= 22))[0]
power = None
if len(cand_b):
    bh = cand_b[np.argmax(area[cand_b] * hs[cand_b])]
    rr = np.asarray(shapely.minimum_rotated_rectangle(polys[bh]).exterior.coords)[:4]
    e0, e1 = rr[1] - rr[0], rr[2] - rr[1]
    u = e0 / np.hypot(*e0) if np.hypot(*e0) >= np.hypot(*e1) else e1 / np.hypot(*e1); v = np.array([-u[1], u[0]])
    c = rr.mean(0); hl = max(np.hypot(*e0), np.hypot(*e1)) / 2
    for k, H in enumerate((120.0, 105.0)):
        done = False
        for push in (14, 22, 30, 40, 52, 66):
            for side in (1, -1):
                for off in (-18, 18, 0, -36, 36):
                    x, y = c + u * side * (hl + push) + v * off
                    if not done and free(x, y, 4.5):
                        CHIM.append((x, y, 0.0, H, 3.6 - 0.4 * k, KIND['power'], 1, 2)); taken.append((x, y, 4.5)); done = True
        print('power stack', k, 'placed' if done else 'NOT placed')
    power = dict(name='Sabarmati Thermal Power Station', lx=tx, ly=ty)
    print('power station stacks beside building', bh, 'h', round(float(hs[bh]), 1))

# ---- haze over the estates: soft brown cells on a 260 m grid
HAZE = []
for e in estates:
    P = e['poly']; x0, y0, x1, y1 = P.bounds
    for x in np.arange(x0, x1, 260):
        for y in np.arange(y0, y1, 260):
            jx, jy = x + rng.random() * 120, y + rng.random() * 120
            if shapely.contains_xy(P, jx, jy):
                HAZE.append((jx, jy, KIND[e['kind']]))

CHIM, TANKS, PONDS, HAZE = (np.array(a, float) if len(a) else np.zeros((0, 8)) for a in (CHIM, TANKS, PONDS, HAZE))
print('stacks', len(CHIM), 'active', int(CHIM[:, 6].sum()) if len(CHIM) else 0, 'tanks', len(TANKS), 'effluent tanks', len(PONDS), 'haze cells', len(HAZE))
pickle.dump(dict(factory=factory, fac_est=fac_est, estates=estates, power=power, chim=CHIM, tanks=TANKS, ponds=PONDS, haze=HAZE),
            open(f'{OUT}/industry.pkl', 'wb'))
print('done', round(time.time() - t0, 1))

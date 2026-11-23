"""Monsoon waterlogging spots: where water collects on the road when a rain cell passes over.

1. Underpasses: every road edge OSM tags tunnel=yes (Akhbarnagar, Parimal, Usmanpura, Income Tax, Paldi, Thaltej,
   Gota Road, Galaxy Cinema, Bhadaj, Ognaj and the unnamed rail underpasses) - deep, slow to drain.
2. Areas the AMC / press keep reporting as waterlogged (Shivranjani, Sindhu Bhavan Road, Prahladnagar, Vastrapur,
   Vejalpur, Bopal, Mithakhali, Maninagar, Khokhra-Hatkeshwar, Nikol, Odhav, Vatva, Kathwada, Gota, Tragad, Isanpur,
   Vastral, Chandkheda): a handful of at-grade road spots each.
3. Scattered low spots on minor roads all over the city: shallow, quick to drain.
Output: OUT/weather.pkl  spots = [x, y, ux, uy, length, width, capacity, kind]
"""
import pickle, json, math, re, time, numpy as np, shapely
from lxml import etree
from common import *

t0 = time.time()
G = pickle.load(open(f'{OUT}/ground.pkl', 'rb'))
rng = np.random.default_rng(615)   # 15 June: the monsoon's normal onset date in Gujarat
roads = [r for r in G['roads'] if not r['bridge']]
segs = []   # (ax, ay, bx, by, hw, cls)
for r in roads:
    xy = r['xy']
    for k in range(len(xy) - 1):
        segs.append((xy[k, 0], xy[k, 1], xy[k + 1, 0], xy[k + 1, 1], r['hw'], r['cls']))
S = np.array(segs)
mid = (S[:, :2] + S[:, 2:4]) / 2
L = np.hypot(S[:, 2] - S[:, 0], S[:, 3] - S[:, 1])
T = shapely.STRtree(shapely.points(mid))
spots = []


def nearest_seg(x, y, maxd=25, cls_ok=None):
    idx = T.query(shapely.Point(x, y), predicate='dwithin', distance=maxd + 40)
    best, bd = None, 1e9
    for i in idx:
        if cls_ok is not None and S[i, 5] not in cls_ok: continue
        ax, ay, bx, by = S[i, :4]; dx, dy = bx - ax, by - ay; l2 = dx * dx + dy * dy or 1
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / l2)); d = math.hypot(ax + dx * t - x, ay + dy * t - y)
        if d < bd: bd, best = d, i
    return best if bd <= maxd else None


def add(i, kind, cap, length=None, at=None):
    ax, ay, bx, by, hw, cls = S[i]
    ux, uy = (bx - ax) / (L[i] or 1), (by - ay) / (L[i] or 1)
    x, y = at if at is not None else mid[i]
    for s in spots:
        if (s[0] - x) ** 2 + (s[1] - y) ** 2 < 40 ** 2: return False
    ln = length or min(max(L[i] * 0.8, 10), 40)
    spots.append((float(x), float(y), float(ux), float(uy), float(ln), float(hw * 2 + 1.0), float(cap), kind))
    return True


# 1. underpasses from the OSM road graph
ns = '{http://graphml.graphdrawing.org/xmlns}'
nodes, tun = {}, []
for ev, el in etree.iterparse(f'{DATA}/ahmedabad.graphml', tag=(ns + 'node', ns + 'edge')):
    d = {c.get('key'): c.text for c in el}
    if el.tag == ns + 'node':
        nodes[el.get('id')] = (float(d['d5']), float(d['d4']))
    elif d.get('d25') == 'yes':
        tun.append((d.get('d18'), el.get('source'), el.get('target')))
    el.clear()
nu = 0
for nm, s, t in tun:
    (lo0, la0), (lo1, la1) = nodes[s], nodes[t]
    x0, y0 = proj_xy(lo0, la0); x1, y1 = proj_xy(lo1, la1)
    x, y = (x0 + x1) / 2, (y0 + y1) / 2
    i = nearest_seg(float(x), float(y), 20)
    if i is not None and add(i, 0, 1.0, length=float(min(70, max(30, math.hypot(x1 - x0, y1 - y0)))), at=(float(x), float(y))): nu += 1
print('underpass spots', nu)

# 2. areas the city reports as waterlogging-prone (lat, lon from the named roads / ward centres in the data)
AREAS = [('Shivranjani', 23.0240, 72.5307, 450, 5), ('Sindhu Bhavan Road', 23.0412, 72.4964, 700, 7), ('Prahladnagar', 23.0084, 72.5087, 600, 6),
         ('Vastrapur', 23.0424, 72.5322, 500, 5), ('Vejalpur', 23.0069, 72.5183, 600, 6), ('Bopal', 23.0274, 72.4904, 700, 7),
         ('Bopal DPS', 23.0445, 72.4659, 600, 5), ('Mithakhali', 23.0312, 72.5641, 350, 4), ('Khokhra-Hatkeshwar', 23.0019, 72.6189, 600, 6),
         ('Nikol', 23.0554, 72.6637, 700, 6), ('Odhav', 23.0229, 72.6548, 600, 6), ('Vatva', 22.9742, 72.6301, 600, 6),
         ('Kathwada', 23.0346, 72.6870, 500, 5), ('Gota', 23.0894, 72.5410, 600, 5), ('Tragad', 23.1191, 72.5599, 500, 4)]
for w in G['wards']:
    if w['name'] in ('Maninagar', 'Isanpur', 'Vastral', 'Chandkheda', 'Bhaipura Hatkeshwar', 'Shahibag'):
        lo, la = unproj_xy(w['x'], w['y']); AREAS.append((w['name'], float(la), float(lo), 650, 6))
na = 0
for nm, la, lo, R, k in AREAS:
    cx, cy = proj_xy(lo, la)
    idx = T.query(shapely.Point(float(cx), float(cy)), predicate='dwithin', distance=R)
    idx = [i for i in idx if S[i, 5] in (1, 2, 3, 5, 6) and L[i] > 12]
    rng.shuffle(idx); got = 0
    for i in idx:
        if got >= k: break
        if add(i, 1, 0.75): got += 1
    na += got
print('area spots', na, 'in', len(AREAS), 'areas')

# 3. scattered shallow puddles on minor roads across the city
cand = np.nonzero(np.isin(S[:, 5], (0, 1, 2)) & (L > 15))[0]
rng.shuffle(cand); nm_ = 0
for i in cand[:6000]:
    if nm_ >= 420: break
    if add(i, 2, 0.4, length=float(min(18, L[i] * 0.6))): nm_ += 1
print('minor spots', nm_, 'total', len(spots), round(time.time() - t0, 1), 's')
pickle.dump(dict(spots=spots), open(f'{OUT}/weather.pkl', 'wb'))

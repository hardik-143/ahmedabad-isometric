"""Stage 2: roads (OSM graph), water, parks, rail, wards, labels. Writes ground.pkl"""
import pickle, json, time, math, re, numpy as np, shapely
import xml.etree.ElementTree as ET
from common import *

t0 = time.time()
x0, y0, x1, y1 = bbox_m()
BOX = shapely.box(x0, y0, x1, y1)

# ---------------- roads ----------------
ns = '{http://graphml.graphdrawing.org/xmlns}'
nodes = {}
edges = []
for ev, el in ET.iterparse(f'{DATA}/ahmedabad.graphml'):
    if el.tag == ns + 'node':
        d = {c.get('key'): c.text for c in el}
        nodes[el.get('id')] = (float(d['d5']), float(d['d4']))
        el.clear()
    elif el.tag == ns + 'edge':
        d = {c.get('key'): c.text for c in el}
        edges.append((el.get('source'), el.get('target'), d))
        el.clear()
print('graph', len(nodes), len(edges), round(time.time() - t0, 1))


def first(v):
    if v is None:
        return None
    v = v.strip()
    if v.startswith('['):
        m = re.findall(r"'([^']*)'", v)
        return m[0] if m else None
    return v


CLS = {'living_street': 0, 'residential': 1, 'road': 1, 'unclassified': 2, 'tertiary': 3,
       'tertiary_link': 4, 'secondary_link': 4, 'primary_link': 4, 'trunk_link': 4, 'motorway_link': 4,
       'secondary': 5, 'primary': 6, 'busway': 7, 'trunk': 8, 'motorway': 9}
# half-width of carriageway, sidewalk width
HW = [2.6, 3.3, 3.5, 4.6, 3.8, 6.0, 7.2, 3.8, 9.0, 11.0]
SW = [0.0, 0.7, 0.8, 1.6, 0.8, 2.2, 2.6, 0.6, 2.6, 1.2]

OC_X, OC_Y = proj_xy(72.5895, 23.0255)
OC_RX, OC_RY = 0.0175 * KX, 0.0150 * KY
seen = set()
roads = []  # dict(cls, name, bridge, oneway, coords(lonlat))
for u, v, d in edges:
    hw = first(d.get('d12'))
    if hw not in CLS:
        continue
    if 'd17' in d:
        coords = [tuple(map(float, p.split())) for p in d['d17'][d['d17'].index('(') + 1:-1].split(',')]
    else:
        coords = [nodes[u], nodes[v]]
    a, b = (u, v) if u <= v else (v, u)
    cc = coords if u <= v else coords[::-1]
    key = (a, b, round(cc[len(cc) // 2][0], 6), round(cc[len(cc) // 2][1], 6))
    if key in seen:
        continue
    seen.add(key)
    br = d.get('d19')
    roads.append(dict(cls=CLS[hw], name=first(d.get('d18')), bridge=bool(br and br not in ('no', 'False')),
                      oneway=(d.get('d13') == 'True'), coords=cc, u=a, v=b))
print('dedup roads', len(roads))

lines = np.array([shapely.LineString(r['coords']) for r in roads], dtype=object)
lines = proj_geom(lines)
keep = shapely.intersects(lines, BOX)
roads = [r for r, k in zip(roads, keep) if k]
lines = lines[keep]
lines = shapely.intersection(lines, BOX)
lines = shapely.simplify(lines, 0.4)
def smooth(c, maxcut, iters=3):
    """Chaikin corner cutting with a capped cut length: bends become arcs, straight runs and real
    geometry stay put (cuts never exceed maxcut metres from a vertex). Endpoints are fixed."""
    c = np.asarray(c, float)
    for _ in range(iters):
        if len(c) < 3:
            break
        d = np.diff(c, axis=0); L = np.hypot(d[:, 0], d[:, 1]) + 1e-9
        u = d / L[:, None]
        turn = np.abs(np.arctan2(u[:-1, 0] * u[1:, 1] - u[:-1, 1] * u[1:, 0], (u[:-1] * u[1:]).sum(1)))
        out = [c[0]]
        for i in range(1, len(c) - 1):
            if turn[i - 1] < math.radians(3):
                out.append(c[i]); continue
            ca = min(0.25 * L[i - 1], maxcut); cb = min(0.25 * L[i], maxcut)
            out.append(c[i] - u[i - 1] * ca); out.append(c[i] + u[i] * cb)
        out.append(c[-1])
        c = np.array(out); maxcut *= 0.5
    return c


R2 = []
for r, ln in zip(roads, lines):
    for p in shapely.get_parts(ln):
        if shapely.get_type_id(p) != 1 or p.length < 0.5:
            continue
        hw = HW[r['cls']]
        c = smooth(np.asarray(p.coords), 8.0 + 2.5 * hw)
        if len(c) > 2:   # drop the near-collinear points the smoothing left on straight runs
            c = np.asarray(shapely.simplify(shapely.LineString(c), 0.12).coords)
        if r['oneway'] and r['cls'] >= 5:
            hw *= 0.62
        mx, my = c[len(c) // 2]
        if r['cls'] <= 2 and ((mx - OC_X) / OC_RX) ** 2 + ((my - OC_Y) / OC_RY) ** 2 < 1.0:
            hw *= 0.62   # narrow pol lanes inside the walled city
        R2.append(dict(cls=r['cls'], name=r['name'], bridge=r['bridge'], hw=hw, sw=SW[r['cls']], xy=c))
R2.sort(key=lambda r: (r['cls'], r['bridge']))

# ---- Ellis Bridge: the 1892 steel bowstring bridge (433.41 m, 14 spans, 6.25 m wide) stands between the two 1997-99
# concrete wings of the Swami Vivekananda Bridge. OSM's wing centrelines leave too narrow a slot for it, so push the
# wings apart over the crossing (tapered to nothing at their ends so the approaches and Ellis Flyover still meet them).
ELLIS = None
_ex, _ey = proj_xy(72.57528, 23.02222)          # Wikipedia 23 01 20 N, 72 34 31 E
_wing = [r for r in R2 if r['bridge'] and r['name'] in ('Swami Vivekananda Road', 'Swami Vivekananda Bridge')
         and shapely.LineString(r['xy']).distance(shapely.Point(_ex, _ey)) < 120 and shapely.LineString(r['xy']).length > 300]
if len(_wing) == 2:
    _la, _lb = (shapely.LineString(r['xy']) for r in _wing)
    _sep = np.mean([_lb.distance(shapely.Point(p)) for p in np.asarray(_la.coords)])
    _need = 2 * (_wing[0]['hw'] + _wing[0]['sw']) + 9.0           # parapet-to-parapet slot for the old trusses
    _push = max(0.0, (_need - _sep) / 2)
    for r, other in ((_wing[0], _lb), (_wing[1], _la)):
        c = np.asarray(r['xy'], float); L = shapely.LineString(c).length
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))])
        tw = np.clip(np.minimum(s, L - s) / 70.0, 0, 1); tw = tw * tw * (3 - 2 * tw)
        for j in range(len(c)):
            q = other.interpolate(other.project(shapely.Point(c[j])))
            d = c[j] - np.array([q.x, q.y]); dl = np.hypot(*d) or 1.0
            c[j] = c[j] + d / dl * _push * tw[j]
        r['xy'] = c
    _a0, _a1 = np.asarray(_wing[0]['xy']), np.asarray(_wing[1]['xy'])
    _e0 = (_a0[0] + (_a1[0] if np.hypot(*(_a1[0] - _a0[0])) < np.hypot(*(_a1[-1] - _a0[0])) else _a1[-1])) / 2
    _e1 = (_a0[-1] + (_a1[-1] if np.hypot(*(_a1[-1] - _a0[-1])) < np.hypot(*(_a1[0] - _a0[-1])) else _a1[0])) / 2
    ELLIS = dict(p0=tuple(_e0), p1=tuple(_e1), slot=_need - 2 * (_wing[0]['hw'] + _wing[0]['sw']))
    print(f'Ellis Bridge: wings {_sep:.1f} m apart, pushed out {_push:.2f} m each; midline {np.hypot(*(_e1 - _e0)):.0f} m')
else:
    print('Ellis Bridge: wings not found', len(_wing))
print('road polylines', len(R2), 'pts', sum(len(r['xy']) for r in R2), round(time.time() - t0, 1))

# junction discs: endpoints with max half-width
jun = {}
for r in R2:
    for pt in (r['xy'][0], r['xy'][-1]):
        k = (round(pt[0], 1), round(pt[1], 1))
        w = r['hw'] + r['sw']
        if k not in jun or jun[k][0] < w:
            jun[k] = (w, r['hw'], r['cls'])
print('junctions', len(jun))

# road labels: merge by name for tertiary+
from collections import defaultdict
byname = defaultdict(list)
for r in R2:
    if r['name'] and r['cls'] >= 3:
        byname[r['name']].append(shapely.LineString(r['xy']))
road_labels, search_roads = [], []
for nm, ls in byname.items():
    merged = shapely.line_merge(shapely.MultiLineString(ls))
    parts = list(shapely.get_parts(merged))
    parts.sort(key=lambda p: -p.length)
    tot = sum(p.length for p in parts)
    if tot < 150:
        continue
    best = parts[0]
    mid = best.interpolate(0.5, normalized=True)
    cls = max(r['cls'] for r in R2 if r['name'] == nm) if False else None
    search_roads.append((nm, mid.x, mid.y, tot))
    for p in parts:
        if p.length < 180:
            continue
        step = 750.0
        d = min(250.0, p.length / 2)
        while d < p.length - 60 or (d == p.length / 2):
            a = p.interpolate(max(0, d - 20)); b = p.interpolate(min(p.length, d + 20)); c = p.interpolate(d)
            ang = math.atan2(b.y - a.y, b.x - a.x)
            road_labels.append((nm, c.x, c.y, ang))
            d += step
            if p.length < 2 * step and d > p.length / 2 + 1:
                break
print('road labels', len(road_labels), 'named roads', len(search_roads))

# ---------------- water ----------------
cd = json.load(open(f'{DATA}/city-data.json'))
A_LAT0, A_LON0, A_R = 23.030, 72.580, 6378137.0
A_COS = math.cos(math.radians(A_LAT0))


def amap_to_m(pts):
    p = np.asarray(pts, dtype=float)
    lon = p[:, 0] / (math.radians(1) * A_R * A_COS) + A_LON0
    lat = p[:, 1] / (math.radians(1) * A_R) + A_LAT0
    x, y = proj_xy(lon, lat)
    return np.column_stack([x, y])


cx0, cy0 = proj_xy(72.535, 22.985); cx1, cy1 = proj_xy(72.625, 23.075)
CENTRAL = shapely.box(cx0, cy0, cx1, cy1)
osm_water = []
for w in cd['water']:
    p = shapely.Polygon(amap_to_m(w['pts']))
    if not p.is_valid:
        p = shapely.make_valid(p)
    osm_water.append(p)
for w in cd['waterways']:
    if w['w'] >= 20:
        continue
    ln = shapely.LineString(amap_to_m(w['pts']))
    osm_water.append(ln.buffer(w['w'] / 2, quad_segs=2))
osm_water = shapely.union_all(osm_water)


def load_gj(name):
    d = json.load(open(f'{DATA}/{name}'))
    return [shapely.geometry.shape(f['geometry']) for f in d['features']], [f['properties'] for f in d['features']]


wris, wp = load_gj('WRIS_River_Polygons.ahd.geojson')
sbm, sp = load_gj('SBM_Water_bodies.ahd.geojson')
other = proj_geom(np.array([shapely.make_valid(g) for g in wris + sbm], dtype=object))
other = shapely.difference(shapely.union_all(other), CENTRAL)
water = shapely.union_all([osm_water, other])
water = shapely.intersection(water, BOX)
water = shapely.simplify(water, 1.0)
water_polys = [p for p in shapely.get_parts(water) if shapely.get_type_id(p) == 3 and p.area > 200]
print('water polys', len(water_polys), 'km2', round(sum(p.area for p in water_polys) / 1e6, 2))

# ---------------- parks ----------------
pk, pp = load_gj('parks_ahmedabad.geojson')
pk = list(proj_geom(np.array([shapely.make_valid(g) for g in pk], dtype=object)))
for w in cd['parks']:
    p = shapely.Polygon(amap_to_m(w['pts']))
    pk.append(shapely.make_valid(p))
parks = shapely.union_all(pk)
parks = shapely.difference(parks, water)
parks = shapely.intersection(parks, BOX)
parks = shapely.simplify(parks, 0.8)
park_polys = [p for p in shapely.get_parts(parks) if shapely.get_type_id(p) == 3 and p.area > 150]
print('park polys', len(park_polys), 'km2', round(sum(p.area for p in park_polys) / 1e6, 2))

# ---------------- rail ----------------
tr, tp = load_gj('IR_Tracks.ahd.geojson')
tr = proj_geom(np.array(tr, dtype=object))
tr = shapely.intersection(shapely.union_all(tr), BOX)
tr = shapely.line_merge(tr)
rail = [np.asarray(p.coords) for p in shapely.get_parts(shapely.simplify(tr, 1.0)) if shapely.get_type_id(p) == 1 and p.length > 20]
print('rail lines', len(rail), 'km', round(sum(np.hypot(*np.diff(r, axis=0).T).sum() for r in rail) / 1000, 1))

st, sp2 = load_gj('IR_Stations.ahd.geojson')
stations = []
for g, p in zip(st, sp2):
    nm = (p.get('fdetail') or p.get('stnname') or p.get('name') or '').strip()
    nm = re.sub(r'\s*(Railway Station|RAILWAY STATION|Rly Stn|Station)\s*$', '', nm).strip()
    if not nm or len(nm) < 3:
        continue
    x, y = proj_xy(g.x, g.y)
    if not (x0 < x < x1 and y0 < y < y1):
        continue
    if any(abs(x - s[1]) < 300 and abs(y - s[2]) < 300 for s in stations):
        continue
    stations.append((nm.title(), float(x), float(y)))
print('stations', stations)

# ---------------- flyovers & bridges ----------------
# OSMnx merges ways, so a bridge tag can cover kilometres of at-grade road. Raise a road only where it
# actually passes over another road (no shared node), a railway or water; ramps at 1:16 to a 7 m deck.
DECK, GRAD = 7.0, 1.0 / 16
flat_lines = [shapely.LineString(r['xy']) for r in R2 if not r['bridge']]
flat_tree = shapely.STRtree(flat_lines)
water_u = shapely.union_all(water_polys)
rail_u = shapely.union_all([shapely.LineString(r) for r in rail]) if rail else None
bidx = [i for i, r in enumerate(R2) if r['bridge']]
chains = [c for c in shapely.get_parts(shapely.line_merge(shapely.MultiLineString([R2[i]['xy'] for i in bidx]))) if c.length > 1]
chain_iv = []
for chn in chains:
    L = chn.length; cv = np.asarray(chn.coords); iv = []
    for j in flat_tree.query(chn, predicate='intersects'):
        for p in shapely.get_parts(chn.intersection(flat_lines[j])):
            if p.geom_type != 'Point':
                continue
            if np.min(np.hypot(cv[:, 0] - p.x, cv[:, 1] - p.y)) < 0.6:
                continue  # shares a node: at-grade junction
            s0 = chn.project(p); iv.append((s0 - 55, s0 + 55))
    if rail_u is not None:
        for p in shapely.get_parts(chn.intersection(rail_u)):
            if p.geom_type == 'Point':
                s0 = chn.project(p); iv.append((s0 - 70, s0 + 70))
    for seg in shapely.get_parts(chn.intersection(water_u)):
        if seg.geom_type == 'LineString' and seg.length > 4:
            a_ = chn.project(shapely.Point(seg.coords[0])); b_ = chn.project(shapely.Point(seg.coords[-1]))
            iv.append((min(a_, b_) - 20, max(a_, b_) + 20))
    iv.sort(); merged = []
    for a_, b_ in iv:
        if merged and a_ <= merged[-1][1] + 120:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b_))
        else:
            merged.append((a_, b_))
    chain_iv.append((L, merged))


def chain_h(k, s):
    L, ivs = chain_iv[k]
    h = np.zeros_like(s)
    for a_, b_ in ivs:
        d = np.maximum(0, np.maximum(a_ - s, s - b_))
        h = np.maximum(h, DECK - GRAD * d)
    h = np.minimum(h, GRAD * np.minimum(s, L - s))   # chain ends meet the ground
    return np.clip(h, 0, DECK)


ctree = shapely.STRtree(np.array(chains, dtype=object))
newR = [r for r in R2 if not r['bridge']]
n_el = 0; el_len = 0.0
for i in bidx:
    r = R2[i]
    ln = shapely.segmentize(shapely.LineString(r['xy']), 8.0)
    k = ctree.query(ln.interpolate(0.5, normalized=True), predicate='dwithin', distance=0.5)
    c = np.asarray(ln.coords)
    if len(k) == 0:
        newR.append(dict(r, bridge=False)); continue
    k = int(k[0])
    s = np.array([chains[k].project(shapely.Point(p)) for p in c])
    h = chain_h(k, s)
    up = h > 0.05
    if not up.any():
        newR.append(dict(r, bridge=False, xy=np.asarray(shapely.simplify(shapely.LineString(c), 0.4).coords))); continue
    # split into elevated runs (padded by one vertex) and flat runs
    j = 0; n = len(c)
    while j < n:
        if up[j]:
            a0 = max(0, j - 1)
            while j < n and up[j]:
                j += 1
            b0 = min(n - 1, j)
            newR.append(dict(r, bridge=True, xy=c[a0:b0 + 1], z=h[a0:b0 + 1]))
            n_el += 1; el_len += shapely.LineString(c[a0:b0 + 1]).length
        else:
            a0 = j
            while j < n and not up[j]:
                j += 1
            b0 = min(n - 1, j)
            if b0 > a0:
                newR.append(dict(r, bridge=False, xy=np.asarray(shapely.simplify(shapely.LineString(c[a0:b0 + 1]), 0.4).coords)))
R2 = newR
R2.sort(key=lambda r: (r['cls'], r['bridge']))
print(f'elevated pieces {n_el}, {el_len / 1000:.1f} km of deck+ramps')

# ---- piers: ~28 m apart under decks over 3.5 m; twin carriageways share aligned positions ----
pieces = [r for r in R2 if r['bridge']]
plines = [shapely.LineString(r['xy']) for r in pieces]
# chain id per piece (pieces touching end-to-end belong to one flyover) for hover highlighting
parent_ = list(range(len(pieces)))
def _f(i):
    while parent_[i] != i:
        parent_[i] = parent_[parent_[i]]; i = parent_[i]
    return i
ends = {}
for i, r in enumerate(pieces):
    for pt in (r['xy'][0], r['xy'][-1]):
        k = (round(pt[0]), round(pt[1]))
        if k in ends:
            parent_[_f(i)] = _f(ends[k])
        else:
            ends[k] = i
ptree = shapely.STRtree(plines)
for i in range(len(pieces)):   # parallel twin decks within 30 m also share a chain
    for j in ptree.query(plines[i].buffer(30), predicate='intersects'):
        if j != i and plines[i].length > 60 and plines[j].length > 60 and plines[i].hausdorff_distance(plines[j]) < 60:
            parent_[_f(i)] = _f(j)
roots = {}
chain_of = [roots.setdefault(_f(i), len(roots)) for i in range(len(pieces))]
piers, grid = [], {}
order = sorted(range(len(pieces)), key=lambda i: -plines[i].length)
for i in order:
    ln, r = plines[i], pieces[i]
    c = np.asarray(r['xy']); z = np.asarray(r['z'])
    cs = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))]); L = cs[-1]
    snap = []
    gx0, gy0, gx1, gy1 = [int(v // 60) for v in ln.buffer(35).bounds]
    for gx in range(gx0, gx1 + 1):
        for gy in range(gy0, gy1 + 1):
            for (px, py, pux, puy, pi_) in grid.get((gx, gy), []):
                if pi_ == i:
                    continue
                sp = ln.project(shapely.Point(px, py))
                if 2 < sp < L - 2:
                    q = ln.interpolate(sp)
                    if q.distance(shapely.Point(px, py)) < 30:
                        a_ = ln.interpolate(max(0, sp - 3)); b_ = ln.interpolate(min(L, sp + 3))
                        tx, ty = b_.x - a_.x, b_.y - a_.y; tl = np.hypot(tx, ty) or 1
                        if abs(tx / tl * pux + ty / tl * puy) > 0.85:
                            snap.append(sp)
    ss = sorted(set(round(v, 1) for v in snap))
    reg = [v for v in np.arange(14, L - 10, 28.0) if all(abs(v - w) > 14 for w in ss)]
    for sp in sorted(ss + list(reg)):
        h = float(np.interp(sp, cs, z))
        if h < 3.5:
            continue
        p = ln.interpolate(sp); a_ = ln.interpolate(max(0, sp - 3)); b_ = ln.interpolate(min(L, sp + 3))
        tx, ty = b_.x - a_.x, b_.y - a_.y; tl = np.hypot(tx, ty) or 1
        ux_, uy_ = tx / tl, ty / tl
        piers.append((p.x, p.y, ux_, uy_, h, (r['hw'] + max(r['sw'], 0.6)) * 0.82, chain_of[i]))
        grid.setdefault((int(p.x // 60), int(p.y // 60)), []).append((p.x, p.y, ux_, uy_, i))
print('piers', len(piers), 'flyover chains', len(roots))

jun = {}
for r in R2:
    for e, pt in ((0, r['xy'][0]), (-1, r['xy'][-1])):
        if r['bridge'] and r['z'][e] > 0.3:
            continue
        k = (round(pt[0], 1), round(pt[1], 1))
        w = r['hw'] + r['sw']
        if k not in jun or jun[k][0] < w:
            jun[k] = (w, r['hw'], r['cls'])
print('junctions', len(jun))

# Atal Bridge (pedestrian, kite-inspired roof): Wikipedia centre, 300 m long, 10-14 m wide, laid square to the river
ax, ay = proj_xy(72.57544637, 23.01647035)
loc = shapely.Point(ax, ay).buffer(450).intersection(water_u)
rr = np.array(shapely.minimum_rotated_rectangle(loc).exterior.coords)
e1, e2 = rr[1] - rr[0], rr[2] - rr[1]
e = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
u = e / np.hypot(*e); v = np.array([-u[1], u[0]])
# measure the actual river crossing along the bridge axis, then land 35 m beyond each bank
axis = shapely.LineString([(ax - v[0] * 700, ay - v[1] * 700), (ax + v[0] * 700, ay + v[1] * 700)])
segs = [g for g in shapely.get_parts(axis.intersection(water_u)) if g.geom_type == 'LineString']
seg = min(segs, key=lambda g: g.distance(shapely.Point(ax, ay)))
sa, sb = sorted(axis.project(shapely.Point(c)) - 700 for c in (seg.coords[0], seg.coords[-1]))
L0, L1 = min(sa - 35, -150), max(sb + 35, 150)
atal = dict(x0=float(ax + v[0] * L0), y0=float(ay + v[1] * L0), x1=float(ax + v[0] * L1), y1=float(ay + v[1] * L1),
            w=12.0, deck=6.5, ws0=float(sa - L0), ws1=float(sb - L0))
print(f'atal crossing: water {sb - sa:.0f} m, bridge {L1 - L0:.0f} m')
print('atal', atal)

# ---------------- wards ----------------
wd, wpp = load_gj('wards.geojson')
wards = []
for g, p in zip(wd, wpp):
    g = shapely.make_valid(proj_geom(g))
    nm = re.sub(r'^\d+\s*', '', p['Name']).strip().title()
    c = shapely.maximum_inscribed_circle(g if g.geom_type == 'Polygon' else max(g.geoms, key=lambda q: q.area), 5)
    lab = shapely.get_point(c, 0)
    simp = shapely.simplify(g, 12)
    rings = []
    for q in shapely.get_parts(simp):
        if q.geom_type == 'Polygon':
            rings.append(np.round(np.asarray(q.exterior.coords)).astype(int).tolist())
    wards.append(dict(name=nm, x=round(lab.x), y=round(lab.y), rings=rings, area=g.area))
print('wards', len(wards))

pickle.dump(dict(ellis=ELLIS, roads=R2, junctions=jun, road_labels=road_labels, search_roads=search_roads, atal=atal, piers=piers, deck_chain=chain_of,
                 water=water_polys, parks=park_polys, rail=rail, stations=stations, wards=wards,
                 HW=HW, SW=SW), open(f'{OUT}/ground.pkl', 'wb'))
print('done', round(time.time() - t0, 1))

"""Stage 2b: Ahmedabad Metro (GTFS alignment + timetable) and the Sabarmati Riverfront channel. Writes transit.pkl

Metro: alignments come from the GTFS shapes of croyla/amd-gtfs (ODbL); rail levels follow the GMRC DPR
(about 8.5-9 m between stations, 12 m at stations with a concourse below), are raised to clear road flyovers
and railways, and the Blue Line dives underground between the Sabarmati's east bank and Apparel Park.
Riverfront: the river is held in a fixed channel between retaining walls from Vasna Barrage up to the new
barrage-cum-bridge at Acher; a lower promenade runs just above the water, the upper promenade along the top.
"""
import pickle, math, zipfile, io, csv, time, numpy as np, shapely
from collections import defaultdict
from shapely.geometry.polygon import orient
from common import *

t0 = time.time()
G = pickle.load(open(f'{OUT}/ground.pkl', 'rb'))
x0, y0, x1, y1 = bbox_m()
BOX = shapely.box(x0, y0, x1, y1)


def smooth(c, maxcut, iters=4):
    c = np.asarray(c, float)
    for _ in range(iters):
        if len(c) < 3:
            break
        d = np.diff(c, axis=0); L = np.hypot(d[:, 0], d[:, 1]) + 1e-9
        u = d / L[:, None]
        turn = np.abs(np.arctan2(u[:-1, 0] * u[1:, 1] - u[:-1, 1] * u[1:, 0], (u[:-1] * u[1:]).sum(1)))
        out = [c[0]]
        for i in range(1, len(c) - 1):
            if turn[i - 1] < math.radians(0.5):
                out.append(c[i]); continue
            ca = min(0.25 * L[i - 1], maxcut); cb = min(0.25 * L[i], maxcut)
            out.append(c[i] - u[i - 1] * ca); out.append(c[i] + u[i] * cb)
        out.append(c[-1])
        c = np.array(out); maxcut *= 0.5
    return c


def chain(c):
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))])


def resample(c, step):
    s = chain(c)
    n = max(2, int(math.ceil(s[-1] / step)) + 1)
    t = np.linspace(0, s[-1], n)
    return np.column_stack([np.interp(t, s, c[:, 0]), np.interp(t, s, c[:, 1])])


def tangents(c):
    d = np.gradient(c, axis=0)
    return d / (np.hypot(d[:, 0], d[:, 1])[:, None] + 1e-9)


def at(c, s_cum, s):
    return np.array([np.interp(s, s_cum, c[:, 0]), np.interp(s, s_cum, c[:, 1])])


def dir_at(c, s_cum, s, h=6.0):
    a = at(c, s_cum, max(0, s - h)); b = at(c, s_cum, min(s_cum[-1], s + h))
    d = b - a
    return d / (np.hypot(*d) + 1e-9)


# =====================================================================================================
# Sabarmati Riverfront: the channel between Vasna Barrage and the Acher barrage-cum-bridge
# =====================================================================================================
water = list(G['water'])
riv = max(water, key=lambda p: p.area)
PROM = 10.0      # lower promenade width (SRFDCL: 6-18 m; 11 m typical)
WATER_Y, PROM_Y = -5.6, -4.5   # water level and lower promenade, below the upper promenade / city level (0)


def chord(px, py, poly, angles=None, L=2500.0):
    """shortest straight crossing of the river polygon through (px, py)"""
    best = None
    P = shapely.Point(px, py)
    for a in (angles if angles is not None else np.radians(np.arange(0, 180, 1.0))):
        ux, uy = math.cos(a), math.sin(a)
        ln = shapely.LineString([(px - ux * L, py - uy * L), (px + ux * L, py + uy * L)])
        for g in shapely.get_parts(ln.intersection(poly)):
            if g.geom_type == 'LineString' and g.distance(P) < 1.0:
                if best is None or g.length < best[0]:
                    best = (g.length, np.asarray(g.coords)[[0, -1]], (ux, uy))
    return best


# south end: Vasna Barrage (Wikipedia coordinates); north end: the barrage-cum-bridge being built at Acher /
# Camp Sadar Bazar for Riverfront Phase 2 (OSM bridge crossing the river at 23.0883 N)
sx, sy = proj_xy(72.55566373, 22.99042331)
cS = chord(float(sx), float(sy), riv)
nb = None
for r in G['roads']:
    if r['bridge'] and r['name'] is None:
        ls = shapely.LineString(r['xy'])
        lo, la = unproj_xy(*np.asarray(r['xy']).mean(0))
        if abs(la - 23.0883) < 0.004 and abs(lo - 72.6039) < 0.004 and ls.intersection(riv).length > 200:
            nb = ls if nb is None else nb.union(ls)
nmid = shapely.line_merge(nb).intersection(riv) if nb is not None else None
if nmid is not None and not nmid.is_empty:
    q = shapely.get_parts(nmid)
    q = max(q, key=lambda g: g.length)
    m = q.interpolate(0.5, normalized=True)
    cN = chord(m.x, m.y, riv)
else:
    nx_, ny_ = proj_xy(72.6039, 23.0883)
    cN = chord(float(nx_), float(ny_), riv)
print(f'riverfront cuts: south {cS[0]:.0f} m wide, north {cN[0]:.0f} m wide')

ref = shapely.Point(*proj_xy(72.5747, 23.0270))   # Nehru Bridge, mid river


def beyond(cut, inside_pt, far=4000.0, ext=500.0):
    a, b = np.asarray(cut[1][0], float), np.asarray(cut[1][1], float)
    u = (b - a) / np.hypot(*(b - a)); n = np.array([-u[1], u[0]])
    if np.dot(np.array([inside_pt.x, inside_pt.y]) - a, n) > 0:
        n = -n
    A, B = a - u * ext, b + u * ext
    return shapely.Polygon([A, B, B + n * far, A + n * far])


BS, BN = beyond(cS, ref), beyond(cN, ref)
CH = riv.difference(BS).difference(BN)
CH = min(shapely.get_parts(CH), key=lambda g: g.distance(ref))
H0 = CH.buffer(PROM, quad_segs=6).difference(BS).difference(BN)
# keep at-grade roads out of the channel: where a road runs closer than the promenade width the wall
# follows the road edge instead (the promenade narrows, as it does in reality around bridge heads)
near = H0.buffer(30)
rbuf = []
for r in G['roads']:
    if r['bridge']:
        continue
    ls = shapely.LineString(r['xy'])
    if ls.intersects(near):
        rbuf.append(ls.buffer(r['hw'] + r['sw'] + 0.8, quad_segs=3))
RB = shapely.union_all(rbuf) if rbuf else shapely.Polygon()
H = H0.difference(RB).buffer(-1.5).buffer(1.5)
H = max(shapely.get_parts(H), key=lambda g: g.area)
H = shapely.Polygon(H.exterior, [r for r in H.interiors if shapely.Polygon(r).area > 3000])
H = orient(shapely.simplify(H, 0.25), 1.0)
CHW = shapely.intersection(CH, H).buffer(-0.6).buffer(0.6)
CHW = max(shapely.get_parts(CHW), key=lambda g: g.area)
CHW = orient(shapely.simplify(CHW, 0.25), 1.0)
PROMP = H.difference(CHW)
LID = H.buffer(26, quad_segs=4).difference(H)
beyond_water = shapely.union_all([riv.difference(CH)] + [w for w in water if w is not riv])
UPPER = H.buffer(9, quad_segs=4).difference(H).difference(beyond_water)
print(f'channel: water {CHW.area / 1e6:.2f} km2, lower promenade {PROMP.area / 1e6:.3f} km2, wall rings {1 + len(H.interiors)}')
shapely.prepare(H)


def ring_runs(poly):
    return [np.asarray(r.coords) for r in [poly.exterior, *poly.interiors]]


walls = ring_runs(H)                 # channel (lower level) on the left of every ring
Hb = H.boundary
edges = []                           # water edge of the lower promenade (water on the left)
for rc in ring_runs(CHW):
    d = shapely.distance(shapely.points(rc), Hb)
    run = []
    for p, dd in zip(rc, d):
        if dd > 0.8:
            run.append(p)
        else:
            if len(run) > 1:
                edges.append(np.array(run))
            run = []
    if len(run) > 1:
        edges.append(np.array(run))


def stations_along(rings, every, offset0, test):
    out = []
    for rc in rings:
        s = chain(rc); L = s[-1]
        if L < every * 0.6:
            continue
        for v in np.arange(offset0 % every, L, every):
            p = at(rc, s, v); u = dir_at(rc, s, v, 4.0)
            n = np.array([-u[1], u[0]])   # into the channel
            if test(p, u, n):
                out.append((float(p[0]), float(p[1]), float(u[0]), float(u[1])))
    return out


CHWb = CHW.boundary


def prom_width(p, n):
    ln = shapely.LineString([p + n * 0.3, p + n * 40])
    it = ln.intersection(CHWb)
    if it.is_empty:
        return 0.0
    return float(shapely.distance(shapely.Point(p), it))


stairs = stations_along(walls, 430.0, 170.0, lambda p, u, n: prom_width(p, n) >= 7.5)
ghats = []
for rc in edges:
    s = chain(rc)
    for v in np.arange(260.0, s[-1] - 30, 640.0):
        p = at(rc, s, v); u = dir_at(rc, s, v, 6.0); n = np.array([u[1], -u[0]])   # n: towards the wall
        ln = shapely.LineString([p + n * 0.3, p + n * 30])
        it = ln.intersection(Hb)
        w = float(shapely.distance(shapely.Point(p), it)) if not it.is_empty else 0
        if w >= 7.0:
            ghats.append((float(p[0]), float(p[1]), float(u[0]), float(u[1]), 24.0))
lamps = []
for rc in walls:
    s = chain(rc)
    for v in np.arange(8.0, s[-1], 34.0):
        p = at(rc, s, v); u = dir_at(rc, s, v, 3.0); n = np.array([-u[1], u[0]])
        q = p - n * 2.2   # on the upper promenade, 2.2 m back from the railing
        if not H.contains(shapely.Point(*q)):
            lamps.append((float(q[0]), float(q[1])))
print(f'riverfront: {len(walls)} wall rings {sum(chain(w)[-1] for w in walls) / 1000:.1f} km, {len(edges)} water edges, '
      f'{len(stairs)} stairs, {len(ghats)} ghats, {len(lamps)} lamps')
barrages = [dict(kind='vasna', a=[float(v) for v in cS[1][0]], b=[float(v) for v in cS[1][1]]),
            dict(kind='acher', a=[float(v) for v in cN[1][0]], b=[float(v) for v in cN[1][1]])]


def in_hole(x, y):
    return bool(shapely.contains_xy(H, x, y))


# =====================================================================================================
# Ahmedabad Metro
# =====================================================================================================
Z = zipfile.ZipFile(f'{DATA}/amd_metro_gtfs.zip')


def rd(n):
    return list(csv.DictReader(io.TextIOWrapper(Z.open(n), 'utf-8-sig')))


shp = defaultdict(list)
for r in rd('shapes.txt'):
    shp[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
STOP = {}
for r in rd('stops.txt'):
    x, y = proj_xy(float(r['stop_lon']), float(r['stop_lat']))
    nm = r['stop_name'].strip()
    if 'Railway' not in nm:
        nm = nm.replace(' Station', '').strip()
    STOP[r['stop_id']] = (float(x), float(y), nm)
ROUTES = {r['route_id']: r for r in rd('routes.txt')}
TRIPS = {r['trip_id']: r for r in rd('trips.txt')}
ST = defaultdict(list)
for r in rd('stop_times.txt'):
    ST[r['trip_id']].append(r)


def path_of(sid):
    v = sorted(shp[sid])
    lo = np.array([p[1] for p in v]); la = np.array([p[2] for p in v])
    x, y = proj_xy(lo, la)
    c = np.column_stack([x, y])
    keep = np.concatenate([[True], np.hypot(*np.diff(c, axis=0).T) > 0.5])
    c = c[keep]
    c = smooth(c, 55.0, 5)
    return resample(c, 4.0)


RP = {1: path_of('gmrcl_shape_line1_0'), 2: path_of('gmrcl_shape_line2_0'),
      3: path_of('gmrcl_shape_line3_0'), 4: path_of('gmrcl_shape_line4_0')}


def s_of(c, pt):
    return float(shapely.line_locate_point(shapely.LineString(c), shapely.Point(pt)))


def extend(c, a=0.0, b=0.0):
    out = c
    if a > 0:
        u = c[0] - c[1]; u /= np.hypot(*u)
        out = np.vstack([[c[0] + u * a], out])
    if b > 0:
        u = c[-1] - c[-2]; u /= np.hypot(*u)
        out = np.vstack([out, [c[-1] + u * b]])
    return resample(out, 4.0)


def cut(c, sa, sb):
    s = chain(c)
    m = (s >= sa) & (s <= sb)
    pts = [at(c, s, sa)] + list(c[m]) + [at(c, s, sb)]
    return resample(np.array(pts), 4.0)


def clip_box(c):
    ln = shapely.LineString(c).intersection(BOX)
    parts = [p for p in shapely.get_parts(ln) if p.geom_type == 'LineString']
    return resample(np.asarray(max(parts, key=lambda p: p.length).coords), 4.0)


TERM_EXT = 285.0     # tail tracks beyond the terminal platforms: scissors crossover + turnback siding
k3 = s_of(RP[3], STOP['GMRCL_KOTESHWAR_ROAD'][:2])
k4 = s_of(RP[4], STOP['GMRCL_GNLU'][:2])
CORR = {
    'blue': clip_box(extend(RP[1], TERM_EXT, TERM_EXT)),
    'red': clip_box(extend(RP[2], TERM_EXT, 0)),
    'yellow': clip_box(cut(RP[3], k3, chain(RP[3])[-1])),
    'violet': clip_box(extend(cut(RP[4], k4, chain(RP[4])[-1]), 0, TERM_EXT)),
}
# Gyaspur depot: past APMC the Red Line runs on south beside the 132 Ft Ring Road, crosses the Narol-Sarkhej
# highway, comes down to grade and curves west along the canal into the depot yard. Traced from satellite imagery,
# offsets in metres from the APMC station; the depot shed is the 172 x 188 m traced building at the west end.
_APMC = np.array([-3878.7, -4136.6])
_DEP = [(105, -592), (105, -1008), (58, -1119), (-11, -1216), (-109, -1285), (-219, -1341), (-358, -1383), (-498, -1410), (-635, -1431), (-774, -1445)]
_red = np.vstack([np.array([_APMC + p for p in _DEP])[::-1], CORR['red']])
CORR['red'] = clip_box(resample(smooth(_red, 60.0, 4), 4.0))
_shc = _APMC + (-1042.0, -1464.0); _su = np.array([0.961, 0.276])
DEPOT = dict(face=tuple(_shc + _su * 86.0), u=tuple(_su), throat=tuple(CORR['red'][0]), W=188.0, L=172.0, shed=tuple(_shc))
COL = {'blue': '#1e63c8', 'red': '#d7262b', 'yellow': '#f2b705', 'violet': '#7d3cc2'}
LINES_OF = {}   # stop -> set of line names
for tid, tr in TRIPS.items():
    ln = {'GMRCL_LINE-1': 'blue', 'GMRCL_LINE-2': 'red', 'GMRCL_LINE-3': 'yellow', 'GMRCL_LINE-4': 'violet'}[tr['route_id']]
    for r in ST[tid]:
        LINES_OF.setdefault(r['stop_id'], set()).add(ln)
UG = {'GMRCL_SHAHPUR_STATION', 'GMRCL_GHEEKANTA', 'GMRCL_KALUPUR_RAILWAY_STATION', 'GMRCL_KANKARIA_EAST'}

# road decks (flyovers) and rail lines the viaduct has to clear
deck_pts, deck_z = [], []
for r in G['roads']:
    if r['bridge']:
        c = np.asarray(r['xy']); zz = np.asarray(r['z'])
        cc = resample(c, 6.0); ss = chain(c); s2 = np.linspace(0, ss[-1], len(cc))
        deck_pts.append(cc); deck_z.append(np.interp(s2, ss, zz))
deck_pts = np.concatenate(deck_pts); deck_z = np.concatenate(deck_z)
dtree = shapely.STRtree(shapely.points(deck_pts))
rail_u = shapely.union_all([shapely.LineString(r) for r in G['rail']])
STA_HALF, STA_RL, RUN_RL, GRADE = 70.0, 12.0, 9.0, 0.03


def stations_on(c, name):
    s = chain(c); out = []
    L = shapely.LineString(c)
    for sid, (x, y, nm) in STOP.items():
        if name not in LINES_OF.get(sid, ()):
            continue
        if L.distance(shapely.Point(x, y)) < 45 and BOX.contains(shapely.Point(x, y)):
            out.append((sid, s_of(c, (x, y))))
    return sorted(out, key=lambda t: t[1])


def base_profile(c, sts, extra_min=None):
    s = chain(c); n = len(c)
    rl = np.full(n, RUN_RL)
    for sid, ss in sts:
        if sid in UG:
            continue
        m = np.abs(s - ss) <= STA_HALF
        rl[m] = np.maximum(rl[m], STA_RL)
    live = [ss for sid, ss in sts if sid not in UG]
    if live:   # terminal tail tracks stay level with the platforms
        if live[0] < TERM_EXT + 40:
            rl[s <= live[0]] = np.maximum(rl[s <= live[0]], STA_RL)
        if s[-1] - live[-1] < TERM_EXT + 40:
            rl[s >= live[-1]] = np.maximum(rl[s >= live[-1]], STA_RL)
    # clear road flyovers by 7.5 m (5.5 m clearance + girder), railways by 10.5 m rail level
    q = dtree.query(shapely.points(c), predicate='dwithin', distance=14.0)
    if len(q[0]):
        np.maximum.at(rl, q[0], deck_z[q[1]] + 7.5)
    dr = shapely.distance(shapely.points(c), rail_u)
    rl[dr < 18] = np.maximum(rl[dr < 18], 10.5)
    if extra_min is not None:
        rl = np.maximum(rl, extra_min)
    ds = np.diff(s)
    for i in range(1, n):
        rl[i] = max(rl[i], rl[i - 1] - GRADE * ds[i - 1])
    for i in range(n - 2, -1, -1):
        rl[i] = max(rl[i], rl[i + 1] - GRADE * ds[i])
    return rl


STS = {k: stations_on(c, k) for k, c in CORR.items()}
# Old High Court interchange: the Red Line crosses above the Blue Line
xing = shapely.LineString(CORR['blue']).intersection(shapely.LineString(CORR['red']))
xp = shapely.get_parts(xing)[0]
RL = {}
ex = np.zeros(len(CORR['red']))
sr = chain(CORR['red']); sx_ = s_of(CORR['red'], (xp.x, xp.y))
ex[np.abs(sr - sx_) <= STA_HALF + 10] = 23.0   # red platforms sit above the blue station roof
RL['red'] = base_profile(CORR['red'], STS['red'], ex)
# depot line: level with the platforms over the tail tracks and across the highway, then 3 % down to grade
_sr = chain(CORR['red']); _sap = dict(STS['red'])['GMRCL_APMC']
_hw = shapely.union_all([shapely.LineString(r['xy']) for r in G['roads'] if r['cls'] >= 5 and 'Sarkhej' in (r['name'] or '')])
_xs = shapely.LineString(CORR['red']).intersection(_hw)
_sx = min([s_of(CORR['red'], (q.x, q.y)) for q in shapely.get_parts(_xs) if q.geom_type == 'Point' and s_of(CORR['red'], (q.x, q.y)) < _sap] or [_sap - 1100.0])
_d = _sap - _sr; _m = _sr < _sap
_dc = _sap - _sx + 40.0
RL['red'][_m] = np.where(_d[_m] <= _dc, np.maximum(RL['red'][_m], STA_RL), np.maximum(1.05, STA_RL - (_d[_m] - _dc) * 0.03))
print(f'depot line: {_sap:.0f} m from the yard throat to APMC, highway crossed {_sap - _sx:.0f} m south of APMC, at grade for the last {max(0.0, _sap - _dc - (STA_RL - 1.05) / 0.03):.0f} m')
RL['yellow'] = base_profile(CORR['yellow'], STS['yellow'])
RL['violet'] = base_profile(CORR['violet'], STS['violet'])
RL['blue'] = base_profile(CORR['blue'], STS['blue'])
# underground: from the west ramp just east of the river to the east ramp before Apparel Park
cb = CORR['blue']; sb = chain(cb)
inH = shapely.contains_xy(H, cb[:, 0], cb[:, 1])
sAP = dict(STS['blue'])['GMRCL_APPAREL_PARK']
sKE = dict(STS['blue'])['GMRCL_KANKARIA_EAST']
sSH = dict(STS['blue'])['GMRCL_SHAHPUR_STATION']
idx_h = np.where(inH)[0]
s_bankE = float(sb[idx_h[0]]) if sb[idx_h[0]] < sb[idx_h[-1]] else float(sb[idx_h[-1]])
RAMP = 0.035
sE = sAP + STA_HALF + (STA_RL - 0.8) / RAMP            # east portal (towards Vastral the line climbs out)
sW = s_bankE - 15.0 - (RUN_RL - 0.8) / RAMP            # west portal (climbs onto the river bridge)
print(f'blue: Apparel Park {sAP:.0f}, east portal {sE:.0f}, Kankaria East {sKE:.0f}, Shahpur {sSH:.0f}, west portal {sW:.0f}, east bank {s_bankE:.0f}')
assert sE < sKE - STA_HALF and sW > sSH + 60
rlb = RL['blue']
m = (sb >= sAP + STA_HALF) & (sb <= sE); rlb[m] = STA_RL - (sb[m] - (sAP + STA_HALF)) * RAMP
m = (sb >= sW) & (sb <= s_bankE - 15); rlb[m] = 0.8 + (sb[m] - sW) * RAMP
m = (sb > sE) & (sb < sW); rlb[m] = -12.0
UGM = {k: np.zeros(len(c), bool) for k, c in CORR.items()}
UGM['blue'] = (sb > sE) & (sb < sW)
portals = []
for sp, sg in ((sE, 1), (sW, -1)):
    p = at(cb, sb, sp); u = dir_at(cb, sb, sp) * sg   # u points into the tunnel
    portals.append((float(p[0]), float(p[1]), float(u[0]), float(u[1])))

# ---- stations
stations = []
seen = {}
for k, sts in STS.items():
    c = CORR[k]; s = chain(c)
    for sid, ss in sts:
        key = (sid, 'red' if k in ('red', 'yellow', 'violet') else 'blue')
        if key in seen:
            continue
        p = at(c, s, ss); u = dir_at(c, s, ss, 30.0)
        ug = sid in UG
        rl = float(np.interp(ss, s, RL[k]))
        seen[key] = len(stations)
        stations.append(dict(id=sid, name=STOP[sid][2], x=float(p[0]), y=float(p[1]), ux=float(u[0]), uy=float(u[1]),
                             rl=rl, ug=ug, corr=k, lines=sorted(LINES_OF.get(sid, {k})), L=140.0, W=22.0))
print('metro stations', len(stations), 'underground', sum(s['ug'] for s in stations))
# street entrances of the underground stations: on footpaths / open ground beside the road, never on a carriageway
_rb = [shapely.LineString(r['xy']).buffer(r['hw'] + r['sw'] + 0.5) for r in G['roads'] if not r['bridge']]
_rt = shapely.STRtree(_rb)


def _rect(cx, cy, ux, uy, ha, hc):
    vx, vy = -uy, ux
    return shapely.Polygon([(cx + ux * sa * ha + vx * sb_ * hc, cy + uy * sa * ha + vy * sb_ * hc) for sa, sb_ in ((-1, -1), (1, -1), (1, 1), (-1, 1))])


for st in stations:
    if not st['ug']:
        continue
    ux, uy = st['ux'], st['uy']; vx, vy = -uy, ux
    best = {1: None, -1: None}
    for a in (-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75):
        for c in (9, 12, 15, 18, 22, 26, 30):
            for sg in (1, -1):
                cx, cy = st['x'] + ux * a + vx * c * sg, st['y'] + uy * a + vy * c * sg
                R_ = _rect(cx, cy, ux, uy, 6.0, 3.8)
                if len(_rt.query(R_, predicate='intersects')):
                    continue
                score = abs(abs(a) - 40) * 0.5 + c
                if best[sg] is None or score < best[sg][0]:
                    best[sg] = (score, cx, cy)
    st['ent'] = [(b[1], b[2]) for b in best.values() if b is not None]
    print(f"  {st['name']}: {len(st['ent'])} entrances")

# ---- piers: every 28 m (U-girder length), nudged off crossing carriageways
rl_lines = np.array([shapely.LineString(r['xy']) for r in G['roads'] if not r['bridge']], dtype=object)
rl_hw = np.array([r['hw'] + 0.6 for r in G['roads'] if not r['bridge']])
rtree = shapely.STRtree(rl_lines)


# elevated road pieces (decks and ramp walls) and rail tracks: a metro pier must stand clear of both
_dk = [r for r in G['roads'] if r['bridge'] and float(np.max(r['z'])) > 0.3]
dk_lines = np.array([shapely.LineString(r['xy']) for r in _dk], dtype=object)
dk_hw = np.array([r['hw'] + 0.6 for r in _dk])
dk_tree = shapely.STRtree(dk_lines)
rail_lines = np.array([shapely.LineString(r) for r in G['rail']], dtype=object)
rail_tree = shapely.STRtree(rail_lines)
PIER_R = 1.2


def pier_ok(p, u):
    P = shapely.Point(*p)
    for j in dk_tree.query(P, predicate='dwithin', distance=20.0):
        if dk_lines[j].distance(P) < dk_hw[j] + 1.5 + PIER_R:
            return False
    if len(rail_tree.query(P, predicate='dwithin', distance=2.5 + PIER_R)):
        return False
    for j in rtree.query(P, predicate='dwithin', distance=14.0):
        ln = rl_lines[j]
        d = ln.distance(P)
        if d >= rl_hw[j]:
            continue
        t = ln.project(P); a_ = ln.interpolate(max(0, t - 3)); b_ = ln.interpolate(min(ln.length, t + 3))
        v = np.array([b_.x - a_.x, b_.y - a_.y]); v /= (np.hypot(*v) + 1e-9)
        if abs(float(np.dot(v, u))) < 0.9:   # a road crossing under the viaduct
            return False
    return True


piers = []
SOFFIT = 2.3
for k, c in CORR.items():
    s = chain(c); rl = RL[k]; ug = UGM[k]
    sts = [ss for sid, ss in STS[k] if sid not in UG]
    v = 14.0
    while v < s[-1] - 4:
        r_ = float(np.interp(v, s, rl))
        i = min(len(c) - 1, int(np.searchsorted(s, v)))
        if ug[i] or r_ - SOFFIT < 1.2 or any(abs(v - q) < STA_HALF + 2 for q in sts):
            v += 4.0; continue
        u = dir_at(c, s, v)
        placed = False
        for dv in (0, 4, -4, 8, -8, 12, -12, 16, -16):
            p = at(c, s, v + dv)
            if pier_ok(p, u):
                r2 = float(np.interp(v + dv, s, rl))
                base = WATER_Y - 0.6 if in_hole(*p) else 0.0
                piers.append((float(p[0]), float(p[1]), float(u[0]), float(u[1]), r2 - SOFFIT, base, k))
                placed = True; v += dv; break
        v += 28.0 if placed else 14.0
print('metro piers', len(piers))

# ---- train paths and timetable (GTFS stop_times; weekday / Saturday / Sunday services)
FAM = {1: ['blue'], 2: ['red', 'yellow', 'violet'], 3: ['red', 'yellow', 'violet'], 4: ['red', 'yellow', 'violet']}
routes = []
for rk in (1, 2, 3, 4):
    c = RP[rk]
    if rk in (2, 3, 4):   # APMC tail tracks: follow the corridor exactly (it curves away towards the depot beyond them)
        _s0 = s_of(CORR['red'], c[0]); _cc = cut(CORR['red'], max(0.0, _s0 - TERM_EXT), _s0)
        c = resample(np.vstack([_cc[:-1], c]), 4.0)
        c = extend(c, 0.0, TERM_EXT if rk == 4 else 0.0)
    else:
        c = extend(c, TERM_EXT, TERM_EXT)   # over the tail tracks at the terminals
    s = chain(c)
    P = shapely.points(c)
    best_d = np.full(len(c), 1e9); rl = np.zeros(len(c)); ug = np.zeros(len(c), bool)
    for k in FAM[rk]:
        L = shapely.LineString(CORR[k]); sk = chain(CORR[k])
        d = shapely.distance(P, L); t = shapely.line_locate_point(L, P)
        m = d < best_d
        best_d[m] = d[m]
        rl[m] = np.interp(t[m], sk, RL[k])
        ug[m] = np.interp(t[m], sk, UGM[k].astype(float))[...] > 0.5
    inbox = shapely.contains_xy(BOX, c[:, 0], c[:, 1]) & (best_d < 6)
    rid = f'GMRCL_LINE-{rk}'
    stops_s = {}
    for tid, tr in TRIPS.items():
        if tr['route_id'] != rid or tr['direction_id'] != '0':
            continue
        for r in ST[tid]:
            sid = r['stop_id']
            if sid not in stops_s:
                stops_s[sid] = s_of(c, STOP[sid][:2])
        break
    routes.append(dict(id=rid, line=['blue', 'red', 'yellow', 'violet'][rk - 1], c=c, s=s, rl=rl, ug=ug, inbox=inbox, stops=stops_s))


def hms(t):
    h, m_, s_ = map(int, t.split(':'))
    return h * 3600 + m_ * 60 + s_


SVC = {'1,2,3,4,5,6,7': 0, '1,2,3,4,5': 1, '6': 2, '7': 3}
trips = []
for tid, tr in TRIPS.items():
    rk = int(tr['route_id'][-1]) - 1
    rows = sorted(ST[tid], key=lambda r: int(r['stop_sequence']))
    R = routes[rk]
    ss = [R['stops'][r['stop_id']] for r in rows]
    tt = [hms(r['arrival_time']) for r in rows]
    trips.append((rk, int(tr['direction_id']), SVC.get(tr['service_id'], 0), [round(v, 1) for v in ss], tt))
print('trips', len(trips))

# ---- exclusion zones for buildings / trees
foot = []
for st in stations:
    ux, uy = st['ux'], st['uy']; vx, vy = -uy, ux
    if st['ug']:
        for cx, cy in st['ent']:
            foot.append(_rect(cx, cy, ux, uy, 6.5, 4.3))
        continue
    hl, hw = st['L'] / 2 + 3, st['W'] / 2 + 1.5
    foot.append(shapely.Polygon([(st['x'] + ux * sa * hl + vx * sb_ * hw, st['y'] + uy * sa * hl + vy * sb_ * hw)
                                 for sa, sb_ in ((-1, -1), (1, -1), (1, 1), (-1, 1))]))
for px, py, ux, uy in portals:   # headwall at the portal, wing walls 60 m back along the ramp
    foot.append(_rect(px - ux * 28, py - uy * 28, ux, uy, 33, 8.5))
band = []
for k, c in CORR.items():
    el = (RL[k] > 1.0) & ~UGM[k]
    i = 0
    while i < len(c):
        if el[i]:
            j = i
            while j < len(c) and el[j]:
                j += 1
            if j - i > 1:
                band.append(shapely.LineString(c[i:j]))
            i = j
        else:
            i += 1
BAND = shapely.union_all([b.buffer(4.9, cap_style='flat') for b in band])
# at grade (the depot line's last stretch and the yard): nothing of any height may stand on it
_gr = []
for k, c in CORR.items():
    lo = (RL[k] < 2.5) & (RL[k] > 0.0) & ~UGM[k]   # at grade only (not above the Blue Line tunnel)
    i = 0
    while i < len(c):
        if lo[i]:
            j = i
            while j < len(c) and lo[j]:
                j += 1
            if j - i > 1:
                _gr.append(shapely.LineString(c[i:j]).buffer(5.5, cap_style='flat'))
            i = j
        else:
            i += 1
_F, _U = np.array(DEPOT['face']), np.array(DEPOT['u']); _V = np.array([-_U[1], _U[0]])
_aT = float((np.array(DEPOT['throat']) - _F) @ _U); _lT = float((np.array(DEPOT['throat']) - _F) @ _V)
_gr.append(shapely.Polygon([_F + _U * a + _V * l for a, l in ((1.0, _lT - 32), (_aT + 12, _lT - 32), (_aT + 12, _lT + 32), (1.0, _lT + 32))]))
GRADE = shapely.union_all(_gr)
PIERS_G = shapely.union_all([shapely.Point(p[0], p[1]).buffer(2.2) for p in piers])
STA_G = shapely.union_all(foot)

pickle.dump(dict(
    river=dict(H=H, CHW=CHW, PROMP=PROMP, LID=LID, UPPER=UPPER, walls=walls, edges=edges, stairs=stairs, ghats=ghats,
               lamps=lamps, barrages=barrages, water_y=WATER_Y, prom_y=PROM_Y),
    metro=dict(corr=CORR, rl=RL, ug=UGM, col=COL, stations=stations, piers=piers, portals=portals, routes=routes, trips=trips, depot=DEPOT),
    excl=dict(stations=STA_G, band=BAND, piers=PIERS_G, hole=H, grade=GRADE),
), open(f'{OUT}/transit.pkl', 'wb'))
print('done', round(time.time() - t0, 1))

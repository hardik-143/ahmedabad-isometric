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
POL = [B[k] for k in ('polT', 'face', 'face2', 'rr0', 'rr1', 'rise')]
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
    px = [[] for _ in POL]
    for i in idx:
        P = polys[i]
        rings = [np.asarray(P.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in P.interiors]
        rings = [r for r in rings if len(r) >= 3][:255]
        if not rings:
            continue
        fl.append(floors[i]); stv.append(style[i]); kd.append(1 if fab[i] == 1 else 0); rc.append(len(rings))
        for a_, src_ in zip(px, POL):
            a_.append(src_[i])
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
    for a_ in px:   # pol houses: roof type, facade edge, 2nd facade edge, ridge vertices, ridge rise (dm)
        b.arr(np.array(a_, np.uint8))
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
X = np.round(xy[:, 0] * 20); Z = np.round(-xy[:, 1] * 20)   # 5 cm precision so smoothed curves stay smooth
b.arr(np.column_stack([X, Z]).ravel().astype(np.int32))
J = G['junctions']
jk = list(J.keys())
jx = np.array([k[0] for k in jk]); jy = np.array([k[1] for k in jk])
b.arr(np.column_stack([np.round(jx * 2), np.round(-jy * 2)]).ravel().astype(np.int16))
b.arr(np.array([round(J[k][0] * 10) for k in jk], np.uint8))
b.arr(np.array([round(J[k][1] * 10) for k in jk], np.uint8))
b.arr(np.array([J[k][2] for k in jk], np.uint8))
ZZ = [np.round(np.asarray(r['z']) * 10).clip(0, 255) for r in roads if r['bridge']]
b.arr((np.concatenate(ZZ) if ZZ else np.zeros(0)).astype(np.uint8))
# paint mask: 1 where a ribbon's edge line / lane paint would land on another road's carriageway (junctions,
# overlapping dual carriageways, slip roads); continuations of the same road at a shared node are ignored
_at = [k for k, r in enumerate(roads) if not r['bridge']]
_asph = [shapely.LineString(roads[k]['xy']).buffer(max(roads[k]['hw'] - 0.25, 0.3), cap_style='flat') for k in _at]
_tree = shapely.STRtree(_asph)
_ends = {}
for k, r in enumerate(roads):
    c = np.asarray(r['xy'])
    for e, (q0, q1) in ((0, (c[0], c[1])), (-1, (c[-1], c[-2]))):
        d = q1 - q0; d = d / (np.hypot(*d) or 1)
        _ends.setdefault((round(q0[0], 0), round(q0[1], 0)), []).append((k, d))
_cont = set()
for lst in _ends.values():
    for a_ in range(len(lst)):
        for b_ in range(a_ + 1, len(lst)):
            (ka, da), (kb, db) = lst[a_], lst[b_]
            if np.dot(da, db) < -0.9:      # outgoing directions opposite: one road carries on into the other
                _cont.add((ka, kb)); _cont.add((kb, ka))
_off = np.zeros(len(roads) + 1, np.int64); _off[1:] = np.cumsum([len(r['xy']) for r in roads])
_PL, _PR, _own = [], [], []
for k, r in enumerate(roads):
    c = np.asarray(r['xy'], float); n_ = len(c)
    t = np.zeros_like(c); t[1:-1] = c[2:] - c[:-2]; t[0] = c[1] - c[0]; t[-1] = c[-1] - c[-2]
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    nl = np.column_stack([-t[:, 1], t[:, 0]]); h = max(r['hw'] - 0.35, 0.2)
    _PL.append(c + nl * h); _PR.append(c - nl * h); _own.append(np.full(n_, k))
_PL, _PR, _own = np.concatenate(_PL), np.concatenate(_PR), np.concatenate(_own)
_atk = np.array(_at)
MASK = np.zeros((len(_own), 2), np.uint8)
for side, PP in ((0, _PL), (1, _PR)):
    pi, gi = _tree.query(shapely.points(PP), predicate='within')
    other = _atk[gi]; mine = _own[pi]
    keep = (other != mine) & ~np.array([(m_, o_) in _cont for m_, o_ in zip(mine, other)], bool) & ~np.array([roads[m_]['bridge'] for m_ in mine], bool)
    MASK[pi[keep], side] = 1
print(f'road paint mask: {int(MASK.any(axis=1).sum())} of {len(MASK)} ribbon points sit on another carriageway')
b.arr(MASK.ravel())
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


# ---------------- metro + riverfront channel (gzip JSON) ----------------
TR = pickle.load(open(f'{OUT}/transit.pkl', 'rb'))
RV, MT = TR['river'], TR['metro']
_H = RV['H']; shapely.prepare(_H)


def fl3(c):   # map metres -> flat three.js [x, z, ...] at 0.1 m
    c = np.asarray(c, float)
    return [round(float(v), 1) for p in c for v in (p[0], -p[1])]


def tri_fl(g):
    V, I = tri_polys([p for p in shapely.get_parts(g) if p.geom_type == 'Polygon' and p.area > 0.5])
    return dict(v=[round(float(c), 2) for xy in V for c in (xy[0], -xy[1])], i=[int(t) for t in I])


def rs(c, step, *vals):
    c = np.asarray(c, float)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))])
    t = np.linspace(0, s[-1], max(2, int(math.ceil(s[-1] / step)) + 1))
    out = [np.column_stack([np.interp(t, s, c[:, 0]), np.interp(t, s, c[:, 1])])]
    out += [np.interp(t, s, np.asarray(v, float)) for v in vals]
    return out


transit = dict(
    river=dict(wy=RV['water_y'], py=RV['prom_y'], water=tri_fl(RV['CHW']), prom=tri_fl(RV['PROMP']), lid=tri_fl(RV['LID']),
               upper=tri_fl(RV['UPPER']), walls=[fl3(w) for w in RV['walls']], edges=[fl3(e) for e in RV['edges']],
               stairs=[[round(x, 1), round(-y, 1), round(ux, 4), round(-uy, 4)] for x, y, ux, uy in RV['stairs']],
               ghats=[[round(x, 1), round(-y, 1), round(ux, 4), round(-uy, 4), w] for x, y, ux, uy, w in RV['ghats']],
               lamps=[[round(x, 1), round(-y, 1)] for x, y in RV['lamps']],
               barrages=[dict(kind=b['kind'], a=[round(b['a'][0], 1), round(-b['a'][1], 1)], b=[round(b['b'][0], 1), round(-b['b'][1], 1)]) for b in RV['barrages']]),
    metro=dict(
        corr=[dict(k=k, col=MT['col'][k], pts=fl3(c), rl=[round(float(v), 2) for v in MT['rl'][k]], ug=[int(v) for v in MT['ug'][k]])
              for k, c in MT['corr'].items()],
        stations=[dict(n=s['name'], id=s['id'], x=round(s['x'], 1), z=round(-s['y'], 1), ux=round(s['ux'], 4), uz=round(-s['uy'], 4), rl=round(s['rl'], 2),
                       ug=int(s['ug']), lines=s['lines'], corr=s['corr'], L=s['L'], W=s['W'],
                       ent=[[round(x, 1), round(-y, 1)] for x, y in s.get('ent', [])]) for s in MT['stations']],
        piers=[[round(x, 1), round(-y, 1), round(ux, 4), round(-uy, 4), round(top, 2), round(base, 2), k] for x, y, ux, uy, top, base, k in MT['piers']],
        portals=[[round(x, 1), round(-y, 1), round(ux, 4), round(-uy, 4)] for x, y, ux, uy in MT['portals']],
        routes=[], trips=[]),
)
for R in MT['routes']:
    c, rl, ug, ib = rs(R['c'], 8.0, R['rl'], R['ug'].astype(float), R['inbox'].astype(float))
    transit['metro']['routes'].append(dict(id=R['id'], line=R['line'], pts=fl3(c), rl=[round(float(v), 1) for v in rl],
                                           ug=[int(v > 0.5) for v in ug], inb=[int(v > 0.5) for v in ib]))
for rk, d, svc, ss, tt in MT['trips']:
    transit['metro']['trips'].append([rk, d, svc, [round(v) for v in ss], [tt[0]] + [b_ - a_ for a_, b_ in zip(tt, tt[1:])]])
# ---- Janmarg BRTS: corridor lines (+ barrier gaps), median stations, bus paths (reverse paths shared), timetable
BR = G.get('brts')
if BR:
    def _st(st):
        return dict(n=st['name'], x=round(st['x'], 1), z=round(-st['y'], 1), ux=round(float(st['ux']), 4), uz=round(-float(st['uy']), 4), li=int(st['li']), s=round(float(st['s']), 1))
    lidx = {lg['ab']: k for k, lg in enumerate(BR['legs'])}
    legs_out, ref = [], {}
    for k, lg in enumerate(BR['legs']):
        a, b = lg['ab']
        if (b, a) in ref:          # same street path driven the other way
            ref[(a, b)] = -(ref[(b, a)] + 1); continue
        ref[(a, b)] = len(legs_out)
        P = np.asarray(lg['pts'])
        legs_out.append(dict(p=[round(float(v), 1) for q in P for v in (q[0], -q[1], q[2])], o=[round(float(v), 1) for v in lg['off']]))
    trips_out = []
    for tr in BR['trips']:
        row = [int(tr[0][1])]
        for (li, ta, tb) in tr:
            row += [ref[BR['legs'][li]['ab']], int(tb - ta)]
        trips_out.append(row)
    transit['brts'] = dict(lines=[dict(pts=fl3(c), paint=int(BR.get('paint', [1] * len(BR['lines']))[j]), gaps=[[round(a, 1), round(b, 1)] for a, b in BR['gaps'][j]]) for j, c in enumerate(BR['lines'])],
                           stations=[_st(st) for st in BR['stations']], legs=legs_out, trips=trips_out)
    print(f"brts: {len(BR['lines'])} corridor lines, {len(BR['stations'])} stations, {len(legs_out)} bus paths, {len(trips_out)} trips")
files['transit'] = json.dumps(transit, separators=(',', ':')).encode()
print('transit: corridors', len(MT['corr']), 'stations', len(MT['stations']), 'piers', len(MT['piers']), 'trips', len(MT['trips']))

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

# ---- Ellis Bridge: 14 bowstring spans centred on the river channel, deck level from the concrete wings beside it
ELLIS3 = None
if G.get('ellis'):
    _e = G['ellis']; _p0, _p1 = np.array(_e['p0']), np.array(_e['p1'])
    _ml = shapely.LineString([_p0, _p1])
    _hole = TR['excl']['hole']
    _ix = _ml.intersection(_hole)
    _ix = max(shapely.get_parts(_ix), key=lambda g: g.length) if not _ix.is_empty else _ml
    _mid = np.array(_ix.interpolate(0.5, normalized=True).coords[0])
    _u = (_p1 - _p0) / np.hypot(*(_p1 - _p0))
    _zs = []
    for r in roads:
        if r['bridge'] and r['name'] in ('Swami Vivekananda Road', 'Swami Vivekananda Bridge'):
            c = np.asarray(r['xy']); z = np.asarray(r['z'])
            near = np.hypot(c[:, 0] - _mid[0], c[:, 1] - _mid[1]) < 180
            _zs += list(z[near])
    _h = float(np.median(_zs)) if _zs else 7.0
    _a, _b = _mid - _u * 433.41 / 2, _mid + _u * 433.41 / 2
    ELLIS3 = dict(x0=m2three(*_a)[0], z0=m2three(*_a)[1], x1=m2three(*_b)[0], z1=m2three(*_b)[1], h=round(_h, 2), n=14,
                  slot=round(_e['slot'], 2), wy=TR['river']['water_y'] if 'water_y' in TR['river'] else -5.6)
    print(f'Ellis Bridge trusses: deck {_h:.1f} m, channel crossing {_ix.length:.0f} m')

# ---- bespoke landmark buildings (their traced footprints were cleared in the buildings stage)
LM3D = []
for k_, d_ in LANDMARK_3D.items():
    o = dict(kind=k_)
    for kk, vv in d_.items():
        if kk == 'c':
            o['x'], o['z'] = m2three(*vv)
        elif kk == 'u':
            o['ux'], o['uz'] = round(vv[0], 4), round(-vv[1], 4)
        elif kk in ('clear', 'ghost'):
            continue
        else:
            o[kk] = vv
    if k_ == 'pinnacle' and B.get('lm_fp', {}).get('pinnacle'):
        _fp = shapely.Polygon(B['lm_fp']['pinnacle']); _rr = np.asarray(shapely.minimum_rotated_rectangle(_fp).exterior.coords)[:4]
        _cr = shapely.union_all([shapely.LineString(r['xy']) for r in roads if r['cls'] >= 3 and not r['bridge']
                                 and shapely.LineString(r['xy']).distance(_fp) < 120])
        _best = None
        for i_ in range(4):   # the front is a long side (two towers side by side), the one nearer a main road
            a_, b_ = _rr[i_], _rr[(i_ + 1) % 4]; m_ = (a_ + b_) / 2
            l_, o_ = np.hypot(*(b_ - a_)), np.hypot(*(_rr[(i_ + 2) % 4] - b_))
            if l_ < o_ - 1:
                continue
            dd_ = _cr.distance(shapely.Point(*m_))
            if _best is None or dd_ < _best[0]:
                _best = (dd_, a_, b_, o_)
        _, a_, b_, D_ = _best
        e_ = (b_ - a_) / np.hypot(*(b_ - a_)); c_ = _rr.mean(0); m_ = (a_ + b_) / 2
        if np.dot([-e_[1], e_[0]], m_ - c_) < 0:   # frame b-axis (left of u) must point at the road
            e_ = -e_
        o['x'], o['z'] = m2three(*c_); o['ux'], o['uz'] = round(float(e_[0]), 4), round(float(-e_[1]), 4)
        o['W'], o['D'] = round(float(np.hypot(*(b_ - a_))), 1), round(float(D_), 1)
    LM3D.append(o)

LANDMARKS = [
    ('Kankaria Lake', 23.0063, 72.6010, 'lake'), ('Sabarmati Riverfront', 23.0330, 72.5770, 'river'),
    ('Sabarmati Ashram', 23.0607, 72.5806, 'monument'), ('Narendra Modi Stadium', 23.0919, 72.5975, 'stadium'),
    ('Patang Hotel', 23.026389, 72.572167, 'tower'), ('ISKCON Temple', 23.02690, 72.50670, 'monument'),
    ('Taj Skyline', 23.04401, 72.48199, 'tower'), ('Pinnacle Business Park', 23.01137, 72.50631, 'tower'),
    ('Sardar Patel Stadium', 23.0418, 72.5645, 'stadium'), ('SVPI Airport', 23.0745, 72.6290, 'airport'),
    ('IIM Ahmedabad', 23.0329, 72.5468, 'campus'), ('Law Garden', 23.0262, 72.5598, 'park'),
    ('Bhadra Fort', 23.0244, 72.5811, 'monument'), ('Sidi Saiyyed Mosque', 23.0268, 72.5810, 'monument'),
    ('Jama Masjid', 23.0236, 72.5878, 'monument'), ('Teen Darwaza', 23.0238, 72.5838, 'monument'),
    ('Hutheesing Jain Temple', 23.0369, 72.5918, 'monument'), ('Vastrapur Lake', 23.0389, 72.5293, 'lake'),
    ('Chandola Lake', 22.9871, 72.5870, 'lake'), ('Atal Bridge', 23.01647, 72.57545, 'monument'), ('Ellis Bridge', 23.02222, 72.57528, 'monument'),
]
LANDMARKS += [(n, la, lo, 'gate') for n, la, lo, *_ in DARWAJAS if n != 'Teen Darwaza']
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
AF = airfield()
AFD = airfield_detail()


def tri_flat(g):
    V, I = tri_polys([p for p in shapely.get_parts(g) if p.geom_type == 'Polygon' and p.area > 1])
    return dict(v=[round(float(c), 2) for xy in V for c in (xy[0], -xy[1])], i=[int(t) for t in I])


x0, y0, x1, y1 = bbox_m()
meta = dict(
    version=1, chunk=CHUNK, origin=dict(lon=LON0, lat=LAT0, kx=KX, ky=KY),
    bounds=dict(minX=round(x0), maxX=round(x1), minZ=round(-y1), maxZ=round(-y0)),
    chunks=chunks, palette=B['palette'], roadNames=names, roadLabels=rl, searchRoads=sr,
    wards=wards, stations=stations, landmarks=lms,
    piers=[[round(x, 1), round(-y, 1), round(ux, 3), round(-uy, 3), round(h, 1), round(hc, 1), ch,
            round(RV['water_y'] - 0.6, 1) if shapely.contains_xy(_H, x, y) else 0] for x, y, ux, uy, h, hc, ch in G['piers']],
    deckChain=G['deck_chain'],
    gates=[[round(x, 1), round(-y, 1), round(math.cos(a), 3), round(-math.sin(a), 3), round(w, 1)] for x, y, a, w in B['gates']],
    chabutros=[[round(x, 1), round(-y, 1)] for x, y in B['chab']],
    airport=dict(rwy=[*m2three(AF['x0'], AF['y0']), *m2three(AF['x1'], AF['y1']), AF['w']],
                 apron=[list(m2three(*q)) for q in AF['apron']],
                 pave=tri_flat(AFD['pave']), shoulder=tri_flat(AFD['shoulder']),
                 lines=[[k, w, [c for q in pts for c in m2three(*q)]] for k, w, pts in AFD['lines']],
                 stands=[[*m2three(*p), round(AFD['nose'][0], 4), round(-AFD['nose'][1], 4), 1 if atr else 0] for p, atr in AFD['stands']],
                 wall=[[c for q in l for c in m2three(*q)] for l in T.get('apwall', [])],
                 gates=[[*m2three(x, y), round(ux, 4), round(-uy, 4)] for x, y, ux, uy in T.get('apgates', [])]),
    patang=dict(x=m2three(*PATANG)[0], z=m2three(*PATANG)[1]),
    ellis=ELLIS3,
    lm3d=LM3D,
    darwajas=[dict(n=d['name'], x=m2three(d['x'], d['y'])[0], z=m2three(d['x'], d['y'])[1], ux=round(d['ux'], 4), uz=round(-d['uy'], 4),
                   cw=round(d['cw'], 2), ch=round(d['ch'], 2), sw=round(d['sw'], 2), sh=round(d['sh'], 2), dp=d['depth'], pr=d['pier'],
                   plat=[round(d['plat'][0], 2), round(d['plat'][1], 2)] if d['plat'] else None) for d in B['darw']],
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

"""Stage 1: buildings -> projected, subdivided, simplified, styled, triangulated.
Writes /home/claude/build/buildings.pkl"""
import pickle, time, math, numpy as np, shapely, pyarrow.parquet as pq
from shapely import affinity
import mapbox_earcut as earcut
from common import *

t0 = time.time()
t = pq.read_table(f'{DATA}/vedas_ahd.parquet')
g = shapely.from_wkb(t.column('geometry').to_numpy(zero_copy_only=False))
H = np.array([float(x) for x in t.column('Height').to_pylist()])
g = proj_geom(g)
parts, idx = shapely.get_parts(g, return_index=True)
H = H[idx]
bad = ~shapely.is_valid(parts)
if bad.any():
    fixed = shapely.make_valid(parts[bad])
    keep_p, keep_h = [parts[~bad]], [H[~bad]]
    fp, fi = shapely.get_parts(fixed, return_index=True)
    ok = shapely.get_type_id(fp) == 3
    keep_p.append(fp[ok]); keep_h.append(H[bad][fi[ok]])
    parts = np.concatenate(keep_p); H = np.concatenate(keep_h)
area = shapely.area(parts)
m = area >= 10
parts, H, area = parts[m], H[m], area[m]
print('polys', len(parts), round(time.time() - t0, 1))

hull = shapely.area(shapely.convex_hull(parts))
solidity = area / np.maximum(hull, 1e-9)
nv = shapely.get_num_coordinates(parts)
fabric = ((area > 2500) & ((solidity < 0.75) | (nv > 80))) | ((area > 20000) & (solidity < 0.92))

# ---- stadiums: ring-shaped structures around a large round hole (closing first seals entrance gaps) ----
stadium = np.zeros(len(parts), bool)
stands, fields, pitches = [], [], []   # stands: (polygon, height, tier)
N_TIER = 6
big = np.where(area > 4000)[0]
closed = shapely.buffer(shapely.buffer(parts[big], 4, quad_segs=2), -4, quad_segs=2)
for k, i in enumerate(big):
    for q in shapely.get_parts(closed[k]):
        if q.geom_type != 'Polygon':
            continue
        ext = shapely.Polygon(q.exterior)
        holes = [shapely.Polygon(r) for r in q.interiors]
        holes = [h for h in holes if h.area > 2500 and h.area / ext.area > 0.2 and 4 * math.pi * h.area / h.length ** 2 > 0.7]
        if not holes:
            continue
        hole = max(holes, key=lambda h: h.area)
        stadium[i] = True
        bowl = ext.difference(hole)
        W = bowl.area / ((ext.length + hole.length) / 2)
        top = max(H[i], 16.0)
        for t in range(N_TIER):
            outer = hole.buffer(W * (t + 1) / N_TIER, quad_segs=8) if t < N_TIER - 1 else ext
            tier = bowl.intersection(outer)
            if t:
                tier = tier.difference(hole.buffer(W * t / N_TIER, quad_segs=8))
            for p in shapely.get_parts(tier):
                if p.geom_type == 'Polygon' and p.area > 20:
                    stands.append((p, top * (0.3 + 0.7 * t / (N_TIER - 1)), t))
        fields.append(hole.buffer(-1.0))
        rr = np.array(shapely.minimum_rotated_rectangle(hole).exterior.coords)
        e1, e2 = rr[1] - rr[0], rr[2] - rr[1]
        e = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
        u = e / np.hypot(*e); v = np.array([-u[1], u[0]]); c = np.array(hole.centroid.coords[0])
        pitches.append(shapely.Polygon([c - u * 11 - v * 1.8, c + u * 11 - v * 1.8, c + u * 11 + v * 1.8, c - u * 11 + v * 1.8]))
        lon, lat = unproj_xy(c[0], c[1])
        print(f'stadium at {float(lat):.4f},{float(lon):.4f}: field {hole.area:.0f} m2, top {top:.0f} m')
fabric &= ~stadium
print('fabric polys', fabric.sum(), 'area km2', round(area[fabric].sum() / 1e6, 2))

rng = np.random.default_rng(42)

# old walled city (approximate ellipse) for palette
oc_x, oc_y = proj_xy(72.5895, 23.0255)
oc_rx, oc_ry = 0.0155 * KX, 0.0135 * KY


def in_oldcity(x, y):
    return ((x - oc_x) / oc_rx) ** 2 + ((y - oc_y) / oc_ry) ** 2 < 1.0


def subdivide(P, hb):
    rect = shapely.minimum_rotated_rectangle(P)
    c = np.array(rect.exterior.coords)
    e1, e2 = c[1] - c[0], c[2] - c[1]
    e = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
    ang = math.degrees(math.atan2(e[1], e[0]))
    ctr = P.centroid
    Q = affinity.rotate(P, -ang, origin=ctr)
    minx, miny, maxx, maxy = Q.bounds
    if hb < 6:
        cw, cd = 10.0, 13.0
    elif hb < 11:
        cw, cd = 11.0, 15.0
    else:
        cw, cd = 12.0, 17.0
    boxes = []
    yy = miny
    while yy < maxy:
        d = cd * rng.uniform(0.75, 1.3)
        xx = minx - rng.uniform(0, cw)
        while xx < maxx:
            w = cw * rng.uniform(0.6, 1.45)
            boxes.append((xx, yy, xx + w, yy + d))
            xx += w
        yy += d
    b = np.array(boxes)
    bx = shapely.box(b[:, 0], b[:, 1], b[:, 2], b[:, 3])
    cand = shapely.STRtree(bx).query(Q, predicate='intersects')
    cells = shapely.intersection(bx[cand], Q)
    cp = shapely.get_parts(cells)
    cp = cp[(shapely.get_type_id(cp) == 3)]
    cp = cp[shapely.area(cp) > 12]
    out = [affinity.rotate(p, ang, origin=ctr) for p in cp]
    f = rng.uniform(0.5, 1.0, len(out)) if hb >= 8 else rng.uniform(0.7, 1.0, len(out))
    return out, hb * f


polys, hs, isfab, special, parent = [], [], [], [], []
for i in np.where(~fabric & ~stadium)[0]:
    polys.append(parts[i]); hs.append(H[i]); isfab.append(0); special.append(0); parent.append(-1)
for i in np.where(fabric)[0]:
    polys.append(parts[i]); hs.append(H[i] * 0.8); isfab.append(1); special.append(0); parent.append(-1)   # LOD0 block
    cells, ch = subdivide(parts[i], H[i])
    polys += cells; hs += list(ch); isfab += [2] * len(cells); special += [0] * len(cells); parent += [i] * len(cells)   # LOD1 cells
for k_, (p, h, t) in enumerate(stands):
    polys.append(p); hs.append(h); isfab.append(0); special.append(1 + t); parent.append(-2)
polys = np.array(polys, dtype=object); hs = np.array(hs); isfab = np.array(isfab); special = np.array(special); parent = np.array(parent)
print('after subdivision', len(polys), round(time.time() - t0, 1))

# ---- roads win: trim buildings back from the carriageway, drop ones mostly on it ----
import pickle as _pk
from collections import defaultdict
G = _pk.load(open(f'{OUT}/ground.pkl', 'rb'))
rl = [r for r in G['roads'] if not r['bridge']]
rbuf = shapely.buffer(np.array([shapely.LineString(r['xy']) for r in rl], dtype=object), np.array([r['hw'] for r in rl]), quad_segs=3)
bi, ri = shapely.STRtree(rbuf).query(polys, predicate='intersects')
hits = defaultdict(list)
for b_, r_ in zip(bi, ri):
    hits[b_].append(r_)
keep = np.ones(len(polys), bool)
ex_p, ex_h, ex_f, ex_s, ex_par = [], [], [], [], []
dropped = clipped = 0
drop_kind = [0, 0, 0]
for b_, rs in hits.items():
    if special[b_]:
        continue
    P = polys[b_]
    cut = shapely.difference(P, shapely.union_all(rbuf[rs]))
    a0, a1 = P.area, shapely.area(cut)
    if a1 > a0 * 0.97:
        continue
    keep[b_] = False
    if a1 < a0 * 0.45:
        dropped += 1; drop_kind[isfab[b_]] += 1
        continue
    clipped += 1
    for q in shapely.get_parts(cut):
        if q.geom_type == 'Polygon' and q.area > 12:
            ex_p.append(q); ex_h.append(hs[b_]); ex_f.append(isfab[b_]); ex_s.append(0); ex_par.append(parent[b_])
polys = np.concatenate([polys[keep], np.array(ex_p, dtype=object)]) if ex_p else polys[keep]
hs = np.concatenate([hs[keep], np.array(ex_h)]); isfab = np.concatenate([isfab[keep], np.array(ex_f, dtype=int)])
special = np.concatenate([special[keep], np.array(ex_s, dtype=int)]); parent = np.concatenate([parent[keep], np.array(ex_par, dtype=int)])
print(f'road conflicts: {dropped} buildings dropped {drop_kind}, {clipped} trimmed', round(time.time() - t0, 1))

# ---- no overlapping buildings: taller (then larger) footprint keeps the shared area ----
def resolve(sel):
    sel = np.asarray(sel)
    pr = hs[sel] * 1e6 + shapely.area(polys[sel])
    order = sel[np.argsort(-pr)]
    rank = np.empty(len(polys), int); rank[order] = np.arange(len(order))
    a_, b_ = shapely.STRtree(polys[order]).query(polys[order], predicate='intersects')
    m = a_ > b_                                   # b_ has priority over a_
    a_, b_ = order[a_[m]], order[b_[m]]
    sib = (parent[a_] >= 0) & (parent[a_] == parent[b_])
    a_, b_ = a_[~sib], b_[~sib]
    real = shapely.area(shapely.intersection(polys[a_], polys[b_])) > 0.5
    a_, b_ = a_[real], b_[real]
    over = defaultdict(list)
    for x, y in zip(a_, b_):
        over[x].append(y)
    out = {}
    for x, ys in over.items():
        out[x] = shapely.difference(polys[x], shapely.union_all(polys[ys]))
    return out

def apply(cuts, label):
    global polys, hs, isfab, special, parent
    keep = np.ones(len(polys), bool); ex = []
    nd = nt = 0
    for x, cut in cuts.items():
        keep[x] = False
        a0, a1 = polys[x].area, shapely.area(cut)
        if a1 < a0 * 0.3:
            nd += 1; continue
        nt += 1
        for q in shapely.get_parts(cut):
            if q.geom_type == 'Polygon' and q.area > 12:
                ex.append((q, hs[x], isfab[x], special[x], parent[x]))
    polys = np.concatenate([polys[keep], np.array([e[0] for e in ex], dtype=object)])
    hs = np.concatenate([hs[keep], np.array([e[1] for e in ex])])
    isfab = np.concatenate([isfab[keep], np.array([e[2] for e in ex], dtype=int)])
    special = np.concatenate([special[keep], np.array([e[3] for e in ex], dtype=int)])
    parent = np.concatenate([parent[keep], np.array([e[4] for e in ex], dtype=int)])
    print(f'{label}: {nd} dropped, {nt} trimmed', round(time.time() - t0, 1))

apply(resolve(np.where(isfab != 1)[0]), 'overlaps (detail)')
apply(resolve(np.where(isfab != 2)[0]), 'overlaps (far LOD)')

tol = np.where(isfab == 1, 1.2, 0.3)
polys = shapely.simplify(polys, tol, preserve_topology=True)
polys = shapely.orient_polygons(polys, exterior_cw=False)
ok = (shapely.get_type_id(polys) == 3) & (~shapely.is_empty(polys)) & (shapely.area(polys) > 6)
polys, hs, isfab, special = polys[ok], hs[ok], isfab[ok], special[ok]
area = shapely.area(polys)

floors = np.maximum(1, np.round(hs / 3.1)).astype(int)
floors = np.minimum(floors, 60)
hsnap = floors * 3.1 + 0.5
cen = shapely.centroid(polys)
cx, cy = shapely.get_x(cen), shapely.get_y(cen)
old = in_oldcity(cx, cy)
industrial = (isfab == 0) & (special == 0) & (area > 1200) & (hsnap <= 10.5)

# ---- palette: (wall, roof, window_style) ----
PAL = {
    'low': [('#ead9b9', '#cfc8bb'), ('#f0caa2', '#c9c1b2'), ('#dcb68b', '#d4cdc0'), ('#e8ab8c', '#bdb5a7'),
            ('#cbd8c2', '#d2cbbd'), ('#bccfe1', '#c6bfb1'), ('#f1e1a4', '#cdc6b8'), ('#ecd8d0', '#d8d2c6'),
            ('#e3cfae', '#8f9aa6'), ('#f3ece0', '#c4bcae')],
    'mid': [('#f1e8d8', '#d3cdc2'), ('#e6d4b6', '#cbc4b7'), ('#dac5a6', '#d9d3c8'), ('#cbd1d6', '#c9c6bf'),
            ('#ecd9c2', '#d0c9bc'), ('#f2dcc3', '#c4beb3'), ('#d9dccf', '#cdc7bb')],
    'high': [('#f5f3ef', '#dcd8d0'), ('#e0e5e9', '#d4d2cc'), ('#a8bccc', '#cfcdc8'), ('#cad2d8', '#d9d6cf'),
             ('#ebe3d5', '#d6d0c5'), ('#93aabd', '#c9c8c4')],
    'ind': [('#bcc3ca', '#9ea9b3'), ('#aab5be', '#c2c8cd'), ('#cbc6ba', '#8f9ca5'), ('#c4c0b6', '#b27e60'),
            ('#b5bdb2', '#a7b0b8')],
    'old': [('#d9b58d', '#a97c61'), ('#cba07a', '#b9a48e'), ('#e4c8a3', '#9d8f80'), ('#bb916d', '#c5b59e'),
            ('#e7d3b4', '#a8735a'), ('#d6a98a', '#b3a593')],
    'stand': [('#d4d1ca', '#3d6da6'), ('#d4d1ca', '#b9bdc5'), ('#ebe9e4', '#f3f2ee')],
}
WSTYLE = {'low': 1, 'mid': 1, 'high': 2, 'ind': 0, 'old': 3, 'stand': 0}
palette, pal_index = [], {}
for k, lst in PAL.items():
    pal_index[k] = []
    for j, (w, r) in enumerate(lst):
        pal_index[k].append(len(palette))
        ws = WSTYLE[k]
        if k == 'high' and j in (0, 1, 3, 4):
            ws = 1
        palette.append([w, r, ws])

hv = hash01(np.round(cx * 7).astype(np.int64), np.round(cy * 13).astype(np.int64))
style = np.zeros(len(polys), dtype=np.uint8)
for i in range(len(polys)):
    if special[i]:
        t = special[i] - 1
        style[i] = pal_index['stand'][2 if t == N_TIER - 1 else t % 2]
        continue
    if industrial[i]:
        k = 'ind'
    elif old[i] and hsnap[i] < 20:
        k = 'old'
    elif hsnap[i] >= 25:
        k = 'high'
    elif hsnap[i] >= 10:
        k = 'mid'
    else:
        k = 'low'
    lst = pal_index[k]
    style[i] = lst[int(hv[i] * len(lst)) % len(lst)]

recs = None

# ---- rooftop props ----
rp = shapely.point_on_surface(polys)
rpx, rpy = shapely.get_x(rp), shapely.get_y(rp)
inner = shapely.buffer(polys, -1.1, quad_segs=1)
props = []  # (x, y, base_h, type, rot, scale)
rect_ang = np.zeros(len(polys))
for i in range(len(polys)):
    if isfab[i] == 1 or special[i] or industrial[i] or hsnap[i] < 3.5 or area[i] < 35:
        continue
    r = hv[i]
    if r > 0.88:
        continue
    ext = np.asarray(polys[i].exterior.coords)
    seg = np.diff(ext, axis=0); L = np.hypot(seg[:, 0], seg[:, 1]); s = seg[np.argmax(L)]
    ang = math.atan2(s[1], s[0]) % math.pi
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    base = hsnap[i]
    cxp, cyp = rpx[i], rpy[i]
    tanks_on = base
    if hsnap[i] >= 9 and area[i] >= 140:
        sc = 1.0 if hsnap[i] < 25 else 1.6
        props.append((cxp, cyp, base, 1, ang, sc))
        tanks_on = base + 2.7 * (1 if sc == 1.0 else 1.3)
        offs = [(-0.9, 0), (0.9, 0)] if area[i] > 300 else [(0, 0)]
        for ox, oy in offs:
            props.append((cxp + ux * ox * sc + vx * oy, cyp + uy * ox * sc + vy * oy, tanks_on, 0, 0, 1.0))
        # extra roof tanks for big roofs
        if area[i] > 900:
            for k, (ox, oy) in enumerate([(6, 3), (-6, -3), (6, -3)]):
                px, py = cxp + ux * ox + vx * oy, cyp + uy * ox + vy * oy
                if inner[i] is not None and not inner[i].is_empty and inner[i].contains(shapely.Point(px, py)):
                    props.append((px, py, base, 0, 0, 1.0))
    else:
        n = 1 + (area[i] > 500) + (area[i] > 1200 and isfab[i] == 0)
        if isfab[i] == 2 and r > 0.55:
            continue
        cand = [(0, 0), (2.4, 0), (-2.4, 0), (0, 2.4)][:n]
        for ox, oy in cand:
            px, py = cxp + ux * ox + vx * oy, cyp + uy * ox + vy * oy
            if inner[i] is not None and not inner[i].is_empty and inner[i].contains(shapely.Point(px, py)):
                props.append((px, py, base, 0, 0, 0.85 + 0.3 * ((r * 7) % 1)))
props = np.array(props)
print('props', len(props), round(time.time() - t0, 1))

pickle.dump(dict(polys=polys, hs=hsnap, style=style, recs=recs, props=props, palette=palette, fields=fields, pitches=pitches,
                 fabric=isfab, industrial=industrial), open(f'{OUT}/buildings.pkl', 'wb'))
print('done', round(time.time() - t0, 1))

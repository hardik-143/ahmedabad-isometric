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

# ---- heights: the VEDAS DSM heights are heavily compressed (4-6 storey societies come out at 1-2 floors).
# Google Open Buildings v3 footprints carry per-building heights from the Open Buildings 2.5D Temporal (2023) rasters;
# use them (calibrated) as a second opinion and keep whichever source says taller.
tq = pq.read_table(f'{DATA}/gobi_ahd.parquet', columns=['confidence', 'height', 'geometry'])
gq = proj_geom(shapely.from_wkb(tq.column('geometry').to_numpy(zero_copy_only=False)))
hq = cal_height(tq.column('height').to_numpy(zero_copy_only=False))
okq = (tq.column('confidence').to_numpy() >= 0.68) & shapely.is_valid(gq)
gq, hq = gq[okq], hq[okq]
gq, _gi = shapely.get_parts(gq, return_index=True)          # stored as (mostly single-part) multipolygons
hq = hq[_gi]
_pt = shapely.get_type_id(gq) == 3
gq, hq = gq[_pt], hq[_pt]
aq = shapely.area(gq); m = aq >= 10
gq, hq, aq = gq[m], hq[m], aq[m]
qc = shapely.centroid(gq)
qi, vi = shapely.STRtree(parts).query(qc, predicate='within')
owner = np.full(len(gq), -1); owner[qi] = vi
has_h = hq[qi] > 0.5
A_ = np.bincount(vi[has_h], weights=aq[qi][has_h], minlength=len(parts))
W_ = np.bincount(vi[has_h], weights=(aq * hq)[qi][has_h], minlength=len(parts))
cover = A_ / area
Hq = np.where(cover >= 0.2, W_ / np.maximum(A_, 1e-9), 0.0)
# a single dominant building inside a merged VEDAS outline sets the height on its own
_dom = has_h & (aq[qi] >= 0.25 * area[vi])
Hdom = np.zeros(len(parts)); np.maximum.at(Hdom, vi[_dom], hq[qi][_dom])
Hq = np.maximum(Hq, Hdom)
H0 = H.copy()
H = np.maximum(H, Hq)
fl0, fl1 = np.maximum(1, np.round(H0 / 3.1)), np.maximum(1, np.round(H / 3.1))
print(f'heights: google covers {np.mean(cover >= 0.2) * 100:.0f}% of footprints; raised {np.mean(fl1 > fl0) * 100:.0f}% '
      f'(by 2+ floors {np.mean(fl1 - fl0 >= 2) * 100:.0f}%); floors>=4 {np.mean(fl0 >= 4) * 100:.1f}% -> {np.mean(fl1 >= 4) * 100:.1f}%')
WC = wc_poly()
vcen = shapely.centroid(parts)
inwc_v = shapely.contains_xy(WC, shapely.get_x(vcen), shapely.get_y(vcen))
inwc_q = shapely.contains_xy(WC, shapely.get_x(qc), shapely.get_y(qc))

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
    elif hb < 17:
        cw, cd = 13.0, 18.0
    else:
        cw, cd = 18.0, 24.0
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
    f = rng.uniform(0.8, 1.0, len(out))
    return out, hb * f


polys, hs, isfab, special, parent, src = [], [], [], [], [], []
kids = {}
for q, o in enumerate(owner):
    if o >= 0:
        kids.setdefault(o, []).append(q)
wc_tall = (~fabric) & (~stadium) & inwc_v & (H > 15.5) & (area > 150)
n_real = n_proc = 0
for i in np.where(~fabric & ~stadium)[0]:
    # inside the walled city the VEDAS outlines are merged pol blocks: far LOD only, real houses come from Google below
    polys.append(parts[i]); hs.append(H[i]); isfab.append(1 if inwc_v[i] and not wc_tall[i] else 0); special.append(0); parent.append(-1); src.append(0)
for i in np.where(fabric)[0]:
    polys.append(parts[i]); hs.append(H[i] * 0.85); isfab.append(1); special.append(0); parent.append(-1); src.append(0)   # LOD0 block
    if inwc_v[i]:
        continue
    ks = [q for q in kids.get(i, []) if not inwc_q[q]]
    if ks and aq[ks].sum() >= 0.3 * area[i]:
        # real footprints of the individual houses (Google Open Buildings) instead of a procedural split
        n_real += len(ks)
        for q in ks:
            polys.append(gq[q]); hs.append(max(hq[q], 3.0) if hq[q] > 0.5 else H[i] * rng.uniform(0.8, 1.0))
            isfab.append(2); special.append(0); parent.append(-3); src.append(1)
    else:
        cells, ch = subdivide(parts[i], H[i])
        n_proc += len(cells)
        polys += cells; hs += list(ch); isfab += [2] * len(cells); special += [0] * len(cells); parent += [i] * len(cells); src += [0] * len(cells)
# walled city: every Google footprint is a house (pol house), unless it sits inside a modern tower we keep
tall_idx = set(np.where(wc_tall)[0].tolist())
n_wc = 0
for q in np.where(inwc_q)[0]:
    if owner[q] in tall_idx:
        continue
    polys.append(gq[q]); hs.append(max(hq[q], 3.0)); isfab.append(2); special.append(0); parent.append(-3); src.append(1); n_wc += 1
# buildings VEDAS never mapped (whole outskirts are empty in it): take Google's footprints as they are
n_fill = 0
_un = np.where((owner < 0) & ~inwc_q)[0]
_qa, _va = shapely.STRtree(parts).query(gq[_un], predicate='intersects')
_ov = np.bincount(_qa, weights=shapely.area(shapely.intersection(gq[_un][_qa], parts[_va])), minlength=len(_un))
dup = np.zeros(len(gq), bool); dup[_un] = _ov > 0.06 * aq[_un]     # same building already mapped by VEDAS
_rwy = shapely.buffer(shapely.LineString([proj_xy(72.622394, 23.065897), proj_xy(72.646431, 23.088442)]), 160, cap_style='flat')
for q in np.where((owner < 0) & ~inwc_q)[0]:
    if aq[q] < 14 or dup[q] or _rwy.contains(qc[q]):
        continue
    # small houses only exist at street-level zoom (keeps the city-wide download lean)
    polys.append(gq[q]); hs.append(max(hq[q], 3.0)); isfab.append(0 if aq[q] >= 110 else 2); special.append(0); parent.append(-3); src.append(1)
    n_fill += 1
print(f'detail footprints: {n_real} real (Google) in dense blocks, {n_proc} procedural cells, {n_wc} walled-city houses, '
      f'{n_fill} gap-fill buildings')
for k_, (p, h, t) in enumerate(stands):
    polys.append(p); hs.append(h); isfab.append(0); special.append(1 + t); parent.append(-2); src.append(0)
polys = np.array(polys, dtype=object); hs = np.array(hs); isfab = np.array(isfab); special = np.array(special); parent = np.array(parent)
src = np.array(src)
print('after subdivision', len(polys), round(time.time() - t0, 1))

# ---- roads win: trim buildings back from the carriageway, drop ones mostly on it ----
import pickle as _pk
from collections import defaultdict
G = _pk.load(open(f'{OUT}/ground.pkl', 'rb'))
rl = list(G['roads'])   # nothing is built on, or under, a road or flyover deck
rbuf = shapely.buffer(np.array([shapely.LineString(r['xy']) for r in rl], dtype=object), np.array([r['hw'] + r['sw'] + 0.4 for r in rl]), quad_segs=3)
jk = list(G['junctions'].keys())
jbuf = shapely.buffer(shapely.points(np.array(jk, dtype=float)), np.array([G['junctions'][k][0] + 0.4 for k in jk]), quad_segs=4)
rbuf = np.concatenate([rbuf, jbuf])
bi, ri = shapely.STRtree(rbuf).query(polys, predicate='intersects')
hits = defaultdict(list)
for b_, r_ in zip(bi, ri):
    hits[b_].append(r_)
keep = np.ones(len(polys), bool)
ex_p, ex_h, ex_f, ex_s, ex_par, ex_src = [], [], [], [], [], []
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
            ex_p.append(q); ex_h.append(hs[b_]); ex_f.append(isfab[b_]); ex_s.append(0); ex_par.append(parent[b_]); ex_src.append(src[b_])
polys = np.concatenate([polys[keep], np.array(ex_p, dtype=object)]) if ex_p else polys[keep]
hs = np.concatenate([hs[keep], np.array(ex_h)]); isfab = np.concatenate([isfab[keep], np.array(ex_f, dtype=int)])
special = np.concatenate([special[keep], np.array(ex_s, dtype=int)]); parent = np.concatenate([parent[keep], np.array(ex_par, dtype=int)])
src = np.concatenate([src[keep], np.array(ex_src, dtype=int)])
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
    global polys, hs, isfab, special, parent, src
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
                ex.append((q, hs[x], isfab[x], special[x], parent[x], src[x]))
    polys = np.concatenate([polys[keep], np.array([e[0] for e in ex], dtype=object)])
    hs = np.concatenate([hs[keep], np.array([e[1] for e in ex])])
    isfab = np.concatenate([isfab[keep], np.array([e[2] for e in ex], dtype=int)])
    special = np.concatenate([special[keep], np.array([e[3] for e in ex], dtype=int)])
    parent = np.concatenate([parent[keep], np.array([e[4] for e in ex], dtype=int)])
    src = np.concatenate([src[keep], np.array([e[5] for e in ex], dtype=int)])
    print(f'{label}: {nd} dropped, {nt} trimmed', round(time.time() - t0, 1))

# a Google footprint that overlaps a VEDAS building is the same building seen twice (slightly offset):
# drop it rather than trimming it, which would fuse two differently coloured halves into one
_g = np.where(src == 1)[0]; _v = np.where((src == 0) & (isfab == 0) & (special == 0))[0]
_gi_, _vi_ = shapely.STRtree(polys[_v]).query(polys[_g], predicate='intersects')
_ova = shapely.area(shapely.intersection(polys[_g][_gi_], polys[_v][_vi_]))
_ovs = np.bincount(_gi_, weights=_ova, minlength=len(_g))
_dropg = _g[_ovs > 0.06 * shapely.area(polys[_g])]
_keep = np.ones(len(polys), bool); _keep[_dropg] = False
print('cross-source duplicates dropped', len(_dropg))
polys, hs, isfab, special, parent, src = polys[_keep], hs[_keep], isfab[_keep], special[_keep], parent[_keep], src[_keep]
apply(resolve(np.where(isfab != 1)[0]), 'overlaps (detail)')
apply(resolve(np.where(isfab != 2)[0]), 'overlaps (far LOD)')

# ---- separate neighbours: pull every footprint in so adjoining buildings read as distinct blocks ----
_c = shapely.centroid(polys)
_wc = shapely.contains_xy(WC, shapely.get_x(_c), shapely.get_y(_c))
# real (Google) house footprints already have their own gaps; pol row houses share walls, so only a hairline seam there
inset = np.where(special > 0, 0.0, np.where(src == 1, np.where(_wc, 0.12, 0.3), np.where(isfab == 2, 0.6, 0.7)))
shr = shapely.buffer(polys, -inset, join_style='mitre', mitre_limit=2.0)
P2, H2, F2, S2, R2_, C2 = [], [], [], [], [], []
for k in range(len(polys)):
    g = shr[k] if inset[k] > 0 else polys[k]
    for q in shapely.get_parts(g):
        if q.geom_type == 'Polygon' and q.area > 9:
            P2.append(q); H2.append(hs[k]); F2.append(isfab[k]); S2.append(special[k]); R2_.append(parent[k]); C2.append(src[k])
print(f'inset: {len(polys)} -> {len(P2)} footprints', round(time.time() - t0, 1))
polys = np.array(P2, dtype=object); hs = np.array(H2); isfab = np.array(F2); special = np.array(S2); parent = np.array(R2_); src = np.array(C2)

tol = np.where(isfab == 1, 1.2, np.where(src == 1, 0.2, 0.3))
polys = shapely.simplify(polys, tol, preserve_topology=True)
polys = shapely.orient_polygons(polys, exterior_cw=False)
ok = (shapely.get_type_id(polys) == 3) & (~shapely.is_empty(polys)) & (shapely.area(polys) > 6)
polys, hs, isfab, special, src = polys[ok], hs[ok], isfab[ok], special[ok], src[ok]
area = shapely.area(polys)

# ---- darwajas. City gates are openings in the old wall, so the passage runs across the wall line: find the street
# that crosses the wall within a few tens of metres of the recorded position and stand the gate astride it.
# Teen Darwaza is the citadel's inner gate and straddles the Bhadra - Manek Chowk street.
darw = []
_flat_all = [r for r in G['roads'] if r.get('z') is None]
_rls = np.array([shapely.LineString(r['xy']) for r in _flat_all], dtype=object)
_dl = shapely.STRtree(_rls)
_wall = WC.exterior
def _dir_at(ln, q):
    t = ln.project(q); a1_, b1_ = ln.interpolate(max(0, t - 5)), ln.interpolate(min(ln.length, t + 5))
    dx_, dy_ = b1_.x - a1_.x, b1_.y - a1_.y; l_ = math.hypot(dx_, dy_) or 1
    return dx_ / l_, dy_ / l_
for nm, la, lo, cw, ch, sw_, plat, depth, pier in DARWAJAS:
    x, y = proj_xy(lo, la); P_ = shapely.Point(x, y)
    best_ = None
    if nm == 'Teen Darwaza':
        for j in _dl.query(P_.buffer(30)):
            d_ = _rls[j].distance(P_)
            if best_ is None or d_ < best_[0]:
                q = _rls[j].interpolate(_rls[j].project(P_)); best_ = (d_, q, _dir_at(_rls[j], q), _flat_all[j])
    else:
        tw0 = _wall.project(P_); wa, wb = _wall.interpolate(tw0 - 25), _wall.interpolate(tw0 + 25)
        Tx, Ty = wb.x - wa.x, wb.y - wa.y; tl = math.hypot(Tx, Ty) or 1; Tx, Ty = Tx / tl, Ty / tl
        Nx, Ny = -Ty, Tx
        seg = shapely.LineString([(x - Tx * 45, y - Ty * 45), (x + Tx * 45, y + Ty * 45)])
        for j in _dl.query(seg, predicate='intersects'):
            for q in shapely.get_parts(_rls[j].intersection(seg)):
                if q.geom_type != 'Point':
                    continue
                ux_, uy_ = _dir_at(_rls[j], q)
                if abs(ux_ * Nx + uy_ * Ny) < 0.55:     # runs along the wall, not through it
                    continue
                sc = q.distance(P_) - 5 * _flat_all[j]['cls']
                if best_ is None or sc < best_[0]:
                    best_ = (sc, q, (ux_, uy_), _flat_all[j])
        if best_ is None:
            best_ = (0, P_, (Nx, Ny), None)
    _, q, (ux, uy), rr = best_
    x, y = q.x, q.y
    print(f'  {nm:18s} moved {math.hypot(x - proj_xy(lo, la)[0], y - proj_xy(lo, la)[1]):5.1f} m onto '
          f'{(rr["name"] or "unnamed") if rr else "-"} (cls {rr["cls"] if rr else "-"})')
    sw_ = sw_ if sw_ else cw * 0.72
    W = cw + 2 * sw_ + 4 * pier
    darw.append(dict(name=nm, x=x, y=y, ux=ux, uy=uy, cw=cw, ch=ch, sw=sw_, sh=ch * 0.8, depth=depth, pier=pier, W=W, plat=plat))
_gz = shapely.union_all([shapely.Polygon([(d['x'] + d['ux'] * a_ * (d['depth'] / 2 + 1.5) + -d['uy'] * b_ * (d['W'] / 2 + 1.5),
                                           d['y'] + d['uy'] * a_ * (d['depth'] / 2 + 1.5) + d['ux'] * b_ * (d['W'] / 2 + 1.5))
                                          for a_, b_ in ((-1, -1), (1, -1), (1, 1), (-1, 1))]) for d in darw])
_okg = ~shapely.intersects(polys, _gz)
print('darwajas', len(darw), 'cleared', int((~_okg).sum()), 'footprints')
polys, hs, isfab, special, src = polys[_okg], hs[_okg], isfab[_okg], special[_okg], src[_okg]

# ---- nothing standing in water (lake-bed / riverbed footprints from older imagery)
_wat = shapely.union_all(list(G['water']))
_wi = shapely.STRtree(polys).query(_wat, predicate='intersects')
_wi = np.unique(_wi[1] if _wi.ndim == 2 else _wi)
_wa = np.zeros(len(polys))
_wa[_wi] = shapely.area(shapely.intersection(polys[_wi], _wat)) / np.maximum(shapely.area(polys[_wi]), 1e-9)
_okw = _wa < 0.35
print('water: removed', int((~_okw).sum()), 'footprints standing in lakes / the river')
polys, hs, isfab, special, src = polys[_okw], hs[_okw], isfab[_okw], special[_okw], src[_okw]

# ---- nothing on the runway, taxiways or apron
AF = airfield()
_af = shapely.union_all([shapely.buffer(shapely.LineString([(AF['x0'], AF['y0']), (AF['x1'], AF['y1'])]), 80, cap_style='flat')]
                        + [shapely.buffer(shapely.LineString(t['xy']), 30) for t in AF['twy']] + [shapely.Polygon(AF['apron'])])
_c = shapely.centroid(polys)
ok = ~shapely.contains_xy(_af, shapely.get_x(_c), shapely.get_y(_c))
print('airfield: removed', int((~ok).sum()), 'footprints')
polys, hs, isfab, special, src = polys[ok], hs[ok], isfab[ok], special[ok], src[ok]
area = shapely.area(polys)

floors = np.maximum(1, np.round(hs / 3.1)).astype(int)
floors = np.minimum(floors, 60)
hsnap = floors * 3.1 + 0.5
cen = shapely.centroid(polys)
cx, cy = shapely.get_x(cen), shapely.get_y(cen)
inwc = shapely.contains_xy(WC, cx, cy)

# ---- pol houses: street facade (edge opening onto a lane/chowk), roof form, ridge parallel to the street
prng = np.random.default_rng(7)
N = len(polys)
polT = np.zeros(N, np.uint8); face = np.full(N, 255, np.uint8); face2 = np.full(N, 255, np.uint8)
rr0 = np.zeros(N, np.uint8); rr1 = np.zeros(N, np.uint8); rise = np.zeros(N, np.uint8)
cand = np.where(inwc & (src == 1) & (floors <= 4) & (special == 0))[0]
_flat = [r for r in G['roads'] if r.get('z') is None]
rlines = np.array([shapely.LineString(r['xy']) for r in _flat], dtype=object)
rclear = np.array([r['hw'] + r['sw'] for r in _flat])
rtree, btree = shapely.STRtree(rlines), shapely.STRtree(polys)
E = []  # (building, edge, x0, y0, x1, y1)
for i in cand:
    ring = np.asarray(polys[i].exterior.coords)
    for k in range(len(ring) - 1):
        E.append((i, k, ring[k, 0], ring[k, 1], ring[k + 1, 0], ring[k + 1, 1]))
E = np.array(E)
eb, ek = E[:, 0].astype(int), E[:, 1].astype(int)
dx, dy = E[:, 4] - E[:, 2], E[:, 5] - E[:, 3]; EL = np.hypot(dx, dy) + 1e-9
nx_, ny_ = dy / EL, -dx / EL                                   # outward normal of a CCW ring
mx, my = (E[:, 2] + E[:, 4]) / 2, (E[:, 3] + E[:, 5]) / 2
p1 = shapely.points(mx + nx_ * 1.0, my + ny_ * 1.0); p2 = shapely.points(mx + nx_ * 2.6, my + ny_ * 2.6)
blocked = np.zeros(len(E), bool)
for pp in (p1, p2):
    a_, b_ = btree.query(pp, predicate='intersects'); blocked[a_] = True
ri, rd = rtree.query_nearest(p1, return_distance=True, all_matches=False)
near = np.zeros(len(E), bool); near[ri[0]] = rd <= rclear[ri[1]] + 3.0
score = EL * (~blocked) * (1 + 1.5 * near) * (EL >= 1.8)
best = {}
for j in np.argsort(-score):
    if score[j] <= 0:
        break
    b = eb[j]
    if b not in best:
        best[b] = [j]
    elif len(best[b]) == 1:
        j0 = best[b][0]
        if abs(dx[j] * dx[j0] + dy[j] * dy[j0]) / (EL[j] * EL[j0]) < 0.7 and EL[j] >= 3.0:
            best[b].append(j)
TAN = math.tan(math.radians(24))
n_gable = n_flat = 0
for i in cand:
    js = best.get(i, [])
    P = polys[i]
    ring = np.asarray(P.exterior.coords)[:-1]; n = len(ring)
    fe = ek[js[0]] if js else -1
    fe2 = ek[js[1]] if len(js) > 1 else -1
    want_gable = prng.random() < 0.68 and len(P.interiors) == 0 and n <= 120
    done = False
    if want_gable:
        if fe >= 0:
            d = ring[(fe + 1) % n] - ring[fe]
        else:
            sg = np.diff(np.vstack([ring, ring[:1]]), axis=0); d = sg[np.argmax(np.hypot(sg[:, 0], sg[:, 1]))]
        u = d / (np.hypot(*d) + 1e-9); v = np.array([-u[1], u[0]])
        pr = (ring - ring[0]) @ v; c = (pr.min() + pr.max()) / 2; half = (pr.max() - pr.min()) / 2
        dd = pr - c
        if half >= 1.3:
            new, ridx, omap = [], [], {}
            for k in range(n):
                a, b = ring[k], ring[(k + 1) % n]; da, db = dd[k], dd[(k + 1) % n]
                omap[k] = len(new); new.append(a)
                if abs(da) < 1e-6:
                    ridx.append(len(new) - 1)
                elif da * db < 0 and abs(db) > 1e-6:
                    t = da / (da - db); new.append(a + (b - a) * t); ridx.append(len(new) - 1)
            if len(ridx) == 2 and len(new) <= 250:
                Q = shapely.Polygon(new)
                if Q.is_valid:
                    polys[i] = Q
                    polT[i] = 2; rr0[i], rr1[i] = ridx
                    rise[i] = int(round(min(2.4, max(0.9, half * TAN)) * 10))
                    if fe >= 0: face[i] = omap[fe]
                    if fe2 >= 0: face2[i] = omap[fe2]
                    done = True; n_gable += 1
    if not done:
        polT[i] = 1; n_flat += 1
        if fe >= 0: face[i] = fe
        if fe2 >= 0: face2[i] = fe2
print(f'pol houses: {n_gable} tiled gable roofs, {n_flat} flat terraces (agasi), {int((face[cand] < 255).sum())} with a street facade')

# ---- pol gates (at lane mouths on bigger streets) and chabutros (bird feeders in the lane chowks)
from collections import defaultdict as _dd
ends = _dd(list)
for r in _flat:
    xy = np.asarray(r['xy'])
    for e, pt in ((0, xy[0]), (-1, xy[-1])):
        ends[(round(pt[0], 1), round(pt[1], 1))].append((r, e))
gates, chab = [], []
for key, lst in ends.items():
    if not WC.contains(shapely.Point(key)):
        continue
    big = [r for r, e in lst if r['cls'] >= 3]
    lanes = [(r, e) for r, e in lst if r['cls'] <= 2]
    if big:
        off = max(r['hw'] + r['sw'] for r in big) + 3.5
        for r, e in lanes:
            ln = shapely.LineString(r['xy'])
            if ln.length < 35:
                continue
            s0 = off if e == 0 else ln.length - off
            pa, pb = ln.interpolate(max(0, s0 - 1)), ln.interpolate(min(ln.length, s0 + 1))
            pc = ln.interpolate(s0)
            ang = math.atan2(pb.y - pa.y, pb.x - pa.x)
            gates.append((pc.x, pc.y, ang, r['hw'] + r['sw'] + 0.4))
    elif len(lanes) >= 3:
        chab.append(key)
def _thin(pts, dmin):
    out = []
    for p in pts:
        if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > dmin * dmin for q in out):
            out.append(p)
    return out
gates = _thin(gates, 22)
chab = [c for c in _thin(chab, 70) if all((c[0] - g[0]) ** 2 + (c[1] - g[1]) ** 2 > 30 ** 2 for g in gates)]
# keep the little pol gates and bird feeders well clear of the big city gates
_gzb = _gz.buffer(12)
gates = [g for g in gates if not _gzb.contains(shapely.Point(g[0], g[1]))]
chab = [c for c in chab if not _gzb.contains(shapely.Point(c[0], c[1]))]
print('pol gates', len(gates), 'chabutros', len(chab))
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
    # pol houses: lime-washed pastel walls (yellow, blue, green, red ochre, white) under Mangalore-tile roofs
    'pol': [('#e9d9a6', '#a5522f'), ('#cfe0cf', '#b3623b'), ('#b8cfe3', '#8e4a2d'), ('#ebc3ae', '#9b5b3d'),
            ('#f1e8d6', '#a5522f'), ('#a9cdb6', '#7f4b36'), ('#e8d290', '#b86b45'), ('#d98f7a', '#9b5b3d'),
            ('#9fc3cf', '#a5522f'), ('#d9cbe3', '#b3623b'), ('#f3ead2', '#8e4a2d'), ('#c9b48e', '#a5522f')],
    # far-LOD walled-city blocks: read as a sea of tile roofs from above
    'polblk': [('#dcc39a', '#a35a3a'), ('#d2b48f', '#9a5a3f'), ('#e2cfaa', '#ad6644'), ('#cdb08a', '#8f5038')],
    # airport terminals / hangars: glass curtain walls, light metal roofs
    'term': [('#dfe6ec', '#e9ecee'), ('#cfd9e2', '#dfe3e6'), ('#e8ebee', '#d5dade')],
}
WSTYLE = {'low': 1, 'mid': 1, 'high': 2, 'ind': 10, 'old': 3, 'stand': 0, 'pol': 4, 'polblk': 3, 'term': 2}
palette, pal_index = [], {}
for k, lst in PAL.items():
    pal_index[k] = []
    for j, (w, r) in enumerate(lst):
        pal_index[k].append(len(palette))
        ws = WSTYLE[k]
        if k == 'high' and j in (0, 1, 3, 4):
            ws = 1
        palette.append([w, r, ws])

# terminal zone: the built strip behind the apron, along the terminal side of the runway
_tz = shapely.Polygon([AF['P'](-250, 440), AF['P'](1450, 440), AF['P'](1450, 720), AF['P'](-250, 720)])
terminal = shapely.contains_xy(_tz, cx, cy) & (area > 1500) & (special == 0)
hsnap = np.where(terminal, np.maximum(hsnap, 3 * 3.1 + 0.5), hsnap)
print('airport terminal/hangar buildings', int(terminal.sum()))
hv = hash01(np.round(cx * 7).astype(np.int64), np.round(cy * 13).astype(np.int64))
style = np.zeros(len(polys), dtype=np.uint8)
for i in range(len(polys)):
    if special[i]:
        t = special[i] - 1
        style[i] = pal_index['stand'][2 if t == N_TIER - 1 else t % 2]
        continue
    if terminal[i]:
        k = 'term'
    elif polT[i]:
        k = 'pol'
    elif inwc[i] and isfab[i] == 1:
        k = 'polblk'
    elif industrial[i]:
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
    if isfab[i] == 1 or special[i] or industrial[i] or hsnap[i] < 3.5 or area[i] < 35 or polT[i] == 2 or terminal[i]:
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
        # rooftop solar on a few modern blocks (Gujarat's rooftop-solar push), kept clear of the stair room
        if not inwc[i] and hsnap[i] >= 10 and area[i] >= 260 and ((r * 37.0) % 1.0) < 0.13:
            for ox, oy in ((6.5, 0), (-6.5, 0), (0, 6.0)):
                px, py = cxp + ux * ox + vx * oy, cyp + uy * ox + vy * oy
                if inner[i] is not None and not inner[i].is_empty and inner[i].buffer(-3.2).contains(shapely.Point(px, py)):
                    props.append((px, py, base, 2, ang, 1.0)); break
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
                 fabric=isfab, industrial=industrial, polT=polT, face=face, face2=face2, rr0=rr0, rr1=rr1, rise=rise,
                 gates=gates, chab=chab, darw=darw), open(f'{OUT}/buildings.pkl', 'wb'))
print('done', round(time.time() - t0, 1))

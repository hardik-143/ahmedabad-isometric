"""Janmarg BRTS corridors, median stations and timetable, from the official Janmarg GTFS (stops, route stop
sequences, stop_times) as packaged in str3939/Janmarg-BRTS-Guide (brts.db). The GTFS has no shapes, so every route
is routed stop-to-stop over the major-road graph. Janmarg runs in dedicated median lanes: on dual carriageways the
corridor is moved onto the median, single carriageways are widened to fit bus lanes + barriers + general lanes,
barriers open at crossing streets and each station is an island in the median with its ramp to a zebra crossing.
Called from p_ground (before junction discs are sized) via build_brts(R2)."""
import sqlite3, math, numpy as np, shapely, shapely.ops, networkx as nx
from common import *

FAC = {2: 3.0, 3: 1.6, 4: 1.4}
LANE_HW = 4.1          # two 3.5 m bus lanes + barrier kerbs
ST_LEN, ST_W = 44.0, 4.6
ROAD_HW = 12.0         # single carriageway carrying the corridor: bus lanes + 2 x 2 general lanes each side


def _unit(v):
    l = math.hypot(*v) or 1.0
    return (v[0] / l, v[1] / l)


def build_brts(R2, log=print):
    db = sqlite3.connect(f'{DATA}/brts.db')
    STOPS = {sid: (name.strip(), *proj_xy(lon, lat)) for sid, name, lat, lon in
             db.execute('select stop_id, stop_name, stop_lat, stop_lon from stops')}
    SEQ = {}
    for rid, seq, sid in db.execute('select route_id, stop_sequence, stop_id from route_stops order by route_id, stop_sequence'):
        if sid in STOPS:
            SEQ.setdefault(rid, []).append(sid)
    RNAME = {r: n for r, n in db.execute('select route_id, long_name from routes')}

    # ---- road graph over the major network; nodes = piece endpoints merged within 1.5 m
    cand = [i for i, r in enumerate(R2) if r['cls'] >= 2]
    lines = {i: shapely.LineString(R2[i]['xy']) for i in cand}
    ends = np.array([[*R2[i]['xy'][0], *R2[i]['xy'][-1]] for i in cand], float)
    key = np.round(np.concatenate([ends[:, :2], ends[:, 2:]]) / 1.5).astype(np.int64)
    _, nid = np.unique(key[:, 0] * 10_000_019 + key[:, 1], return_inverse=True)
    nA, nB = nid[:len(cand)], nid[len(cand):]
    NG = nx.Graph()
    pos = {}
    for k, i in enumerate(cand):
        a, b = int(nA[k]), int(nB[k]); pos[i] = (a, b)
        if a == b:
            continue
        w = lines[i].length * FAC.get(R2[i]['cls'], 1.0) * (1.3 if R2[i]['bridge'] else 1.0) * (3.0 if 'service' in (R2[i]['name'] or '').lower() else 1.0)
        if not NG.has_edge(a, b) or NG[a][b]['w'] > w:
            NG.add_edge(a, b, w=w, i=i)
    # ---- stations snapped to the nearest main road (secondary and above preferred)
    mi = np.array([i for i in cand if R2[i]['cls'] >= 3])
    mtree = shapely.STRtree([lines[i] for i in mi])
    SNAP = {}
    for sid, (nm, x, y) in STOPS.items():
        p = shapely.Point(x, y); best = None
        for j in mtree.query(p, predicate='dwithin', distance=90):
            i = int(mi[j]); d = lines[i].distance(p)
            sc = d - (12 if R2[i]['cls'] >= 5 else 0) + (40 if R2[i]['bridge'] else 0)
            if best is None or sc < best[0]:
                best = (sc, i)
        if best:
            i = best[1]; t = lines[i].project(p); a, b = pos[i]; L = lines[i].length; f = FAC.get(R2[i]['cls'], 1.0)
            SNAP[sid] = (i, t)
            NG.add_edge(('s', sid), a, w=t * f, i=i, part=(t, 0.0))
            NG.add_edge(('s', sid), b, w=(L - t) * f, i=i, part=(t, L))
    # ---- route every leg; remember which road stretches each route uses (and in which order, for the buses)
    legs, USE, RPATH = {}, {}, {}
    for rid, seq in SEQ.items():
        rp = []
        for a, b in zip(seq[:-1], seq[1:]):
            if a == b or a not in SNAP or b not in SNAP:
                continue
            pk = (a, b)
            if pk not in legs:
                (ia, ta), (ib, tb) = SNAP[a], SNAP[b]
                segs = []
                if ia == ib:
                    segs.append((ia, ta, tb))
                else:
                    try:
                        path = nx.shortest_path(NG, ('s', a), ('s', b), weight='w')
                    except nx.NetworkXNoPath:
                        legs[pk] = []; continue
                    for u, v in zip(path[:-1], path[1:]):
                        d = NG[u][v]; i = d['i']
                        if 'part' in d:
                            t, e = d['part']
                            segs.append((i, t, e) if u == ('s', a) else (i, e, t))
                        else:
                            # direction along the piece: from u's end to v's end
                            segs.append((i, 0.0, lines[i].length) if pos[i][0] == u else (i, lines[i].length, 0.0))
                legs[pk] = [s for s in segs if abs(s[2] - s[1]) > 0.5]
            for (i, s0, s1) in legs[pk]:
                USE.setdefault((i, min(s0, s1), max(s0, s1)), set()).add(rid)
            rp.append((a, b))
        RPATH[rid] = rp
    cover = {}
    for (i, s0, s1), rs in USE.items():
        cover.setdefault(i, []).append((s0, s1, rs))
    parts = []
    for i, iv in cover.items():
        iv.sort(); cur = None
        for s0, s1, rs in iv:
            if cur and s0 <= cur[1] + 1.0:
                cur = (cur[0], max(cur[1], s1), cur[2] | rs)
            else:
                if cur:
                    parts.append((i, *cur))
                cur = (s0, s1, set(rs))
        parts.append((i, *cur))
    log(f'brts: {len(STOPS)} stations, {len(SEQ)} routes, {len(SNAP)} snapped, {len(legs)} legs, '
        f'{sum(p[2] - p[1] for p in parts) / 1000:.1f} km of road used')

    # ---- dual carriageways: a parallel same-name piece 5-38 m to one side -> corridor on the median
    ati = [i for i, r in enumerate(R2) if r['cls'] >= 3 and not r['bridge']]
    atl = [shapely.LineString(R2[i]['xy']) for i in ati]
    atree = shapely.STRtree(atl)
    med = []      # (line, twin, routes, road idx)
    twin_of = {}
    for (i, s0, s1, rs) in sorted(parts, key=lambda p: -(p[2] - p[1])):
        r = R2[i]
        g = shapely.ops.substring(lines[i], s0, s1)
        if g.geom_type != 'LineString' or g.length < 6 or r['bridge']:
            continue
        offs = []
        for f in np.linspace(0.1, 0.9, 7):
            sp = f * g.length; p = g.interpolate(sp)
            q0, q1 = g.interpolate(max(0, sp - 3)), g.interpolate(min(g.length, sp + 3))
            t = _unit((q1.x - q0.x, q1.y - q0.y)); nl = (-t[1], t[0])
            best = None
            for j in atree.query(p, predicate='dwithin', distance=45):
                k = ati[j]
                if k == i:
                    continue
                if r['name'] and R2[k]['name'] and R2[k]['name'] != r['name'] and 'service' not in R2[k]['name'].lower():
                    continue
                o = atl[j]; so = o.project(p); pp = o.interpolate(so)
                v = (pp.x - p.x, pp.y - p.y); lat = v[0] * nl[0] + v[1] * nl[1]; along = v[0] * t[0] + v[1] * t[1]
                if abs(lat) < 5 or abs(lat) > 45 or abs(along) > 8:
                    continue
                pa, pb = o.interpolate(max(0, so - 3)), o.interpolate(min(o.length, so + 3))
                to = _unit((pb.x - pa.x, pb.y - pa.y))
                if abs(to[0] * t[0] + to[1] * t[1]) < 0.94:
                    continue
                if best is None or abs(lat) < abs(best):
                    best = lat
            offs.append(best)
        good = [o for o in offs if o is not None]
        twin = len(good) >= 4 and float(np.std(good)) < 6
        if twin:
            off = float(np.median(good)) / 2
            gg = g.offset_curve(off, join_style='round')
            if gg.geom_type == 'LineString' and gg.length > 6:
                g = gg
            twin_of[i] = off
        med.append((g, twin, rs, i))
    # drop duplicates (both carriageways routed -> same median)
    acc, accb = [], []
    for g, twin, rs, i in med:
        if acc:
            bb = np.array(accb); x0, y0, x1, y1 = g.bounds
            near = np.where((bb[:, 0] < x1 + 13) & (bb[:, 2] > x0 - 13) & (bb[:, 1] < y1 + 13) & (bb[:, 3] > y0 - 13))[0]
            if len(near):
                g = g.difference(shapely.union_all([acc[k][0].buffer(12.0, cap_style='flat') for k in near]))
        for q in shapely.get_parts(g):
            if q.geom_type == 'LineString' and q.length > 12:
                acc.append((q, twin, rs, i)); accb.append(q.bounds)
    # join pieces whose ends nearly meet (twin -> single transitions, junction gaps)
    L = [np.asarray(q.coords, float) for q, *_ in acc]
    E = np.array([[*c[0], *c[-1]] for c in L])
    ep = np.concatenate([E[:, :2], E[:, 2:]])
    et = shapely.STRtree(shapely.points(ep))
    for k in range(len(ep)):
        js = [j for j in et.query(shapely.Point(*ep[k]), predicate='dwithin', distance=18) if j != k and j % len(L) != k % len(L)]
        if not js:
            continue
        j = min(js, key=lambda j: np.hypot(*(ep[j] - ep[k])))
        m = (ep[j] + ep[k]) / 2
        for q in (k, j):
            li, end = q % len(L), (0 if q < len(L) else -1)
            L[li][end] = m
        ep[j] = ep[k] = m
    merged = shapely.line_merge(shapely.union_all([shapely.LineString(c) for c in L if len(c) >= 2]))
    cl = [g for g in shapely.get_parts(merged) if g.geom_type == 'LineString' and g.length > 25]
    cl = [g.simplify(0.4) for g in cl]
    # dead ends that stop short of another corridor (median lines end before the junction): run them onto it
    cc = [np.asarray(g.coords, float) for g in cl]
    gl = [shapely.LineString(c) for c in cc]
    tr_ = shapely.STRtree(gl)
    ext, TC = [], {j: [] for j in range(len(cc))}
    for j in range(len(cc)):
        for e in (0, -1):
            P = shapely.Point(*cc[j][e]); best = None; touching = False
            for k in tr_.query(P, predicate='dwithin', distance=25):
                if k == j:
                    continue
                d = gl[k].distance(P)
                if d < 0.6:
                    touching = True; break
                if best is None or d < best[0]:
                    best = (d, k)
            if best and not touching:
                ext.append((j, e, best[1]))
    pre = {}
    for j, e, k in ext:
        P = cc[j][e]; sk = gl[k].project(shapely.Point(*P)); Q = np.array(gl[k].interpolate(sk).coords[0])
        TC[k].append((sk, Q))
        if e == 0:
            pre[j] = pre.get(j, 0.0) + float(np.hypot(*(Q - P))); cc[j] = np.vstack([Q, cc[j]])
        else:
            cc[j] = np.vstack([cc[j], Q])
    for k in TC:
        TC[k] = [(sk + pre.get(k, 0.0), Q) for sk, Q in TC[k]]
    def chaikin(c, it=3):
        c = np.asarray(c, float)
        for _ in range(it):
            if len(c) < 3:
                break
            q = 0.75 * c[:-1] + 0.25 * c[1:]; r_ = 0.25 * c[:-1] + 0.75 * c[1:]
            m = np.empty((2 * len(q), 2)); m[0::2] = q; m[1::2] = r_
            c = np.vstack([c[:1], m, c[-1:]])
        return c
    cc = [chaikin(shapely.LineString(c).segmentize(25).coords) for c in cc]
    cl = [shapely.LineString(c).simplify(0.25) for c in cc]
    log(f'brts: joined {len(ext)} dead ends onto crossing corridors')
    log(f'brts: {len(cl)} corridor lines, {sum(g.length for g in cl) / 1000:.1f} km; '
        f'{sum(1 for m in med if m[1])} of {len(med)} stretches on dual-carriageway medians')

    # ---- widen single carriageways that carry the corridor
    covered = {}
    for (i, s0, s1, rs) in parts:
        covered[i] = covered.get(i, 0) + (s1 - s0)
    nw = 0
    for i, c in covered.items():
        r = R2[i]
        if r['bridge'] or i in twin_of or r['cls'] < 3:
            continue
        if c > 0.4 * lines[i].length or c > 60:
            r['brts'] = True
            if r['hw'] < ROAD_HW:
                r['hw'] = ROAD_HW; nw += 1
    log(f'brts: widened {nw} road pieces to {ROAD_HW * 2:.0f} m carriageways')

    # ---- barrier gaps where streets cross or join the corridor
    ctree = shapely.STRtree(cl)
    gaps = [[] for _ in cl]
    for r in R2:
        if r['bridge']:
            continue
        xy = np.asarray(r['xy'])
        for e in (0, -1):
            p = shapely.Point(*xy[e])
            for j in ctree.query(p, predicate='dwithin', distance=14):
                g = cl[j]; s = g.project(p)
                q0, q1 = g.interpolate(max(0, s - 4)), g.interpolate(min(g.length, s + 4))
                t = _unit((q1.x - q0.x, q1.y - q0.y))
                o = xy[1] - xy[0] if e == 0 else xy[-2] - xy[-1]
                ou = _unit(o)
                if abs(ou[0] * t[0] + ou[1] * t[1]) > 0.82:        # running along the corridor, not across it
                    continue
                w = r['hw'] + r['sw'] + 2.5
                gaps[j].append([max(0.0, s - w), min(g.length, s + w)])
    for j in range(len(gaps)):
        gs = sorted(gaps[j]); out = []
        for a, b in gs:
            if out and a <= out[-1][1] + 3:
                out[-1][1] = max(out[-1][1], b)
            else:
                out.append([a, b])
        gaps[j] = out

    # ---- stations: one island per name, on the corridor nearest its stop(s), clear of junction gaps
    import re as _re
    groups = {}
    for sid, (nm, x, y) in STOPS.items():
        if sid not in SNAP:
            continue
        base = _re.sub(r'[\s-]+([A-Da-d]|[0-9])$', '', nm).strip()
        groups.setdefault(base, []).append((x, y, sid))
    stations = []
    for nm, pts in groups.items():
        # split same-name stops further than 150 m apart
        clus = []
        for x, y, sid in pts:
            for c in clus:
                if math.hypot(c[0][0] - x, c[0][1] - y) < 300:
                    c.append((x, y, sid)); break
            else:
                clus.append([(x, y, sid)])
        for c in clus:
            x = float(np.mean([q[0] for q in c])); y = float(np.mean([q[1] for q in c]))
            p = shapely.Point(x, y)
            js = list(ctree.query(p, predicate='dwithin', distance=45))
            if not js:
                continue
            j = min(js, key=lambda j: cl[j].distance(p)); g = cl[j]; s = g.project(p)
            half = ST_LEN / 2 + 11
            if g.length < 2 * half + 4:
                continue
            s = min(max(s, half), g.length - half)
            # slide off junction gaps
            for _ in range(8):
                hit = [gp for gp in gaps[j] if gp[0] - half < s < gp[1] + half]
                if not hit:
                    break
                a, b = hit[0]
                s = (a - half - 0.5) if abs(s - (a - half)) < abs(s - (b + half)) else (b + half + 0.5)
                s = min(max(s, half), g.length - half)
            q0, q1 = g.interpolate(max(0, s - 6)), g.interpolate(min(g.length, s + 6))
            t = _unit((q1.x - q0.x, q1.y - q0.y)); pp = g.interpolate(s)
            stations.append(dict(name=nm, x=pp.x, y=pp.y, ux=t[0], uy=t[1], li=j, s=s, ids=[q[2] for q in c]))
    log(f'brts: {len(stations)} median stations')

    # ---- timetable: trips per route as stop-index + departure seconds (buses follow the station chain)
    st_of = {sid: k for k, st in enumerate(stations) for sid in st['ids']}
    trips = []
    rows = db.execute('select trip_id, route_id, stop_sequence, stop_id, departure_time from stop_times order by trip_id, stop_sequence').fetchall()
    cur, buf = None, []

    def flush(buf):
        seq = [(st_of[s], t) for s, t in buf if s in st_of]
        if len(seq) >= 2:
            trips.append(seq)
    for tid, rid, sq, sid, dep in rows:
        if tid != cur:
            if buf:
                flush(buf)
            cur, buf = tid, []
        h, m_, s_ = (int(v) for v in dep.split(':'))
        buf.append((sid, h * 3600 + m_ * 60 + s_))
    if buf:
        flush(buf)
    log(f'brts: {len(trips)} timetabled trips')

    # ---- bus paths between consecutive stations along the corridor network (lane offset swings round islands)
    CG = nx.Graph(); node_at = {}
    def nkey(x, y):
        return ('n', round(x / 2.0), round(y / 2.0))
    # bridge stretches (river bridges, flyovers): mixed traffic, no lane paint, but buses ride them at deck height
    gl2 = shapely.STRtree(cl)
    for (i, s0, s1, rs) in parts:
        r = R2[i]
        if not r['bridge']:
            continue
        g = shapely.ops.substring(lines[i], s0, s1)
        if g.geom_type != 'LineString' or g.length < 2:
            continue
        xy = np.asarray(r['xy']); sv = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
        c = np.asarray(g.coords); ss = np.array([lines[i].project(shapely.Point(*q)) for q in c])
        h = np.interp(ss, sv, np.asarray(r['z'], float))
        geom = np.column_stack([c, h])
        ends_ = []
        for e in (0, -1):
            P = shapely.Point(*c[e]); js = list(gl2.query(P, predicate='dwithin', distance=30))
            if js:
                k = min(js, key=lambda k: cl[k].distance(P)); sk = cl[k].project(P); Q = np.array(cl[k].interpolate(sk).coords[0])
                TC[k].append((sk, Q))
                CG.add_edge(nkey(*c[e]), nkey(*Q), w=float(np.hypot(*(Q - c[e]))) + 0.01,
                            geom=np.array([[*c[e], h[e]], [*Q, 0.0]]), na=nkey(*c[e]))
        hw_ = r['hw']; off = 0.0 if hw_ < 5 else min(hw_ - 1.9, hw_ * 0.5)
        CG.add_edge(nkey(*c[0]), nkey(*c[-1]), w=g.length, geom=geom, na=nkey(*c[0]), off=off)
    for j, g in enumerate(cl):
        cuts = [(0.0, nkey(*g.coords[0])), (g.length, nkey(*g.coords[-1]))]
        for k, st in enumerate(stations):
            if st['li'] == j:
                cuts.append((st['s'], ('st', k)))
        for sk, Q in TC[j]:
            cuts.append((min(max(sk, 0.0), g.length), nkey(*Q)))
        cuts.sort(key=lambda c: c[0])
        for (sa, na), (sb, nb) in zip(cuts[:-1], cuts[1:]):
            if sb - sa < 0.05 or na == nb:
                continue
            if not CG.has_edge(na, nb) or CG[na][nb]['w'] > sb - sa:
                CG.add_edge(na, nb, w=sb - sa, j=j, sa=sa, sb=sb, na=na)
    pairs = sorted({(a[0], b[0]) for tr in trips for a, b in zip(tr[:-1], tr[1:]) if a[0] != b[0]})
    legs2, leg_idx = [], {}
    stp = np.array([[st['x'], st['y']] for st in stations]) if stations else np.zeros((0, 2))
    for a, b in pairs:
        try:
            path = nx.shortest_path(CG, ('st', a), ('st', b), weight='w')
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue
        pts, offb = [], []
        for u, v in zip(path[:-1], path[1:]):
            d = CG[u][v]
            if 'geom' in d:
                c = d['geom'].copy(); ob = d.get('off', None)
            else:
                sub = shapely.ops.substring(cl[d['j']], d['sa'], d['sb'])
                c = np.column_stack([np.asarray(sub.coords), np.zeros(len(sub.coords))]) if sub.geom_type == 'LineString' else np.zeros((0, 3))
                ob = None
            if d['na'] != u:
                c = c[::-1]
            if len(pts) and len(c):
                c = c[1:]
            pts.extend(c.tolist()); offb.extend([ob] * len(c))
        if len(pts) < 2:
            continue
        P3 = np.asarray(pts, float)
        seg_l = np.hypot(*np.diff(P3[:, :2], axis=0).T); sv = np.concatenate([[0], np.cumsum(seg_l)]); Lt = sv[-1]
        if Lt < 1:
            continue
        n = max(2, int(Lt / 8) + 1); st_ = np.linspace(0, Lt, n)
        rs = np.column_stack([np.interp(st_, sv, P3[:, 0]), np.interp(st_, sv, P3[:, 1]), np.interp(st_, sv, P3[:, 2])])
        ob = np.array([np.nan if o is None else o for o in offb]); obi = np.interp(st_, sv, np.nan_to_num(ob, nan=-1.0))
        dd = np.min(np.hypot(rs[:, None, 0] - stp[None, :, 0], rs[:, None, 1] - stp[None, :, 1]), axis=1) if len(stp) else np.full(n, 1e9)
        fl = np.clip(1 - (dd - (ST_LEN / 2 + 2)) / 18.0, 0, 1)
        off = 1.85 + (ST_W / 2) * (fl * fl * (3 - 2 * fl))
        off = np.where(obi >= 0, obi, off)
        leg_idx[(a, b)] = len(legs2)
        legs2.append(dict(ab=(a, b), pts=np.round(rs, 1), off=np.round(off, 2), L=Lt))
    trips2 = []
    for tr in trips:   # a trip with an unroutable hop runs as separate pieces
        ls = []
        for (a, ta), (b, tb) in zip(tr[:-1], tr[1:]):
            if a == b:
                continue
            if (a, b) not in leg_idx:
                if ls:
                    trips2.append(ls)
                ls = []; continue
            ls.append((leg_idx[(a, b)], ta, tb))
        if ls:
            trips2.append(ls)
    log(f'brts: {len(legs2)} station-to-station bus paths, {len(trips2)} trips with complete paths')
    has_st = {st['li'] for st in stations}
    paint = [bool(g.length >= 90 or j in has_st) for j, g in enumerate(cl)]
    return dict(paint=paint, lines=[np.round(np.asarray(g.coords), 2) for g in cl], gaps=gaps, stations=stations, trips=trips2, legs=legs2,
                stops=STOPS, snap=SNAP, routes=RNAME)

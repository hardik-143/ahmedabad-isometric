"""Footprint regularisation: square up building outlines traced from imagery.

Edges within SNAP degrees of the building's dominant axes are snapped onto them (collinear runs merged, corners
re-intersected), genuinely oblique walls are kept, then notches and spurs narrower than ~1.2 m are closed / opened
with mitred buffers so corners stay square. Shapes that would change too much keep their simplified outline.
"""
import math
import numpy as np
import shapely

SNAP = math.radians(16)


def _dominant(c):
    d = np.diff(c, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    a = np.arctan2(d[:, 1], d[:, 0])
    C, S = (L * np.cos(4 * a)).sum(), (L * np.sin(4 * a)).sum()
    return math.atan2(S, C) / 4


def _isect(l1, l2):
    # lines as (point, direction)
    (p, d), (q, e) = l1, l2
    den = d[0] * e[1] - d[1] * e[0]
    if abs(den) < 1e-6:
        return None
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    return (p[0] + d[0] * t, p[1] + d[1] * t)


def ortho_ring(c):
    """c: closed ring (N+1, 2) already in the building's axis frame. Returns new closed ring or None."""
    c = np.asarray(c, float)
    if len(c) < 5:
        return c
    pts = c[:-1]
    n = len(pts)
    segs = []   # (kind, value/point, dir, length): kind 0 = horizontal (y), 1 = vertical (x), 2 = oblique
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        d = b - a
        L = math.hypot(*d)
        if L < 1e-6:
            continue
        ang = math.atan2(d[1], d[0])
        dev_h = abs(math.atan2(math.sin(ang), math.cos(ang)))
        dev_h = min(dev_h, math.pi - dev_h)
        dev_v = abs(math.pi / 2 - dev_h)
        if dev_h <= SNAP:
            segs.append([0, (a[1] + b[1]) / 2 * L, L, a, b])
        elif dev_v <= SNAP:
            segs.append([1, (a[0] + b[0]) / 2 * L, L, a, b])
        else:
            segs.append([2, 0.0, L, a, b])
    if len(segs) < 3:
        return None
    # merge consecutive runs of the same axis class (cyclic)
    merged = []
    for s in segs:
        if merged and s[0] != 2 and merged[-1][0] == s[0]:
            m = merged[-1]
            m[1] += s[1]; m[2] += s[2]; m[4] = s[4]
        else:
            merged.append(list(s))
    if len(merged) > 1 and merged[0][0] != 2 and merged[0][0] == merged[-1][0]:
        m = merged.pop()
        merged[0][1] += m[1]; merged[0][2] += m[2]; merged[0][3] = m[3]
    if len(merged) < 3:
        return None
    lines = []
    for k, acc, L, a, b in merged:
        if k == 0:
            y = acc / L
            lines.append(((0.0, y), (1.0, 0.0)))
        elif k == 1:
            x = acc / L
            lines.append(((x, 0.0), (0.0, 1.0)))
        else:
            d = (b[0] - a[0], b[1] - a[1]); l = math.hypot(*d)
            lines.append(((a[0], a[1]), (d[0] / l, d[1] / l)))
    out = []
    m = len(lines)
    for i in range(m):
        p = _isect(lines[i - 1], lines[i])
        if p is None:   # parallel neighbours (an H run, a short oblique cut out, another H): use the original corner
            p = tuple(merged[i][3])
        out.append(p)
    out.append(out[0])
    return np.array(out)


def regularize(P, min_area=6.0):
    """Return a squared-up polygon, or the simplified original when squaring would distort it."""
    if P is None or P.is_empty or P.geom_type != 'Polygon':
        return P
    P0 = shapely.simplify(P, 0.45, preserve_topology=True)
    if P0.is_empty or P0.geom_type != 'Polygon':
        return P
    ext = np.asarray(P0.exterior.coords)
    th = _dominant(ext)
    cx, cy = P0.centroid.x, P0.centroid.y
    cs, sn = math.cos(-th), math.sin(-th)

    def fwd(c):
        c = np.asarray(c) - (cx, cy)
        return np.column_stack([c[:, 0] * cs - c[:, 1] * sn, c[:, 0] * sn + c[:, 1] * cs])

    def back(c):
        c = np.asarray(c)
        return np.column_stack([c[:, 0] * cs + c[:, 1] * sn + cx, -c[:, 0] * sn + c[:, 1] * cs + cy])

    re = ortho_ring(fwd(ext))
    if re is None:
        return P0
    holes = []
    for r in P0.interiors:
        h = ortho_ring(fwd(np.asarray(r.coords)))
        if h is not None and len(h) >= 4:
            holes.append(h)
    try:
        Q = shapely.Polygon(re, holes)
        if not Q.is_valid:
            Q = shapely.make_valid(Q)
            Q = max(shapely.get_parts(Q), key=lambda g: g.area if g.geom_type == 'Polygon' else 0)
        # close notches / open spurs narrower than ~1.2 m, keeping square corners (in the axis frame)
        Q2 = Q.buffer(0.6, join_style='mitre', mitre_limit=2.5).buffer(-0.6, join_style='mitre', mitre_limit=2.5)
        Q2 = Q2.buffer(-0.6, join_style='mitre', mitre_limit=2.5).buffer(0.6, join_style='mitre', mitre_limit=2.5)
        if Q2.geom_type == 'MultiPolygon':
            Q2 = max(Q2.geoms, key=lambda g: g.area)
        if Q2.geom_type == 'Polygon' and Q2.area > min_area and abs(Q2.area - Q.area) < 0.12 * Q.area:
            Q = Q2
        if Q.geom_type != 'Polygon' or Q.is_empty:
            return P0
        R = shapely.Polygon(back(np.asarray(Q.exterior.coords)), [back(np.asarray(h.coords)) for h in Q.interiors])
        if not R.is_valid or R.area < min_area:
            return P0
        a0 = P.area
        if abs(R.area - a0) > 0.15 * a0 or R.symmetric_difference(P).area > 0.3 * a0:
            return P0
        return shapely.simplify(R, 0.05)
    except Exception:
        return P0


def squareness(P):
    """Fraction of corners that are right angles (or straight) after a light simplify."""
    c = np.asarray(shapely.simplify(P, 0.3).exterior.coords)[:-1]
    n = len(c)
    if n < 4:
        return 1.0
    a = np.roll(c, 1, axis=0) - c
    b = np.roll(c, -1, axis=0) - c
    cs = np.abs((a * b).sum(1)) / (np.hypot(a[:, 0], a[:, 1]) * np.hypot(b[:, 0], b[:, 1]) + 1e-9)
    return float(np.mean((cs < 0.12) | (cs > 0.99)))


def raster_ortho(P, cell=None, min_part=20.0):
    """Rebuild a noisy outline as an orthogonal mass on a grid aligned with the building's own axes.
    Returns a list of polygons (largest first)."""
    from scipy import ndimage
    P0 = shapely.simplify(P, 0.3, preserve_topology=True)
    if P0.is_empty or P0.geom_type != 'Polygon':
        return [P]
    if cell is None:
        cell = float(np.clip(math.sqrt(P.area) / 14, 1.5, 4.0))
    th = _dominant(np.asarray(P0.exterior.coords))
    cx, cy = P0.centroid.x, P0.centroid.y
    from shapely import affinity
    Q = affinity.rotate(P0, -th, origin=(cx, cy), use_radians=True)
    minx, miny, maxx, maxy = Q.bounds
    nx = max(1, int(math.ceil((maxx - minx) / cell))); ny = max(1, int(math.ceil((maxy - miny) / cell)))
    if nx * ny > 4_000_000:
        return [P0]
    xs = minx + (np.arange(nx) + 0.5) * cell
    ys = miny + (np.arange(ny) + 0.5) * cell
    X, Y = np.meshgrid(xs, ys)
    M = shapely.contains_xy(Q, X.ravel(), Y.ravel()).reshape(ny, nx)
    st = np.ones((3, 3), bool)
    M = ndimage.binary_closing(np.pad(M, 2), structure=st)[2:-2, 2:-2]
    M = ndimage.binary_opening(M, structure=st)
    if not M.any():
        return [P0]
    boxes = []
    for j in range(ny):
        row = M[j]
        if not row.any():
            continue
        d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
        s, e = np.where(d == 1)[0], np.where(d == -1)[0]
        for a, b in zip(s, e):
            boxes.append((minx + a * cell, miny + j * cell, minx + b * cell, miny + (j + 1) * cell))
    b = np.array(boxes)
    U = shapely.union_all(shapely.box(b[:, 0], b[:, 1], b[:, 2], b[:, 3]))
    U = shapely.simplify(U, 0.05)
    out = []
    for g in shapely.get_parts(U):
        if g.geom_type == 'Polygon' and g.area >= min_part:
            out.append(affinity.rotate(g, th, origin=(cx, cy), use_radians=True))
    out.sort(key=lambda g: -g.area)
    return out or [P0]

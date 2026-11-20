import math, os, numpy as np, shapely

LON0, LAT0 = 72.575, 23.035
R = 6371008.8
KX = math.radians(1) * R * math.cos(math.radians(LAT0))
KY = math.radians(1) * R
BBOX_LL = (72.43, 22.89, 72.72, 23.17)  # lon/lat extent of the map
CHUNK = 1000.0  # metres
DATA = os.environ.get('AMD_DATA', '/home/claude/data')
OUT = os.environ.get('AMD_OUT', '/home/claude/build')
SITE = os.environ.get('AMD_SITE', '/home/claude/site')
FMT = os.environ.get('AMD_FORMAT', 'txt')  # 'bin' = gzip binaries, 'txt' = base64 text


def proj_xy(lon, lat):
    return (np.asarray(lon) - LON0) * KX, (np.asarray(lat) - LAT0) * KY


def unproj_xy(x, y):
    return np.asarray(x) / KX + LON0, np.asarray(y) / KY + LAT0


def proj_geom(g):
    def f(c):
        x, y = proj_xy(c[:, 0], c[:, 1])
        return np.column_stack([x, y])
    return shapely.transform(g, f)


def bbox_m():
    x0, y0 = proj_xy(BBOX_LL[0], BBOX_LL[1])
    x1, y1 = proj_xy(BBOX_LL[2], BBOX_LL[3])
    return float(x0), float(y0), float(x1), float(y1)


def chunk_of(x, y):
    return np.floor(np.asarray(x) / CHUNK).astype(int), np.floor(np.asarray(y) / CHUNK).astype(int)


def hash01(*vals):
    h = np.zeros_like(np.asarray(vals[0], dtype=np.uint64), dtype=np.uint64)
    for v in vals:
        h = (h ^ (np.asarray(v).astype(np.int64).astype(np.uint64) + np.uint64(0x9E3779B97F4A7C15) + (h << np.uint64(6)) + (h >> np.uint64(2))))
        h = h * np.uint64(0xBF58476D1CE4E5B9)
        h ^= h >> np.uint64(31)
    return (h % np.uint64(1000003)).astype(np.float64) / 1000003.0

# Walled city of Ahmedabad: polygon through its historic gates (Wikipedia "Gates of Ahmedabad" coordinates),
# clockwise from Shahpur; the west side follows the old river wall.
WC_GATES = [(23.03917, 72.57944), (23.03833, 72.58389), (23.03778, 72.58778), (23.03722, 72.59278), (23.03500, 72.59667),
            (23.03083, 72.59778), (23.02500, 72.59694), (23.02250, 72.59806), (23.01722, 72.59472), (23.01667, 72.59083),
            (23.01380, 72.58620), (23.01222, 72.58139), (23.01520, 72.57680), (23.01904, 72.57780), (23.02350, 72.57550),
            (23.02662, 72.57620), (23.03000, 72.57600), (23.03600, 72.57700)]


def wc_poly():
    import shapely as _s
    return _s.Polygon([proj_xy(lo, la) for la, lo in WC_GATES])


def cal_height(h):
    """Google Open Buildings 2.5D heights are footprint-mean values from a 4 m effective-resolution raster, which
    flattens mid/high-rise blocks; stretch everything above a single storey."""
    h = np.nan_to_num(np.asarray(h, float))
    return h + 0.6 * np.maximum(0.0, h - 3.5)

# SVPI airport (VAAH): runway 05/23 thresholds from the published aerodrome data; 3505 x 45 m.
RWY05, RWY23, RWY_W = (72.622394, 23.065897), (72.646431, 23.088442), 45.0


def airfield():
    """Runway / parallel taxiway / apron in projected metres. The parallel taxiway is on the terminal (north-west)
    side and runs 1,895 m from the 05 end; offsets and apron extent are read off the empty band in the building data."""
    x0, y0 = proj_xy(*RWY05); x1, y1 = proj_xy(*RWY23)
    L = math.hypot(x1 - x0, y1 - y0); ux, uy = (x1 - x0) / L, (y1 - y0) / L; vx, vy = -uy, ux
    P = lambda s, d: (x0 + ux * s + vx * d, y0 + uy * s + vy * d)
    TO = 185.0
    links = (40.0, 640.0, 1260.0, 1895.0)
    twy = [dict(w=23.0, xy=[P(40, TO), P(1895, TO)])]
    for s in links:
        twy.append(dict(w=23.0, xy=[P(s, 0), P(s, TO)]))
    apron = [P(90, TO + 19), P(1250, TO + 19), P(1250, 440), P(90, 440)]
    return dict(L=L, x0=x0, y0=y0, x1=x1, y1=y1, u=(ux, uy), v=(vx, vy), w=RWY_W, twy=twy, apron=apron, P=P, TO=TO, links=links)


def airfield_detail():
    """Taxiway pavement with proper fillets, shoulders, markings (centrelines with curved lead-ins, double edge lines,
    runway-holding positions, stand lead-in lines) and aircraft stands, all as projected-metre geometry."""
    import shapely as _s
    AF = airfield(); P = AF['P']; TO = AF['TO']; L = AF['L']
    rect = lambda s0, s1, d0, d1: _s.Polygon([P(s0, d0), P(s1, d0), P(s1, d1), P(s0, d1)])
    rwy = rect(-60, L + 60, -22.5, 22.5)
    rwy_sh = rect(-60, L + 60, -30, 30)
    apron = _s.Polygon(AF['apron'])
    cl = [_s.LineString(t['xy']) for t in AF['twy']]
    hw, sh, R = 11.5, 7.5, 32.0
    core = _s.union_all([c.buffer(hw, cap_style='flat') for c in cl] + [rwy, apron])
    core = core.buffer(R, quad_segs=12).buffer(-R, quad_segs=12)          # fillets wherever pavements meet
    pave = core.difference(rwy).difference(apron)
    outer = _s.union_all([c.buffer(hw + sh, cap_style='flat') for c in cl] + [rwy_sh, apron.buffer(sh, join_style='mitre')])
    outer = outer.buffer(R, quad_segs=12).buffer(-R, quad_segs=12)
    shoulder = outer.difference(core).difference(rwy_sh)
    arc = lambda cs, cd, r, a0, a1, n=24: [P(cs + r * math.cos(a0 + (a1 - a0) * k / n), cd + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]
    lines = []   # (kind, width_m, [(x, y), ...]); kind 4 = solid yellow, 5 = dashed yellow
    lines.append((4, 0.3, [P(40, TO), P(1895, TO)]))
    R1, R2, R3 = 45.0, 55.0, 30.0
    for s in AF['links']:
        lines.append((4, 0.3, [P(s, 0), P(s, TO)]))
        for sg in (1, -1):
            if 40 <= s + sg * R1 <= 1895:    # turn from the link onto the parallel taxiway
                lines.append((4, 0.3, arc(s + sg * R1, TO - R1, R1, math.pi if sg > 0 else 0.0, math.pi / 2)))
            if 0 <= s + sg * R2 <= L:        # lead-on curve onto the runway centreline
                lines.append((4, 0.3, arc(s + sg * R2, R2, R2, math.pi if sg > 0 else 0.0, 1.5 * math.pi if sg > 0 else -0.5 * math.pi)))
        # runway-holding position (pattern A) 90 m from the runway centreline: two solid + two dashed bars
        for k, (dd, kind) in enumerate([(90.0, 5), (90.6, 5), (91.4, 4), (92.0, 4)]):
            lines.append((kind, 0.3, [P(s - hw + 0.8, dd), P(s + hw - 0.8, dd)]))
    edge = core.buffer(-0.6, quad_segs=12)
    for off in (0.6, 1.15):
        ring = core.buffer(-off, quad_segs=12).boundary
        ring = ring.difference(rwy.buffer(3.0)).difference(apron.buffer(3.0))
        for g in _s.get_parts(ring):
            if g.geom_type == 'LineString' and g.length > 8:
                lines.append((4, 0.18, list(g.coords)))
    # aircraft stands along the apron: nose-in towards the terminals, each with a lead-in line off the taxiway
    stands = []
    s_, k = 170.0, 0
    while s_ < 900:
        atr = k % 4 == 3
        stands.append((P(s_, 440 - 12 - (11.5 if atr else 18.5)), atr))
        lines.append((4, 0.3, [P(s_, TO + R3), P(s_, 428)]))
        lines.append((4, 0.3, [P(s_ - 2, 428), P(s_ + 2, 428)]))
        for sg in (1, -1):
            lines.append((4, 0.3, arc(s_ - sg * R3, TO + R3, R3, -math.pi / 2, 0.0 if sg > 0 else -math.pi)))
        s_ += 38.0 if atr else 52.0; k += 1
    fx, fy = AF['v']
    return dict(pave=pave, shoulder=shoulder, apron=apron, lines=lines, stands=stands, nose=(fx, fy))


# Historic gates (darwajas). Coordinates: Wikipedia "Gates of Ahmedabad" / "Teen Darwaza". Arch sizes from the
# Bombay Gazetteer figures quoted there (feet -> metres); cw/ch = central arch width/height, plat = roofed gun
# platform on top (w x d, m) or None for an open terrace. Gates without published sizes use typical values.
FT = 0.3048
DARWAJAS = [
    ('Teen Darwaza', 23.02420, 72.58460, 17 * FT, 25 * FT, 13 * FT, None, 11.3, 2.44),
    ('Delhi Darwaza', 23.03778, 72.58778, 15 * FT, 22 * FT, None, (32 * FT, 20 * FT), 8.0, 2.4),
    ('Dariyapur Darwaza', 23.03722, 72.59278, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Prem Darwaza', 23.03500, 72.59667, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Kalupur Darwaza', 23.03083, 72.59778, 17 * FT, 27 * FT, None, (32 * FT, 16 * FT), 8.0, 2.4),
    ('Panchkuva Darwaza', 23.02500, 72.59694, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Sarangpur Darwaza', 23.02250, 72.59806, 15 * FT, 26 * FT, None, (33 * FT, 16 * FT), 8.0, 2.4),
    ('Raipur Darwaza', 23.01722, 72.59472, 19 * FT, 26 * FT, None, (32 * FT, 20 * FT), 8.0, 2.4),
    ('Astodia Darwaza', 23.01667, 72.59083, 17 * FT, 25 * FT, None, (28 * FT, 27 * FT), 8.5, 2.4),
    ('Jamalpur Darwaza', 23.01222, 72.58139, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Raikhad Darwaza', 23.01904, 72.57886, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Khanpur Darwaza', 23.03000, 72.57694, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
    ('Shahpur Darwaza', 23.03917, 72.57944, 16 * FT, 24 * FT, None, (30 * FT, 18 * FT), 8.0, 2.4),
]

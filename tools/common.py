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
    twy = [dict(w=23.0, xy=[P(-30, TO), P(1895, TO)])]
    for s in (-30, 640, 1260, 1895):
        twy.append(dict(w=23.0, xy=[P(s, 0), P(s, TO)]))
    apron = [P(-60, TO + 30), P(1330, TO + 30), P(1330, 440), P(-60, 440)]
    return dict(L=L, x0=x0, y0=y0, x1=x1, y1=y1, u=(ux, uy), v=(vx, vy), w=RWY_W, twy=twy, apron=apron, P=P)

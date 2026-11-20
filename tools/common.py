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

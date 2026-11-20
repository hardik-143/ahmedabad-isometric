"""Clip Google Open Buildings v3 + 2.5D Temporal 2023 heights (ramSeraph GOBI-2023 release) to Ahmedabad,
reading only the parquet row groups that overlap the city (HTTP range requests)."""
import io, os, sys, time, requests, numpy as np, pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc

DATA = os.environ.get('AMD_DATA', '/home/claude/data')
URL = 'https://github.com/ramSeraph/indian_buildings/releases/download/GOBI-2023/'
PARTS = ['google-open-buildings-india-2023.000010.parquet', 'google-open-buildings-india-2023.001000.parquet']
BX = (72.40, 22.88, 72.75, 23.20)


class RangeFile(io.RawIOBase):
    def __init__(self, url, block=4 << 20):
        self.s = requests.Session()
        r = self.s.get(url, allow_redirects=False, timeout=60)
        self.url = r.headers.get('location', url)
        r = self.s.get(self.url, headers={'Range': 'bytes=0-0'}, timeout=60)
        self.size = int(r.headers['Content-Range'].split('/')[-1]); self.pos = 0; self.block = block; self.cache = {}

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off); return self.pos

    def _blk(self, i):
        if i not in self.cache:
            a = i * self.block; b = min(self.size, a + self.block) - 1
            for t in range(5):
                try:
                    r = self.s.get(self.url, headers={'Range': f'bytes={a}-{b}'}, timeout=180); r.raise_for_status(); break
                except Exception:
                    if t == 4: raise
                    time.sleep(2 * (t + 1))
            self.cache[i] = r.content
        return self.cache[i]

    def read(self, n=-1):
        if n is None or n < 0: n = self.size - self.pos
        n = min(n, self.size - self.pos); out = bytearray()
        while n > 0:
            i = self.pos // self.block; o = self.pos - i * self.block
            c = self._blk(i)[o:o + n]; out += c; self.pos += len(c); n -= len(c)
        return bytes(out)

    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)


def main():
    out = os.path.join(DATA, 'gobi_ahd.parquet')
    if os.path.exists(out):
        return
    tabs = []
    for name in PARTS:
        f = pq.ParquetFile(RangeFile(URL + name))
        md = f.metadata
        for i in range(md.num_row_groups):
            rg = md.row_group(i); st = {}
            for j in range(rg.num_columns):
                s = rg.column(j).statistics
                if s is not None and s.has_min_max: st[rg.column(j).path_in_schema] = (s.min, s.max)
            if not (st['bbox.xmin'][0] <= BX[2] and st['bbox.xmax'][1] >= BX[0] and st['bbox.ymin'][0] <= BX[3] and st['bbox.ymax'][1] >= BX[1]):
                continue
            t = f.read_row_group(i, columns=['confidence', 'presence', 'height', 'covered', 'geometry', 'bbox'])
            b = t.column('bbox')
            m = pc.and_(pc.and_(pc.less_equal(pc.struct_field(b, 'xmin'), BX[2]), pc.greater_equal(pc.struct_field(b, 'xmax'), BX[0])),
                        pc.and_(pc.less_equal(pc.struct_field(b, 'ymin'), BX[3]), pc.greater_equal(pc.struct_field(b, 'ymax'), BX[1])))
            t = t.filter(m)
            tabs.append(t.drop_columns(['bbox']))
            print(f'  {name} rg{i}: {t.num_rows} buildings', flush=True)
    t = pa.concat_tables(tabs)
    pq.write_table(t, out + '.part', compression='zstd')
    os.replace(out + '.part', out)
    print('gobi_ahd.parquet', t.num_rows, 'buildings')


if __name__ == '__main__':
    main()

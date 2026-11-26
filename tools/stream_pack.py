"""Per-chunk stream files for on-foot mode (GTA-style streaming).

The map view downloads each detail layer as one gzip file (bld, cells, props, trees). On foot only the 1 km chunks
round the player are needed, so every chunk also gets its own small file, data/s/<cx>_<cy>.bin:

    gzip( u32 len_bld, u32 len_cells, u32 len_props, u32 len_trees, bld bytes, cells bytes, props bytes, trees bytes )

The bytes are exactly the chunk's slices of the big layers (same encoding, offsets start at 0), so the app decodes
them with the same code. Run after pack.py (pack.py calls it at the end), or by hand:

    python3 tools/stream_pack.py public/data
"""
import gzip, json, os, struct, sys

LAYERS = ('bld', 'cells', 'props', 'trees')


def write_stream(data_dir):
    meta = json.load(open(os.path.join(data_dir, 'meta.json')))
    raw = {}
    for k in LAYERS:
        b = open(os.path.join(data_dir, f'{k}.bin'), 'rb').read()
        raw[k] = gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b
    out = os.path.join(data_dir, 's')
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        if f.endswith('.bin'):
            os.remove(os.path.join(out, f))
    n, total = 0, 0
    for row in meta['chunks']:
        cx, cy = row[0], row[1]
        parts = [raw[k][row[2 + 2 * i]: row[2 + 2 * i] + row[3 + 2 * i]] for i, k in enumerate(LAYERS)]
        if not any(parts):
            continue
        body = struct.pack('<4I', *[len(p) for p in parts]) + b''.join(parts)
        gz = gzip.compress(body, 9, mtime=0)
        open(os.path.join(out, f'{cx}_{cy}.bin'), 'wb').write(gz)
        n += 1; total += len(gz)
    print(f'stream: {n} chunk files, {total // 1024} KB, avg {total // max(1, n) // 1024} KB')


if __name__ == '__main__':
    write_stream(sys.argv[1] if len(sys.argv) > 1 else 'public/data')

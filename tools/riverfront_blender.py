"""Street furniture for the riverfront, modelled in Blender (run headless with the bpy module):

    python tools/riverfront_blender.py public/models/riverfront.glb     (then tools/bus_pack.mjs to compress it)

One GLB with a node per model:
  Kiosk     a riverfront food stall: counter, steel pots and jars, stocked back shelves, a striped awning with a string
            of bulbs, and a signboard. Built facing +X (its counter side), 3 m wide along Y.
  Table     a round plastic table with four stacking chairs, the kind every chai stall puts out
  Parasol   a market umbrella on a weighted base

Blender is Z-up; glTF export turns +X forward / -Y right into +X forward / +Z right, Y up, as the app expects.
Material names carry meaning for the app: Body, AwningA and Plastic are recoloured per stall; Sign gets that stall's
signboard (the face is a plane whose UVs run 0..1 across it); Bulb glows at night; anything else is plain.
"""
import math, sys
import bpy
from mathutils import Vector

OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else 'riverfront.glb'
bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


MATS = {}


def mat(name, rgb, rough=0.6, metal=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (srgb(rgb[0]), srgb(rgb[1]), srgb(rgb[2]), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    MATS[name] = m
    return m


PARTS = []


def box(x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = (x1 - x0, y1 - y0, z1 - z0)
    o.location = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(m)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'
    PARTS.append(o)
    return o


def quad(a, b, c, d, m):
    """One face through four corners (counter-clockwise seen from the side it faces), UVs 0..1 a->b along U, a->d along V."""
    me = bpy.data.meshes.new('q')
    me.from_pydata([a, b, c, d], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name='UVMap')
    for i, (u, v) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uv.data[i].uv = (u, v)
    o = bpy.data.objects.new('q', me)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def cyl(x, y, z, r, depth, m, verts=16, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=(x, y, z))
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=(x, y, z))
    o = bpy.context.active_object
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def rod(a, b, r, m, verts=8):
    ax, ay, az = a; bx, by, bz = b
    dx, dy, dz = bx - ax, by - ay, bz - az
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=L, location=((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2))
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector((dx, dy, dz)).normalized())
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def ball(x, y, z, r, m, seg=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=max(4, seg // 2), radius=r, location=(x, y, z))
    o = bpy.context.active_object
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def finish(name, smooth=False):
    global PARTS
    bpy.ops.object.select_all(action='DESELECT')
    for o in PARTS:
        bpy.context.view_layer.objects.active = o
        for mdf in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mdf.name)
        o.select_set(True)
    bpy.context.view_layer.objects.active = PARTS[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name; o.data.name = name
    bpy.ops.object.shade_flat()
    PARTS = []
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f'{name}: {tris} triangles, materials {[m.name for m in o.data.materials]}')
    return o


C = dict(
    body=mat('Body', (214, 60, 48), 0.5), awnA=mat('AwningA', (214, 60, 48), 0.8), awnB=mat('AwningB', (246, 242, 232), 0.8),
    roof=mat('Roof', (232, 230, 224), 0.6), trim=mat('Trim', (44, 46, 50), 0.6), steel=mat('Steel', (196, 200, 204), 0.25, 0.85),
    sign=mat('Sign', (255, 255, 255), 0.5), bulb=mat('Bulb', (255, 236, 180), 0.2), glass=mat('Glass', (170, 200, 210), 0.1),
    wood=mat('Wood', (132, 88, 52), 0.7), plastic=mat('Plastic', (200, 40, 40), 0.45), white=mat('PlasticWhite', (238, 236, 230), 0.45),
    goodsR=mat('GoodsRed', (210, 50, 40), 0.6), goodsY=mat('GoodsYellow', (240, 190, 40), 0.6), goodsG=mat('GoodsGreen', (40, 140, 70), 0.6),
    goodsB=mat('GoodsBlue', (40, 90, 170), 0.6), canvas=mat('Canopy', (240, 140, 40), 0.8), conc=mat('Concrete', (150, 150, 146), 0.8),
)


# ---------------------------------------------------------------- food stall
def kiosk():
    B, W = C['body'], 1.45                                        # half width along Y
    box(-1.0, 0.85, -W, W, 0.0, 0.08, C['trim'])                   # plinth
    box(-1.0, 0.85, -W, W, 0.08, 1.0, B, bevel=0.03)               # base cabinet
    box(0.84, 0.87, -W + 0.1, W - 0.1, 0.18, 0.32, C['steel'])     # kick-strip
    box(0.84, 0.87, -W + 0.1, W - 0.1, 0.62, 0.9, C['awnB'])       # a pale band across the front (the menu painted on it in life)
    box(0.5, 1.12, -W - 0.05, W + 0.05, 1.0, 1.06, C['steel'], bevel=0.01)   # steel counter top
    box(-1.0, -0.88, -W, W, 1.0, 2.55, B)                          # back wall
    for s in (-1, 1):
        box(-1.0, 0.55, s * W - 0.06, s * W + 0.06, 1.0, 2.55, B)  # side walls
        box(0.5, 0.6, s * (W - 0.05) - 0.05, s * (W - 0.05) + 0.05, 1.06, 2.55, C['trim'])   # front posts
    box(-1.1, 1.0, -W - 0.12, W + 0.12, 2.55, 2.68, C['roof'], bevel=0.02)   # roof slab
    # signboard on the roof edge: a trimmed box, the face a plane with 0..1 UVs for the stall's name
    box(0.94, 1.02, -W - 0.05, W + 0.05, 2.66, 3.3, C['trim'])
    quad((1.025, -W, 2.7), (1.025, W, 2.7), (1.025, W, 3.26), (1.025, -W, 3.26), C['sign'])
    # back shelves, stocked
    goods = [C['goodsR'], C['goodsY'], C['goodsG'], C['goodsB'], C['awnB']]
    for k, z in enumerate((1.45, 1.85, 2.25)):
        box(-0.88, -0.6, -W + 0.1, W - 0.1, z - 0.03, z, C['wood'])
        y = -W + 0.18
        i = 0
        while y < W - 0.22:
            w = 0.12 + 0.05 * ((i * 7 + k * 3) % 3)
            h = 0.16 + 0.05 * ((i * 5 + k) % 3)
            box(-0.84, -0.66, y, y + w, z, z + h, goods[(i * 3 + k * 2) % len(goods)])
            y += w + 0.03; i += 1
    # on the counter: steel pots, glass jars of snacks, a stack of paper plates
    for y, r, h in ((-1.05, 0.17, 0.26), (-0.65, 0.14, 0.22)):
        cyl(0.8, y, 1.06 + h / 2, r, h, C['steel'], 20)
        cyl(0.8, y, 1.06 + h + 0.015, r + 0.01, 0.03, C['steel'], 20)
    for k, y in enumerate((-0.2, 0.08, 0.36, 0.64)):
        cyl(0.86, y, 1.06 + 0.14, 0.1, 0.28, C['glass'], 14)
        cyl(0.86, y, 1.06 + 0.1, 0.085, 0.18, goods[k % 4], 14)
        cyl(0.86, y, 1.06 + 0.3, 0.07, 0.05, goods[(k + 2) % 4], 14)
    cyl(0.82, 1.0, 1.06 + 0.06, 0.13, 0.12, C['awnB'], 18)
    # striped awning, out over the customers, its scalloped valance and a string of bulbs
    N = 10
    for k in range(N):
        y0, y1 = -W - 0.1 + k * (2 * W + 0.2) / N, -W - 0.1 + (k + 1) * (2 * W + 0.2) / N
        m = C['awnA'] if k % 2 == 0 else C['awnB']
        quad((1.0, y0, 2.52), (1.0, y1, 2.52), (1.85, y1, 2.18), (1.85, y0, 2.18), m)     # top face (seen from above)
        quad((1.85, y0, 2.18), (1.85, y1, 2.18), (1.0, y1, 2.52), (1.0, y0, 2.52), m)     # and from below
        quad((1.85, y0, 2.0), (1.85, y1, 2.0), (1.85, y1, 2.18), (1.85, y0, 2.18), m)     # valance
        quad((1.85, y1, 2.0), (1.85, y0, 2.0), (1.85, y0, 2.18), (1.85, y1, 2.18), m)
        yc = (y0 + y1) / 2
        me = bpy.data.meshes.new('sc')                                                     # scallop under each stripe
        me.from_pydata([(1.851, y0, 2.0), (1.851, y1, 2.0), (1.851, yc, 1.91)], [], [(0, 1, 2), (2, 1, 0)])
        o = bpy.data.objects.new('sc', me); bpy.context.collection.objects.link(o); o.data.materials.append(m); PARTS.append(o)
        ball(1.83, yc, 1.95, 0.035, C['bulb'], 6)
    for s in (-1, 1):
        rod((0.6, s * W, 2.3), (1.82, s * (W + 0.05), 2.17), 0.018, C['trim'])            # awning arms
    finish('Kiosk')


# ---------------------------------------------------------------- table and chairs
def table():
    P, Wt = C['plastic'], C['white']
    cyl(0, 0, 0.72, 0.42, 0.04, Wt, 24)                            # round top
    cyl(0, 0, 0.36, 0.05, 0.7, Wt, 10)                             # centre stem
    for a in range(4):
        t = a * math.pi / 2 + math.pi / 4
        rod((0, 0, 0.05), (math.cos(t) * 0.3, math.sin(t) * 0.3, 0.0), 0.025, Wt)
    for a in range(4):                                             # four stacking chairs, facing the table
        t = a * math.pi / 2
        cx, cy = math.cos(t) * 0.72, math.sin(t) * 0.72
        fx, fy = -math.cos(t), -math.sin(t); sx, sy = -fy, fx
        def p(f, s, z):
            return (cx + fx * f + sx * s, cy + fy * f + sy * s, z)
        quad(p(-0.2, -0.21, 0.44), p(-0.2, 0.21, 0.44), p(0.2, 0.21, 0.44), p(0.2, -0.21, 0.44), P)   # seat (top)
        quad(p(0.2, -0.21, 0.42), p(0.2, 0.21, 0.42), p(-0.2, 0.21, 0.42), p(-0.2, -0.21, 0.42), P)   # seat (under)
        quad(p(-0.24, 0.2, 0.46), p(-0.24, -0.2, 0.46), p(-0.29, -0.2, 0.86), p(-0.29, 0.2, 0.86), P)  # back rest
        quad(p(-0.25, -0.2, 0.46), p(-0.25, 0.2, 0.46), p(-0.3, 0.2, 0.86), p(-0.3, -0.2, 0.86), P)
        for f, s in ((0.18, 0.19), (0.18, -0.19), (-0.2, 0.19), (-0.2, -0.19)):
            rod(p(f, s, 0.43), p(f * 1.15, s * 1.12, 0.0), 0.017, P, 6)
    finish('Table')


# ---------------------------------------------------------------- market umbrella
def parasol():
    cyl(0, 0, 0.05, 0.28, 0.1, C['conc'], 16)
    rod((0, 0, 0.1), (0, 0, 2.35), 0.025, C['trim'])
    R, H0, H1, n = 1.35, 1.95, 2.35, 8
    for k in range(n):
        a0, a1 = k * 2 * math.pi / n, (k + 1) * 2 * math.pi / n
        m = C['canvas'] if k % 2 == 0 else C['awnB']
        for up in (1, -1):
            v = [(0, 0, H1), (math.cos(a0) * R, math.sin(a0) * R, H0), (math.cos(a1) * R, math.sin(a1) * R, H0)]
            me = bpy.data.meshes.new('pa')
            me.from_pydata(v, [], [(0, 1, 2) if up > 0 else (0, 2, 1)])
            o = bpy.data.objects.new('pa', me); bpy.context.collection.objects.link(o); o.data.materials.append(m); PARTS.append(o)
    finish('Parasol')


kiosk()
table()
parasol()
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, export_materials='EXPORT')
print('wrote', OUT)

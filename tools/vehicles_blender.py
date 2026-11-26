"""The vehicles you see up close, modelled in Blender (run headless with the bpy module):

    python tools/vehicles_blender.py public/models/vehicles.glb     (then tools/bus_pack.mjs to compress it)

One GLB with a node per model; wheels are separate nodes so the app can spin them and steer the front ones:
  Bus, BusWheel         12 m Janmarg AC bus (white over blue, orange waist stripe, doors on the right) and its wheel
  Scooter, ScooterWheel step-through scooter (Activa-like); the body panels use the 'Paint' material, recoloured in app
  Auto, AutoWheel       Bajaj-style CNG auto rickshaw: green body, yellow canvas roof, single front wheel

Blender is Z-up with every vehicle along +X (front) and its right side towards -Y; glTF export turns that into +X
forward, Y up, right side towards +Z, which is how the app places vehicles. Wheels are built round their own centre
with the axle along Blender Y (glTF Z), so the app spins them about local Z.

Material names carry meaning for the app: HeadLamp, TailLamp, LED / Indicator and Glass glow at night (VEHMAT lamp
kinds 1, 2, 3 and 4); Paint takes the rider's chosen colour; anything else is plain.
"""
import math, sys
import bpy

OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else 'vehicles.glb'
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


def box(x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2, rake=0.0, taper=0.0):
    """Axis box; rake pulls the top front edge back by that much, taper narrows the top (in y) by that much a side."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = (x1 - x0, y1 - y0, z1 - z0)
    o.location = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for v in o.data.vertices:
        if v.co.z > 0:
            if rake and v.co.x > 0:
                v.co.x -= rake
            if taper:
                v.co.y -= math.copysign(taper, v.co.y)
    o.data.materials.append(m)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
    PARTS.append(o)
    return o


def cyl(x, y, z, r, depth, m, verts=16, axis='Y', r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=(x, y, z))
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=(x, y, z))
    o = bpy.context.active_object
    if axis == 'Y':
        o.rotation_euler = (math.pi / 2, 0, 0)
    elif axis == 'X':
        o.rotation_euler = (0, math.pi / 2, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def rod(a, b, r, m, verts=8):
    """A round bar from point a to point b."""
    ax, ay, az = a; bx, by, bz = b
    dx, dy, dz = bx - ax, by - ay, bz - az
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=L, location=((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2))
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    from mathutils import Vector
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector((dx, dy, dz)).normalized())
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.data.materials.append(m)
    PARTS.append(o)
    return o


def finish(name):
    """Apply modifiers and join everything built since the last finish() into one object called name."""
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
    o.name = name
    o.data.name = name
    bpy.ops.object.shade_flat()
    PARTS = []
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    print(f'{name}: {tris} triangles, materials {[m.name for m in o.data.materials]}')
    return o


C = dict(
    white=mat('Body', (242, 242, 238), 0.35), blue=mat('Skirt', (28, 92, 160), 0.4), orange=mat('Stripe', (240, 130, 30), 0.4),
    glass=mat('Glass', (30, 40, 48), 0.1, 0.2), dark=mat('Trim', (38, 40, 44), 0.6), tyre=mat('Tyre', (22, 22, 24), 0.9),
    rim=mat('Rim', (170, 174, 178), 0.3, 0.8), roof=mat('Roof', (200, 204, 206), 0.5), head=mat('HeadLamp', (250, 246, 225), 0.2),
    tail=mat('TailLamp', (190, 30, 24), 0.3), led=mat('LED', (255, 170, 40), 0.3), ind=mat('Indicator', (255, 150, 30), 0.3),
    paint=mat('Paint', (200, 40, 40), 0.3), seat=mat('Seat', (30, 26, 24), 0.8), chrome=mat('Chrome', (200, 204, 208), 0.2, 0.9),
    green=mat('AutoGreen', (34, 120, 62), 0.4), yellow=mat('AutoYellow', (242, 200, 46), 0.7), grey=mat('Engine', (96, 100, 104), 0.6),
)


# ---------------------------------------------------------------- Janmarg bus (no wheels: BusWheel)
def bus():
    L0, L1, W, ZB, ZS, ZT = -6.0, 6.0, 1.275, 0.33, 1.02, 3.08
    AXLES, AR = (-3.6, 3.6), 0.66
    cuts = [L0] + [v for a in AXLES for v in (a - AR, a + AR)] + [L1]
    for i in range(0, len(cuts), 2):
        box(cuts[i], cuts[i + 1], -W, W, ZB, ZS, C['blue'], bevel=0.05)
    for a in AXLES:
        box(a - AR, a + AR, -W + 0.32, W - 0.32, ZB, ZS, C['dark'])
        for s in (-1, 1):
            box(a - AR - 0.04, a + AR + 0.04, s * W - 0.03, s * W + 0.03, ZS - 0.04, ZS + 0.02, C['dark'])
    box(L0, L1, -W, W, ZS, ZT, C['white'], bevel=0.1, seg=3, rake=0.14)
    box(L0 + 0.15, L1 - 0.3, -W - 0.006, -W + 0.02, 1.02, 1.14, C['orange'])
    box(L0 + 0.15, L1 - 0.3, W - 0.02, W + 0.006, 1.02, 1.14, C['orange'])
    DOORS = (2.3, -2.3)
    for sgn in (1, -1):
        y0, y1 = (W - 0.01, W + 0.012) if sgn > 0 else (-W - 0.012, -W + 0.01)
        x = L0 + 0.45
        while x < L1 - 0.6:
            x2 = min(x + 1.32, L1 - 0.6)
            if sgn < 0 and any(abs((x + x2) / 2 - d) < 1.05 for d in DOORS):
                x = x2 + 0.1
                continue
            box(x, x2, y0, y1, 1.3, 2.55, C['glass'])
            x = x2 + 0.1
    for d in DOORS:
        box(d - 0.62, d + 0.62, -W - 0.016, -W + 0.01, 0.38, 2.68, C['dark'])
        for s in (-1, 1):
            box(d + s * 0.3 - 0.26, d + s * 0.3 + 0.26, -W - 0.024, -W + 0.004, 0.5, 2.58, C['glass'])
    k = 0.14 / (ZT - ZS)
    box(L1 - 0.02 - k * (2.55 - ZS), L1 + 0.012 - k * (1.05 - ZS), -W + 0.12, W - 0.12, 1.05, 2.55, C['glass'], rake=k * 1.5)
    xr = L1 - k * (2.72 - ZS)
    box(xr - 0.02, xr + 0.02, -0.95, 0.95, 2.62, 2.92, C['dark'])
    box(xr + 0.015, xr + 0.03, -0.85, 0.85, 2.68, 2.86, C['led'])
    for s in (-1, 1):
        box(L1 - 0.02, L1 + 0.025, s * 0.78 - 0.2, s * 0.78 + 0.2, 0.55, 0.72, C['head'])
        box(L1 - 0.02, L1 + 0.025, s * 1.08 - 0.1, s * 1.08 + 0.1, 0.55, 0.72, C['ind'])
        box(L0 - 0.025, L0 + 0.02, s * 1.0 - 0.14, s * 1.0 + 0.14, 0.6, 1.0, C['tail'])
        box(L0 - 0.025, L0 + 0.02, s * 1.0 - 0.1, s * 1.0 + 0.1, 1.02, 1.16, C['ind'])
        box(L1 - 0.15, L1 + 0.28, s * (W - 0.05) - 0.03, s * (W + 0.12), 2.2, 2.25, C['dark'])
        box(L1 + 0.22, L1 + 0.3, s * (W + 0.05) - 0.08, s * (W + 0.05) + 0.08, 1.75, 2.25, C['dark'])
        box(L1 + 0.02, L1 + 0.04, s * 0.45 - 0.45, s * 0.45 + 0.45, 1.12, 1.15, C['dark'])
    box(L1 - 0.05, L1 + 0.06, -W + 0.05, W - 0.05, 0.33, 0.5, C['dark'], bevel=0.03)
    box(L0 - 0.06, L0 + 0.05, -W + 0.05, W - 0.05, 0.33, 0.5, C['dark'], bevel=0.03)
    box(L0 - 0.012, L0 + 0.01, -W + 0.2, W - 0.2, 1.4, 2.5, C['glass'])
    box(-2.6, 2.4, -0.95, 0.95, ZT - 0.02, ZT + 0.36, C['roof'], bevel=0.12, seg=3)
    box(-5.4, -3.4, -0.85, 0.85, ZT - 0.02, ZT + 0.18, C['roof'], bevel=0.05)
    finish('Bus')


def wheel(name, r, w, rim_r, spokes=0, hub=0.08):
    """A wheel round its own centre, axle along Y: tyre with a rounded shoulder, rim, hub (and spokes)."""
    cyl(0, 0, 0, r, w, C['tyre'], 24)
    cyl(0, 0, 0, r * 0.94, w + 0.02, C['tyre'], 24)
    for s in (-1, 1):
        cyl(0, s * (w / 2 + 0.006), 0, rim_r, 0.012, C['rim'], 18)
        cyl(0, s * (w / 2 + 0.014), 0, hub, 0.016, C['dark'], 10)
        for k in range(spokes):   # rim spokes / alloy arms, so the turning shows
            a = k / spokes * math.pi * 2
            rod((math.cos(a) * hub, s * (w / 2 + 0.016), math.sin(a) * hub), (math.cos(a) * rim_r * 0.92, s * (w / 2 + 0.016), math.sin(a) * rim_r * 0.92), 0.012 + r * 0.03, C['dark'], 6)
    finish(name)


# ---------------------------------------------------------------- scooter (front wheel x 0.62, rear x -0.55, r 0.25)
def scooter():
    P, D, S = C['paint'], C['dark'], C['seat']
    box(-0.25, 0.4, -0.16, 0.16, 0.27, 0.33, D)                                        # floorboard
    box(0.36, 0.5, -0.2, 0.2, 0.3, 1.0, P, bevel=0.05, rake=0.08, taper=0.04)           # leg shield
    box(0.44, 0.62, -0.14, 0.14, 0.18, 0.4, P, bevel=0.04)                              # front fender / fork cover
    rod((0.6, 0, 0.3), (0.5, 0, 1.0), 0.03, D)                                         # steering column
    box(0.36, 0.62, -0.13, 0.13, 0.96, 1.1, P, bevel=0.04)                              # handlebar cover
    box(0.6, 0.64, -0.07, 0.07, 1.0, 1.08, C['head'])                                   # headlamp
    for s in (-1, 1):
        rod((0.46, 0, 1.04), (0.44, s * 0.36, 1.04), 0.016, D)                          # bars
        rod((0.44, s * 0.28, 1.04), (0.44, s * 0.38, 1.04), 0.022, S)                   # grips
        rod((0.48, s * 0.16, 1.08), (0.46, s * 0.2, 1.3), 0.008, C['chrome'])          # mirror stalks
        box(0.43, 0.49, s * 0.2 - 0.06, s * 0.2 + 0.06, 1.28, 1.36, D)                  # mirrors
        box(0.62, 0.65, s * 0.1 - 0.025, s * 0.1 + 0.025, 0.9, 0.95, C['ind'])          # front indicators
    box(-0.8, -0.18, -0.19, 0.19, 0.36, 0.72, P, bevel=0.1, seg=3, taper=0.03)          # rear body
    box(-0.74, -0.1, -0.15, 0.15, 0.71, 0.8, S, bevel=0.04, seg=2)                      # seat
    box(-0.83, -0.79, -0.1, 0.1, 0.55, 0.64, C['tail'])                                 # tail lamp
    rod((-0.78, -0.17, 0.82), (-0.5, -0.17, 0.82), 0.012, C['chrome'])                  # grab rail
    rod((-0.78, 0.17, 0.82), (-0.5, 0.17, 0.82), 0.012, C['chrome'])
    rod((-0.78, -0.17, 0.82), (-0.78, 0.17, 0.82), 0.012, C['chrome'])
    box(-0.62, -0.22, 0.03, 0.16, 0.15, 0.36, C['grey'])                                # engine / swing arm (left)
    rod((-0.6, -0.12, 0.2), (-0.95, -0.14, 0.28), 0.035, C['chrome'])                   # silencer (right)
    box(-0.76, -0.38, -0.12, 0.12, 0.47, 0.52, D)                                       # rear mudguard lip
    finish('Scooter')


# ---------------------------------------------------------------- auto rickshaw (front wheel x 1.0, rear x -0.85 at +-0.6, r 0.22)
def auto():
    G, Y, D, S = C['green'], C['yellow'], C['dark'], C['seat']
    box(-1.2, 1.1, -0.6, 0.6, 0.26, 0.36, D)                                            # chassis floor
    box(-1.32, 0.45, -0.68, 0.68, 0.36, 0.86, G, bevel=0.06)                            # rear tub
    box(0.82, 1.36, -0.42, 0.42, 0.3, 0.95, G, bevel=0.08, taper=0.1, rake=0.05)        # front nose / cowl
    for s in (-1, 1):
        box(0.45, 0.86, s * 0.68 - 0.04, s * 0.68 + 0.04, 0.36, 0.62, G, bevel=0.02)  # open footwell's low sides
    box(0.78, 0.84, -0.42, 0.42, 0.62, 0.98, D)                                         # dashboard
    box(0.86, 1.18, -0.2, 0.2, 0.16, 0.32, G, bevel=0.04)                               # front mudguard
    box(0.84, 0.9, -0.56, 0.56, 0.95, 1.62, C['glass'], rake=0.08)                      # windscreen
    box(0.9, 1.0, -0.56, 0.56, 0.93, 0.99, D)
    box(-1.36, 0.98, -0.72, 0.72, 1.62, 1.79, Y, bevel=0.07, seg=3)                     # canvas roof
    for x, y in ((-1.3, -0.66), (-1.3, 0.66), (0.86, -0.58), (0.86, 0.58)):
        box(x - 0.03, x + 0.03, y - 0.03, y + 0.03, 0.86, 1.63, D)                      # roof posts
    box(-1.36, -1.3, -0.7, 0.7, 0.86, 1.63, D)                                          # rear canvas
    box(-1.37, -1.36, -0.25, 0.25, 1.15, 1.4, C['glass'])                               # rear window
    box(-1.15, -0.45, -0.62, 0.62, 0.6, 0.7, S, bevel=0.03)                             # passenger bench
    box(-1.2, -1.1, -0.62, 0.62, 0.7, 1.2, S, bevel=0.03)                               # and its back
    box(0.3, 0.6, -0.22, 0.22, 0.58, 0.68, S, bevel=0.03)                               # driver's seat
    box(0.32, 0.58, -0.18, 0.18, 0.36, 0.58, D)                                         # seat box
    rod((0.82, 0, 0.92), (0.72, 0, 1.02), 0.025, D)                                    # steering column
    for s in (-1, 1):
        rod((0.72, 0, 1.02), (0.68, s * 0.3, 1.04), 0.015, D)                           # handlebar
        rod((0.68, s * 0.22, 1.04), (0.67, s * 0.32, 1.04), 0.02, S)
        box(-1.34, -1.31, s * 0.55 - 0.08, s * 0.55 + 0.08, 0.55, 0.68, C['tail'])      # tail lamps
        box(1.27, 1.31, s * 0.3 - 0.04, s * 0.3 + 0.04, 0.82, 0.88, C['ind'])           # indicators
        rod((0.92, s * 0.52, 1.3), (1.05, s * 0.7, 1.35), 0.01, D)                      # mirror arms
        box(1.02, 1.07, s * 0.72 - 0.05, s * 0.72 + 0.05, 1.29, 1.41, D)
    box(1.3, 1.37, -0.11, 0.11, 0.72, 0.86, C['head'])                                  # headlamp
    box(-1.0, -0.6, -0.69, 0.69, 0.36, 0.42, C['dark'])                                 # rear wheel arches
    finish('Auto')


bus()
wheel('BusWheel', 0.5, 0.3, 0.3, spokes=6, hub=0.09)
scooter()
wheel('ScooterWheel', 0.25, 0.1, 0.16, spokes=5, hub=0.04)
auto()
wheel('AutoWheel', 0.22, 0.12, 0.14, spokes=4, hub=0.04)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, export_materials='EXPORT')
print('wrote', OUT)

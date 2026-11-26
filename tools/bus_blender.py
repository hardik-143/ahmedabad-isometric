"""Janmarg AC bus, modelled in Blender (run headless with the bpy module):

    python tools/bus_blender.py public/models/bus.glb

12 m low-floor city bus as Ahmedabad's Janmarg runs them: white body over a blue skirt with an orange waist stripe,
bevelled corners, a raked windscreen under an amber LED destination board, a continuous window band with pillars,
two sliding doors on the right (station) side at +-2.3 m, wheel arches, an AC pod on the roof, mirrors, bumpers,
head, tail and indicator lamps. Blender is Z-up with the bus along +X (front) and its right side towards -Y; glTF
export turns that into +X forward, Y up, right side towards +Z, which is how the app places buses.

Material names carry meaning for the app: HeadLamp, TailLamp, LED and Glass glow at night (VEHMAT lamp kinds 1, 2, 3
and 4); every other material is plain paint.
"""
import math, sys
import bpy

OUT = sys.argv[-1] if sys.argv[-1].endswith('.glb') else 'bus.glb'
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


def box(name, x0, x1, y0, y1, z0, z1, m, bevel=0.0, seg=2, rake=0.0):
    """Axis box from (x0, y0, z0) to (x1, y1, z1); rake pulls the top front edge back (towards -x) by that much."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.name = name
    o.scale = (x1 - x0, y1 - y0, z1 - z0)   # the cube is 1 m a side
    o.location = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rake:
        for v in o.data.vertices:
            if v.co.x > 0 and v.co.z > 0:
                v.co.x -= rake
    o.data.materials.append(m)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
    return o


def cyl(name, x, y, z, r, depth, m, verts=16, axis='Y'):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=(x, y, z))
    o = bpy.context.active_object
    o.name = name
    if axis == 'Y':
        o.rotation_euler = (math.pi / 2, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.data.materials.append(m)
    return o


white = mat('Body', (242, 242, 238), 0.35)
blue = mat('Skirt', (28, 92, 160), 0.4)
orange = mat('Stripe', (240, 130, 30), 0.4)
glass = mat('Glass', (30, 40, 48), 0.1, 0.2)
dark = mat('Trim', (38, 40, 44), 0.6)
tyre = mat('Tyre', (22, 22, 24), 0.9)
rim = mat('Rim', (170, 174, 178), 0.3, 0.8)
roofu = mat('Roof', (200, 204, 206), 0.5)
head = mat('HeadLamp', (250, 246, 225), 0.2)
tail = mat('TailLamp', (190, 30, 24), 0.3)
led = mat('LED', (255, 170, 40), 0.3)
ind = mat('Indicator', (255, 150, 30), 0.3)

L0, L1, W, ZB, ZS, ZT = -6.0, 6.0, 1.275, 0.33, 1.02, 3.08   # length, half width, floor, skirt top, roof

# body: blue skirt, white upper, raked front
# skirt in pieces, open over the wheels (wheel arches), with a dark inner arch so you never see into the bus
AXLES, AR = (-3.6, 3.6), 0.66
cuts = [L0] + [v for a in AXLES for v in (a - AR, a + AR)] + [L1]
for i in range(0, len(cuts), 2):
    box(f'skirt_{i}', cuts[i], cuts[i + 1], -W, W, ZB, ZS, blue, bevel=0.05)
for a in AXLES:
    box(f'arch_in_{a}', a - AR, a + AR, -W + 0.28, W - 0.28, ZB, ZS, dark)
    for s in (-1, 1):
        box(f'fender_{a}_{s}', a - AR - 0.04, a + AR + 0.04, s * W - 0.03, s * W + 0.03, ZS - 0.04, ZS + 0.02, dark)
box('upper', L0, L1, -W, W, ZS, ZT, white, bevel=0.1, seg=3, rake=0.14)
# orange waist stripe, both sides and the front
box('stripe_r', L0 + 0.15, L1 - 0.3, -W - 0.006, -W + 0.02, 1.02, 1.14, orange)
box('stripe_l', L0 + 0.15, L1 - 0.3, W - 0.02, W + 0.006, 1.02, 1.14, orange)
# window band with pillars (left side continuous; right side broken by the doors)
DOORS = (2.3, -2.3)
for side, sgn in (('l', 1), ('r', -1)):
    y0, y1 = (W - 0.01, W + 0.012) if sgn > 0 else (-W - 0.012, -W + 0.01)
    x = L0 + 0.45
    while x < L1 - 0.6:
        x2 = min(x + 1.32, L1 - 0.6)
        if sgn < 0 and any(abs((x + x2) / 2 - d) < 1.05 for d in DOORS):
            x = x2 + 0.1
            continue
        box(f'win_{side}_{x:.1f}', x, x2, y0, y1, 1.3, 2.55, glass)
        x = x2 + 0.1
# doors on the right side: glass leaves in dark frames, with a step light strip
for d in DOORS:
    box(f'door_{d}', d - 0.62, d + 0.62, -W - 0.016, -W + 0.01, 0.38, 2.68, dark)
    for s in (-1, 1):
        box(f'door_{d}_{s}', d + s * 0.3 - 0.26, d + s * 0.3 + 0.26, -W - 0.024, -W + 0.004, 0.5, 2.58, glass)
# front: raked windscreen (follows the rake), LED destination board, lamps, bumper, wipers, mirrors
bpy.ops.mesh.primitive_plane_add(size=1)
ws = bpy.context.active_object
ws.name = 'windscreen'
ws.data.vertices[0].co = (L1 + 0.012, -W + 0.12, 1.05)
ws.data.vertices[1].co = (L1 + 0.012, W - 0.12, 1.05)
ws.data.vertices[2].co = (L1 + 0.012 - 0.14 * (2.55 - ZS) / (ZT - ZS), -W + 0.12, 2.55)
ws.data.vertices[3].co = (L1 + 0.012 - 0.14 * (2.55 - ZS) / (ZT - ZS), W - 0.12, 2.55)
ws.data.polygons[0].vertices  # noqa
ws.data.materials.append(glass)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.flip_normals(); bpy.ops.object.mode_set(mode='OBJECT')
xr = L1 - 0.14 * (2.72 - ZS) / (ZT - ZS)
box('led_board', xr - 0.02, xr + 0.02, -0.95, 0.95, 2.62, 2.92, dark)
box('led_text', xr + 0.015, xr + 0.03, -0.85, 0.85, 2.68, 2.86, led)
for s in (-1, 1):
    box(f'headlamp_{s}', L1 - 0.02, L1 + 0.025, s * 0.78 - 0.2, s * 0.78 + 0.2, 0.55, 0.72, head)
    box(f'ind_f_{s}', L1 - 0.02, L1 + 0.025, s * 1.08 - 0.1, s * 1.08 + 0.1, 0.55, 0.72, ind)
    box(f'tail_{s}', L0 - 0.025, L0 + 0.02, s * 1.0 - 0.14, s * 1.0 + 0.14, 0.6, 1.0, tail)
    box(f'ind_r_{s}', L0 - 0.025, L0 + 0.02, s * 1.0 - 0.1, s * 1.0 + 0.1, 1.02, 1.16, ind)
    # mirror on an arm
    box(f'mirror_arm_{s}', L1 - 0.15, L1 + 0.28, s * (W - 0.05), s * (W + 0.12), 2.2, 2.25, dark)
    box(f'mirror_{s}', L1 + 0.22, L1 + 0.3, s * (W + 0.05) - 0.08, s * (W + 0.05) + 0.08, 1.75, 2.25, dark)
    box(f'wiper_{s}', L1 + 0.02, L1 + 0.04, s * 0.45 - 0.45, s * 0.45 + 0.45, 1.12, 1.15, dark)
box('bumper_f', L1 - 0.05, L1 + 0.06, -W + 0.05, W - 0.05, 0.33, 0.5, dark, bevel=0.03)
box('bumper_r', L0 - 0.06, L0 + 0.05, -W + 0.05, W - 0.05, 0.33, 0.5, dark, bevel=0.03)
box('rear_glass', L0 - 0.012, L0 + 0.01, -W + 0.2, W - 0.2, 1.4, 2.5, glass)
# wheel arches and wheels (axles at +-3.6 m, the app steers on those)
for ax in AXLES:
    for s in (-1, 1):
        cyl(f'tyre_{ax}_{s}', ax, s * 1.1, 0.5, 0.5, 0.3, tyre, 20)
        cyl(f'rim_{ax}_{s}', ax, s * 1.255, 0.5, 0.29, 0.03, rim, 16)
        cyl(f'hub_{ax}_{s}', ax, s * 1.27, 0.5, 0.09, 0.03, dark, 10)
# roof: AC pod and the rear service hatch
box('ac_pod', -2.6, 2.4, -0.95, 0.95, ZT - 0.02, ZT + 0.36, roofu, bevel=0.12, seg=3)
box('hatch', -5.4, -3.4, -0.85, 0.85, ZT - 0.02, ZT + 0.18, roofu, bevel=0.05)

# apply modifiers, join into one object (one primitive per material on export)
for o in bpy.data.objects:
    bpy.context.view_layer.objects.active = o
    for mdf in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=mdf.name)
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = bpy.data.objects['upper']  # any object; join keeps world positions
bpy.ops.object.join()
bus = bpy.context.active_object
bus.name = 'JanmargBus'
bpy.ops.object.shade_flat()
tris = sum(len(p.vertices) - 2 for p in bus.data.polygons)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True, export_materials='EXPORT')
print('bus.glb', OUT, 'triangles', tris, 'materials', [m.name for m in bus.data.materials])

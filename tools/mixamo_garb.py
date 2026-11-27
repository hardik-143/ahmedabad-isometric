"""Indian clothes for a Mixamo body (called from tools/mixamo_char.py with garb=m or garb=f, in Blender, before decimating).

The bodies have no skin under their clothes, so the body's own top stays as the blouse / kurta top (the app recolours
it) and only the parts below and over it are made here, as skinned meshes on the same armature:

  <Ch>_GKnee   knee-length skirt of a kurta (men) or kameez (women), from just above the top's hem; hips and thighs
  <Ch>_GSaree  ankle-length saree skirt from above the top's hem, with pleats down the front; hips, thighs and shins
  <Ch>_GPallu  the saree's loose end: from the right hip across the chest, over the left shoulder, down the back
  <Ch>_GDupatta  a scarf: over both shoulders, dipping across the chest, both ends down the back
  <Ch>_GBun    a bun at the back of the head

Skirts are rings that follow the body's measured cross-section (body, top and trousers, as a star-shaped hull around
the hips), never narrowing below the hips and flaring a little to the hem. Their weights blend from the hips at the
waist to each leg by side, the shins taking over below the knee, so a skirt walks with the legs. Pallu and dupatta are
strips laid on the clothes by casting rays at them, and take their weights from the nearest point of the top.
UVs: skirts u = round the body (0..1), v = up from the hem (0..1); strips u = along (0..1), v = across (0..1).
The app draws all of them with its own patterned material (border, motifs) in the colours each person wears.
"""
import bpy, bmesh, math, re
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def build(gender):
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    end = lambda o, *names: any(o.name.endswith('_' + n) for n in names)
    body = next(o for o in meshes if end(o, 'Body'))
    tops = sorted([o for o in meshes if end(o, 'Shirt', 'Suit', 'Hoody')], key=lambda o: -len(o.data.vertices))
    top = tops[0]
    pants = next((o for o in meshes if end(o, 'Pants')), None)
    hair = next((o for o in meshes if end(o, 'Hair')), None)
    name = body.name.rsplit('_', 1)[0]
    W = lambda o: [o.matrix_world @ v.co for v in o.data.vertices]
    bone = lambda n: arm.matrix_world @ arm.data.bones['mixamorig:' + n].head_local
    hips, knee, ankle, neck, head = bone('Hips'), bone('LeftLeg'), bone('LeftFoot'), bone('Neck'), bone('Head')
    cx, cy = hips.x, hips.y
    cloud = [w for o in [body, pants] + tops if o for w in W(o)]
    hem = min(w.z for w in W(top))                                            # the top's lowest edge
    front = -1.0                                                              # the body faces -y

    NA = 36
    def section(z, band=0.03):
        r = [0.0] * NA
        for w in cloud:
            if abs(w.z - z) > band: continue
            dx, dy = w.x - cx, w.y - cy
            a = int((math.atan2(dy, dx) / (2 * math.pi)) % 1 * NA) % NA
            r[a] = max(r[a], math.hypot(dx, dy))
        for _ in range(NA):                                                   # empty wedges (between the legs) take their neighbours'
            if all(r): break
            r = [x or max(r[i - 1], r[(i + 1) % NA]) for i, x in enumerate(r)]
        for _ in range(2): r = [max(r[i], 0.5 * (r[i - 1] + r[(i + 1) % NA])) for i in range(NA)]
        return r

    def new_obj(nm, verts, faces, uvs, mat):
        me = bpy.data.meshes.new(nm); M = body.matrix_world.inverted()
        me.from_pydata([M @ v for v in verts], [], faces); me.update()
        uvl = me.uv_layers.new(name='UVMap')
        for p in me.polygons:
            for li, vi in zip(p.loop_indices, p.vertices): uvl.data[li].uv = uvs[vi]
        for p in me.polygons: p.use_smooth = True
        m = bpy.data.materials.get(mat) or bpy.data.materials.new(mat); me.materials.append(m)
        o = bpy.data.objects.new(nm, me); bpy.context.collection.objects.link(o)
        o.parent = body.parent; o.matrix_parent_inverse = body.matrix_parent_inverse.copy(); o.matrix_basis = body.matrix_basis.copy()
        mod = o.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
        bpy.context.view_layer.update()                                       # its world matrix, for laying strips on it
        return o

    def skirt(nm, z_top, z_bot, flare, pleats, shins, mat):
        NR = 14
        zs = [z_top - (z_top - z_bot) * (i / (NR - 1)) ** 1.25 for i in range(NR)]
        rings, prev = [], None
        for i, z in enumerate(zs):
            r = section(z); f = (i / (NR - 1)) ** 2
            r = [x + 0.014 for x in r]
            if prev: r = [max(x, p) for x, p in zip(r, prev)]                 # never narrower below
            prev = r
            rr = []
            for a in range(NA):
                th = (a + 0.5) / NA * 2 * math.pi; R = r[a] * (1 + flare * f)
                fr = -math.sin(th) * -front                                    # 1 straight ahead
                if pleats and fr > 0.55 and z < hips.z: R += 0.007 * f ** 0.5 * (1 + math.sin(th * 30))
                rr.append(R)
            rings.append(rr)
        verts, uvs, faces = [], [], []
        for i, z in enumerate(zs):
            for a in range(NA + 1):                                            # a seam column so u runs 0..1
                th = (a + 0.5) / NA * 2 * math.pi; R = rings[i][a % NA]
                verts.append(Vector((cx + R * math.cos(th), cy + R * math.sin(th), z)))
                uvs.append((a / NA, (z - z_bot) / (z_top - z_bot)))
        C = NA + 1
        for i in range(NR - 1):
            for a in range(NA): faces.append((i * C + a, i * C + a + 1, (i + 1) * C + a + 1, (i + 1) * C + a))
        o = new_obj(nm, verts, faces, uvs, mat)
        G = {n: o.vertex_groups.new(name='mixamorig:' + n) for n in ('Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg')}
        for vi, v in enumerate(verts):
            t = max(0.0, min(1.0, (z_top - v.z) / max(1e-3, z_top - knee.z)))
            wh = (1 - t) ** 2; legs = 1 - wh
            s = max(0.0, min(1.0, 0.5 + (v.x - cx) / 0.12))                    # the body's left is +x
            sh = shins * max(0.0, min(1.0, (knee.z - v.z) / max(1e-3, knee.z - ankle.z)))
            for g, w in (('Hips', wh), ('LeftUpLeg', legs * s * (1 - sh)), ('LeftLeg', legs * s * sh),
                         ('RightUpLeg', legs * (1 - s) * (1 - sh)), ('RightLeg', legs * (1 - s) * sh)):
                if w > 1e-3: G[g].add([vi], w, 'REPLACE')
        return o

    def strip(nm, path, targets, mat, src, zmax):
        """path: [(origin, ray direction, across (unit), width)], laid on the targets 2 cm out; weights from src. A ray
        that misses, or lands above zmax (the head, seen from above the shoulder), takes the nearest point of the targets"""
        tri, vs = [], []
        for t in targets:
            bm = bmesh.new(); bm.from_mesh(t.data); bm.transform(t.matrix_world); bmesh.ops.triangulate(bm, faces=bm.faces)
            off = len(vs); vs += [v.co.copy() for v in bm.verts]; tri += [[off + v.index for v in f.verts] for f in bm.faces]; bm.free()
        bvh = BVHTree.FromPolygons(vs, tri)
        NV = 5; verts, uvs = [], []
        L = len(path)
        for k, (o, d, across, w) in enumerate(path):
            for j in range(NV):
                c = (j / (NV - 1) - 0.5) * w
                org = o + across * c
                hit = bvh.ray_cast(org, d)
                if hit[0] is None or hit[0].z > zmax:
                    near = bvh.find_nearest(org + d * 0.6 if hit[0] is None else Vector((hit[0].x, hit[0].y, zmax - 0.02)))
                    hit = (near[0], near[1])
                p = hit[0] + hit[1] * 0.02 if hit[1].dot(d) < 0 else hit[0] - d * 0.02
                verts.append(p); uvs.append((k / (L - 1), j / (NV - 1)))
        faces = [(k * NV + j, k * NV + j + 1, (k + 1) * NV + j + 1, (k + 1) * NV + j) for k in range(L - 1) for j in range(NV - 1)]
        o = new_obj(nm, verts, faces, uvs, mat)
        for g in src.vertex_groups: o.vertex_groups.new(name=g.name)
        dt = o.modifiers.new('wt', 'DATA_TRANSFER'); dt.object = src; dt.use_vert_data = True; dt.data_types_verts = {'VGROUP_WEIGHTS'}
        dt.vert_mapping = 'POLYINTERP_NEAREST'; dt.layers_vgroup_select_src = 'ALL'; dt.layers_vgroup_select_dst = 'NAME'
        bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = o; o.select_set(True)
        bpy.ops.object.modifier_move_to_index(modifier='wt', index=0); bpy.ops.object.modifier_apply(modifier='wt')
        return o

    made = []
    knee_top = hem + 0.06
    made.append(skirt(f'{name}_GKnee', knee_top, knee.z - (0.07 if gender == 'f' else 0.02), 0.16 if gender == 'f' else 0.04, False, 0.0, 'G_knee'))
    if gender == 'f':
        z_top = max(hips.z + 0.05, hem + 0.05)
        saree = skirt(f'{name}_GSaree', z_top, 0.035, 0.10, True, 0.8, 'G_saree'); made.append(saree)
        sx = (neck.x - cx) + 0.15                                               # the left shoulder, a hand's width out from the neck
        zt = neck.z - 0.03
        Y, Z = Vector((0, 1, 0)), Vector((0, 0, 1))
        P = []
        for i in range(10):                                                     # from the right hip, up across the chest
            s = i / 9; x, z = cx - 0.11 + (sx + 0.11) * s, z_top - 0.03 + (zt - 0.05 - z_top + 0.03) * s
            dxz = Vector((sx + 0.11, 0, zt - 0.05 - z_top + 0.03)).normalized(); across = Vector((-dxz.z, 0, dxz.x))
            P.append((Vector((x, cy - 0.6, z)), Y, across, 0.26 - 0.12 * s))
        for i in range(1, 8):                                                   # over the shoulder
            ph = i / 8 * math.pi; out = Vector((0, -math.cos(ph), math.sin(ph)))
            P.append((Vector((cx + sx, cy, zt - 0.06)) + out * 0.6, -out, Vector((1, 0, 0)), 0.11))
        for i in range(9):                                                      # down the back, widening
            s = i / 8; P.append((Vector((cx + sx - 0.07 * min(1, s * 3), cy + 0.6, zt - 0.05 - (zt - 0.05 - (hips.z - 0.2)) * s)), -Y, Vector((1, 0, 0)), 0.14 + 0.18 * s))
        made.append(strip(f'{name}_GPallu', P, [top, saree], 'G_saree', top, neck.z + 0.06))
        D = []
        for i in range(6):                                                      # the left end, up the back
            s = i / 5; D.append((Vector((cx + sx - 0.07 * min(1, (1 - s) * 2.5), cy + 0.6, hips.z - 0.12 + (zt - 0.05 - hips.z + 0.12) * s)), -Y, Vector((1, 0, 0)), 0.12 - 0.02 * s))
        for i in range(1, 6):                                                   # over the left shoulder
            ph = math.pi - i / 6 * math.pi; out = Vector((0, -math.cos(ph), math.sin(ph)))
            D.append((Vector((cx + sx, cy, zt - 0.06)) + out * 0.6, -out, Vector((1, 0, 0)), 0.1))
        for i in range(11):                                                     # dipping across the chest
            s = i / 10; x = cx + sx - 2 * sx * s; z = zt - 0.05 - 0.2 * math.sin(math.pi * s)
            D.append((Vector((x, cy - 0.6, z)), Y, Vector((0, 0, 1)), 0.12 + 0.05 * math.sin(math.pi * s)))
        for i in range(1, 6):                                                   # over the right shoulder
            ph = i / 6 * math.pi; out = Vector((0, -math.cos(ph), math.sin(ph)))
            D.append((Vector((cx - sx, cy, zt - 0.06)) + out * 0.6, -out, Vector((1, 0, 0)), 0.1))
        for i in range(6):                                                      # the right end, down the back
            s = i / 5; D.append((Vector((cx - sx + 0.07 * min(1, s * 2.5), cy + 0.6, zt - 0.05 - (zt - 0.05 - hips.z + 0.12) * s)), -Y, Vector((1, 0, 0)), 0.1 + 0.02 * s))
        made.append(strip(f'{name}_GDupatta', D, [top, made[0]], 'G_dupatta', top, neck.z + 0.06))
        # a bun: low on the back of the head, on the hair (or the scalp)
        tg = [t for t in (hair, body) if t]
        vs, tri = [], []
        for t in tg:
            bm = bmesh.new(); bm.from_mesh(t.data); bm.transform(t.matrix_world); bmesh.ops.triangulate(bm, faces=bm.faces)
            off = len(vs); vs += [v.co.copy() for v in bm.verts]; tri += [[off + v.index for v in f.verts] for f in bm.faces]; bm.free()
        hit = BVHTree.FromPolygons(vs, tri).ray_cast(Vector((head.x, head.y + 0.5, head.z + 0.06)), Vector((0, -1, 0)))
        c = (hit[0] if hit[0] is not None else Vector((head.x, head.y + 0.1, head.z + 0.06))) + Vector((0, 0.035, -0.01))
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=7, radius=1.0)
        verts = [Vector((c.x + v.co.x * 0.055, c.y + v.co.y * 0.05, c.z + v.co.z * 0.05)) for v in bm.verts]
        faces = [tuple(v.index for v in f.verts) for f in bm.faces]; bm.free()
        o = new_obj(f'{name}_GBun', verts, faces, [(0.5, 0.5)] * len(verts), 'G_bun')
        o.vertex_groups.new(name='mixamorig:Head').add(list(range(len(verts))), 1.0, 'REPLACE')
        made.append(o)
    for o in made: print('garb', o.name, len(o.data.polygons), 'faces')
    return made

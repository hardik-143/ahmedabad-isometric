"""A Mixamo character (FBX, T-pose, with skin) -> a light GLB for the app (run headless with the bpy module):

    python tools/mixamo_char.py in.fbx out.glb [texture_px=1024] [keep=0.35] [garb=m|f] [lod=0.03]
      keep: decimate to that share of the triangles; garb: add Indian clothes (tools/mixamo_garb.py);
      lod: also a far copy of every part at that share (the crowd: 512 0.2 garb=f lod=0.03)

- bones renamed from Mixamo's numbered prefix (mixamorig4:Hips) to mixamorig:Hips, so every Mixamo clip drives every
  character by bone name
- only the colour texture is kept, scaled down and saved as JPEG (the app lights people with plain Lambert materials)
- the T-pose action Mixamo bakes in is dropped; the app brings its own walk / run / idle
"""
import bpy, os, re, sys
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
src, out = [a for a in args if a.endswith('.fbx')][0], [a for a in args if a.endswith('.glb')][0]
px = int(next((a for a in args if a.isdigit()), '1024'))
keep = float(next((a for a in args if a.startswith('0.')), '1'))   # people in the crowd: fewer triangles
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for b in arm.data.bones:
    b.name = re.sub(r'^mixamorig\d*:', 'mixamorig:', b.name)
for o in bpy.data.objects:
    if o.type == 'MESH':
        for g in o.vertex_groups: g.name = re.sub(r'^mixamorig\d*:', 'mixamorig:', g.name)
        o.data.uv_layers.active_index = 0
# some Mixamo characters (Ch12) come as one merged mesh: split it into named parts (Body, Shirt, Pants, Shoes, Belt, Hair)
# so the app can recolour clothes, skin and hair one by one. Every piece of clothing is its own loose part in the source;
# pieces are told apart by material and by where they sit on the T-posed body (metres, z up)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if len(meshes) == 1:
    from mathutils import Vector
    me = meshes[0]; name = me.name.split('_')[0].split('.')[0]
    bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = me; me.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.separate(type='LOOSE'); bpy.ops.object.mode_set(mode='OBJECT')
    groups = {}
    for o in [o for o in bpy.data.objects if o.type == 'MESH']:
        ws = [o.matrix_world @ v.co for v in o.data.vertices]
        z0, z1 = min(w.z for w in ws), max(w.z for w in ws); x0, x1 = min(w.x for w in ws), max(w.x for w in ws)
        mats = {o.data.materials[p.material_index].name for p in o.data.polygons}
        if any('hair' in m.lower() for m in mats): g = 'Hair'
        elif z1 < 0.16: g = 'Shoes'
        elif z0 < 0.25 and z1 > 0.8: g = 'Pants'
        elif z0 > 0.95 and z1 < 1.06 and x1 - x0 < 0.4: g = 'Belt'
        elif z0 > 0.9 and z1 < 1.6 and x1 - x0 > 0.5 and abs(x0 + x1) < 0.1: g = 'Shirt'
        else: g = 'Body'                                   # head, arms, eyes
        groups.setdefault(g, []).append(o)
    for g, objs in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs: o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1: bpy.ops.object.join()
        objs[0].name = objs[0].data.name = f'{name}_{g}'
        print('part', objs[0].name, len(objs[0].data.polygons), 'faces')
# garb=m / garb=f: add a kurta / kameez skirt, and for women a saree, pallu, dupatta and bun (tools/mixamo_garb.py)
garb = next((a.split('=', 1)[1] for a in args if a.startswith('garb=')), None)
if garb:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import mixamo_garb
    mixamo_garb.build(garb)
# lod=0.03: a second, far lighter copy of every part (<name>_L1) on the same skeleton, which the app shows from ~20 m
# (hair keeps a little more, eyelashes are left out; the clothes made above serve both)
lod = float(next((a.split('=', 1)[1] for a in args if a.startswith('lod=')), '0'))
if lod > 0:
    for o in [o for o in bpy.data.objects if o.type == 'MESH' and '_G' not in o.name and 'Eyelas' not in o.name]:
        c = o.copy(); c.data = o.data.copy(); bpy.context.collection.objects.link(c); c.name = c.data.name = o.name + '_L1'
        d = c.modifiers.new('decimate', 'DECIMATE'); d.ratio = max(lod, 0.12) if o.name.endswith('_Hair') else lod
        bpy.ops.object.select_all(action='DESELECT'); bpy.context.view_layer.objects.active = c; c.select_set(True)
        bpy.ops.object.modifier_move_to_index(modifier='decimate', index=0); bpy.ops.object.modifier_apply(modifier='decimate')
        print(c.name, 'far copy', len(c.data.polygons), 'faces')
if keep < 1:
    for o in bpy.data.objects:
        if o.type == 'MESH' and '_G' not in o.name and not o.name.endswith('_L1'):   # the clothes made above are light already
            d = o.modifiers.new('decimate', 'DECIMATE'); d.ratio = keep
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_move_to_index(modifier='decimate', index=0)   # before the armature modifier
            bpy.ops.object.modifier_apply(modifier='decimate')
            print(o.name, 'decimated to', len(o.data.polygons), 'faces')
# keep only base colour, downscaled
tmp = os.path.join(os.path.dirname(os.path.abspath(out)), '_tex'); os.makedirs(tmp, exist_ok=True)
done = {}
for m in bpy.data.materials:
    if not m.node_tree: continue
    nt = m.node_tree; bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf: continue
    base = bsdf.inputs['Base Color'].links[0].from_node if bsdf.inputs['Base Color'].links else None
    for n in list(nt.nodes):
        if n.type in ('TEX_IMAGE', 'NORMAL_MAP') and n != base: nt.nodes.remove(n)
    for k in ('Metallic', 'Specular IOR Level', 'Roughness'):
        if k in bsdf.inputs:
            for l in list(bsdf.inputs[k].links): nt.links.remove(l)
    bsdf.inputs['Roughness'].default_value = 0.8
    if base and base.image:
        im = base.image
        if im.name not in done:
            im.scale(px, px)
            p = os.path.join(tmp, re.sub(r'\W+', '_', m.name) + '.jpg')
            im.filepath_raw = p; im.file_format = 'JPEG'; im.save()
            done[im.name] = p
        base.image = bpy.data.images.load(done[im.name])
for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_image_format='JPEG', export_jpeg_quality=85,
                          export_skins=True, export_yup=True, export_apply=False)
print('wrote', out, os.path.getsize(out))

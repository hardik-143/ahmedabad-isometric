"""A Mixamo character (FBX, T-pose, with skin) -> a light GLB for the app (run headless with the bpy module):

    python tools/mixamo_char.py in.fbx out.glb [texture_px=1024]

- bones renamed from Mixamo's numbered prefix (mixamorig4:Hips) to mixamorig:Hips, so every Mixamo clip drives every
  character by bone name
- only the colour texture is kept, scaled down and saved as JPEG (the app lights people with plain Lambert materials)
- the T-pose action Mixamo bakes in is dropped; the app brings its own walk / run / idle
"""
import bpy, os, re, sys
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[-3:]
src, out = [a for a in args if a.endswith('.fbx')][0], [a for a in args if a.endswith('.glb')][0]
px = int(next((a for a in args if a.isdigit()), '1024'))
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

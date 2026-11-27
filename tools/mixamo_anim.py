"""A Mixamo animation (FBX, without skin) -> a GLB holding its skeleton and one clip (run headless with the bpy module):

    python tools/mixamo_anim.py in.fbx out.glb ClipName

Bones are renamed from Mixamo's numbered prefix to mixamorig:*, like tools/mixamo_char.py, so tools/retarget/mixamo.js can
carry the clip over to any Mixamo body.
"""
import bpy, re, sys
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[-3:]
src, out, name = args[0], args[1], args[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
old = {b.name: re.sub(r'^mixamorig\d*:', 'mixamorig:', b.name) for b in arm.data.bones}
for b in arm.data.bones: b.name = old[b.name]
act = arm.animation_data.action
for fc in act.fcurves:   # the curves still name the old bones
    m = re.match(r'pose\.bones\["(.+?)"\]', fc.data_path)
    if m and m.group(1) in old: fc.data_path = fc.data_path.replace(m.group(1), old[m.group(1)], 1)
act.name = name
for a in list(bpy.data.actions):
    if a != act: bpy.data.actions.remove(a)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True, export_yup=True, export_apply=False)
print('wrote', out)

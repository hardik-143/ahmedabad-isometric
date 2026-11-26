// Builds the walk-mode character assets from Quaternius CC0 packs:
//   man.glb / woman.glb  - Universal Base Characters [Standard], base-colour textures only, JPEG, downsized
//   anims.glb            - Universal Animation Library [Standard], only the clips walk mode uses, no mesh
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, resample } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';

// usage: node tools/build_chars.mjs <folder with the Quaternius files> <out folder, e.g. public/models>
// sources (CC0): Universal Base Characters [Standard] (Superhero_Male/Female_FullBody.gltf + textures) and
// Universal Animation Library [Standard] (UAL1_Standard.glb), from quaternius.com / itch.io
const SRC = process.argv[2] || '.cache/quaternius', OUT = process.argv[3] || 'public/models';
fs.mkdirSync(OUT, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function jpeg(tex, size) {
  const img = tex.getImage();
  const buf = await sharp(Buffer.from(img)).resize(size, size).flatten({ background: '#808080' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  tex.setImage(new Uint8Array(buf)).setMimeType('image/jpeg').setURI(tex.getURI().replace(/\.png$/i, '.jpg'));
}

for (const [src, out] of [['Superhero_Male_FullBody.gltf', 'man.glb'], ['Superhero_Female_FullBody.gltf', 'woman.glb']]) {
  const doc = await io.read(`${SRC}/${src}`), root = doc.getRoot();
  for (const m of root.listMaterials()) {          // base colour only: no normal / roughness maps on the web
    m.setNormalTexture(null); m.setMetallicRoughnessTexture(null); m.setOcclusionTexture(null);
    m.setMetallicFactor(0); m.setRoughnessFactor(0.85);
  }
  await doc.transform(prune());
  for (const t of root.listTextures()) {
    const n = (t.getURI() || t.getName() || '').toLowerCase(), img = t.getImage();
    if (!img || img.byteLength < 200) { t.dispose(); continue; }      // missing files in the mirror
    await jpeg(t, n.includes('eye') ? 128 : n.includes('hair') ? 512 : 1024);
  }
  for (const a of root.listAnimations()) a.dispose();
  await doc.transform(prune(), dedup());
  await io.write(`${OUT}/${out}`, doc);
  console.log(out, fs.statSync(`${OUT}/${out}`).size);
}

const KEEP = ['Idle_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land',
  'Driving_Loop', 'Sitting_Enter', 'Sitting_Idle_Loop', 'Sitting_Exit', 'Interact', 'Idle_Talking_Loop'];
{
  const doc = await io.read(`${SRC}/UAL1_Standard.glb`), root = doc.getRoot();
  for (const a of root.listAnimations()) if (!KEEP.includes(a.getName())) {
    for (const c of a.listChannels()) c.dispose();
    for (const sm of a.listSamplers()) sm.dispose();      // accessors may be shared with kept clips: prune drops the rest
    a.dispose();
  }
  for (const n of root.listNodes()) { n.setMesh(null); n.setSkin(null); }
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  await doc.transform(prune({ keepLeaves: true }), resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }));
  await io.write(`${OUT}/anims.glb`, doc);
  console.log('anims.glb', fs.statSync(`${OUT}/anims.glb`).size, root.listAnimations().map((a) => a.getName()).join(','));
}

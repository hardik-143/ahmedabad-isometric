// Builds the walk-mode people from Quaternius's Animated Men Pack and Animated Women Pack (CC0):
// keeps the everyday clips, drops combat ones, resamples keyframes, quantizes and meshopt-compresses.
// usage: node tools/build_people.mjs <folder with civilian_*.glb> <out folder, e.g. public/models/people>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { prune, dedup, resample, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import fs from 'node:fs';

const SRC = process.argv[2] || '.cache/quaternius-people', OUT = process.argv[3] || 'public/models/people';
fs.mkdirSync(OUT, { recursive: true });
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const KEEP = ['Idle', 'Walk', 'Run', 'Jump', 'RunningJump', 'Sitting', 'Standing', 'Clapping'];
const FILES = { man: 'civilian_man', suit: 'civilian_suit', longsleeve: 'civilian_longsleeve', casual: 'civilian_casual', woman: 'civilian_woman', woman2: 'civilian_woman2' };
for (const [out, src] of Object.entries(FILES)) {
  const doc = await io.read(`${SRC}/${src}.glb`), root = doc.getRoot();
  for (const a of root.listAnimations()) {
    const short = a.getName().split('|').pop().replace(/^(Man|Female)_/, '');
    if (!KEEP.includes(short)) { for (const c of a.listChannels()) c.dispose(); for (const s of a.listSamplers()) s.dispose(); a.dispose(); continue; }
    a.setName(short);
  }
  await doc.transform(prune({ keepLeaves: true }), resample({ tolerance: 1e-4 }), dedup(), quantize({ quantizeNormal: 10, quantizePosition: 14 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune({ keepLeaves: true }));
  await io.write(`${OUT}/${out}.glb`, doc);
  console.log(out, fs.statSync(`${OUT}/${out}.glb`).size, root.listAnimations().map((a) => a.getName()).join(','));
}

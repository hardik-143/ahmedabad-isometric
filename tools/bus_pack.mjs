// weld + quantize + meshopt the Blender bus (the app's GLTFLoader gets the meshopt decoder)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, quantize, meshopt, prune, dedup } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const [src, dst] = process.argv.slice(2);
const doc = await io.read(src);
await doc.transform(dedup(), weld(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(dst, doc);
console.log('ok');

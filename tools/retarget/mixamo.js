// Retargets the three.js Soldier's Mixamo clips (Walk, Run, Idle) onto a Mixamo body made by tools/mixamo_char.py.
// Both rigs are Mixamo T-poses, but their bones' local axes (and which way they face) differ, so each bone's motion is
// carried over as a world-space turn from its rest pose: Wt(t) = A Ws(t) Ws0^-1 A^-1 Wt0, then made local again; the
// hips' movement is turned and scaled by hip height. Run in a page that has three.js on its import map (run.py):
//   const { retargetMixamo } = await import('/tools/retarget/mixamo.js');
//   JSON.stringify(await retargetMixamo('Soldier.glb', '/models/people/ch12.glb'))
// The Soldier: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
// The result goes into public/models/people/mixamo_anims.json under the body's name.
export async function retargetMixamo(sourceUrl, targetUrl) {
  const THREE = await import('three'); const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const L = new GLTFLoader();
  const [S, T] = await Promise.all([L.loadAsync(sourceUrl), L.loadAsync(targetUrl)]);
  const ss = S.scene, ts = T.scene; ss.updateMatrixWorld(true); ts.updateMatrixWorld(true);
  const bonesOf = (sc) => { const m = new Map(); sc.traverse((o) => { if (o.isBone) m.set(o.name, o); }); return m; };
  const SB = bonesOf(ss), TB = bonesOf(ts);
  const names = [...TB.keys()].filter((n) => SB.has(n));
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  const Ws0 = new Map(names.map((n) => [n, wq(SB.get(n))])), Wt0 = new Map(names.map((n) => [n, wq(TB.get(n))]));
  // which way each faces: the Soldier faces -z, the body +z: turn the Soldier's motion half round
  const A = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), Ai = A.clone().invert();
  const sh = SB.get('mixamorigHips'), th = TB.get('mixamorigHips');
  const sh0 = sh.getWorldPosition(new THREE.Vector3()), th0 = th.getWorldPosition(new THREE.Vector3()), k = th0.y / sh0.y;
  // target bones in hierarchy order (parents first)
  const order = []; ts.traverse((o) => { if (o.isBone && names.includes(o.name)) order.push(o); });
  const mixer = new THREE.AnimationMixer(ss), out = {};
  for (const clip of S.animations) {
    if (!/^(Walk|Run|Idle)$/.test(clip.name)) continue;
    mixer.stopAllAction(); const act = mixer.clipAction(clip); act.reset().play();
    const N = Math.max(2, Math.round(clip.duration * 30)), times = [], Q = new Map(order.map((b) => [b.name, []])), HP = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * clip.duration; times.push(+t.toFixed(4));
      mixer.setTime(t); ss.updateMatrixWorld(true);
      const W = new Map();
      for (const b of order) {
        const n = b.name, Ws = wq(SB.get(n));
        const D = A.clone().multiply(Ws).multiply(Ws0.get(n).clone().invert()).multiply(Ai);   // the source's turn from its rest, in the body's frame
        const Wt = D.multiply(Wt0.get(n));
        W.set(n, Wt);
        const pw = b.parent && W.has(b.parent.name) ? W.get(b.parent.name) : wq(b.parent);
        const loc = pw.clone().invert().multiply(Wt);
        Q.get(n).push(+loc.x.toFixed(5), +loc.y.toFixed(5), +loc.z.toFixed(5), +loc.w.toFixed(5));
      }
      // hips: the Soldier's movement from its rest position, turned and scaled to the body, in the hips' parent space
      const hp = sh.getWorldPosition(new THREE.Vector3()).sub(sh0).applyQuaternion(A).multiplyScalar(k).add(th0);
      th.parent.worldToLocal(hp); HP.push(+hp.x.toFixed(5), +hp.y.toFixed(5), +hp.z.toFixed(5));
    }
    const tracks = order.map((b) => ({ name: b.name + '.quaternion', type: 'quaternion', times, values: Q.get(b.name) }));
    tracks.push({ name: 'mixamorigHips.position', type: 'vector', times, values: HP });
    out[clip.name] = { name: clip.name, duration: clip.duration, tracks, uuid: THREE.MathUtils.generateUUID(), blendMode: 2500 };
  }
  return out;
}

// Retargets the three.js Soldier's Mixamo clips (Walk, Run, Idle) onto a Mixamo body made by tools/mixamo_char.py.
// Both rigs are Mixamo T-poses, but their bones' local axes (and which way they face) differ, so each bone's motion is
// carried over as a world-space turn from its rest pose: Wt(t) = A Ws(t) Ws0^-1 A^-1 Wt0, then made local again; the
// hips' movement is turned and scaled by hip height. Run in a page that has three.js on its import map (run.py):
//   const { retargetMixamo } = await import('/tools/retarget/mixamo.js');
//   JSON.stringify(await retargetMixamo('Soldier.glb', '/models/people/ch12.glb'))
// The Soldier: https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
// The result goes into public/models/people/mixamo_anims.json under the body's name.
export async function retargetMixamo(sourceUrl, targetUrl, { turn = Math.PI, clips = /^(Walk|Run|Idle)$/, rename = {}, fps = 30 } = {}) {
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
  const A = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn), Ai = A.clone().invert();   // the Soldier faces -z (turn PI); clips from tools/mixamo_anim.py face +z (turn 0)
  const sh = SB.get('mixamorigHips'), th = TB.get('mixamorigHips');
  const sh0 = sh.getWorldPosition(new THREE.Vector3()), th0 = th.getWorldPosition(new THREE.Vector3()), k = th0.y / sh0.y;
  // target bones in hierarchy order (parents first)
  const order = []; ts.traverse((o) => { if (o.isBone && names.includes(o.name)) order.push(o); });
  const mixer = new THREE.AnimationMixer(ss), out = {};
  for (const clip of S.animations) {
    if (!clips.test(clip.name)) continue;
    mixer.stopAllAction(); const act = mixer.clipAction(clip); act.reset().play();
    const N = Math.max(2, Math.round(clip.duration * fps)), times = [], Q = new Map(order.map((b) => [b.name, []])), HP = [];
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
        Q.get(n).push(+loc.x.toFixed(4), +loc.y.toFixed(4), +loc.z.toFixed(4), +loc.w.toFixed(4));
      }
      // hips: the Soldier's movement from its rest position, turned and scaled to the body, in the hips' parent space
      const hp = sh.getWorldPosition(new THREE.Vector3()).sub(sh0).applyQuaternion(A).multiplyScalar(k).add(th0);
      th.parent.worldToLocal(hp); HP.push(+hp.x.toFixed(4), +hp.y.toFixed(4), +hp.z.toFixed(4));
    }
    const tracks = order.map((b) => ({ name: b.name + '.quaternion', type: 'quaternion', times, values: Q.get(b.name) }));
    tracks.push({ name: 'mixamorigHips.position', type: 'vector', times, values: HP });
    const nm = rename[clip.name] || clip.name;
    out[nm] = { name: nm, duration: clip.duration, tracks, uuid: THREE.MathUtils.generateUUID(), blendMode: 2500 };
  }
  return out;
}

// Clips from a rig with other bone names and another rest pose (the Quaternius people stand with their arms down, not in
// a T-pose) onto a Mixamo body. map: body bone -> source bone. Each mapped bone takes the source bone's world turn from
// its rest after its own rest direction (towards its first mapped child) has been swung onto the source's:
// Wt(t) = A Ws(t) Ws0^-1 A^-1 C Wt0, C the shortest turn from the body's rest direction to the source's. Bones with no
// counterpart (Spine1, fingers, toes) keep their rest pose under their parent.
//   retargetMapped('/models/people/man.glb', '/models/people/ch12.glb', { map: QUATERNIUS_TO_MIXAMO, clips: /^(Jump|RunningJump)$/ })
export const QUATERNIUS_TO_MIXAMO = { mixamorigHips: 'Hips', mixamorigSpine: 'Abdomen', mixamorigSpine2: 'Torso', mixamorigNeck: 'Neck', mixamorigHead: 'Head' };
for (const [s, S] of [['L', 'Left'], ['R', 'Right']]) Object.assign(QUATERNIUS_TO_MIXAMO, { [`mixamorig${S}Shoulder`]: 'Shoulder' + s, [`mixamorig${S}Arm`]: 'UpperArm' + s,
  [`mixamorig${S}ForeArm`]: 'LowerArm' + s, [`mixamorig${S}Hand`]: 'Palm' + s, [`mixamorig${S}UpLeg`]: 'UpperLeg' + s, [`mixamorig${S}Leg`]: 'LowerLeg' + s, [`mixamorig${S}Foot`]: 'Foot' + s });
export async function retargetMapped(sourceUrl, targetUrl, { map = QUATERNIUS_TO_MIXAMO, turn = 0, clips = /.*/, rename = {}, fps = 30 } = {}) {
  const THREE = await import('three'); const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  const L = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [S, T] = await Promise.all([L.loadAsync(sourceUrl), L.loadAsync(targetUrl)]);
  const ss = S.scene, ts = T.scene; ss.updateMatrixWorld(true); ts.updateMatrixWorld(true);
  const bonesOf = (sc) => { const m = new Map(); sc.traverse((o) => { if (o.isBone) m.set(o.name, o); }); return m; };
  const SB = bonesOf(ss), TB = bonesOf(ts);
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion()), wp = (o) => o.getWorldPosition(new THREE.Vector3());
  const A = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn), Ai = A.clone().invert();
  const M = new Map(Object.entries(map).filter(([t, s]) => TB.has(t) && SB.has(s)));
  const Ws0 = new Map(), Wt0 = new Map(), C = new Map();
  for (const [t, s] of M) {
    Ws0.set(t, wq(SB.get(s))); Wt0.set(t, wq(TB.get(t)));
    let tc = null; const q = [...TB.get(t).children];                       // the first mapped bone below, breadth first
    while (q.length && !tc) { const o = q.shift(); if (o.isBone && M.has(o.name)) tc = o; else q.push(...o.children); }
    const c = new THREE.Quaternion();
    if (tc) {
      const dt = wp(tc).sub(wp(TB.get(t))).normalize(), ds = wp(SB.get(M.get(tc.name))).sub(wp(SB.get(s))).applyQuaternion(A).normalize();
      c.setFromUnitVectors(dt, ds);
    }
    C.set(t, c);
  }
  const order = []; ts.traverse((o) => { if (o.isBone) order.push(o); });   // parents first
  const restLocal = new Map(order.map((b) => [b.name, b.quaternion.clone()]));
  const sh = SB.get(M.get('mixamorigHips')), th = TB.get('mixamorigHips');
  const sh0 = wp(sh), th0 = wp(th), k = th0.y / sh0.y;
  const mixer = new THREE.AnimationMixer(ss), out = {};
  for (const clip of S.animations) {
    if (!clips.test(clip.name)) continue;
    mixer.stopAllAction(); mixer.clipAction(clip).reset().play();
    const N = Math.max(2, Math.round(clip.duration * fps)), times = [], Q = new Map([...M.keys()].map((n) => [n, []])), HP = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * clip.duration; times.push(+t.toFixed(4));
      mixer.setTime(t); ss.updateMatrixWorld(true);
      const W = new Map();
      for (const b of order) {
        const n = b.name, pw = b.parent && W.has(b.parent.name) ? W.get(b.parent.name) : wq(b.parent);
        if (!M.has(n)) { W.set(n, pw.clone().multiply(restLocal.get(n))); continue; }
        const Wt = A.clone().multiply(wq(SB.get(M.get(n)))).multiply(Ws0.get(n).clone().invert()).multiply(Ai).multiply(C.get(n)).multiply(Wt0.get(n));
        W.set(n, Wt);
        const loc = pw.clone().invert().multiply(Wt);
        Q.get(n).push(+loc.x.toFixed(4), +loc.y.toFixed(4), +loc.z.toFixed(4), +loc.w.toFixed(4));
      }
      const hp = wp(sh).sub(sh0).applyQuaternion(A).multiplyScalar(k).add(th0);
      th.parent.worldToLocal(hp); HP.push(+hp.x.toFixed(4), +hp.y.toFixed(4), +hp.z.toFixed(4));
    }
    const tracks = [...M.keys()].map((n) => ({ name: n + '.quaternion', type: 'quaternion', times, values: Q.get(n) }));
    tracks.push({ name: 'mixamorigHips.position', type: 'vector', times, values: HP });
    const nm = rename[clip.name] || clip.name;
    out[nm] = { name: nm, duration: clip.duration, tracks, uuid: THREE.MathUtils.generateUUID(), blendMode: 2500 };
  }
  return out;
}

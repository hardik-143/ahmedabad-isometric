import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const L = new GLTFLoader(); L.setMeshoptDecoder(MeshoptDecoder);
window.load = (u) => new Promise((res, rej) => L.load(u, res, undefined, rej));
window.THREE = THREE;
window.dump = async (u) => {
  const g = await load(u); const out = [];
  g.scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  g.scene.traverse((o) => { if (o.isBone) { o.getWorldPosition(v); out.push(`${o.name}<${o.parent && o.parent.name} @${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`); } });
  return { clips: g.animations.map((a) => a.name + ':' + a.duration.toFixed(2)), bones: out };
};
window.ready = true;

// ---- retarget the Soldier's mocap (Mixamo rig, faces -z, T-pose) onto a Quaternius body (faces +z, arms down)
const MAP = {   // target <- source
  Body: 'mixamorigHips', Abdomen: 'mixamorigSpine', Torso: 'mixamorigSpine2', Neck: 'mixamorigNeck', Head: 'mixamorigHead',
  ShoulderL: 'mixamorigLeftShoulder', UpperArmL: 'mixamorigLeftArm', LowerArmL: 'mixamorigLeftForeArm', PalmL: 'mixamorigLeftHand',
  ShoulderR: 'mixamorigRightShoulder', UpperArmR: 'mixamorigRightArm', LowerArmR: 'mixamorigRightForeArm', PalmR: 'mixamorigRightHand',
  UpperLegL: 'mixamorigLeftUpLeg', LowerLegL: 'mixamorigLeftLeg', FootL: 'mixamorigLeftFoot',
  UpperLegR: 'mixamorigRightUpLeg', LowerLegR: 'mixamorigRightLeg', FootR: 'mixamorigRightFoot',
};
const DIR = {   // bone -> the child that gives its direction (target / source); none: spine-like, aligned as is
  ShoulderL: ['UpperArmL', 'mixamorigLeftArm'], UpperArmL: ['LowerArmL', 'mixamorigLeftForeArm'], LowerArmL: ['PalmL', 'mixamorigLeftHand'], PalmL: ['MiddleHandL', 'mixamorigLeftHandMiddle1'],
  ShoulderR: ['UpperArmR', 'mixamorigRightArm'], UpperArmR: ['LowerArmR', 'mixamorigRightForeArm'], LowerArmR: ['PalmR', 'mixamorigRightHand'], PalmR: ['MiddleHandR', 'mixamorigRightHandMiddle1'],
  UpperLegL: ['LowerLegL', 'mixamorigLeftLeg'], LowerLegL: ['LowerLegL_end', 'mixamorigLeftFoot'], FootL: ['FootL_end', 'mixamorigLeftToeBase'],
  UpperLegR: ['LowerLegR', 'mixamorigRightLeg'], LowerLegR: ['LowerLegR_end', 'mixamorigRightFoot'], FootR: ['FootR_end', 'mixamorigRightToeBase'],
  Body: ['Abdomen', 'mixamorigSpine'], Abdomen: ['Torso', 'mixamorigSpine2'], Torso: ['Neck', 'mixamorigNeck'], Neck: ['Head', 'mixamorigHead'], Head: ['Head_end', 'mixamorigHeadTop_End'],
};
const Q = () => new THREE.Quaternion(), V = () => new THREE.Vector3();
const R180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
function bones(root) { const m = {}; root.traverse((o) => { if (o.isBone || o.type === 'Bone' || o.name) m[o.name] = o; }); return m; }
const wq = (o) => o.getWorldQuaternion(Q()), wp = (o) => o.getWorldPosition(V());
function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }
window.retarget = async (modelUrl, srcGltf) => {
  const S = srcGltf || (window.SRC = window.SRC || await load('Soldier.glb'));
  const T = await load(modelUrl);
  const sRoot = S.scene, tRoot = T.scene; sRoot.updateMatrixWorld(true); tRoot.updateMatrixWorld(true);
  const sb = bones(sRoot), tb = bones(tRoot);
  // rest (bind) poses as loaded: world rotations, the source turned to face +z like the target
  const rest = {};
  for (const [t, s] of Object.entries(MAP)) {
    const qs = R180.clone().multiply(wq(sb[s])), qt = wq(tb[t]);
    let A = Q();
    if (DIR[t]) {
      const dt = wp(tb[DIR[t][0]]).sub(wp(tb[t])).normalize();
      const ds = wp(sb[DIR[t][1]]).sub(wp(sb[s])).applyQuaternion(R180).normalize();
      A.setFromUnitVectors(dt, ds);
    }
    rest[t] = { qsInv: qs.invert(), AQt: A.multiply(qt) };
  }
  const hipS0 = wp(sb.mixamorigHips).applyQuaternion(R180), bodyT0 = wp(tb.Body);
  const legS = wp(sb.mixamorigLeftUpLeg).y - wp(sb.mixamorigLeftFoot).y, legT = wp(tb.UpperLegL).y - wp(tb.FootL).y, k = legT / legS;
  const footOff = { L: wp(tb.FootL).sub(wp(tb.LowerLegL_end)), R: wp(tb.FootR).sub(wp(tb.LowerLegR_end)) };
  const restLocal = {}; tRoot.traverse((o) => { if (o.isBone) restLocal[o.name] = { q: o.quaternion.clone(), p: o.position.clone() }; });
  const order = Object.keys(MAP).sort((a, b) => depth(tb[a]) - depth(tb[b]));
  const allBones = []; tRoot.traverse((o) => { if (o.isBone) allBones.push(o); });
  const mixer = new THREE.AnimationMixer(sRoot), out = {};
  for (const name of ['Walk', 'Run', 'Idle']) {
    const clip = S.animations.find((a) => a.name === name); mixer.stopAllAction(); const act = mixer.clipAction(clip); act.reset().play();
    const fps = 30, n = Math.max(2, Math.round(clip.duration * fps) + 1), times = [];
    const qv = {}, pv = {}; for (const b of allBones) qv[b.name] = [];
    pv.Body = []; pv.FootL = []; pv.FootR = [];
    // hips path: drift removed (in-place), sway and bob kept
    const hp = []; for (let f = 0; f < n; f++) { mixer.setTime(Math.min(clip.duration, f / fps)); sRoot.updateMatrixWorld(true); hp.push(wp(sb.mixamorigHips).applyQuaternion(R180)); }
    const drift = hp[n - 1].clone().sub(hp[0]).divideScalar(n - 1);
    const footTrack = { L: [], R: [] };
    for (let f = 0; f < n; f++) {
      const t = Math.min(clip.duration, f / fps); times.push(f / fps);
      mixer.setTime(t); sRoot.updateMatrixWorld(true);
      for (const b of allBones) { b.quaternion.copy(restLocal[b.name].q); b.position.copy(restLocal[b.name].p); }
      tRoot.updateMatrixWorld(true);
      for (const tn of order) {
        const bt = tb[tn], r = rest[tn];
        const qsNow = R180.clone().multiply(wq(sb[MAP[tn]]));
        const want = qsNow.multiply(r.qsInv).multiply(r.AQt);                     // world rotation wanted
        bt.quaternion.copy(bt.parent.getWorldQuaternion(Q()).invert().multiply(want));
        if (tn === 'Body') {
          const h = hp[f].clone().sub(drift.clone().multiplyScalar(f)).sub(hipS0).multiplyScalar(k);
          h.y = (hp[f].y - hipS0.y) * k;
          bt.position.copy(bt.parent.worldToLocal(bodyT0.clone().add(h)));
        }
        bt.updateMatrixWorld(true);
        if (tn === 'LowerLegL' || tn === 'LowerLegR') {   // the foot bone hangs off the root: put it at the ankle
          const sd = tn.endsWith('L') ? 'L' : 'R', fb = tb['Foot' + sd], ank = wp(tb[`LowerLeg${sd}_end`]).add(footOff[sd]);
          fb.position.copy(fb.parent.worldToLocal(ank)); fb.updateMatrixWorld(true);
        }
      }
      for (const b of allBones) qv[b.name].push(...b.quaternion.toArray().map((x) => +x.toFixed(4)));
      for (const nm of ['Body', 'FootL', 'FootR']) pv[nm].push(...tb[nm].position.toArray().map((x) => +x.toFixed(4)));
      for (const sd of ['L', 'R']) footTrack[sd].push(wp(tb['Foot' + sd]));
    }
    // ground speed: how fast a planted foot slides back (model units / s), from the lowest third of its path
    let sp = [];
    for (const sd of ['L', 'R']) { const P = footTrack[sd], ys = P.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys);
      for (let f = 1; f < n; f++) if (P[f].y < lo + (hi - lo) * 0.12 && P[f - 1].y < lo + (hi - lo) * 0.12) sp.push(Math.hypot(P[f].x - P[f - 1].x, P[f].z - P[f - 1].z) * fps); }
    sp.sort((a, b) => a - b);
    const tracks = [];
    for (const b of allBones) {
      const v = qv[b.name]; let still = true; for (let f = 1; f < n && still; f++) for (let c = 0; c < 4; c++) if (Math.abs(v[f * 4 + c] - v[c]) > 1e-3) { still = false; break; }
      tracks.push(new THREE.QuaternionKeyframeTrack(b.name + '.quaternion', still ? [0] : times, still ? v.slice(0, 4) : v));
    }
    for (const nm of ['Body', 'FootL', 'FootR']) tracks.push(new THREE.VectorKeyframeTrack(nm + '.position', times, pv[nm]));
    out[name] = { clip: THREE.AnimationClip.toJSON(new THREE.AnimationClip(name, (n - 1) / fps, tracks)), speed: sp.length ? +sp[Math.floor(sp.length / 2)].toFixed(3) : 0 };
  }
  return out;
};

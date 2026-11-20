// Ahmedabad · Isometric City — real footprints, real roads, rendered as a GTA-style isometric map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import earcut from 'https://cdn.jsdelivr.net/npm/earcut@3.0.1/src/earcut.js';

const $ = (id) => document.getElementById(id);
const errBox = $('err');
function showErr(m) { errBox.style.display = 'block'; errBox.textContent = m; }
window.addEventListener('error', (e) => showErr('Error: ' + (e.message || e)));
window.addEventListener('unhandledrejection', (e) => showErr('Error: ' + (e.reason && e.reason.message || e.reason)));

const TIPS = [
  'Every building footprint and height comes from <b>VEDAS / ISRO-SAC</b> survey data — about 137,000 of them.',
  'Press <b>Q</b> / <b>E</b> to swing the city round 90°, or <b>right-drag</b> to rotate freely.',
  'Try <b>Night</b> — 1.3 million lit windows and sodium street-lamps along every major road.',
  'Search <b>Ashram Road</b>, <b>Kankaria</b> or <b>SG Highway</b> to fly straight there.',
  'Zoom in on the walled city: water tanks on the rooftops, trees in the courtyards.',
];
$('ltip').innerHTML = 'TIP: ' + TIPS[Math.floor(Math.random() * TIPS.length)];

// ---------------------------------------------------------------- helpers
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function hash1(i) { let x = (i | 0) * 2654435761; x ^= x >>> 15; x = Math.imul(x, 2246822519); x ^= x >>> 13; return ((x >>> 0) % 10000) / 10000; }
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function hexLin8(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(srgbToLin(c) * 255));
}

class Reader {
  constructor(buf, off = 0) { this.buf = buf; this.p = off; this.dv = new DataView(buf); }
  align(n) { this.p = Math.ceil(this.p / n) * n; }
  u32() { this.align(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  arr(T, n) { this.align(T.BYTES_PER_ELEMENT); const a = new T(this.buf, this.p, n); this.p += n * T.BYTES_PER_ELEMENT; return a; }
}

async function fetchBin(name, total, onProgress) {
  const v = META && META.build ? `?v=${META.build}` : '';
  let res = await fetch(`data/${name}.bin${v}`), b64 = false;
  if (!res.ok) { res = await fetch(`data/${name}.txt${v}`); b64 = true; }
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader(); const parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onProgress && onProgress(Math.min(1, got / total));
    }
    bytes = new Uint8Array(got); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  } else bytes = new Uint8Array(await res.arrayBuffer());
  if (b64) bytes = b64decode(bytes);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(ds).arrayBuffer();
  }
  return bytes.buffer;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const B64 = new Uint8Array(256).fill(255);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => (B64[c.charCodeAt(0)] = i));
function b64decode(src) {
  // src: ASCII bytes of a base64 string (whitespace tolerated)
  const out = new Uint8Array(Math.floor(src.length * 3 / 4)); let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < src.length; i++) {
    const v = B64[src[i]]; if (v === 255) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------- renderer
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
let basePR = Math.min(window.devicePixelRatio || 1, 1.6);
renderer.setPixelRatio(basePR);
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#c9d8e6');
const EL = Math.PI / 6;                       // 2:1 isometric camera (30° elevation)
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 100, 160000);
const view = { tx: 0, tz: 0, mpp: 1.6, az: Math.PI / 4 };
let dirty = true, lastInteract = performance.now();

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0xb59a74, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.castShadow = true;
const SHADOW_SIZE = Math.min(4096, renderer.capabilities.maxTextureSize);
sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
sun.shadow.bias = -0.00025;
scene.add(sun); scene.add(sun.target);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.5, 0.78);
composer.addPass(bloom);
composer.addPass(new OutputPass());
composer.setPixelRatio(basePR);
composer.setSize(innerWidth, innerHeight);

// shared uniforms
const U = {
  uTime: { value: 0 }, uNight: { value: 0 }, uDay: { value: 1 },
  uSunCol: { value: new THREE.Color(1, 1, 1) }, uHover: { value: -1 },
};

// ---------------------------------------------------------------- shaders
const NOISE = `
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+17.1; a*=.5;} return s; }
uniform float uTime; uniform float uNight; uniform float uDay; uniform vec3 uSunCol; uniform float uHover;
`;

let hookId = 0;
function hook(mat, { vHead = '', vBody = '', fHead = '', fColor = '', fEmissive = '', flatGround = false, uniforms = {} }) {
  const key = 'h' + (hookId++);
  mat.extensions = { derivatives: true };
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + vHead)
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\n' + vBody);
    if (flatGround) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;');
      sh.vertexShader = sh.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0,1.0,0.0);')
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, 0.0, position.y);');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + NOISE + fHead)
      .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 xEm = vec3(0.0);\n' + fColor)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + fEmissive + '\ntotalEmissiveRadiance += xEm;');
  };
  return mat;
}

// --- buildings
const bldMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'attribute vec2 aInfo; varying vec2 vInfo; varying vec3 vWN;',
  vBody: 'vInfo = aInfo; vWN = normal;',
  fHead: 'varying vec2 vInfo; varying vec3 vWN;',
  fColor: `
  float ws = vInfo.x; float fl = vInfo.y;
  vec3 wn = normalize(vWN);
  float isWall = 1.0 - step(0.6, abs(wn.y));
  float topH = fl*3.1 + 0.5;
  // contact darkening at the base of walls, parapet band at the top
  diffuseColor.rgb *= mix(1.0, mix(0.70, 1.0, smoothstep(0.0, 4.5, vWPos.y)), isWall);
  diffuseColor.rgb *= mix(1.0, 1.0 - 0.10*step(topH-0.55, vWPos.y), isWall);
  // roof grain
  diffuseColor.rgb *= mix(1.0, 0.94 + 0.10*vnoise(mod(vWPos.xz*0.9, 1024.0)), 1.0-isWall);
  if (isWall > 0.5 && ws > 0.5) {
    vec2 t = normalize(vec2(-wn.z, wn.x));
    float u = dot(vWPos.xz, t);
    bool glassT = ws > 1.5 && ws < 2.5;
    float cw = glassT ? 1.55 : (ws > 2.5 ? 2.6 : 3.1);
    float fu = u / cw; float col = floor(fu); float xu = fract(fu);
    float fy = vWPos.y / 3.1; float row = floor(fy); float yv = fract(fy);
    float px = fwidth(u);
    float aa = clamp(px / cw, 0.002, 0.2);
    float wx, wy;
    if (glassT) { wx = smoothstep(0.05, 0.05+aa, xu)*(1.0-smoothstep(0.95-aa, 0.95, xu)); wy = smoothstep(0.10, 0.10+aa*1.5, yv)*(1.0-smoothstep(0.90-aa*1.5, 0.90, yv)); }
    else { wx = smoothstep(0.24, 0.24+aa, xu)*(1.0-smoothstep(0.76-aa, 0.76, xu)); wy = smoothstep(0.30, 0.30+aa*1.5, yv)*(1.0-smoothstep(0.80-aa*1.5, 0.80, yv)); }
    float wallId = floor(dot(vWPos.xz, wn.xz)*0.5 + 0.5);
    float rnd = h21(vec2(col*1.37 + wallId*7.13, row*2.11 + fl*3.7));
    if (ws > 2.5) wx *= step(0.45, h21(vec2(col, wallId)));
    float inFacade = step(0.6, vWPos.y) * (1.0 - step(topH - 0.8, vWPos.y));
    float win = wx * wy * inFacade;
    float detail = 1.0 - smoothstep(0.3, 0.85, px);
    vec3 glass = glassT ? vec3(0.30, 0.42, 0.52) + 0.08*h21(vec2(col,row)) : vec3(0.22, 0.25, 0.29) + 0.07*h21(vec2(col,row));
    glass = pow(glass, vec3(2.2));
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85 * detail);
    // night: lit windows (exact when close, averaged glow when far)
    float on = step(rnd, 0.40);
    float exact = win * on;
    float avgG = 0.40 * (glassT ? 0.6 : 0.2) * inFacade * (0.55 + 0.5*h21(vec2(floor(vWPos.y/3.1), wallId)));
    float g = mix(avgG, exact, detail);
    vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.92, 1.0), step(0.82, h21(vec2(rnd, col))));
    xEm = g * warm * 1.55 * uNight;
  }`,
});

// --- ground layers (vec2 positions)
function groundMat(fColor, fEmissive = '', extra = {}) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.depthWrite = false; m.depthTest = false; m.side = THREE.DoubleSide;
  return hook(m, { flatGround: true, fColor, fEmissive, ...extra });
}
const LAND = groundMat(`
  vec2 p = vWPos.xz;
  float n1 = fbm(mod(p*0.0011, 512.0)); float n2 = vnoise(mod(p*0.06, 1024.0)); float n3 = fbm(mod(p*0.008, 512.0));
  vec3 c = mix(vec3(0.71,0.63,0.50), vec3(0.79,0.71,0.57), n1);
  c = mix(c, vec3(0.60,0.60,0.42), smoothstep(0.55, 0.8, n3)*0.35);
  c *= 0.94 + 0.10*n2;
  float d = length(p);
  c = mix(c, vec3(0.66,0.62,0.53), smoothstep(17000.0, 34000.0, d));
  diffuseColor.rgb = pow(c, vec3(2.2));`);
const PARK = groundMat(`
  vec2 p = vWPos.xz;
  vec3 c = mix(vec3(0.30,0.45,0.16), vec3(0.42,0.55,0.20), fbm(mod(p*0.02, 512.0)));
  c *= 0.88 + 0.18*vnoise(mod(p*0.7, 1024.0));
  diffuseColor.rgb = pow(c, vec3(2.2));`);
const WATER = groundMat(`
  vec2 p = vWPos.xz;
  float n = fbm(mod(p*0.004 + vec2(uTime*0.004, uTime*0.002), 512.0));
  vec3 c = mix(vec3(0.13,0.38,0.50), vec3(0.22,0.52,0.60), n);
  float r = vnoise(mod(p*0.33 + vec2(uTime*0.55, uTime*0.31), 1024.0)) * vnoise(mod(p*0.47 - vec2(uTime*0.4, -uTime*0.2), 1024.0));
  c += 0.06*r;
  diffuseColor.rgb = pow(c, vec3(2.2));
  float wdet = 1.0 - smoothstep(0.5, 2.5, length(fwidth(p)));
  xEm = (pow(r, 7.0) * 1.0 * uSunCol * uDay + vec3(0.9,0.55,0.25)*pow(r,4.0)*0.14*uNight) * wdet + vec3(0.025,0.05,0.065)*uDay;`);
const FIELD = groundMat(`
  vec2 p = vWPos.xz;
  float st = step(0.5, fract((p.x + p.y) / 10.0));
  vec3 c = mix(vec3(0.33,0.56,0.20), vec3(0.40,0.64,0.25), st);
  c *= 0.95 + 0.08*vnoise(mod(p*0.8, 1024.0));
  diffuseColor.rgb = pow(c, vec3(2.2));`);
const PITCH = groundMat(`
  vec3 c = vec3(0.80,0.69,0.50) * (0.94 + 0.1*vnoise(mod(vWPos.xz*2.0, 1024.0)));
  diffuseColor.rgb = pow(c, vec3(2.2));`);
const RAIL = new THREE.MeshLambertMaterial({ color: 0xffffff });
RAIL.depthWrite = false; RAIL.depthTest = false; RAIL.side = THREE.DoubleSide;
hook(RAIL, {
  flatGround: true,
  vHead: 'attribute vec2 aR; varying vec2 vR;', vBody: 'vR = aR;', fHead: 'varying vec2 vR;',
  fColor: `
  float a = abs(vR.x); float s = vR.y;
  vec3 c = vec3(0.47,0.43,0.38) * (0.9 + 0.2*vnoise(mod(vWPos.xz*2.0, 1024.0)));
  float px = fwidth(s); float det = 1.0 - smoothstep(0.08, 0.25, px);
  float sl = step(fract(s/0.65), 0.35) * step(a, 1.25);
  c = mix(c, vec3(0.33,0.26,0.20), sl*det);
  float rail = (1.0 - smoothstep(0.06, 0.12, abs(a-0.72)));
  c = mix(c, vec3(0.72,0.73,0.75), rail*max(det, 0.5));
  c *= mix(1.0, 0.8, smoothstep(1.7, 2.2, a));
  diffuseColor.rgb = pow(c, vec3(2.2));`,
});

// --- roads (two passes over the same ribbons: kerb/sidewalk, then asphalt + markings)
const ASPH = ['#a2978a', '#8a8a89', '#848586', '#78797b', '#76777a', '#6f7174', '#696b6f', '#8c4a3f', '#646669', '#5f6165']
  .map((h) => new THREE.Color(h));
function roadMat(pass) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.depthWrite = false; m.depthTest = false; m.side = THREE.DoubleSide;
  return hook(m, {
    flatGround: true,
    vHead: 'attribute vec4 aR; varying vec4 vR;', vBody: 'vR = aR;',
    fHead: `varying vec4 vR; uniform vec3 uAsph[10];`,
    uniforms: { uAsph: { value: ASPH } },
    fColor: pass === 0 ? `
      float a = abs(vR.x); float hw = vR.z; float cls = mod(vR.w, 16.0); float br = step(15.5, vR.w);
      vec3 c = vec3(0.80,0.77,0.71) * (0.92 + 0.12*vnoise(mod(vWPos.xz*1.3, 1024.0)));
      c = mix(c, vec3(0.92,0.90,0.86), (1.0 - smoothstep(0.18, 0.32, a-hw)) * step(hw, a));
      c = mix(c, vec3(0.70,0.69,0.67), br*0.6);
      c = mix(c, vec3(0.95,0.94,0.91), smoothstep(2.0, 9.0, length(fwidth(vWPos.xz))) * 0.8);
      diffuseColor.rgb = pow(c, vec3(2.2));` : `
      float a = abs(vR.x); float s = vR.y; float hw = vR.z; float cls = mod(vR.w, 16.0); float br = step(15.5, vR.w);
      if (a > hw) discard;
      int ci = int(cls + 0.5);
      vec3 c = pow(uAsph[ci], vec3(1.0/2.2));
      c *= 0.92 + 0.12*vnoise(mod(vWPos.xz*0.9, 1024.0)) + 0.04*vnoise(mod(vWPos.xz*7.0, 1024.0));
      float px = fwidth(s);
      float pxa = length(fwidth(vWPos.xz));
      c = mix(c, vec3(0.93,0.92,0.89), smoothstep(2.0, 9.0, pxa) * 0.85);
      float det = (1.0 - smoothstep(0.18, 0.55, px)) * step(0.0, s);
      if (det > 0.0) {
        float aw = fwidth(a) + 0.02;
        bool twoWayMajor = cls > 5.5 && cls < 9.5 && cls != 7.0 && hw > 5.8;
        // centre: dashed line, or landscaped median on big two-way roads
        if (twoWayMajor) {
          float med = 1.0 - smoothstep(0.85, 0.85+aw, a);
          c = mix(c, vec3(0.78,0.76,0.70), med*det);
          c = mix(c, vec3(0.30,0.45,0.18), (1.0 - smoothstep(0.55, 0.55+aw, a))*det*step(7.5, cls));
          float lane = (1.0 - smoothstep(0.07, 0.07+aw, abs(a - (hw+0.85)*0.5))) * step(fract(s/9.0), 0.45);
          c = mix(c, vec3(0.93), lane*det*0.9);
        } else if (cls > 2.5 && cls != 4.0) {
          float cl = (1.0 - smoothstep(0.08, 0.08+aw, a)) * step(fract(s/9.0), 0.45);
          c = mix(c, vec3(0.94,0.92,0.85), cl*det*0.9);
        }
        if (cls > 4.5) {
          float ed = 1.0 - smoothstep(0.07, 0.07+aw, abs(a - (hw - 0.45)));
          c = mix(c, vec3(0.93), ed*det*0.85);
        }
      }
      diffuseColor.rgb = pow(c, vec3(2.2));`,
    fEmissive: pass === 0 ? '' : `
      if (cls > 2.5 && s >= 0.0) {
        float da = mod(s + 16.0*step(0.0, vR.x), 32.0) - 16.0;
        float dx = hw - a;
        float pool = exp(-(da*da + dx*dx) / (2.0*6.0*6.0));
        xEm += vec3(1.0, 0.58, 0.22) * (0.035 + 0.5*pool) * uNight * (cls > 5.5 ? 1.0 : 0.7);
      } else {
        xEm += vec3(1.0, 0.6, 0.25) * 0.05 * uNight;
      }`,
  });
}
const ROAD0 = roadMat(0), ROAD1 = roadMat(1);

const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const tankMat = new THREE.MeshLambertMaterial({ color: '#1c1e21' });
const mumtyMat = hook(new THREE.MeshLambertMaterial({ color: '#d8d1c3' }), {
  fColor: 'diffuseColor.rgb *= 0.9 + 0.1*vnoise(mod(vWPos.xz*3.0,1024.0));',
});

// ---------------------------------------------------------------- data
let META, PAL;
const chunks = [];
const group = { ground: new THREE.Group(), bld: new THREE.Group(), near: new THREE.Group() };
scene.add(group.ground, group.bld, group.near);
let BUF = {};

function setProgress(p, msg) { $('lbar').style.width = (p * 100).toFixed(1) + '%'; if (msg) $('lstatus').textContent = msg; }

function decodeBld(buf, off) {
  const r = new Reader(buf, off);
  const n = r.u32(), nR = r.u32(), nP = r.u32();
  const floors = r.arr(Uint8Array, n), style = r.arr(Uint8Array, n), kind = r.arr(Uint8Array, n), rc = r.arr(Uint8Array, n);
  const rl = r.arr(Uint16Array, nR); const co = r.arr(Int16Array, nP * 2);
  // absolute coords per ring
  const abs = new Int16Array(nP * 2);
  let p = 0;
  for (let k = 0; k < nR; k++) {
    let x = 0, z = 0;
    for (let j = 0; j < rl[k]; j++, p++) { x += co[p * 2]; z += co[p * 2 + 1]; abs[p * 2] = x; abs[p * 2 + 1] = z; }
  }
  return { n, nR, nP, floors, style, kind, rc, rl, abs };
}

const flat = new Float64Array(2 * 70000);
const STATS = { v: 0, t: 0 };
let farLod = null;
function setFarLod(on) {
  if (on === farLod) return; farLod = on;
  for (const ch of chunks) for (const m of ch.reg.concat(ch.blk)) m.geometry.setDrawRange(0, on ? m.userData.far : m.userData.all);
}
function buildingMeshes(S, ox, oz, filter, noWindows, out, canvasCtx) {
  const { n, floors, style, kind, rc, rl, abs } = S;
  // per-building ring/point starts
  const ringStart = new Uint32Array(n + 1), ptStart = new Uint32Array(n + 1);
  let rr = 0, pp = 0;
  for (let i = 0; i < n; i++) { ringStart[i] = rr; ptStart[i] = pp; for (let k = 0; k < rc[i]; k++) pp += rl[rr++]; }
  ringStart[n] = rr; ptStart[n] = pp;
  let i = 0;
  while (i < n) {
    let vc = 0, ic = 0, j = i;
    for (; j < n; j++) {
      if (!filter(kind[j])) continue;
      const np = ptStart[j + 1] - ptStart[j];
      const nv = 5 * np, ni = 6 * np + 3 * (np + 2 * (rc[j] - 1));
      if (vc + nv > 65000 && vc > 0) break;
      vc += nv; ic += ni;
    }
    if (vc === 0) { i = j; continue; }
    const pos = new Int16Array(vc * 3), nor = new Int8Array(vc * 3), col = new Uint8ClampedArray(vc * 3), info = new Uint8Array(vc * 2);
    const idxR = new Uint16Array(ic), idxT = new Uint16Array(ic), idxS = new Uint16Array(ic);
    let v = 0, qr = 0, qt = 0, qs = 0;
    for (let b = i; b < j; b++) {
      if (!filter(kind[b])) continue;
      const H = floors[b] * 31 + 5;
      const pal = PAL[style[b]];
      const jit = 0.93 + 0.12 * hash1(b * 7919 + ox);
      const wr = Math.min(255, pal.w[0] * jit), wg = Math.min(255, pal.w[1] * jit), wb = Math.min(255, pal.w[2] * jit);
      const ws = noWindows ? 0 : pal.ws;
      const fl = floors[b];
      const r0 = ringStart[b], r1 = ringStart[b + 1];
      let pt = ptStart[b];
      const tall = fl >= 5;
      const W = tall ? idxT : idxS;
      let q = tall ? qt : qs;
      // walls
      for (let k = r0; k < r1; k++) {
        const m = rl[k];
        for (let e = 0; e < m; e++) {
          const a = (pt + e) * 2, c = (pt + ((e + 1) % m)) * 2;
          const ax = abs[a], az = abs[a + 1], bx = abs[c], bz = abs[c + 1];
          let dx = bx - ax, dz = bz - az; const L = Math.hypot(dx, dz) || 1;
          const nx = Math.round((-dz / L) * 127), nz = Math.round((dx / L) * 127);
          const vb = v;
          pos[v * 3] = ax; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = az; v++;
          pos[v * 3] = bx; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = bz; v++;
          pos[v * 3] = bx; pos[v * 3 + 1] = H; pos[v * 3 + 2] = bz; v++;
          pos[v * 3] = ax; pos[v * 3 + 1] = H; pos[v * 3 + 2] = az; v++;
          for (let t = vb; t < v; t++) {
            nor[t * 3] = nx; nor[t * 3 + 1] = 0; nor[t * 3 + 2] = nz;
            col[t * 3] = wr; col[t * 3 + 1] = wg; col[t * 3 + 2] = wb;
            info[t * 2] = ws; info[t * 2 + 1] = fl;
          }
          W[q++] = vb; W[q++] = vb + 1; W[q++] = vb + 2; W[q++] = vb; W[q++] = vb + 2; W[q++] = vb + 3;
        }
        pt += m;
      }
      if (tall) qt = q; else qs = q;
      // roof
      const p0 = ptStart[b], np = ptStart[b + 1] - p0;
      const holes = [];
      let acc = 0;
      for (let k = r0; k < r1; k++) { if (k > r0) holes.push(acc); acc += rl[k]; }
      const fv = flat.subarray(0, np * 2);
      for (let t = 0; t < np * 2; t++) fv[t] = abs[p0 * 2 + t];
      const tri = earcut(fv, holes.length ? holes : null, 2);
      const vb = v;
      for (let t = 0; t < np; t++) {
        pos[v * 3] = abs[(p0 + t) * 2]; pos[v * 3 + 1] = H; pos[v * 3 + 2] = abs[(p0 + t) * 2 + 1];
        nor[v * 3] = 0; nor[v * 3 + 1] = 127; nor[v * 3 + 2] = 0;
        col[v * 3] = pal.r[0] * jit; col[v * 3 + 1] = pal.r[1] * jit; col[v * 3 + 2] = pal.r[2] * jit;
        info[v * 2] = 0; info[v * 2 + 1] = fl; v++;
      }
      for (let t = 0; t < tri.length; t += 3) {
        const A = tri[t], B = tri[t + 1], C = tri[t + 2];
        const cr = (fv[B * 2] - fv[A * 2]) * (fv[C * 2 + 1] - fv[A * 2 + 1]) - (fv[B * 2 + 1] - fv[A * 2 + 1]) * (fv[C * 2] - fv[A * 2]);
        if (cr > 0) { idxR[qr++] = vb + A; idxR[qr++] = vb + C; idxR[qr++] = vb + B; }
        else { idxR[qr++] = vb + A; idxR[qr++] = vb + B; idxR[qr++] = vb + C; }
      }
      if (canvasCtx) drawFootprint(canvasCtx, abs, r0, r1, rl, p0, ox, oz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info.subarray(0, v * 2), 2));
    const idx = new Uint16Array(qr + qt + qs);
    idx.set(idxR.subarray(0, qr), 0); idx.set(idxT.subarray(0, qt), qr); idx.set(idxS.subarray(0, qs), qr + qt);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, bldMat);
    mesh.userData.far = qr + qt; mesh.userData.all = qr + qt + qs;
    STATS.v += v; STATS.t += (qr + qt + qs) / 3;
    mesh.scale.setScalar(0.1);
    mesh.position.set(ox, 0, oz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.renderOrder = 10;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    out.push(mesh);
    i = j;
  }
}

// ---------------------------------------------------------------- map canvas (radar + big map)
const MS = 16; // metres per map pixel
let mapCanvas, mapCtx, MB;
function mapXY(x, z) { return [(x - MB.minX) / MS, (z - MB.minZ) / MS]; }
function initMapCanvas() {
  MB = META.bounds;
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = Math.ceil((MB.maxX - MB.minX) / MS); mapCanvas.height = Math.ceil((MB.maxZ - MB.minZ) / MS);
  mapCtx = mapCanvas.getContext('2d');
  mapCtx.fillStyle = '#353a42'; mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
}
function drawFootprint(ctx, abs, r0, r1, rl, p0, ox, oz) {
  ctx.beginPath();
  let pt = p0;
  for (let k = r0; k < r1; k++) {
    for (let e = 0; e < rl[k]; e++) {
      const x = (ox + abs[(pt + e) * 2] * 0.1 - MB.minX) / MS, z = (oz + abs[(pt + e) * 2 + 1] * 0.1 - MB.minZ) / MS;
      if (e === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    }
    ctx.closePath(); pt += rl[k];
  }
  ctx.fill();
}

// ---------------------------------------------------------------- ground builders
function triMesh(V, I, mat, order) {
  const pos = new Float32Array(V.length);
  for (let i = 0; i < V.length; i++) pos[i] = V[i] * 0.5;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 2));
  g.setIndex(new THREE.BufferAttribute(I, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const m = new THREE.Mesh(g, mat); m.renderOrder = order; m.receiveShadow = true; m.frustumCulled = false;
  return m;
}

function buildGround() {
  const r = new Reader(BUF.ground);
  const out = [];
  // land
  const S = 70000;
  const land = triMesh(new Float32Array([-S, -S, S, -S, S, S, -S, S].map((v) => v * 2)), new Uint32Array([0, 2, 1, 0, 3, 2]), LAND, 0);
  out.push(land);
  for (const [mat, order, color] of [[WATER, 2, '#2c5f87'], [PARK, 1, '#3f5a3a']]) {
    const nv = r.u32(), ni = r.u32();
    const V = r.arr(Int16Array, nv * 2); const I = r.arr(Uint32Array, ni);
    out.push(triMesh(V, I, mat, order));
    // map canvas
    mapCtx.fillStyle = color; mapCtx.beginPath();
    for (let t = 0; t < ni; t += 3) {
      for (let k = 0; k < 3; k++) { const [x, z] = mapXY(V[I[t + k] * 2] * 0.5, V[I[t + k] * 2 + 1] * 0.5); k ? mapCtx.lineTo(x, z) : mapCtx.moveTo(x, z); }
      mapCtx.closePath();
    }
    mapCtx.fill();
  }
  // rail
  const nl = r.u32(), np = r.u32();
  const lens = r.arr(Uint16Array, nl); const xy = r.arr(Int16Array, np * 2);
  const RW = 2.2;
  let nv = 0, ni = 0; for (let k = 0; k < nl; k++) { nv += lens[k] * 2; ni += (lens[k] - 1) * 6; }
  const pos = new Float32Array(nv * 2), aR = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let v = 0, q = 0, p = 0;
  mapCtx.strokeStyle = '#7d8189'; mapCtx.lineWidth = 1.2; mapCtx.setLineDash([3, 2]);
  for (let k = 0; k < nl; k++) {
    const n = lens[k]; let s = 0;
    mapCtx.beginPath();
    for (let j = 0; j < n; j++) {
      const x = xy[(p + j) * 2] * 0.5, z = xy[(p + j) * 2 + 1] * 0.5;
      const [mx, mz] = mapXY(x, z); j ? mapCtx.lineTo(mx, mz) : mapCtx.moveTo(mx, mz);
      const [nx, nz, ml] = miter(xy, p, n, j, 0.5);
      if (j > 0) s += Math.hypot(x - xy[(p + j - 1) * 2] * 0.5, z - xy[(p + j - 1) * 2 + 1] * 0.5);
      pos[v * 2] = x + nx * RW * ml; pos[v * 2 + 1] = z + nz * RW * ml; aR[v * 2] = RW; aR[v * 2 + 1] = s; v++;
      pos[v * 2] = x - nx * RW * ml; pos[v * 2 + 1] = z - nz * RW * ml; aR[v * 2] = -RW; aR[v * 2 + 1] = s; v++;
      if (j > 0) { const b = v - 4; idx[q++] = b; idx[q++] = b + 1; idx[q++] = b + 2; idx[q++] = b + 1; idx[q++] = b + 3; idx[q++] = b + 2; }
    }
    mapCtx.stroke();
    p += n;
  }
  mapCtx.setLineDash([]);
  for (const [mat, order, color] of [[FIELD, 1.4, '#4f8a3a'], [PITCH, 1.6, '#b49a6c']]) {
    if (r.p >= BUF.ground.byteLength) break;
    const fv = r.u32(), fi = r.u32(); if (!fv) continue;
    const V = r.arr(Int16Array, fv * 2); const I = r.arr(Uint32Array, fi);
    out.push(triMesh(V, I, mat, order));
    mapCtx.fillStyle = color; mapCtx.beginPath();
    for (let t = 0; t < fi; t += 3) { for (let k = 0; k < 3; k++) { const [x, z] = mapXY(V[I[t + k] * 2] * 0.5, V[I[t + k] * 2 + 1] * 0.5); k ? mapCtx.lineTo(x, z) : mapCtx.moveTo(x, z); } mapCtx.closePath(); }
    mapCtx.fill();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 2)); g.setAttribute('aR', new THREE.BufferAttribute(aR, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const rm = new THREE.Mesh(g, RAIL); rm.renderOrder = 3; rm.receiveShadow = true; rm.frustumCulled = false; out.push(rm);
  for (const m of out) group.ground.add(m);
}

// returns unit normal (left) and miter length factor at point j of a polyline stored in xy (int16, scale sc)
function miter(xy, p, n, j, sc) {
  const X = (k) => xy[(p + k) * 2] * sc, Z = (k) => xy[(p + k) * 2 + 1] * sc;
  let dx0, dz0, dx1, dz1;
  if (j > 0) { dx0 = X(j) - X(j - 1); dz0 = Z(j) - Z(j - 1); const l = Math.hypot(dx0, dz0) || 1; dx0 /= l; dz0 /= l; }
  if (j < n - 1) { dx1 = X(j + 1) - X(j); dz1 = Z(j + 1) - Z(j); const l = Math.hypot(dx1, dz1) || 1; dx1 /= l; dz1 /= l; }
  if (j === 0) { dx0 = dx1; dz0 = dz1; }
  if (j === n - 1) { dx1 = dx0; dz1 = dz0; }
  let mx = -(dz0 + dz1), mz = dx0 + dx1; const ml = Math.hypot(mx, mz);
  if (ml < 1e-3) return [-dz1, dx1, 1];
  mx /= ml; mz /= ml;
  const dot = mx * -dz1 + mz * dx1;
  return [mx, mz, Math.min(1 / Math.max(dot, 0.25), 3)];
}

// ---------------------------------------------------------------- elevated roads: flyovers & river bridges
const SEE_THROUGH = 'if (abs(vId - uHover) < 0.5 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;';
const DECK = hook(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
  vHead: 'attribute vec4 aR; attribute float aId; varying vec4 vR; varying float vId;', vBody: 'vR = aR; vId = aId;',
  fHead: 'varying vec4 vR; varying float vId; uniform vec3 uAsph[10];', uniforms: { uAsph: { value: ASPH } },
  fColor: SEE_THROUGH + `
    float a = abs(vR.x); float s = vR.y; float hw = vR.z; float cls = vR.w;
    vec3 c;
    if (a > hw) {
      c = vec3(0.80,0.78,0.73) * (0.92 + 0.1*vnoise(mod(vWPos.xz*1.3, 1024.0)));
    } else {
      c = pow(uAsph[int(cls + 0.5)], vec3(1.0/2.2)) * (0.93 + 0.1*vnoise(mod(vWPos.xz*0.9, 1024.0)));
      float px = fwidth(s); float det = 1.0 - smoothstep(0.18, 0.55, px); float aw = fwidth(a) + 0.02;
      if (cls > 2.5 && cls != 4.0) c = mix(c, vec3(0.94,0.92,0.85), (1.0 - smoothstep(0.08, 0.08+aw, a)) * step(fract(s/9.0), 0.45) * det * 0.9);
      c = mix(c, vec3(0.93), (1.0 - smoothstep(0.07, 0.07+aw, abs(a - (hw - 0.45)))) * det * 0.85);
    }
    c = mix(c, vec3(0.93,0.92,0.89), smoothstep(2.0, 9.0, length(fwidth(vWPos.xz))) * 0.8);
    diffuseColor.rgb = pow(c, vec3(2.2));`,
  fEmissive: `
    float da = mod(s + 16.0*step(0.0, vR.x), 32.0) - 16.0; float dx = hw - a;
    xEm += vec3(1.0, 0.58, 0.22) * (0.035 + 0.5*exp(-(da*da + dx*dx) / 72.0)) * uNight * step(a, hw);`,
});
const CONCRETE = hook(new THREE.MeshLambertMaterial({ color: '#cdc8bd', side: THREE.DoubleSide }), {
  fColor: 'diffuseColor.rgb *= 0.9 + 0.12*vnoise(mod(vWPos.xz*0.7 + vWPos.y*0.3, 1024.0));',
});
const DECKWALL = hook(new THREE.MeshLambertMaterial({ color: '#cfcac0', side: THREE.DoubleSide }), {
  vHead: 'attribute float aId; varying float vId;', vBody: 'vId = aId;', fHead: 'varying float vId;',
  fColor: SEE_THROUGH + 'diffuseColor.rgb *= 0.9 + 0.12*vnoise(mod(vWPos.xz*0.7 + vWPos.y*0.3, 1024.0));',
});
const KITE = hook(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
  fColor: 'xEm = diffuseColor.rgb * 0.9 * uNight;',
});

class Geo {
  constructor(extra, withId) { this.p = []; this.n = []; this.i = []; this.x = extra ? [] : null; this.c = []; this.ids = withId ? [] : null; this.cur = 0; }
  v(x, y, z, nx, ny, nz, e, col) { this.p.push(x, y, z); this.n.push(nx, ny, nz); if (this.x) this.x.push(...e); if (col) this.c.push(...col); if (this.ids) this.ids.push(this.cur); return this.p.length / 3 - 1; }
  q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  quad(p0, p1, p2, p3, n, col) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    if ((ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0) { const t = p1; p1 = p3; p3 = t; }
    const a = this.v(...p0, ...n, null, col), b = this.v(...p1, ...n, null, col), c = this.v(...p2, ...n, null, col), d = this.v(...p3, ...n, null, col); this.q(a, b, c, d); }
  box(cx, cz, ux, uz, ha, hc, y0, y1) { // vertical box: along (ux,uz) half ha, across half hc
    const vx = -uz, vz = ux, P = (sa, sc, y) => [cx + ux * ha * sa + vx * hc * sc, y, cz + uz * ha * sa + vz * hc * sc];
    this.quad(P(-1, -1, y0), P(1, -1, y0), P(1, -1, y1), P(-1, -1, y1), [-vx, 0, -vz]);
    this.quad(P(1, 1, y0), P(-1, 1, y0), P(-1, 1, y1), P(1, 1, y1), [vx, 0, vz]);
    this.quad(P(1, -1, y0), P(1, 1, y0), P(1, 1, y1), P(1, -1, y1), [ux, 0, uz]);
    this.quad(P(-1, 1, y0), P(-1, -1, y0), P(-1, -1, y1), P(-1, 1, y1), [-ux, 0, -uz]);
    this.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), [0, 1, 0]);
  }
  mesh(mat, opts = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    if (this.x) g.setAttribute('aR', new THREE.Float32BufferAttribute(this.x, 4));
    if (this.c.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.ids) g.setAttribute('aId', new THREE.Float32BufferAttribute(this.ids, 1));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; m.renderOrder = 10;
    return m;
  }
}

let DECKIDX = null;
function buildDecks(decks, xy) {
  const D = new Geo(true, true), W = new Geo(false, true);
  const chainOf = META.deckChain || [];
  DECKIDX = new Map();
  decks.forEach((d, di) => {
    const { p, L, c, H, z } = d; const O = H + Math.max(d.O - H, 0.6);
    const cid = chainOf[di] != null ? chainOf[di] : di; D.cur = cid; W.cur = cid;
    let s = 0;
    const pts = [];
    for (let j = 0; j < L; j++) {
      const x = xy[(p + j) * 2] * 0.5, zz = xy[(p + j) * 2 + 1] * 0.5, h = z[j] / 10 + 0.05;
      if (j > 0) s += Math.hypot(x - pts[j - 1].x, zz - pts[j - 1].z);
      const [nx, nz, ml] = miter(xy, p, L, j, 0.5);
      pts.push({ x, z: zz, h, nx, nz, ml, s });
      D.v(x + nx * O * ml, h, zz + nz * O * ml, 0, 1, 0, [O, s, H, c]);
      D.v(x - nx * O * ml, h, zz - nz * O * ml, 0, 1, 0, [-O, s, H, c]);
      if (j > 0) { const b = D.p.length / 3 - 4; D.i.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      if (j > 0 && h > 2.5) {   // hover index on the deck (cells of 40 m)
        const k = Math.floor(x / 40) * 100003 + Math.floor(zz / 40);
        let arr = DECKIDX.get(k); if (!arr) DECKIDX.set(k, (arr = [])); arr.push(pts[j - 1].x, pts[j - 1].z, x, zz, O, cid);
      }
    }
    for (let j = 0; j < L - 1; j++) {
      const A = pts[j], B = pts[j + 1];
      if (A.h < 0.35 && B.h < 0.35) continue;
      for (const sg of [1, -1]) {
        const ax = A.x + A.nx * O * A.ml * sg, az = A.z + A.nz * O * A.ml * sg, bx = B.x + B.nx * O * B.ml * sg, bz = B.z + B.nz * O * B.ml * sg;
        const n = [A.nx * sg, 0, A.nz * sg];
        W.quad([ax, Math.max(0, A.h - 1.3), az], [bx, Math.max(0, B.h - 1.3), bz], [bx, B.h + 0.85, bz], [ax, A.h + 0.85, az], n);
      }
    }
  });
  // piers: square column + hammerhead cap, positions aligned across twin carriageways (from the data build)
  for (const [x, zz, ux, uz, h, hc, cid] of META.piers || []) {
    W.cur = cid;
    W.box(x, zz, ux, uz, 0.75, 0.85, 0, h - 2.1);
    W.box(x, zz, ux, uz, 0.95, hc, h - 2.1, h - 1.3);
  }
  if (D.p.length) { const m = D.mesh(DECK); group.ground.add(m); }
  if (W.p.length) { const m = W.mesh(DECKWALL); group.ground.add(m); }
  buildAtal();
}

// Atal Bridge: 300 m pedestrian bridge with a kite-coloured canopy (Uttarayan inspired)
function buildAtal() {
  const A = META.atal; if (!A) return;
  const dx = A.x1 - A.x0, dz = A.z1 - A.z0, Lb = Math.hypot(dx, dz), ux = dx / Lb, uz = dz / Lb, vx = -uz, vz = ux, hw = A.w / 2;
  const S = new Geo(false), K = new Geo(false);
  const at = (s, c, y) => [A.x0 + ux * s + vx * c, y, A.z0 + uz * s + vz * c];
  // deck is level over the river (plus 8 m), then ramps down to a paved landing on each bank
  const w0 = A.ws0 != null ? A.ws0 : 18, w1 = A.ws1 != null ? A.ws1 : Lb - 18;
  const f0 = Math.max(4, w0 - 8), f1 = Math.min(Lb - 4, w1 + 8);
  const yAt = (s) => s < f0 ? 0.25 + (A.deck - 0.25) * (s / f0) : s > f1 ? 0.25 + (A.deck - 0.25) * ((Lb - s) / (Lb - f1)) : A.deck;
  const marks = [0, f0, f1, Lb]; for (let s = 6; s < Lb; s += 6) marks.push(s);
  marks.sort((a, b) => a - b);
  for (let i = 0; i < marks.length - 1; i++) {
    const s = marks[i], e = marks[i + 1]; if (e - s < 0.01) continue;
    const y0 = yAt(s), y1 = yAt(e), solid = s < f0 || e > f1;   // ramps sit on solid abutments
    const b0 = solid ? 0 : y0 - 1.4, b1 = solid ? 0 : y1 - 1.4;
    S.quad(at(s, -hw, y0), at(e, -hw, y1), at(e, hw, y1), at(s, hw, y0), [0, 1, 0]);
    S.quad(at(s, -hw, b0), at(e, -hw, b1), at(e, -hw, y1 + 1.1), at(s, -hw, y0 + 1.1), [-vx, 0, -vz]);
    S.quad(at(e, hw, b1), at(s, hw, b0), at(s, hw, y0 + 1.1), at(e, hw, y1 + 1.1), [vx, 0, vz]);
  }
  // piers: one at each bank, two in the river
  for (const sp of [w0, w0 + (w1 - w0) / 3, w0 + 2 * (w1 - w0) / 3, w1]) S.box(A.x0 + ux * sp, A.z0 + uz * sp, ux, uz, 1.6, hw * 0.7, 0, A.deck - 1.4);
  // paved landings where the bridge meets each riverfront promenade
  for (const [sc, dir] of [[0, -1], [Lb, 1]]) {
    const a0 = sc, a1 = sc + dir * 16;
    S.quad(at(Math.min(a0, a1), -hw * 1.8, 0.08), at(Math.max(a0, a1), -hw * 1.8, 0.08), at(Math.max(a0, a1), hw * 1.8, 0.08), at(Math.min(a0, a1), hw * 1.8, 0.08), [0, 1, 0]);
  }
  // canopy: arched kite panels with gaps, posts at each panel edge
  const KC = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#7b5ce0', '#f06292', '#3fb6e8', '#ff7b25'].map((h) => new THREE.Color(h));
  const prof = [[-1, 3.0], [-0.55, 4.6], [0, 5.4], [0.55, 4.6], [1, 3.0]];
  let k = 0;
  for (let s = f0 - 2; s < f1 - 4; s += 8, k++) {
    const e = s + 6.2, col = KC[k % KC.length], cc = [col.r, col.g, col.b];
    const ys = yAt(s), ye = yAt(e);
    for (let t = 0; t < prof.length - 1; t++) {
      const [c0, h0] = prof[t], [c1, h1] = prof[t + 1];
      const tilt = (t % 2 ? 0.35 : -0.35);
      const sl = (h1 - h0) / ((c1 - c0) * hw), nl = Math.hypot(sl, 1);
      K.quad(at(s, c0 * hw, ys + h0 + tilt), at(e, c0 * hw, ye + h0 - tilt), at(e, c1 * hw, ye + h1 - tilt), at(s, c1 * hw, ys + h1 + tilt), [-vx * sl / nl, 1 / nl, -vz * sl / nl], cc);
    }
    for (const c of [-1, 1]) { const p = at(s, c * hw * 0.98, 0); S.box(p[0], p[2], ux, uz, 0.12, 0.12, ys, ys + 3.1); }
  }
  group.ground.add(S.mesh(CONCRETE));
  group.ground.add(K.mesh(KITE));
}

// roads
let ROADS; // decoded road data for lookup
function buildRoads() {
  const r = new Reader(BUF.roads);
  const n = r.u32(), np = r.u32(), nj = r.u32();
  const cls = r.arr(Uint8Array, n), br = r.arr(Uint8Array, n), hw = r.arr(Uint8Array, n), sw = r.arr(Uint8Array, n);
  const name = r.arr(Uint16Array, n), lens = r.arr(Uint16Array, n);
  const xy = r.arr(Int16Array, np * 2);
  const jxy = r.arr(Int16Array, nj * 2), jr = r.arr(Uint8Array, nj), jhw = r.arr(Uint8Array, nj), jcls = r.arr(Uint8Array, nj);
  const start = new Uint32Array(n + 1); for (let i = 0; i < n; i++) start[i + 1] = start[i] + lens[i];
  let nz = 0; for (let i = 0; i < n; i++) if (br[i]) nz += lens[i];
  const zz = r.arr(Uint8Array, nz);
  ROADS = { n, cls, br, hw, sw, name, lens, xy, start };
  const SEG = 12;
  let nv = np * 2 + nj * (SEG + 1), ni = 0;
  for (let i = 0; i < n; i++) ni += (lens[i] - 1) * 6;
  ni += nj * SEG * 3;
  const pos = new Float32Array(nv * 2), aR = new Float32Array(nv * 4), idx = new Uint32Array(ni);
  let v = 0, q = 0;
  // junction discs first (so ribbons draw over them in the same pass)
  for (let k = 0; k < nj; k++) {
    const x = jxy[k * 2] * 0.5, z = jxy[k * 2 + 1] * 0.5, R = jr[k] / 10, H = jhw[k] / 10, c = jcls[k];
    const vb = v;
    pos[v * 2] = x; pos[v * 2 + 1] = z; aR.set([0, -1000, H, c], v * 4); v++;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      pos[v * 2] = x + Math.cos(a) * R; pos[v * 2 + 1] = z + Math.sin(a) * R; aR.set([R, -1000, H, c], v * 4); v++;
    }
    for (let s = 0; s < SEG; s++) { idx[q++] = vb; idx[q++] = vb + 1 + ((s + 1) % SEG); idx[q++] = vb + 1 + s; }
  }
  // map canvas: roads by class
  const mapW = [0.7, 0.9, 1.0, 1.6, 1.4, 2.0, 2.4, 1.6, 3.0, 3.4];
  const mapC = ['#6c7179', '#7d828a', '#868b93', '#a9adb3', '#b3b6bb', '#c4c7cc', '#d6d8db', '#c4c7cc', '#e9c46a', '#f0a94b'];
  const decks = []; let zo = 0;
  for (let i = 0; i < n; i++) {
    const L = lens[i], p = start[i], c = cls[i];
    const H = hw[i] / 10, O = H + sw[i] / 10;
    if (br[i]) { decks.push({ p, L, c, H, O, z: zz.subarray(zo, zo + L) }); zo += L; continue; }
    const vb = v; let s = 0;
    for (let j = 0; j < L; j++) {
      const x = xy[(p + j) * 2] * 0.5, z = xy[(p + j) * 2 + 1] * 0.5;
      if (j > 0) s += Math.hypot(x - xy[(p + j - 1) * 2] * 0.5, z - xy[(p + j - 1) * 2 + 1] * 0.5);
      const [nx, nz, ml] = miter(xy, p, L, j, 0.5);
      const w = c + (br[i] ? 16 : 0);
      pos[v * 2] = x + nx * O * ml; pos[v * 2 + 1] = z + nz * O * ml; aR[v * 4] = O; aR[v * 4 + 1] = s; aR[v * 4 + 2] = H; aR[v * 4 + 3] = w; v++;
      pos[v * 2] = x - nx * O * ml; pos[v * 2 + 1] = z - nz * O * ml; aR[v * 4] = -O; aR[v * 4 + 1] = s; aR[v * 4 + 2] = H; aR[v * 4 + 3] = w; v++;
    }
    for (let j = 0; j < L - 1; j++) { const b = vb + j * 2; idx[q++] = b; idx[q++] = b + 1; idx[q++] = b + 2; idx[q++] = b + 1; idx[q++] = b + 3; idx[q++] = b + 2; }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const c = cls[i]; if ((pass === 0) !== (c < 3)) continue;
      const L = lens[i], p = start[i];
      mapCtx.strokeStyle = mapC[c]; mapCtx.lineWidth = mapW[c]; mapCtx.lineCap = 'round'; mapCtx.lineJoin = 'round';
      mapCtx.beginPath();
      for (let j = 0; j < L; j++) { const [mx, mz] = mapXY(xy[(p + j) * 2] * 0.5, xy[(p + j) * 2 + 1] * 0.5); j ? mapCtx.lineTo(mx, mz) : mapCtx.moveTo(mx, mz); }
      mapCtx.stroke();
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 2), 2));
  g.setAttribute('aR', new THREE.BufferAttribute(aR.subarray(0, v * 4), 4));
  g.setIndex(new THREE.BufferAttribute(idx.subarray(0, q), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  buildDecks(decks, xy);
  for (const [mat, ord] of [[ROAD0, 4], [ROAD1, 5]]) {
    const m = new THREE.Mesh(g, mat); m.renderOrder = ord; m.receiveShadow = true; m.frustumCulled = false; group.ground.add(m);
  }
  buildRoadIndex();
}

function deckUnder(sx, sy) {
  if (!DECKIDX) return -1;
  ndc.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, cam);
  const o = raycaster.ray.origin, d = raycaster.ray.direction; const t = (6.5 - o.y) / d.y;
  const x = o.x + d.x * t, z = o.z + d.z * t;
  const ca = Math.floor(x / 40), cb = Math.floor(z / 40); let best = 1e9, id = -1;
  for (let a = ca - 1; a <= ca + 1; a++) for (let b = cb - 1; b <= cb + 1; b++) {
    const arr = DECKIDX.get(a * 100003 + b); if (!arr) continue;
    for (let k = 0; k < arr.length; k += 6) {
      const x0 = arr[k], z0 = arr[k + 1], x1 = arr[k + 2], z1 = arr[k + 3], O = arr[k + 4];
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1, u = clamp(((x - x0) * dx + (z - z0) * dz) / L2, 0, 1);
      const dd = Math.hypot(x - (x0 + u * dx), z - (z0 + u * dz)) - O;
      if (dd < 1.5 && dd < best) { best = dd; id = arr[k + 5]; }
    }
  }
  return id;
}

// spatial index for "which street am I on"
const RCELL = 80; let rIndex;
function buildRoadIndex() {
  rIndex = new Map();
  const { n, xy, start } = ROADS;
  for (let i = 0; i < n; i++) {
    for (let j = start[i]; j < start[i + 1] - 1; j++) {
      const x0 = xy[j * 2] * 0.5, z0 = xy[j * 2 + 1] * 0.5, x1 = xy[j * 2 + 2] * 0.5, z1 = xy[j * 2 + 3] * 0.5;
      const cx0 = Math.floor(Math.min(x0, x1) / RCELL), cx1 = Math.floor(Math.max(x0, x1) / RCELL);
      const cz0 = Math.floor(Math.min(z0, z1) / RCELL), cz1 = Math.floor(Math.max(z0, z1) / RCELL);
      for (let a = cx0; a <= cx1; a++) for (let b = cz0; b <= cz1; b++) {
        const key = a * 100003 + b; let arr = rIndex.get(key); if (!arr) rIndex.set(key, (arr = [])); arr.push(i, j);
      }
    }
  }
}
function nearestRoad(x, z) {
  const { xy, hw, name, cls } = ROADS; let best = 1e9, bi = -1;
  const ca = Math.floor(x / RCELL), cb = Math.floor(z / RCELL);
  for (let a = ca - 1; a <= ca + 1; a++) for (let b = cb - 1; b <= cb + 1; b++) {
    const arr = rIndex.get(a * 100003 + b); if (!arr) continue;
    for (let t = 0; t < arr.length; t += 2) {
      const i = arr[t], j = arr[t + 1];
      const x0 = xy[j * 2] * 0.5, z0 = xy[j * 2 + 1] * 0.5, x1 = xy[j * 2 + 2] * 0.5, z1 = xy[j * 2 + 3] * 0.5;
      const dx = x1 - x0, dz = z1 - z0; const L2 = dx * dx + dz * dz || 1;
      const u = clamp(((x - x0) * dx + (z - z0) * dz) / L2, 0, 1);
      let d = Math.hypot(x - (x0 + u * dx), z - (z0 + u * dz)) - hw[i] / 10;
      if (name[i] === 65535) d += 12; // prefer named roads nearby
      if (d < best) { best = d; bi = i; }
    }
  }
  return best < 45 ? bi : -1;
}

// ---------------------------------------------------------------- chunks
function chunkOrigin(cx, cy) { return [(cx + 0.5) * META.chunk, -(cy + 0.5) * META.chunk]; }

async function buildFarBuildings(progressBase, progressSpan) {
  const total = META.chunks.length; let t0 = performance.now();
  mapCtx.fillStyle = '#4a505a';
  for (let k = 0; k < total; k++) {
    const [cx, cy, bo, bl, co, cl, po, pl, to, tl] = META.chunks[k];
    const [ox, oz] = chunkOrigin(cx, cy);
    const ch = { cx, cy, ox, oz, bo, bl, co, cl, po, pl, to, tl, reg: [], blk: [], cells: null, trees: null, props: null, near: false, lastUsed: 0 };
    if (bl) {
      const S = decodeBld(BUF.bld, bo);
      buildingMeshes(S, ox, oz, (kd) => kd === 0, false, ch.reg, mapCtx);
      buildingMeshes(S, ox, oz, (kd) => kd === 1, true, ch.blk, mapCtx);
      for (const m of ch.reg) group.bld.add(m);
      for (const m of ch.blk) group.bld.add(m);
    }
    chunks.push(ch);
    if (performance.now() - t0 > 40) { setProgress(progressBase + progressSpan * (k / total), `Raising ${META.counts.buildings.toLocaleString()} buildings… ${Math.round(k / total * 100)}%`); await tick(); t0 = performance.now(); }
  }
}

// near detail (lazy)
let treeGeo, tankGeo, mumtyGeo;
function initDetailGeos() {
  const canopy = new THREE.IcosahedronGeometry(1, 0); canopy.scale(3.0, 2.5, 3.0); canopy.translate(0, 5.0, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 3.4, 5); trunk.translate(0, 1.7, 0);
  const paint = (g, c) => { const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(c, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g.index ? g.toNonIndexed() : g; };
  treeGeo = mergeGeometries([paint(canopy.toNonIndexed(), [1, 1, 1]), paint(trunk.toNonIndexed(), [0.55, 0.42, 0.33])]);
  tankGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.25, 9); tankGeo.translate(0, 0.625, 0);
  mumtyGeo = new THREE.BoxGeometry(3.4, 2.7, 3.4); mumtyGeo.translate(0, 1.35, 0);
}
const TREE_COLS = ['#557f2f', '#6f9a36', '#86924a', '#b9653a', '#47732d'].map((h) => new THREE.Color(h));
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();

function buildCells(ch) {
  ch.cells = [];
  if (!ch.cl || !BUF.cells) return;
  const S = decodeBld(BUF.cells, ch.co);
  buildingMeshes(S, ch.ox, ch.oz, () => true, false, ch.cells, null);
  for (const m of ch.cells) group.near.add(m);
}
function buildTrees(ch) {
  ch.trees = [];
  if (!ch.tl || !BUF.trees) return;
  const r = new Reader(BUF.trees, ch.to); const n = r.u32();
  const X = r.arr(Int16Array, n), Z = r.arr(Int16Array, n), SC = r.arr(Uint8Array, n), VR = r.arr(Uint8Array, n);
  const im = new THREE.InstancedMesh(treeGeo, treeMat, n);
  for (let i = 0; i < n; i++) {
    const s = SC[i] / 64, vr = VR[i];
    _p.set(X[i] * 0.1, 0, Z[i] * 0.1);
    _e.set(0, hash1(i + ch.cx * 131 + ch.cy * 977) * 6.283, 0); _q.setFromEuler(_e);
    if (vr === 4) _s.set(s * 0.55, s * 1.5, s * 0.55); else _s.set(s, s * (0.9 + 0.2 * hash1(i * 3)), s);
    _m.compose(_p, _q, _s); im.setMatrixAt(i, _m);
    const c = TREE_COLS[vr]; const j = 0.88 + 0.22 * hash1(i * 17 + 3);
    im.setColorAt(i, _tmpC.setRGB(c.r * j, c.g * j, c.b * j));
  }
  im.position.set(ch.ox, 0, ch.oz); im.castShadow = true; im.receiveShadow = true; im.renderOrder = 10;
  im.computeBoundingSphere();
  ch.trees.push(im); group.near.add(im);
}
const _tmpC = new THREE.Color();
function buildProps(ch) {
  ch.props = [];
  if (!ch.pl || !BUF.props) return;
  const r = new Reader(BUF.props, ch.po); const n = r.u32();
  const X = r.arr(Int16Array, n), Z = r.arr(Int16Array, n), Y = r.arr(Uint16Array, n), T = r.arr(Uint8Array, n), RO = r.arr(Uint8Array, n), SC = r.arr(Uint8Array, n);
  let nt = 0, nm = 0; for (let i = 0; i < n; i++) T[i] ? nm++ : nt++;
  const tanks = new THREE.InstancedMesh(tankGeo, tankMat, Math.max(nt, 1)); tanks.count = nt;
  const mum = new THREE.InstancedMesh(mumtyGeo, mumtyMat, Math.max(nm, 1)); mum.count = nm;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    _p.set(X[i] * 0.1, Y[i] * 0.1, Z[i] * 0.1);
    const s = SC[i] / 20;
    if (T[i] === 0) { _q.identity(); _s.set(s, s, s); _m.compose(_p, _q, _s); tanks.setMatrixAt(a++, _m); }
    else { _e.set(0, (RO[i] / 255) * Math.PI, 0); _q.setFromEuler(_e); _s.set(s, s > 1.2 ? 1.3 : 1, s); _m.compose(_p, _q, _s); mum.setMatrixAt(b++, _m); }
  }
  for (const im of [tanks, mum]) { im.position.set(ch.ox, 0, ch.oz); im.castShadow = true; im.receiveShadow = true; im.renderOrder = 10; im.computeBoundingSphere(); group.near.add(im); ch.props.push(im); }
}
function disposeNear(ch) {
  for (const k of ['cells', 'trees', 'props']) {
    if (!ch[k]) continue;
    for (const m of ch[k]) { group.near.remove(m); if (k === 'cells') m.geometry.dispose(); else if (m.dispose) m.dispose(); }
    ch[k] = null;
  }
}

// ---------------------------------------------------------------- camera / view math
const raycaster = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function updateCamera() {
  const w = innerWidth, h = innerHeight, m = view.mpp;
  cam.left = -w / 2 * m; cam.right = w / 2 * m; cam.top = h / 2 * m; cam.bottom = -h / 2 * m;
  const D = 60000, ce = Math.cos(EL), se = Math.sin(EL);
  cam.position.set(view.tx + D * ce * Math.sin(view.az), D * se, view.tz + D * ce * Math.cos(view.az));
  cam.up.set(0, 1, 0); cam.lookAt(view.tx, 0, view.tz);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}
function screenToGround(sx, sy) {
  ndc.set((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, cam);
  const o = raycaster.ray.origin, d = raycaster.ray.direction; const t = -o.y / d.y;
  return [o.x + d.x * t, o.z + d.z * t];
}
const _v = new THREE.Vector3();
function worldToScreen(x, y, z) { _v.set(x, y, z).project(cam); return [(_v.x + 1) / 2 * innerWidth, (1 - _v.y) / 2 * innerHeight, _v.z]; }
function visibleQuad() { return [screenToGround(0, 0), screenToGround(innerWidth, 0), screenToGround(innerWidth, innerHeight), screenToGround(0, innerHeight)]; }
function quadContains(Q, x, z, pad) {
  let ar = 0; for (let i = 0; i < 4; i++) { const [ax, az] = Q[i], [bx, bz] = Q[(i + 1) % 4]; ar += ax * bz - bx * az; }
  const sg = ar > 0 ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = Q[i], [bx, bz] = Q[(i + 1) % 4];
    const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
    const cross = sg * (ex * (z - az) - ez * (x - ax)) / L;
    if (cross < -pad) return false;
  }
  return true;
}
function clampView() {
  const b = META.bounds;
  view.tx = clamp(view.tx, b.minX, b.maxX); view.tz = clamp(view.tz, b.minZ, b.maxZ);
  view.mpp = clamp(view.mpp, 0.06, 45);
}

// ---------------------------------------------------------------- lighting / time of day
// bear = sun angle measured from screen-left (+ = towards the viewer); the light follows the camera like a studio key light
const TIMES = {
  morning: { bear: 35, elev: 30, sun: '#ffe2bf', si: 1.75, sky: '#b8d0ea', gnd: '#9c8466', hi: 0.85, bg: '#cfd9e2', night: 0, exp: 1.0 },
  noon: { bear: 18, elev: 47, sun: '#fff3df', si: 1.9, sky: '#c6dcf5', gnd: '#a08a6a', hi: 0.9, bg: '#c7d6e4', night: 0, exp: 1.0 },
  golden: { bear: -12, elev: 17, sun: '#ffa65a', si: 2.1, sky: '#e9bf9b', gnd: '#6e5440', hi: 0.62, bg: '#e2bb98', night: 0, exp: 1.04 },
  night: { bear: 25, elev: 50, sun: '#8ea6dc', si: 0.2, sky: '#23345a', gnd: '#100d0a', hi: 0.27, bg: '#070a12', night: 1, exp: 1.0 },
};
let tod = { ...TIMES.noon }, todFrom = null, todTo = null, todT = 1, todName = 'noon';
const sunDir = new THREE.Vector3();
function updateSunDir() {
  const p = tod, e = THREE.MathUtils.degToRad(p.elev), f = THREE.MathUtils.degToRad(p.bear);
  const ca = Math.cos(view.az), sa = Math.sin(view.az);
  // screen-left on the ground = (-ca, sa); towards camera = (sa, ca)
  const hx = -ca * Math.cos(f) + sa * Math.sin(f), hz = sa * Math.cos(f) + ca * Math.sin(f);
  sunDir.set(hx * Math.cos(e), Math.sin(e), hz * Math.cos(e)).normalize();
}
function applyTod(p) {
  updateSunDir();
  sun.color.set(p.sunC || p.sun); sun.intensity = p.si;
  hemi.color.set(p.skyC || p.sky); hemi.groundColor.set(p.gndC || p.gnd); hemi.intensity = p.hi;
  scene.background.set(p.bgC || p.bg);
  U.uNight.value = p.night; U.uDay.value = 1 - p.night; U.uSunCol.value.copy(sun.color);
  renderer.toneMappingExposure = p.exp;
  document.body.classList.toggle('night', p.night > 0.5);
}
function setTime(name) {
  todName = name;
  todFrom = { ...tod }; todTo = TIMES[name]; todT = 0;
  document.querySelectorAll('#timebar button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  dirty = true;
}
function stepTod(dt) {
  if (todT >= 1) return false;
  todT = Math.min(1, todT + dt / 1.4); const t = ease(todT);
  const c1 = new THREE.Color(), c2 = new THREE.Color();
  const mix = (k) => { c1.set(todFrom[k + 'C'] || todFrom[k]); c2.set(todTo[k]); return '#' + c1.lerp(c2, t).getHexString(); };
  let db = todTo.bear - todFrom.bear; if (db > 180) db -= 360; if (db < -180) db += 360;
  tod = { bear: todFrom.bear + db * t, elev: lerp(todFrom.elev, todTo.elev, t), si: lerp(todFrom.si, todTo.si, t), hi: lerp(todFrom.hi, todTo.hi, t),
    night: lerp(todFrom.night, todTo.night, t), exp: lerp(todFrom.exp, todTo.exp, t),
    sunC: mix('sun'), skyC: mix('sky'), gndC: mix('gnd'), bgC: mix('bg') };
  applyTod(tod);
  return true;
}

// ---------------------------------------------------------------- shadows
const _lc = new THREE.Vector3();
function fitShadow(Q) {
  const on = settings.shadows && view.mpp < 7;
  sun.castShadow = on;
  if (!on) return;
  sun.position.set(view.tx + sunDir.x * 6000, sunDir.y * 6000, view.tz + sunDir.z * 6000);
  sun.target.position.set(view.tx, 0, view.tz);
  sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.position.copy(sun.position); sc.lookAt(sun.target.position); sc.updateMatrixWorld();
  const inv = sc.matrixWorldInverse;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [x, z] of Q) for (const y of [0, 140]) {
    _lc.set(x, y, z).applyMatrix4(inv);
    x0 = Math.min(x0, _lc.x); x1 = Math.max(x1, _lc.x); y0 = Math.min(y0, _lc.y); y1 = Math.max(y1, _lc.y); z0 = Math.min(z0, _lc.z); z1 = Math.max(z1, _lc.z);
  }
  const pad = 60; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const texel = Math.max(x1 - x0, y1 - y0) / SHADOW_SIZE;
  x0 = Math.floor(x0 / texel) * texel; x1 = Math.ceil(x1 / texel) * texel; y0 = Math.floor(y0 / texel) * texel; y1 = Math.ceil(y1 / texel) * texel;
  sc.left = x0; sc.right = x1; sc.bottom = y0; sc.top = y1; sc.near = Math.max(1, -z1 - 400); sc.far = -z0 + 400;
  sc.updateProjectionMatrix();
  sun.shadow.normalBias = clamp(texel * 0.9, 0.05, 4);
  sun.shadow.bias = -0.00002 * (1 + texel);
}

// ---------------------------------------------------------------- LOD / detail scheduling
const settings = { shadows: true, trees: true, labels: true, retro: false };
const NEAR_MPP = 2.1, TREE_MPP = 1.6, PROP_MPP = 1.05;
let queue = [];
function updateLOD(Q) {
  setFarLod(view.mpp > 6.5);
  const near = view.mpp < NEAR_MPP;
  const [cx, cz] = [view.tx, view.tz];
  queue = [];
  let visibleNear = 0;
  for (const ch of chunks) {
    const inView = quadContains(Q, ch.ox, ch.oz, 900);
    const wantNear = near && inView;
    ch.near = wantNear;
    const showCells = wantNear && ch.cells && ch.cells.length;
    for (const m of ch.blk) m.visible = !showCells;
    if (ch.cells) for (const m of ch.cells) m.visible = wantNear;
    const showTrees = wantNear && settings.trees && view.mpp < TREE_MPP;
    const showProps = wantNear && settings.trees && view.mpp < PROP_MPP;
    if (ch.trees) for (const m of ch.trees) m.visible = showTrees;
    if (ch.props) for (const m of ch.props) m.visible = showProps;
    if (wantNear) {
      visibleNear++; ch.lastUsed = performance.now();
      const d = Math.hypot(ch.ox - cx, ch.oz - cz);
      if (!ch.cells && BUF.cells) queue.push([d, ch, 'cells']);
      if (showTrees && !ch.trees && BUF.trees) queue.push([d + 200, ch, 'trees']);
      if (showProps && !ch.props && BUF.props) queue.push([d + 400, ch, 'props']);
    }
  }
  queue.sort((a, b) => a[0] - b[0]);
  // evict old detail
  const built = chunks.filter((c) => (c.cells || c.trees) && !c.near);
  if (built.length > 70) { built.sort((a, b) => a.lastUsed - b.lastUsed); for (const c of built.slice(0, built.length - 70)) disposeNear(c); }
}
function runQueue(budget) {
  const t0 = performance.now(); let did = false;
  while (queue.length && performance.now() - t0 < budget) {
    const [, ch, kind] = queue.shift();
    if (!ch.near) continue;
    if (kind === 'cells' && !ch.cells) { buildCells(ch); for (const m of ch.blk) m.visible = !(ch.cells.length); }
    if (kind === 'trees' && !ch.trees) buildTrees(ch);
    if (kind === 'props' && !ch.props) buildProps(ch);
    did = true;
  }
  return did;
}

// ---------------------------------------------------------------- labels
const labelsEl = $('labels');
let LBL = { dist: [], poi: [], road: [] };
function initLabels() {
  const mk = (cls, html) => { const d = document.createElement('div'); d.className = 'lbl ' + cls; d.innerHTML = html; labelsEl.appendChild(d); return d; };
  for (const w of META.wards) LBL.dist.push({ el: mk('district', w.name), x: w.x, z: w.z, area: w.area, name: w.name });
  for (const w of EXTRA_AREAS) LBL.dist.push({ el: mk('district', w.name), x: w.x, z: w.z, area: 9e6, name: w.name });
  const icon = { lake: '~', river: '~', monument: '★', stadium: '◎', airport: '✈', campus: '◆', park: '♣' };
  for (const l of META.landmarks) LBL.poi.push({ el: mk('poi ' + l.kind, `<span class="pin">${icon[l.kind] || '★'}</span>${l.name}`), x: l.x, z: l.z, min: 14 });
  for (const s of META.stations) LBL.poi.push({ el: mk('poi station', `<span class="pin">🚆︎</span>${s.name}`), x: s.x, z: s.z, min: 6 });
  for (let i = 0; i < 90; i++) { const d = mk('road', ''); d.style.display = 'none'; LBL.road.push(d); }
  for (const r of META.roadLabels) r.len = META.roadNames[r[0]].length;
}
function hideAll(arr) { for (const o of arr) o.el.style.display = 'none'; }
function updateLabels() {
  if (!settings.labels) { hideAll(LBL.dist); hideAll(LBL.poi); for (const d of LBL.road) d.style.display = 'none'; return; }
  const W = innerWidth, H = innerHeight, m = view.mpp;
  const placed = [];
  const free = (x0, y0, x1, y1) => { for (const r of placed) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false; placed.push([x0, y0, x1, y1]); return true; };
  // POIs
  for (const o of LBL.poi) {
    if (m > o.min) { o.el.style.display = 'none'; continue; }
    const [sx, sy] = worldToScreen(o.x, 0, o.z);
    if (sx < -100 || sx > W + 100 || sy < -40 || sy > H + 40 || !free(sx - 12, sy - 12, sx + 150, sy + 12)) { o.el.style.display = 'none'; continue; }
    o.el.style.display = ''; o.el.style.transform = `translate(${sx - 10}px,${sy - 10}px)`;
  }
  // districts
  for (const o of LBL.dist) {
    const sz = clamp(Math.sqrt(o.area) / m * 0.055, 12, 34);
    if (m < 0.55 || (m > 26 && o.area < 4e6)) { o.el.style.display = 'none'; continue; }
    const [sx, sy] = worldToScreen(o.x, 0, o.z);
    const wpx = o.name.length * sz * 0.62;
    if (sx < -wpx || sx > W + wpx || sy < -40 || sy > H + 40 || !free(sx - wpx / 2, sy - sz / 2, sx + wpx / 2, sy + sz / 2)) { o.el.style.display = 'none'; continue; }
    o.el.style.display = ''; o.el.style.fontSize = sz + 'px';
    o.el.style.opacity = m < 0.9 ? (m - 0.55) / 0.35 : 1;
    o.el.style.transform = `translate(${sx - wpx / 2}px,${sy - sz / 2}px)`;
  }
  // roads
  let used = 0;
  if (m < 1.5) {
    for (const r of META.roadLabels) {
      if (used >= LBL.road.length) break;
      const [ni, x, z, ang] = r;
      const [sx, sy] = worldToScreen(x, 0, z);
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      const [ex, ey] = worldToScreen(x + Math.cos(ang) * 30, 0, z + Math.sin(ang) * 30);
      let a = Math.atan2(ey - sy, ex - sx); if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
      const w = r.len * 6.4 + 8;
      const hx = Math.abs(Math.cos(a)) * w / 2 + 8, hy = Math.abs(Math.sin(a)) * w / 2 + 8;
      if (!free(sx - hx, sy - hy, sx + hx, sy + hy)) continue;
      const d = LBL.road[used++];
      d.textContent = META.roadNames[ni]; d.style.display = '';
      d.style.transform = `translate(${sx}px,${sy}px) rotate(${a}rad) translate(-50%,-50%)`;
    }
  }
  for (let i = used; i < LBL.road.length; i++) LBL.road[i].style.display = 'none';
}
const EXTRA_AREAS = [];

// ---------------------------------------------------------------- radar + big map
const radar = $('radar'), rctx = radar.getContext('2d');
function drawRadar(Q) {
  const R = radar.width; rctx.save(); rctx.clearRect(0, 0, R, R);
  rctx.fillStyle = '#2b3036'; rctx.fillRect(0, 0, R, R);
  const s = 3.1; // radar px per map px
  rctx.translate(R / 2, R / 2); rctx.rotate(view.az); rctx.scale(s, s);
  const [px, pz] = mapXY(view.tx, view.tz);
  rctx.imageSmoothingEnabled = true;
  rctx.drawImage(mapCanvas, -px, -pz);
  // view footprint
  rctx.beginPath();
  Q.forEach(([x, z], i) => { const [a, b] = mapXY(x, z); i ? rctx.lineTo(a - px, b - pz) : rctx.moveTo(a - px, b - pz); });
  rctx.closePath(); rctx.fillStyle = 'rgba(255,255,255,0.08)'; rctx.fill(); rctx.lineWidth = 1.6 / s; rctx.strokeStyle = 'rgba(255,255,255,0.75)'; rctx.stroke();
  rctx.restore();
  // player marker
  rctx.save(); rctx.translate(R / 2, R / 2);
  rctx.beginPath(); rctx.moveTo(0, -15); rctx.lineTo(11, 12); rctx.lineTo(0, 6); rctx.lineTo(-11, 12); rctx.closePath();
  rctx.fillStyle = '#fff'; rctx.shadowColor = 'rgba(0,0,0,.6)'; rctx.shadowBlur = 6; rctx.fill(); rctx.restore();
  // north
  const nx = Math.sin(view.az), nz = -Math.cos(view.az), rr = R / 2 - 26;
  rctx.save(); rctx.translate(R / 2 + nx * rr, R / 2 + nz * rr);
  rctx.beginPath(); rctx.arc(0, 0, 17, 0, Math.PI * 2); rctx.fillStyle = '#111'; rctx.fill(); rctx.lineWidth = 3; rctx.strokeStyle = '#fff'; rctx.stroke();
  rctx.fillStyle = '#fff'; rctx.font = '800 20px "Barlow Condensed"'; rctx.textAlign = 'center'; rctx.textBaseline = 'middle'; rctx.fillText('N', 0, 1);
  rctx.restore();
  // edge shading
  const g = rctx.createRadialGradient(R / 2, R / 2, R * 0.3, R / 2, R / 2, R * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)'); rctx.fillStyle = g; rctx.fillRect(0, 0, R, R);
}
const bigmap = $('bigmap'), bmc = $('bigmapCanvas'), bml = $('bigmapLabels');
function openBigMap() {
  const W = innerWidth * 0.86, H = innerHeight * 0.80;
  const sc = Math.min(W / mapCanvas.width, H / mapCanvas.height);
  bmc.width = Math.round(mapCanvas.width * sc * (devicePixelRatio || 1)); bmc.height = Math.round(mapCanvas.height * sc * (devicePixelRatio || 1));
  bmc.style.width = mapCanvas.width * sc + 'px'; bmc.style.height = mapCanvas.height * sc + 'px';
  const c = bmc.getContext('2d'); c.imageSmoothingQuality = 'high';
  c.drawImage(mapCanvas, 0, 0, bmc.width, bmc.height);
  const k = bmc.width / mapCanvas.width;
  // current view
  const Q = visibleQuad(); c.beginPath(); Q.forEach(([x, z], i) => { const [a, b] = mapXY(x, z); i ? c.lineTo(a * k, b * k) : c.moveTo(a * k, b * k); }); c.closePath();
  c.lineWidth = 2 * (devicePixelRatio || 1); c.strokeStyle = '#ff9d2e'; c.stroke(); c.fillStyle = 'rgba(255,157,46,.15)'; c.fill();
  bml.innerHTML = '';
  for (const w of [...META.wards, ...EXTRA_AREAS]) {
    const [a, b] = mapXY(w.x, w.z); const d = document.createElement('div'); d.textContent = w.name;
    d.style.left = a * sc + 'px'; d.style.top = b * sc + 'px'; bml.appendChild(d);
  }
  bmc._sc = sc; bigmap.classList.add('show');
}
bmc.addEventListener('click', (e) => {
  const r = bmc.getBoundingClientRect(); const sc = bmc._sc;
  const x = (e.clientX - r.left) / sc * MS + MB.minX, z = (e.clientY - r.top) / sc * MS + MB.minZ;
  bigmap.classList.remove('show'); flyTo(x, z, 1.4);
});
bigmap.addEventListener('click', (e) => { if (e.target === bigmap) bigmap.classList.remove('show'); });
$('radarWrap').addEventListener('click', openBigMap);
$('bMap').addEventListener('click', openBigMap);

// ---------------------------------------------------------------- location readout
const wD = $('wD'), wR = $('wR'), wM = $('wM');
function pip(rings, x, z) {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
let lastWhere = '';
function updateWhere(x, z) {
  let d = null;
  for (const w of META.wards) { if (pip(w.rings, x, z)) { d = w.name; break; } }
  if (!d) { let best = 1e9; for (const a of EXTRA_AREAS) { const dd = Math.hypot(a.x - x, a.z - z); if (dd < best && dd < 3500) { best = dd; d = a.name; } } }
  if (!d) d = 'Ahmedabad Outskirts';
  const ri = ROADS ? nearestRoad(x, z) : -1;
  const road = ri >= 0 ? (ROADS.name[ri] !== 65535 ? META.roadNames[ROADS.name[ri]] : ['Lane', 'Residential street', 'Street', 'Road', 'Slip road', 'Road', 'Main road', 'BRTS corridor', 'Highway', 'Expressway'][ROADS.cls[ri]]) : '';
  const o = META.origin; const lon = x / o.kx + o.lon, lat = -z / o.ky + o.lat;
  const key = d + '|' + road;
  if (key !== lastWhere) { wD.textContent = d; wR.textContent = road; lastWhere = key; }
  wM.textContent = `${lat.toFixed(4)}° N · ${lon.toFixed(4)}° E`;
}

// ---------------------------------------------------------------- search
let SEARCH = [];
function initSearch() {
  for (const w of META.wards) SEARCH.push({ t: w.name, k: 'district', x: w.x, z: w.z, m: 3.2 });
  for (const w of EXTRA_AREAS) SEARCH.push({ t: w.name, k: 'area', x: w.x, z: w.z, m: 3.2 });
  for (const l of META.landmarks) SEARCH.push({ t: l.name, k: 'landmark', x: l.x, z: l.z, m: 0.9 });
  for (const s of META.stations) SEARCH.push({ t: s.name + ' Station', k: 'station', x: s.x, z: s.z, m: 0.9 });
  for (const [ni, x, z, L] of META.searchRoads) SEARCH.push({ t: META.roadNames[ni], k: 'road', x, z, m: 1.1, L });
}
const qEl = $('q'), resEl = $('results'); let resItems = [], resSel = 0;
function doSearch() {
  const q = qEl.value.trim().toLowerCase();
  resEl.innerHTML = ''; resItems = [];
  if (!q) { resEl.style.display = 'none'; return; }
  const ll = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = +ll[1], lon = +ll[2], o = META.origin;
    resItems.push({ t: `${lat}, ${lon}`, k: 'coords', x: (lon - o.lon) * o.kx, z: -(lat - o.lat) * o.ky, m: 0.8 });
  }
  const scored = [];
  for (const it of SEARCH) {
    const t = it.t.toLowerCase(); const i = t.indexOf(q);
    if (i < 0) continue;
    scored.push([(i === 0 ? 0 : 1) + (it.k === 'road' ? 0.5 : 0) - (it.L || 0) / 1e6, it]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  for (const [, it] of scored.slice(0, 8)) resItems.push(it);
  resItems.forEach((it, i) => {
    const d = document.createElement('div'); d.innerHTML = `${it.t}<span>${it.k}</span>`; if (i === resSel) d.classList.add('sel');
    d.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); }); resEl.appendChild(d);
  });
  resEl.style.display = resItems.length ? 'block' : 'none';
}
function pick(it) { qEl.value = it.t; resEl.style.display = 'none'; qEl.blur(); flyTo(it.x, it.z, it.m); }
qEl.addEventListener('input', () => { resSel = 0; doSearch(); });
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { resSel = Math.min(resSel + 1, resItems.length - 1); doSearch(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { resSel = Math.max(resSel - 1, 0); doSearch(); e.preventDefault(); }
  else if (e.key === 'Enter' && resItems[resSel]) pick(resItems[resSel]);
  else if (e.key === 'Escape') { qEl.blur(); resEl.style.display = 'none'; }
  e.stopPropagation();
});
qEl.addEventListener('blur', () => setTimeout(() => (resEl.style.display = 'none'), 150));

// ---------------------------------------------------------------- animation: fly & rotate
let fly = null, rot = null;
function flyTo(x, z, mpp, dur) {
  const d = Math.hypot(x - view.tx, z - view.tz);
  fly = { t: 0, dur: dur || clamp(0.9 + d / 9000, 1.0, 2.6), x0: view.tx, z0: view.tz, x1: x, z1: z, m0: view.mpp, m1: mpp, mm: Math.max(view.mpp, mpp, d / 1400) };
  lastInteract = performance.now();
}
function rotateBy(delta) {
  const target = (rot ? rot.a1 : view.az) + delta;
  rot = { t: 0, a0: view.az, a1: target }; lastInteract = performance.now();
}
function stepAnims(dt) {
  let moved = false;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / fly.dur); const t = ease(fly.t);
    view.tx = lerp(fly.x0, fly.x1, t); view.tz = lerp(fly.z0, fly.z1, t);
    const lm0 = Math.log(fly.m0), lm1 = Math.log(fly.m1), lmm = Math.log(fly.mm);
    view.mpp = Math.exp(t < 0.5 ? lerp(lm0, lmm, ease(t * 2)) : lerp(lmm, lm1, ease((t - 0.5) * 2)));
    if (fly.t >= 1) fly = null; moved = true;
  }
  if (rot) {
    rot.t = Math.min(1, rot.t + dt / 0.65); view.az = lerp(rot.a0, rot.a1, ease(rot.t));
    if (rot.t >= 1) rot = null; moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------- input
let drag = null; const pointers = new Map();
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  fly = null;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mpp: view.mpp, az: view.az };
  } else drag = { x: e.clientX, y: e.clientY, rot: e.button === 2 || e.shiftKey || e.ctrlKey };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.in = true;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!drag) { whereDirty = true; return; }
  lastInteract = performance.now();
  if (drag.pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    view.mpp = clamp(drag.mpp * drag.d / d, 0.06, 45); view.az = drag.az - (ang - drag.ang); dirty = true; return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (drag.rot) { view.az -= dx * 0.006; rot = null; }
  else {
    const m = view.mpp, ca = Math.cos(view.az), sa = Math.sin(view.az);
    view.tx -= ca * dx * m; view.tz -= -sa * dx * m;
    const k = dy * m / Math.sin(EL);
    view.tx += -sa * k; view.tz += -ca * k;
  }
  clampView(); dirty = true;
});
const endDrag = (e) => { pointers.delete(e.pointerId); if (pointers.size === 0) { drag = null; canvas.classList.remove('dragging'); } else if (pointers.size === 1) { const [p] = pointers.values(); drag = { x: p.x, y: p.y }; } };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { mouse.in = false; whereDirty = true; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); fly = null;
  const f = Math.exp(clamp(e.deltaY, -120, 120) * (e.ctrlKey ? 0.01 : 0.0022));
  zoomAt(e.clientX, e.clientY, f);
}, { passive: false });
function zoomAt(sx, sy, f) {
  updateCamera(); const [ax, az] = screenToGround(sx, sy);
  view.mpp = clamp(view.mpp * f, 0.06, 45); updateCamera();
  const [bx, bz] = screenToGround(sx, sy);
  view.tx += ax - bx; view.tz += az - bz; clampView(); dirty = true; lastInteract = performance.now();
}
const mouse = { x: 0, y: 0, in: false }; let whereDirty = true;
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target === qEl) return;
  const k = e.key.toLowerCase();
  if (k === 'q') rotateBy(Math.PI / 2);
  else if (k === 'e') rotateBy(-Math.PI / 2);
  else if (k === 'n') setTime(todName === 'night' ? 'noon' : 'night');
  else if (k === 't') { const o = ['morning', 'noon', 'golden', 'night']; setTime(o[(o.indexOf(todName) + 1) % 4]); }
  else if (k === 'm') bigmap.classList.contains('show') ? bigmap.classList.remove('show') : openBigMap();
  else if (k === 'escape') bigmap.classList.remove('show');
  else if (k === '/') { e.preventDefault(); qEl.focus(); }
  else if (k === '+' || k === '=') zoomAt(innerWidth / 2, innerHeight / 2, 0.7);
  else if (k === '-' || k === '_') zoomAt(innerWidth / 2, innerHeight / 2, 1.4);
  else keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
function stepKeys(dt) {
  let dx = 0, dy = 0;
  if (keys.has('w') || keys.has('arrowup')) dy += 1; if (keys.has('s') || keys.has('arrowdown')) dy -= 1;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1; if (keys.has('d') || keys.has('arrowright')) dx += 1;
  if (!dx && !dy) return false;
  const sp = 700 * view.mpp * dt, ca = Math.cos(view.az), sa = Math.sin(view.az);
  view.tx += ca * dx * sp - sa * dy * sp / Math.sin(EL) * 0.5; view.tz += -sa * dx * sp - ca * dy * sp / Math.sin(EL) * 0.5;
  clampView(); lastInteract = performance.now(); return true;
}
$('bRotL').onclick = () => rotateBy(Math.PI / 2);
$('bRotR').onclick = () => rotateBy(-Math.PI / 2);
$('bIn').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.6);
$('bOut').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.65);
const toggle = (id, key, after) => { $(id).onclick = () => { settings[key] = !settings[key]; $(id).classList.toggle('on', settings[key]); after && after(); dirty = true; }; };
toggle('bShadow', 'shadows'); toggle('bTrees', 'trees'); toggle('bLabels', 'labels');
toggle('bRetro', 'retro', () => {
  const pr = settings.retro ? 0.34 : basePR; renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false); composer.setSize(innerWidth, innerHeight); canvas.classList.toggle('retro', settings.retro);
});
document.querySelectorAll('#timebar button').forEach((b) => (b.onclick = () => setTime(b.dataset.t)));
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false); composer.setSize(innerWidth, innerHeight); bloom.setSize(innerWidth, innerHeight); dirty = true;
});

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), lastRender = 0, ready = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (!ready) return;
  U.uTime.value = now / 1000;
  let changed = stepAnims(dt) | stepKeys(dt);
  if (stepTod(dt)) changed = true;
  if (changed) dirty = true;
  if (dirty) {
    clampView(); updateCamera();
    const Q = visibleQuad();
    updateSunDir(); updateLOD(Q); fitShadow(Q); updateLabels(); drawRadar(Q);
    whereDirty = true;
  }
  const built = runQueue(dirty ? 6 : 12);
  if (whereDirty) {
    const [x, z] = mouse.in && !drag ? screenToGround(mouse.x, mouse.y) : [view.tx, view.tz];
    updateWhere(x, z); whereDirty = false;
    const hov = mouse.in && !drag && view.mpp < 3 ? deckUnder(mouse.x, mouse.y) : -1;
    if (hov !== U.uHover.value) { U.uHover.value = hov; dirty = true; renderer.shadowMap.needsUpdate = true; }
  }
  const idle = now - lastInteract > 1500 && todT >= 1;
  const minGap = idle ? (U.uNight.value > 0.5 ? 66 : 80) : 0;
  if (dirty || built) renderer.shadowMap.needsUpdate = true;
  if (dirty || built || now - lastRender > minGap) {
    if (U.uNight.value > 0.02) { bloom.strength = 0.85 * U.uNight.value; composer.render(); } else renderer.render(scene, cam);
    lastRender = now;
  }
  dirty = false;
}

// ---------------------------------------------------------------- boot
async function boot() {
  setProgress(0.02, 'Loading city plan…');
  META = await (await fetch('data/meta.json', { cache: 'no-store' })).json();
  PAL = META.palette.map(([w, r, ws]) => ({ w: hexLin8(w), r: hexLin8(r), ws }));
  for (const w of META.wards) { if (w.name === 'S.P.Stadium') w.name = 'Stadium'; if (w.name === 'Kubernagr') w.name = 'Kubernagar'; }
  const o = META.origin;
  for (const [nm, lat, lon] of [['Bopal', 23.0335, 72.4645], ['Shela', 23.0065, 72.4545], ['Ghuma', 23.0425, 72.4445], ['Sola', 23.0790, 72.5180], ['Narol', 22.9725, 72.5940], ['Aslali', 22.9195, 72.5985]])
    EXTRA_AREAS.push({ name: nm, x: (lon - o.lon) * o.kx, z: -(lat - o.lat) * o.ky });
  initMapCanvas(); initDetailGeos();
  const s = META.sizes; const tot = s.bld + s.roads + s.ground;
  let got = { bld: 0, roads: 0, ground: 0 };
  const prog = (k) => (p) => { got[k] = p * s[k]; setProgress(0.04 + 0.5 * (got.bld + got.roads + got.ground) / tot, `Downloading city data… ${((got.bld + got.roads + got.ground) / 1048576).toFixed(1)} / ${(tot / 1048576).toFixed(1)} MB`); };
  [BUF.bld, BUF.roads, BUF.ground] = await Promise.all([fetchBin('bld', s.bld, prog('bld')), fetchBin('roads', s.roads, prog('roads')), fetchBin('ground', s.ground, prog('ground'))]);
  setProgress(0.56, 'Laying water, parks and rail…'); await tick();
  buildGround();
  setProgress(0.6, `Paving ${META.counts.roads.toLocaleString()} road segments…`); await tick();
  buildRoads();
  await buildFarBuildings(0.62, 0.36);
  initLabels(); initSearch();
  $('stats').innerHTML = `${META.counts.buildings.toLocaleString()} buildings · ${META.counts.roads.toLocaleString()} road segments<br>${(META.counts.trees / 1000).toFixed(0)}k trees · ${(META.counts.props / 1000).toFixed(0)}k rooftop tanks &amp; stair-rooms`;
  // start: city overview, then swoop to the riverfront
  view.tx = 0; view.tz = 0; view.mpp = 26; view.az = Math.PI / 4;
  applyTod(tod);
  ready = true; dirty = true;
  try { sessionStorage.removeItem('amd-retry'); } catch (_) {}
  setProgress(1, 'Ready');
  $('loader').classList.add('hide');
  const [sx, sz] = [(72.5745 - o.lon) * o.kx, -(23.0255 - o.lat) * o.ky];
  setTimeout(() => flyTo(sx, sz, 1.25, 3.2), 500);
  setTimeout(() => ($('help').style.opacity = 0), 14000);
  // stream detail layers in the background
  const later = async (k) => { BUF[k] = await fetchBin(k, s[k]); dirty = true; };
  later('cells').then(() => later('trees')).then(() => later('props')).catch((e) => showErr('Detail layer failed: ' + e.message));
}
window.AMD = { STATS, view, flyTo, setTime, settings, sun, renderer, TIMES, get tod() { return tod; }, stopFly: () => { fly = null; }, poke: () => { dirty = true; }, chunks, get queue() { return queue.length; } };
requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  // one automatic retry: a half-updated browser cache is the usual cause after a redeploy
  let retried = false; try { retried = sessionStorage.getItem('amd-retry') === '1'; if (!retried) sessionStorage.setItem('amd-retry', '1'); } catch (_) { retried = true; }
  if (!retried) { location.reload(); return; }
  showErr('Failed to start: ' + e.message + ' — try a hard refresh (Ctrl/Cmd+Shift+R).');
});

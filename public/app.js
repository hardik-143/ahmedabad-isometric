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
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
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
  uSunCol: { value: new THREE.Color(1, 1, 1) }, uHover: { value: -1 }, uFlow: { value: 0 }, uMpp: { value: 26 },
  uWind: { value: new THREE.Vector2(0.6, -0.8) },   // smoke drifts north-east, on the prevailing south-westerly
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
  vHead: 'attribute vec4 aInfo; varying vec4 vInfo; varying vec3 vWN;',
  vBody: 'vInfo = aInfo; vWN = normal;',
  fHead: 'varying vec4 vInfo; varying vec3 vWN;',
  fColor: `
  float ws = vInfo.x; float fl = vInfo.y; int W = int(ws + 0.5);
  vec3 wn = normalize(vWN);
  float isWall = 1.0 - step(0.6, abs(wn.y));
  float topH = fl*3.1 + 0.5;
  float litW = 0.0, glowW = 0.0;
  if (W != 8) {
    // contact darkening at the base of walls, parapet band at the top
    diffuseColor.rgb *= mix(1.0, mix(0.70, 1.0, smoothstep(0.0, 4.5, vWPos.y)), isWall);
    if (W < 4) diffuseColor.rgb *= mix(1.0, 1.0 - 0.10*step(topH-0.55, vWPos.y), isWall);
    if (W != 6) diffuseColor.rgb *= mix(1.0, 0.94 + 0.10*vnoise(mod(vWPos.xz*0.9, 1024.0)), 1.0-isWall);
  }
  if (isWall > 0.5 && W >= 1 && W <= 3) {
    vec2 t = normalize(vec2(-wn.z, wn.x));
    float u = dot(vWPos.xz, t);
    bool glassT = W == 2;
    float cw = glassT ? 1.55 : (W == 3 ? 2.6 : 3.1);
    float fu = u / cw; float col = floor(fu); float xu = fract(fu);
    float fy = vWPos.y / 3.1; float row = floor(fy); float yv = fract(fy);
    float px = fwidth(u);
    float aa = clamp(px / cw, 0.002, 0.2);
    float wx, wy;
    if (glassT) { wx = smoothstep(0.05, 0.05+aa, xu)*(1.0-smoothstep(0.95-aa, 0.95, xu)); wy = smoothstep(0.10, 0.10+aa*1.5, yv)*(1.0-smoothstep(0.90-aa*1.5, 0.90, yv)); }
    else { wx = smoothstep(0.24, 0.24+aa, xu)*(1.0-smoothstep(0.76-aa, 0.76, xu)); wy = smoothstep(0.30, 0.30+aa*1.5, yv)*(1.0-smoothstep(0.80-aa*1.5, 0.80, yv)); }
    float wallId = floor(dot(vWPos.xz, wn.xz)*0.5 + 0.5);
    float rnd = h21(vec2(col*1.37 + wallId*7.13, row*2.11 + fl*3.7));
    if (W == 3) wx *= step(0.18, h21(vec2(col, wallId)));
    float inFacade = step(0.6, vWPos.y) * (1.0 - step(topH - 0.8, vWPos.y));
    float win = wx * wy * inFacade;
    // ground floor: a door (or a shop shutter) every few bays instead of a window
    float isDoor = (1.0 - step(1.0, row)) * step(h21(vec2(col * 0.71 + wallId, 5.3)), glassT ? 0.0 : 0.3);
    float dx0 = smoothstep(0.30, 0.30+aa, xu)*(1.0-smoothstep(0.70-aa, 0.70, xu));
    float door = isDoor * dx0 * (1.0 - smoothstep(0.74, 0.74+aa*1.5, yv));
    win *= 1.0 - isDoor;
    float detail = 1.0 - smoothstep(0.3, 0.85, px);
    vec3 glass = glassT ? vec3(0.30, 0.42, 0.52) + 0.08*h21(vec2(col,row)) : vec3(0.22, 0.25, 0.29) + 0.07*h21(vec2(col,row));
    glass = pow(glass, vec3(2.2));
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85 * detail);
    vec3 doorC = h21(vec2(col, wallId + 1.0)) < 0.5 ? pow(vec3(0.32, 0.22, 0.14), vec3(2.2)) : pow(vec3(0.42, 0.44, 0.46), vec3(2.2)) * (0.85 + 0.15*step(0.5, fract(vWPos.y * 6.0)));
    diffuseColor.rgb = mix(diffuseColor.rgb, doorC, door * detail);
    float on = step(rnd, 0.40);
    litW = win * on * detail;
    glowW = 0.40 * (glassT ? 0.6 : 0.2) * inFacade * (0.55 + 0.5*h21(vec2(floor(vWPos.y/3.1), wallId))) * (1.0 - detail);
  } else if (isWall > 0.5 && W == 10) {
    vec2 t = normalize(vec2(-wn.z, wn.x));
    float u = dot(vWPos.xz, t); float y = vWPos.y;
    float px = fwidth(u); float det = 1.0 - smoothstep(0.3, 0.9, px);
    vec3 c = diffuseColor.rgb * (0.92 + 0.08 * step(0.5, fract(u / 0.9)));
    float clere = step(topH - 1.7, y) * step(y, topH - 0.7) * step(0.12, fract(u / 1.6));
    c = mix(c, pow(vec3(0.26, 0.32, 0.38), vec3(2.2)), clere * det);
    float bay = floor(u / 14.0); float bx = fract(u / 14.0) * 14.0;
    float shut = step(5.0, bx) * step(bx, 9.0) * step(y, 4.4) * step(h21(vec2(bay, floor(dot(vWPos.xz, wn.xz)))), 0.6);
    c = mix(c, pow(vec3(0.50, 0.52, 0.54), vec3(2.2)) * (0.8 + 0.2 * step(0.5, fract(y * 5.0))), shut * det);
    float pdoor = step(1.5, bx) * step(bx, 2.5) * step(y, 2.2) * (1.0 - shut);
    c = mix(c, pow(vec3(0.20, 0.22, 0.25), vec3(2.2)), pdoor * det);
    diffuseColor.rgb = c;
    litW = clere * det * step(0.6, h21(vec2(floor(u / 1.6), 3.0)));
  } else if (W == 6) {
    // Mangalore-tile roof: courses down the slope, staggered rolls across, grime, darker ridge cap
    vec2 sd = normalize(wn.xz + vec2(1e-5, 0.0));
    vec2 td = vec2(-sd.y, sd.x);
    float s = dot(vWPos.xz, sd), tt = dot(vWPos.xz, td);
    float course = s / 0.33; float ci = floor(course); float cf = fract(course);
    float tcol = tt / 0.24 + 0.5*mod(ci, 2.0); float ti = floor(tcol); float tf = fract(tcol);
    float det = 1.0 - smoothstep(0.22, 0.55, max(fwidth(course), fwidth(tcol)));
    float roll = 0.80 + 0.26*sin(tf*6.2832);
    float lip = 1.0 - 0.38*smoothstep(0.80, 1.0, cf);
    float tv = 0.86 + 0.28*h21(vec2(ti, ci));
    vec3 c = diffuseColor.rgb * mix(0.95, roll*lip*tv, det);
    c *= 0.74 + 0.34*fbm(mod(vWPos.xz*0.45, 512.0));
    float ridgeY = topH + vInfo.z*0.1;
    c = mix(c, c*0.62, step(ridgeY - 0.14, vWPos.y));
    // the odd house has patched the tiles with a tin sheet
    float hs = h21(floor(vWPos.xz / 4.0) + 0.5);
    float tin = step(0.93, hs) * step(0.3, fract(tt*0.11 + hs*5.0));
    c = mix(c, pow(vec3(0.55,0.58,0.60), vec3(2.2)) * (0.85 + 0.15*step(0.5, fract(tt/0.12))), tin);
    diffuseColor.rgb = c;
  } else if (isWall > 0.5 && (W == 4 || W == 5 || W == 7 || W == 9)) {
    // ---------------- pol house walls
    vec2 t = normalize(vec2(-wn.z, wn.x));
    float L = vInfo.w * 0.1; float uL = vInfo.z * 0.1;
    float uW = dot(vWPos.xz, t);
    if (L < 0.05) { L = 4.0; uL = mod(uW, 4.0); }
    float y = vWPos.y;
    float seed = h21(floor((vWPos.xz + t*uL) * 2.0) + vec2(0.37, 0.71));
    float seed2 = fract(seed * 13.7), seed3 = fract(seed * 71.3);
    float pxu = fwidth(uL) + 1e-4;
    float det = 1.0 - smoothstep(0.22, 0.5, pxu);
    vec3 base = diffuseColor.rgb;
    vec3 wood = pow(vec3(0.38, 0.24, 0.13), vec3(2.2));
    vec3 teakW = pow(vec3(0.55, 0.37, 0.20), vec3(2.2));
    vec3 frameL = pow(vec3(0.86, 0.74, 0.52), vec3(2.2));
    vec3 woodD = pow(vec3(0.20, 0.12, 0.07), vec3(2.2));
    bool teak = seed < 0.30;
    vec3 c = base;
    // lime-wash weathering: soft vertical rain streaks, greyer near the ground
    c *= 0.84 + 0.16*smoothstep(0.15, 0.85, fbm(mod(vec2(uW*1.4, y*0.22), 512.0)));
    c *= mix(0.82, 1.0, smoothstep(0.2, 1.4, y));
    if (W == 4) {
      float nb = max(1.0, floor(L / 1.9 + 0.5)); float bw = L / nb;
      float bx = fract(uL / bw); float bi = floor(uL / bw);
      float fy = (y - 3.1) / 3.1; float row = floor(fy); float yv = fract(fy) * 3.1;
      if (teak) c = teakW * (0.82 + 0.28*vnoise(mod(vec2(uL*5.0, y*14.0), 1024.0)));
      // carved floor beam with dentils, pilasters between bays
      float beam = step(yv, 0.34);
      float dent = step(0.5, fract(uL / 0.21)) * step(yv, 0.15);
      c = mix(c, teak ? mix(frameL, wood, dent) : mix(wood, woodD, dent), beam * det + beam * (1.0 - det) * 0.6);
      float pil = 1.0 - smoothstep(0.06, 0.09, min(bx, 1.0 - bx) * bw);
      c = mix(c, teak ? wood : c * 0.86, pil * (1.0 - beam) * det);
      // window per bay: carved frame, arched head on some houses, louvred shutters in the house colour
      float dxm = abs(bx * bw - bw * 0.5);
      float ww = min(1.05, bw * 0.56);
      bool arch = seed3 < 0.45;
      float r1 = ww * 0.5, r2 = ww * 0.5 + 0.09;
      float topIn = arch ? 1.95 + sqrt(max(0.0, r1*r1 - dxm*dxm)) : 2.3;
      float topFr = arch ? 1.95 + sqrt(max(0.0, r2*r2 - dxm*dxm)) : 2.39;
      float inW = step(dxm, r1) * step(0.64, yv) * step(yv, topIn);
      float frame = step(dxm, r2) * step(0.55, yv) * step(yv, topFr) * (1.0 - inW);
      vec3 sh = seed2 < 0.25 ? vec3(0.12,0.40,0.38) : seed2 < 0.45 ? vec3(0.15,0.29,0.52) : seed2 < 0.62 ? vec3(0.20,0.43,0.22) : seed2 < 0.82 ? vec3(0.40,0.25,0.13) : vec3(0.46,0.14,0.12);
      if (teak && seed2 >= 0.62 && seed2 < 0.82) sh = vec3(0.10, 0.42, 0.45);   // no brown shutters on a brown wall
      sh = pow(sh, vec3(2.2));
      float open = step(h21(vec2(bi * 3.1 + seed * 91.0, row * 1.7 + fl)), 0.38);
      vec3 shut = sh * (0.80 + 0.20*step(0.5, fract(yv * 7.5))) * (1.0 - 0.45*(1.0 - smoothstep(0.015, 0.035, dxm)));
      vec3 dark = pow(vec3(0.08, 0.07, 0.07), vec3(2.2));
      vec3 win = mix(shut, dark, open);
      c = mix(c, teak ? frameL : wood, frame * det);
      c = mix(c, win, inW * det);
      // little sunshade (chhajja) shadow over each window
      c *= 1.0 - 0.25 * step(topFr, yv) * step(yv, topFr + 0.12) * step(dxm, r2 + 0.1) * det;
      // dark fascia board under the eaves
      c = mix(c, woodD, step(topH - 0.30, y));
      c = mix(c, c * 0.78, (1.0 - det) * 0.55);
      litW = inW * open * step(h21(vec2(bi + seed * 17.0, row)), 0.65) * det;
      glowW = 0.07 * (1.0 - det) * step(3.1, y) * step(y, topH - 0.4);
    } else if (W == 7) {
      // recessed ground floor behind the otla: carved door in the middle, barred windows either side
      float mid = abs(uL - L * 0.5);
      float door = step(mid, 0.56) * step(y, 2.25);
      float dfr = step(mid, 0.72) * step(y, 2.42) * (1.0 - door);
      vec3 dc = wood * (0.80 + 0.30*step(0.5, fract(y * 2.4))) * (0.85 + 0.25*step(0.06, abs(uL - L * 0.5)));
      dc = mix(dc, pow(vec3(0.72, 0.58, 0.30), vec3(2.2)), step(0.82, fract(y * 4.0)) * step(0.82, fract(uL * 4.0)));
      float wdx = abs(mid - 1.45);
      float sw = step(3.4, L) * step(wdx, 0.40) * step(0.9, y) * step(y, 2.0);
      float bars = step(0.5, fract(uL / 0.12));
      c = mix(c, woodD, dfr * det);
      c = mix(c, dc, door * det);
      c = mix(c, mix(pow(vec3(0.07), vec3(2.2)), wood, bars), sw * det);
      c *= mix(0.86, 1.0, step(0.55, y));
      litW = sw * (1.0 - bars) * step(seed2, 0.6) * det;
    } else if (W == 9) {
      // jharokha railing: carved balusters between two rails (cut through)
      float ry = y - 3.2;
      float rail = step(ry, 0.12) + step(0.82, ry);
      if (rail < 0.5 && fract(uL / 0.15) > 0.55 && det > 0.5) discard;
      c = wood * (0.8 + 0.3*vnoise(mod(vec2(uL * 9.0, y * 9.0), 1024.0)));
    } else {
      // side / rear wall: lime plaster with plain shuttered windows (party walls hide in the seam anyway)
      float bw = 2.3; float bi = floor(uW / bw); float bx = fract(uW / bw);
      float fi = floor(y / 3.1); float yv = y - fi * 3.1;
      float dxm = abs(bx - 0.5) * bw;
      float has = step(0.25, h21(vec2(bi + seed * 37.0, fi * 1.3)));
      float inW = step(dxm, 0.40) * step(0.95, yv) * step(yv, 2.15) * step(y, topH - 0.4) * has;
      float fr = step(dxm, 0.48) * step(0.87, yv) * step(yv, 2.25) * step(y, topH - 0.32) * has * (1.0 - inW);
      vec3 sh = seed2 < 0.3 ? vec3(0.12,0.40,0.38) : seed2 < 0.55 ? vec3(0.15,0.29,0.52) : seed2 < 0.8 ? vec3(0.40,0.25,0.13) : vec3(0.20,0.43,0.22);
      sh = pow(sh, vec3(2.2));
      float open = step(h21(vec2(bi * 1.7 + seed * 11.0, fi)), 0.35);
      vec3 win = mix(sh * (0.80 + 0.20*step(0.5, fract(yv * 7.5))) * (1.0 - 0.45*(1.0 - smoothstep(0.015, 0.035, dxm))), pow(vec3(0.08), vec3(2.2)), open);
      c = mix(c, wood, fr * det);
      c = mix(c, win, inW * det);
      c *= 1.0 - 0.22 * step(2.25, yv) * step(yv, 2.37) * step(dxm, 0.55) * has * det * step(y, topH - 0.3);
      c = mix(c, c * 0.84, step(topH - 0.22, y) * step(y, topH + 0.02));
      litW = inW * open * step(h21(vec2(bi + 3.0, fi + seed)), 0.6) * det;
    }
    diffuseColor.rgb = c;
  }
  if (W == 8) diffuseColor.rgb *= 0.9 + 0.12*vnoise(mod(vWPos.xz*4.0 + vWPos.y*3.0, 1024.0));
  vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.92, 1.0), step(0.85, h21(floor(vWPos.xz*0.7) + floor(vWPos.y/3.1))));
  xEm = (litW + glowW) * warm * 1.55 * uNight;`,
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
const WATER_FC = `
  vec2 p = vWPos.xz;
  float n = fbm(mod(p*0.004 + vec2(uTime*0.004, uTime*0.002), 512.0));
  vec3 c = mix(vec3(0.13,0.38,0.50), vec3(0.22,0.52,0.60), n);
  float r = vnoise(mod(p*0.33 + vec2(uTime*0.55, uTime*0.31), 1024.0)) * vnoise(mod(p*0.47 - vec2(uTime*0.4, -uTime*0.2), 1024.0));
  c += 0.06*r;
  diffuseColor.rgb = pow(c, vec3(2.2));
  float wdet = 1.0 - smoothstep(0.5, 2.5, length(fwidth(p)));
  xEm = (pow(r, 7.0) * 1.0 * uSunCol * uDay + vec3(0.9,0.55,0.25)*pow(r,4.0)*0.14*uNight) * wdet + vec3(0.025,0.05,0.065)*uDay;`;
const WATER = groundMat(WATER_FC);
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
    vHead: 'attribute vec4 aR; attribute float aM; varying vec4 vR; varying float vM;', vBody: 'vR = aR; vM = aM;',
    fHead: `varying vec4 vR; varying float vM; uniform vec3 uAsph[10]; uniform float uFlow;`,
    uniforms: { uAsph: { value: ASPH } },
    fColor: pass === 0 ? `
      float a = abs(vR.x); float hw = vR.z; float cls = mod(vR.w, 16.0); float br = step(15.5, mod(vR.w, 32.0));
      vec3 c = vec3(0.80,0.77,0.71) * (0.92 + 0.12*vnoise(mod(vWPos.xz*1.3, 1024.0)));
      c = mix(c, vec3(0.92,0.90,0.86), (1.0 - smoothstep(0.18, 0.32, a-hw)) * step(hw, a));
      c = mix(c, vec3(0.70,0.69,0.67), br*0.6);
      c = mix(c, vec3(0.95,0.94,0.91), smoothstep(2.0, 9.0, length(fwidth(vWPos.xz))) * 0.8);
      diffuseColor.rgb = pow(c, vec3(2.2));` : `
      float a = abs(vR.x); float s = vR.y; float hw = vR.z; float cls = mod(vR.w, 16.0); float br = step(15.5, mod(vR.w, 32.0));
      if (a > hw) discard;
      int ci = int(cls + 0.5);
      vec3 c = pow(uAsph[ci], vec3(1.0/2.2));
      c *= 0.92 + 0.12*vnoise(mod(vWPos.xz*0.9, 1024.0)) + 0.04*vnoise(mod(vWPos.xz*7.0, 1024.0));
      float px = fwidth(s);
      float pxa = length(fwidth(vWPos.xz));
      c = mix(c, vec3(0.93,0.92,0.89), smoothstep(2.0, 9.0, pxa) * 0.85);
      float det = (1.0 - smoothstep(0.18, 0.55, px)) * step(0.0, s) * (1.0 - smoothstep(0.15, 0.6, vM));   // no paint on another carriageway
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
      float flw = 0.0, fhd = 0.0, ftl = 0.0; vec3 fcol = vec3(0.0);
      if (uFlow > 0.002 && cls > 2.5 && cls != 7.0 && s >= 0.0 && vM < 0.5) {
        float ow = step(31.5, vR.w);
        float inner = ow > 0.5 ? 0.0 : (cls > 5.5 && hw > 5.8 ? 1.0 : 0.3);
        float span = ow > 0.5 ? 2.0 * hw - 0.8 : hw - 0.4 - inner;
        float u = ow > 0.5 ? (vR.x + hw - 0.4) / span : (a - inner) / span;
        float dirv = ow > 0.5 ? -1.0 : (vR.x < 0.0 ? 1.0 : -1.0);   // ribbon +x is right of the drawn direction
        if (span > 1.4 && u > 0.0 && u < 1.0) {
          float nl = max(1.0, floor(span / 3.2)), lu = u * nl, li = floor(lu), lc = abs(fract(lu) - 0.5) * span / nl;
          // dashes keep a few pixels of size however far out (a streak of traffic rather than individual cars)
          float pxs = fwidth(s), pxa = fwidth(a);
          float Lc = max(4.4, pxs * 6.0), hwd = min(span / nl * 0.42, max(0.8, pxa * 1.1));
          float spd = 6.0 + cls * 1.3, spc = max(36.0 - cls * 2.0, Lc * 3.2);
          float q = (s - dirv * uTime * spd) / spc + li * 0.37 + dirv * 0.25;
          float cell = floor(q), f = fract(q) * spc, rk = h21(vec2(cell, li * 3.1 + dirv + hw * 1.7));
          float keep = step(rk, 0.4 + cls * 0.05); Lc *= 1.0 + 0.6 * step(0.93, rk);
          float fs = pxs * 0.6 + 0.05, fa = pxa * 0.6 + 0.03;
          flw = keep * (1.0 - smoothstep(hwd - fa, hwd + fa, lc)) * (smoothstep(-fs, fs, f) - smoothstep(Lc - fs, Lc + fs, f)) * uFlow;
          float fr = (dirv > 0.0 ? f : Lc - f) / Lc;   // 0 at the tail end .. 1 at the nose
          fhd = flw * smoothstep(0.55, 0.75, fr); ftl = flw * (1.0 - smoothstep(0.25, 0.45, fr));
          float ck = fract(rk * 13.7);
          fcol = ck < 0.38 ? vec3(0.93) : ck < 0.58 ? vec3(0.66, 0.68, 0.70) : ck < 0.7 ? vec3(0.65, 0.12, 0.10) : ck < 0.8 ? vec3(0.13, 0.25, 0.52) : ck < 0.92 ? vec3(0.95, 0.78, 0.10) : vec3(0.12);
          c = mix(c, mix(fcol, vec3(0.08), uNight * 0.85), flw);
        }
      }
      diffuseColor.rgb = pow(c, vec3(2.2));`,
    fEmissive: pass === 0 ? '' : `
      xEm += (vec3(1.0, 0.93, 0.78) * 2.6 * fhd + vec3(1.0, 0.08, 0.04) * 1.8 * ftl) * uNight;
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
const tankMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'varying vec3 vLN;', vBody: 'vLN = normal;', fHead: 'varying vec3 vLN;',
  fColor: `float top = step(0.7, normalize(vLN).y);
  float ribs = 0.80 + 0.20*smoothstep(0.35, 0.5, abs(fract(vWPos.y * 4.2) - 0.5) * 2.0);
  diffuseColor.rgb *= mix(ribs, 1.3, top);`,
});
const TANK_COLS = ['#1f2124', '#1f2124', '#1f2124', '#26292d', '#e8e4da', '#3a6fb0'].map((h) => new THREE.Color(h));
const mumtyMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
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
  const polT = r.arr(Uint8Array, n), face = r.arr(Uint8Array, n), face2 = r.arr(Uint8Array, n);
  const rA = r.arr(Uint8Array, n), rB = r.arr(Uint8Array, n), rise = r.arr(Uint8Array, n);
  const rl = r.arr(Uint16Array, nR); const co = r.arr(Int16Array, nP * 2);
  // absolute coords per ring
  const abs = new Int16Array(nP * 2);
  let p = 0;
  for (let k = 0; k < nR; k++) {
    let x = 0, z = 0;
    for (let j = 0; j < rl[k]; j++, p++) { x += co[p * 2]; z += co[p * 2 + 1]; abs[p * 2] = x; abs[p * 2 + 1] = z; }
  }
  return { n, nR, nP, floors, style, kind, rc, rl, abs, polT, face, face2, rA, rB, rise };
}

const flat = new Float64Array(2 * 70000);
const yScratch = new Float64Array(4096), dScratch = new Float64Array(4096);
const STATS = { v: 0, t: 0 };
let farLod = null;
function setFarLod(on) {
  if (on === farLod) return; farLod = on;
  for (const ch of chunks) for (const m of ch.reg.concat(ch.blk)) m.geometry.setDrawRange(0, on ? m.userData.far : m.userData.all);
}
// colours for the wooden / stone parts of pol houses (sRGB 0-255)
const TEAK = [96, 62, 36], TEAK_D = [64, 40, 24], OTLA = [[206, 196, 178], [168, 84, 60], [190, 186, 176], [214, 205, 186]];

function buildingMeshes(S, ox, oz, filter, noWindows, out, canvasCtx) {
  const { n, floors, style, kind, rc, rl, abs, polT, face, face2, rA, rB, rise } = S;
  const ringStart = new Uint32Array(n + 1), ptStart = new Uint32Array(n + 1);
  let rr = 0, pp = 0;
  for (let i = 0; i < n; i++) { ringStart[i] = rr; ptStart[i] = pp; for (let k = 0; k < rc[i]; k++) pp += rl[rr++]; }
  ringStart[n] = rr; ptStart[n] = pp;
  const est = (j) => {
    const np = ptStart[j + 1] - ptStart[j];
    return polT[j] ? [6 * np + 420, 12 * np + 760] : [5 * np, 6 * np + 3 * (np + 2 * (rc[j] - 1))];
  };
  let i = 0;
  while (i < n) {
    let vc = 0, ic = 0, j = i;
    for (; j < n; j++) {
      if (!filter(kind[j])) continue;
      const [nv, ni] = est(j);
      if (vc + nv > 65000 && vc > 0) break;
      vc += nv; ic += ni;
    }
    if (vc === 0) { i = j; continue; }
    const pos = new Int16Array(vc * 3), nor = new Int8Array(vc * 3), col = new Uint8ClampedArray(vc * 3), info = new Uint8Array(vc * 4);
    const idxR = new Uint16Array(ic), idxT = new Uint16Array(ic), idxS = new Uint16Array(ic);
    let v = 0, qr = 0, qt = 0, qs = 0;
    const V = (x, y, z, nx, ny, nz, c, i0, i1, i2, i3) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
      info[v * 4] = i0; info[v * 4 + 1] = i1; info[v * 4 + 2] = i2; info[v * 4 + 3] = i3;
      return v++;
    };
    // quad into the small-building wall list; corners in order around the face, normal given (Int8 units)
    const Q = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, c, ws, fl, ua, ub, L) => {
      const vb = v;
      V(ax, ay, az, nx, ny, nz, c, ws, fl, ua, L); V(bx, by, bz, nx, ny, nz, c, ws, fl, ub, L);
      V(cx, cy, cz, nx, ny, nz, c, ws, fl, ub, L); V(dx, dy, dz, nx, ny, nz, c, ws, fl, ua, L);
      // winding: make the geometric normal agree with the given one
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
      if (gx * nx + gy * ny + gz * nz >= 0) { idxS[qs++] = vb; idxS[qs++] = vb + 1; idxS[qs++] = vb + 2; idxS[qs++] = vb; idxS[qs++] = vb + 2; idxS[qs++] = vb + 3; }
      else { idxS[qs++] = vb; idxS[qs++] = vb + 2; idxS[qs++] = vb + 1; idxS[qs++] = vb; idxS[qs++] = vb + 3; idxS[qs++] = vb + 2; }
    };
    const vbox = (cx, cz, ux, uz, ha, hc, y0, y1, c) => {   // vertical box (sides only)
      const vx = -uz, vz = ux, P = (sa, sc) => [cx + ux * ha * sa + vx * hc * sc, cz + uz * ha * sa + vz * hc * sc];
      const s = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let k = 0; k < 4; k++) {
        const [a1, c1] = s[k], [a2, c2] = s[(k + 1) % 4];
        const p = P(a1, c1), q = P(a2, c2);
        const mx = (a1 + a2) / 2, mc = (c1 + c2) / 2;
        const nx = Math.round((ux * mx + vx * mc) * 127), nz = Math.round((uz * mx + vz * mc) * 127);
        Q(p[0], y0, p[1], q[0], y0, q[1], q[0], y1, q[1], p[0], y1, p[1], nx, 0, nz, c, 8, 1, 0, 0, 0);
      }
    };
    for (let b = i; b < j; b++) {
      if (!filter(kind[b])) continue;
      const fl = floors[b];
      const H = fl * 31 + 5;
      const pal = PAL[style[b]];
      const jit = 0.93 + 0.12 * hash1(b * 7919 + ox);
      const wc = [pal.w[0] * jit, pal.w[1] * jit, pal.w[2] * jit];
      const r0 = ringStart[b], r1 = ringStart[b + 1];
      const p0 = ptStart[b], np = ptStart[b + 1] - p0;
      if (polT[b]) {
        // ------------------------------------------------ pol house
        const T = polT[b], m = rl[r0];
        const gable = T === 2 && r1 - r0 === 1;
        const f = face[b] < m ? face[b] : -1, f2 = face2[b] < m ? face2[b] : -1;
        const X = (k) => abs[(p0 + k) * 2], Z = (k) => abs[(p0 + k) * 2 + 1];
        const RISE = rise[b];
        let ia = 0, ib = 0, nrx = 0, nrz = 0, dA = 1, dB = 1, front = 0;
        if (gable) {
          ia = rA[b]; ib = rB[b];
          const wx = X(ib) - X(ia), wz = Z(ib) - Z(ia), wl = Math.hypot(wx, wz) || 1;
          nrx = -wz / wl; nrz = wx / wl;
          dA = 1e-3; dB = 1e-3;
          for (let k = 0; k < m; k++) {
            const d = (X(k) - X(ia)) * nrx + (Z(k) - Z(ia)) * nrz; dScratch[k] = d;
            if (d > 0) dA = Math.max(dA, d); else dB = Math.max(dB, -d);
          }
          for (let k = 0; k < m; k++) { const d = dScratch[k]; yScratch[k] = H + RISE * (1 - Math.abs(d) / (d > 0 ? dA : dB)); }
          if (f >= 0) { const fm = ((X(f) + X((f + 1) % m)) / 2 - X(ia)) * nrx + ((Z(f) + Z((f + 1) % m)) / 2 - Z(ia)) * nrz; front = fm > 0 ? 1 : -1; }
        } else for (let k = 0; k < m; k++) yScratch[k] = H;
        // walls (all rings; only the outer ring has a gable profile / facade)
        let pt = p0;
        for (let k = r0; k < r1; k++) {
          const mm = rl[k], outer = k === r0;
          for (let e = 0; e < mm; e++) {
            const a = (pt + e) * 2, c2 = (pt + ((e + 1) % mm)) * 2;
            const ax = abs[a], az = abs[a + 1], bx = abs[c2], bz = abs[c2 + 1];
            const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
            const onx = -dz / L, onz = dx / L, nx = Math.round(onx * 127), nz = Math.round(onz * 127);
            const ya = outer ? yScratch[e] : H, yb = outer ? yScratch[(e + 1) % mm] : H;
            const Lq = L <= 255 ? Math.round(L) : 0;
            if (outer && e === f) {
              // street facade: recessed ground floor behind an otla, upper floors carried on wooden posts
              let depth = 0;
              for (let k2 = 0; k2 < mm; k2++) depth = Math.max(depth, -((abs[(pt + k2) * 2] - ax) * onx + (abs[(pt + k2) * 2 + 1] - az) * onz));
              const G = 31;
              if (fl >= 2 && depth >= 45 && L >= 22) {
                const D = Math.max(7, Math.min(11, depth * 0.22));
                const ix = -onx * D, iz = -onz * D;
                Q(ax, G, az, bx, G, bz, bx, yb, bz, ax, ya, az, nx, 0, nz, wc, 4, fl, 0, Lq, Lq);                       // upper facade
                Q(ax + ix, 0, az + iz, bx + ix, 0, bz + iz, bx + ix, G, bz + iz, ax + ix, G, az + iz, nx, 0, nz, wc, 7, fl, 0, Lq, Lq); // recessed ground wall
                Q(ax, G, az, bx, G, bz, bx + ix, G, bz + iz, ax + ix, G, az + iz, 0, -127, 0, TEAK_D, 8, fl, 0, 0, 0);        // soffit
                const oc = OTLA[(b * 13 + 5) % OTLA.length], OT = 5, ox2 = onx * 2, oz2 = onz * 2;
                Q(ax + ix, OT, az + iz, bx + ix, OT, bz + iz, bx + ox2, OT, bz + oz2, ax + ox2, OT, az + oz2, 0, 127, 0, oc, 8, fl, 0, 0, 0); // otla top
                Q(ax + ox2, 0, az + oz2, bx + ox2, 0, bz + oz2, bx + ox2, OT, bz + oz2, ax + ox2, OT, az + oz2, nx, 0, nz, [oc[0] * 0.8, oc[1] * 0.8, oc[2] * 0.8], 8, fl, 0, 0, 0);
                const ncol = Math.max(2, Math.min(7, Math.round(L / 24) + 1)), ux = dx / L, uz = dz / L;
                for (let c = 0; c < ncol; c++) {
                  const t = 0.07 + 0.86 * c / (ncol - 1);
                  const px = ax + dx * t - onx * 1.6, pz = az + dz * t - onz * 1.6;
                  vbox(px, pz, ux, uz, 1.1, 1.1, OT, G - 3, TEAK);
                  vbox(px, pz, ux, uz, 1.7, 1.7, G - 3, G, TEAK_D);   // carved capital / bracket block
                }
                if (hash1(b * 31 + 7) < 0.4 && L >= 30) {   // jharokha: projecting wooden balcony on the first floor
                  const bw = Math.min(40, Math.max(16, L * 0.45)) / 2, t0 = 0.5 - bw / L, t1 = 0.5 + bw / L, BD = 6, y0 = G + 1, y1 = G + 11;
                  const qa = [ax + dx * t0, az + dz * t0], qb = [ax + dx * t1, az + dz * t1];
                  const fa = [qa[0] + onx * BD, qa[1] + onz * BD], fb = [qb[0] + onx * BD, qb[1] + onz * BD];
                  const bl = Math.round(bw * 2);
                  Q(fa[0], y0, fa[1], fb[0], y0, fb[1], fb[0], y1, fb[1], fa[0], y1, fa[1], nx, 0, nz, TEAK, 9, fl, 0, bl, bl);
                  const sx = Math.round(dx / L * 127), sz = Math.round(dz / L * 127);
                  Q(qb[0], y0, qb[1], fb[0], y0, fb[1], fb[0], y1, fb[1], qb[0], y1, qb[1], sx, 0, sz, TEAK, 9, fl, 0, BD, BD);
                  Q(fa[0], y0, fa[1], qa[0], y0, qa[1], qa[0], y1, qa[1], fa[0], y1, fa[1], -sx, 0, -sz, TEAK, 9, fl, 0, BD, BD);
                  Q(qa[0], y0, qa[1], qb[0], y0, qb[1], fb[0], y0, fb[1], fa[0], y0, fa[1], 0, -127, 0, TEAK_D, 8, fl, 0, 0, 0);
                  Q(qa[0], y0 + 1, qa[1], qb[0], y0 + 1, qb[1], fb[0], y0 + 1, fb[1], fa[0], y0 + 1, fa[1], 0, 127, 0, TEAK_D, 8, fl, 0, 0, 0);
                }
                continue;
              }
              Q(ax, 0, az, bx, 0, bz, bx, yb, bz, ax, ya, az, nx, 0, nz, wc, fl >= 2 ? 4 : 7, fl, 0, Lq, Lq);
              continue;
            }
            Q(ax, 0, az, bx, 0, bz, bx, yb, bz, ax, ya, az, nx, 0, nz, wc, outer && e === f2 ? 3 : 5, fl, 0, Lq, Lq);
          }
          pt += mm;
        }
        // roof
        const rcol = [pal.r[0] * jit, pal.r[1] * jit, pal.r[2] * jit];
        if (gable) {
          for (const side of [1, -1]) {
            // vertices of this half: from one ridge vertex round to the other
            const s0 = side === 1 ? (dScratch[(ia + 1) % m] > 0 ? ia : ib) : (dScratch[(ia + 1) % m] > 0 ? ib : ia);
            const s1 = s0 === ia ? ib : ia;
            const idx = []; for (let k = s0; ; k = (k + 1) % m) { idx.push(k); if (k === s1) break; if (idx.length > m) break; }
            const dmax = side === 1 ? dA : dB, ov = side === front ? 5 : 0;
            const sl = RISE / dmax, nl = Math.hypot(sl, 1);
            const rnx = Math.round(side * sl * nrx / nl * 127), rny = Math.round(127 / nl), rnz = Math.round(side * sl * nrz / nl * 127);
            const fv = flat.subarray(0, idx.length * 2);
            const vb = v;
            idx.forEach((k, t) => {
              const ad = Math.abs(dScratch[k]), g = ov * ad / dmax;
              const x = X(k) + nrx * side * g, z = Z(k) + nrz * side * g, y = H + RISE * (1 - (ad + g) / dmax);
              fv[t * 2] = x; fv[t * 2 + 1] = z;
              V(Math.round(x), Math.round(y), Math.round(z), rnx, rny, rnz, rcol, 6, fl, RISE, 0);
            });
            const tri = earcut(fv, null, 2);
            for (let t = 0; t < tri.length; t += 3) {
              const A = tri[t], B = tri[t + 1], C = tri[t + 2];
              const cr = (fv[B * 2] - fv[A * 2]) * (fv[C * 2 + 1] - fv[A * 2 + 1]) - (fv[B * 2 + 1] - fv[A * 2 + 1]) * (fv[C * 2] - fv[A * 2]);
              if (cr > 0) { idxR[qr++] = vb + A; idxR[qr++] = vb + C; idxR[qr++] = vb + B; }
              else { idxR[qr++] = vb + A; idxR[qr++] = vb + B; idxR[qr++] = vb + C; }
            }
          }
        } else {
          const agasi = [(pal.w[0] * 0.5 + 196 * 0.5) * jit, (pal.w[1] * 0.5 + 180 * 0.5) * jit, (pal.w[2] * 0.5 + 160 * 0.5) * jit];
          const holes = []; let acc = 0;
          for (let k = r0; k < r1; k++) { if (k > r0) holes.push(acc); acc += rl[k]; }
          const fv = flat.subarray(0, np * 2);
          for (let t = 0; t < np * 2; t++) fv[t] = abs[p0 * 2 + t];
          const tri = earcut(fv, holes.length ? holes : null, 2);
          const vb = v;
          for (let t = 0; t < np; t++) V(fv[t * 2], H, fv[t * 2 + 1], 0, 127, 0, agasi, 0, fl, 0, 0);
          for (let t = 0; t < tri.length; t += 3) {
            const A = tri[t], B = tri[t + 1], C = tri[t + 2];
            const cr = (fv[B * 2] - fv[A * 2]) * (fv[C * 2 + 1] - fv[A * 2 + 1]) - (fv[B * 2 + 1] - fv[A * 2 + 1]) * (fv[C * 2] - fv[A * 2]);
            if (cr > 0) { idxR[qr++] = vb + A; idxR[qr++] = vb + C; idxR[qr++] = vb + B; }
            else { idxR[qr++] = vb + A; idxR[qr++] = vb + B; idxR[qr++] = vb + C; }
          }
        }
        if (canvasCtx) drawFootprint(canvasCtx, abs, r0, r1, rl, p0, ox, oz);
        continue;
      }
      // ------------------------------------------------ ordinary building
      const ws = noWindows ? 0 : pal.ws;
      let pt = p0;
      const tall = fl >= 5;
      const W = tall ? idxT : idxS;
      let q = tall ? qt : qs;
      for (let k = r0; k < r1; k++) {
        const m = rl[k];
        for (let e = 0; e < m; e++) {
          const a = (pt + e) * 2, c = (pt + ((e + 1) % m)) * 2;
          const ax = abs[a], az = abs[a + 1], bx = abs[c], bz = abs[c + 1];
          const dx = bx - ax, dz = bz - az; const L = Math.hypot(dx, dz) || 1;
          const nx = Math.round((-dz / L) * 127), nz = Math.round((dx / L) * 127);
          const vb = v;
          V(ax, 0, az, nx, 0, nz, wc, ws, fl, 0, 0); V(bx, 0, bz, nx, 0, nz, wc, ws, fl, 0, 0);
          V(bx, H, bz, nx, 0, nz, wc, ws, fl, 0, 0); V(ax, H, az, nx, 0, nz, wc, ws, fl, 0, 0);
          W[q++] = vb; W[q++] = vb + 1; W[q++] = vb + 2; W[q++] = vb; W[q++] = vb + 2; W[q++] = vb + 3;
        }
        pt += m;
      }
      if (tall) qt = q; else qs = q;
      const holes = [];
      let acc = 0;
      for (let k = r0; k < r1; k++) { if (k > r0) holes.push(acc); acc += rl[k]; }
      const fv = flat.subarray(0, np * 2);
      for (let t = 0; t < np * 2; t++) fv[t] = abs[p0 * 2 + t];
      const tri = earcut(fv, holes.length ? holes : null, 2);
      const vb = v;
      const rcol = [pal.r[0] * jit, pal.r[1] * jit, pal.r[2] * jit];
      for (let t = 0; t < np; t++) V(abs[(p0 + t) * 2], H, abs[(p0 + t) * 2 + 1], 0, 127, 0, rcol, 0, fl, 0, 0);
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
    g.setAttribute('aInfo', new THREE.BufferAttribute(info.subarray(0, v * 4), 4));
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
function triMeshes(V, I, mat, order) {
  const pos = new Float32Array(V.length);
  for (let i = 0; i < V.length; i++) pos[i] = V[i] * 0.5;
  return flatTiles(pos, {}, I, [[mat, order]]);
}
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
    out.push(...triMeshes(V, I, mat, order));
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
    out.push(...triMeshes(V, I, mat, order));
    mapCtx.fillStyle = color; mapCtx.beginPath();
    for (let t = 0; t < fi; t += 3) { for (let k = 0; k < 3; k++) { const [x, z] = mapXY(V[I[t + k] * 2] * 0.5, V[I[t + k] * 2 + 1] * 0.5); k ? mapCtx.lineTo(x, z) : mapCtx.moveTo(x, z); } mapCtx.closePath(); }
    mapCtx.fill();
  }
  out.push(...flatTiles(pos, { aR: new THREE.BufferAttribute(aR, 2) }, idx, [[RAIL, 3]]));
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
const SEE_THROUGH = '';   // (hover see-through on flyovers removed)
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

// ---------------------------------------------------------------- tiles: split big ground meshes so off-screen parts are culled
const TILE = 1500;
function tileSplit(attrs, index, X, Z, yr, make) {
  const B = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const cx = (X(a) + X(b) + X(c)) / 3, cz = (Z(a) + Z(b) + Z(c)) / 3;
    const k = (Math.floor(cx / TILE) + 2048) * 4096 + (Math.floor(cz / TILE) + 2048);
    let e = B.get(k);
    if (!e) B.set(k, (e = { i: [], x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, mx: 0 }));
    e.i.push(a, b, c);
    for (const q of [a, b, c]) { const x = X(q), z = Z(q); if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x; if (z < e.z0) e.z0 = z; if (z > e.z1) e.z1 = z; if (q > e.mx) e.mx = q; }
  }
  const outM = [];
  for (const e of B.values()) {
    const g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(attrs)) g.setAttribute(n, a);
    g.setIndex(new THREE.BufferAttribute(e.mx > 65535 ? new Uint32Array(e.i) : new Uint16Array(e.i), 1));
    const cx = (e.x0 + e.x1) / 2, cz = (e.z0 + e.z1) / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (yr[0] + yr[1]) / 2, cz), Math.hypot(e.x1 - e.x0, e.z1 - e.z0, yr[1] - yr[0]) / 2 + 1);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(e.x0, yr[0], e.z0), new THREE.Vector3(e.x1, yr[1], e.z1));
    outM.push(...make(g));
  }
  return outM;
}
// flat ground layer (vec2 positions) split into culled tiles
function flatTiles(pos2, extra, index, mats) {
  const attrs = { position: new THREE.BufferAttribute(pos2, 2), ...extra };
  return tileSplit(attrs, index, (i) => pos2[i * 2], (i) => pos2[i * 2 + 1], [0, 0], (g) => mats.map(([mat, ord]) => {
    const m = new THREE.Mesh(g, mat); m.renderOrder = ord; m.receiveShadow = true; m.matrixAutoUpdate = false; return m;
  }));
}

// ---------------------------------------------------------------- walled city: pol gates and chabutros
const POLX = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  fColor: 'diffuseColor.rgb *= 0.9 + 0.12*vnoise(mod(vWPos.xz*3.0 + vWPos.y*2.0, 1024.0));',
});
function cbox(G, cx, cz, ux, uz, ha, hc, y0, y1, col, top = true) {
  const vx = -uz, vz = ux, P = (sa, sc, y) => [cx + ux * ha * sa + vx * hc * sc, y, cz + uz * ha * sa + vz * hc * sc];
  G.quad(P(-1, -1, y0), P(1, -1, y0), P(1, -1, y1), P(-1, -1, y1), [-vx, 0, -vz], col);
  G.quad(P(1, 1, y0), P(-1, 1, y0), P(-1, 1, y1), P(1, 1, y1), [vx, 0, vz], col);
  G.quad(P(1, -1, y0), P(1, 1, y0), P(1, 1, y1), P(1, -1, y1), [ux, 0, uz], col);
  G.quad(P(-1, 1, y0), P(-1, -1, y0), P(-1, -1, y1), P(-1, 1, y1), [-ux, 0, -uz], col);
  if (top) G.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), [0, 1, 0], col);
}
function pyramid(G, cx, cz, ux, uz, h, y0, y1, col) {
  const vx = -uz, vz = ux, A = [cx, y1, cz];
  const P = (sa, sc) => [cx + (ux * sa + vx * sc) * h, y0, cz + (uz * sa + vz * sc) * h];
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < 4; k++) {
    const p = P(...c[k]), q = P(...c[(k + 1) % 4]);
    const mx = (p[0] + q[0]) / 2 - cx, mz = (p[2] + q[2]) / 2 - cz, ml = Math.hypot(mx, mz) || 1, s = h / (y1 - y0);
    const n = [mx / ml, s, mz / ml]; const nl = Math.hypot(...n);
    G.quad(p, q, A, A, n.map((x) => x / nl), col);
  }
}
const C255 = (r, g, b) => [srgbToLin(r), srgbToLin(g), srgbToLin(b)];
function buildPolExtras() {
  const G = new Geo(false);
  const lime = C255(236, 229, 212), teak = C255(96, 62, 36), dark = C255(40, 30, 24), tile = C255(165, 82, 47);
  const pastel = [C255(233, 217, 166), C255(184, 207, 227), C255(207, 224, 207), C255(235, 195, 174), C255(241, 232, 214)];
  for (const [x, z, ux, uz, w] of META.gates || []) {
    const vx = -uz, vz = ux, k = Math.abs(Math.round(x * 7 + z * 13)) % pastel.length, col = pastel[k];
    const half = w + 0.9;
    for (const sg of [1, -1]) cbox(G, x + vx * (w + 0.45) * sg, z + vz * (w + 0.45) * sg, ux, uz, 1.6, 0.45, 0, 3.6, lime, false);
    cbox(G, x, z, ux, uz, 1.7, half, 3.6, 6.6, col);                       // guard room over the gateway (chowki)
    cbox(G, x, z, ux, uz, 1.75, half + 0.05, 3.35, 3.6, teak);              // carved wooden lintel beam
    G.quad([x - vx * w + ux * 1.6, 3.35, z - vz * w + uz * 1.6], [x + vx * w + ux * 1.6, 3.35, z + vz * w + uz * 1.6],
      [x + vx * w - ux * 1.6, 3.35, z + vz * w - uz * 1.6], [x - vx * w - ux * 1.6, 3.35, z - vz * w - uz * 1.6], [0, -1, 0], dark);
    for (const sg of [1, -1]) for (const o of [-0.45, 0.45]) {   // little windows of the guard room, both street faces
      const cx = x + ux * 1.72 * sg + vx * o * half, cz = z + uz * 1.72 * sg + vz * o * half, hw = 0.38;
      G.quad([cx - vx * hw, 4.4, cz - vz * hw], [cx + vx * hw, 4.4, cz + vz * hw], [cx + vx * hw, 5.6, cz + vz * hw], [cx - vx * hw, 5.6, cz - vz * hw], [ux * sg, 0, uz * sg], teak);
    }
    // tiled gable roof, ridge across the lane
    const RO = 0.35, ER = 6.6, RR = 7.7;
    for (const sg of [1, -1]) {
      const e0 = [x + ux * (1.7 + RO) * sg - vx * (half + RO), ER - 0.15, z + uz * (1.7 + RO) * sg - vz * (half + RO)];
      const e1 = [x + ux * (1.7 + RO) * sg + vx * (half + RO), ER - 0.15, z + uz * (1.7 + RO) * sg + vz * (half + RO)];
      const r1 = [x + vx * (half + RO), RR, z + vz * (half + RO)], r0 = [x - vx * (half + RO), RR, z - vz * (half + RO)];
      const s = (RR - ER) / 1.7, nl = Math.hypot(s, 1);
      G.quad(e0, e1, r1, r0, [ux * sg * s / nl, 1 / nl, uz * sg * s / nl], tile);
    }
    for (const sg of [1, -1]) {   // gable triangles
      const a = [x + vx * half * sg + ux * 1.7, 6.6, z + vz * half * sg + uz * 1.7], b = [x + vx * half * sg - ux * 1.7, 6.6, z + vz * half * sg - uz * 1.7], t = [x + vx * half * sg, 7.6, z + vz * half * sg];
      G.quad(a, b, t, t, [vx * sg, 0, vz * sg], col);
    }
  }
  const birds = [C255(86, 168, 92), C255(92, 150, 205), C255(238, 236, 226), C255(232, 190, 82), C255(222, 132, 150), C255(70, 160, 160)];
  for (const [x, z] of META.chabutros || []) {
    const k = Math.abs(Math.round(x * 3 + z * 5)), col = birds[k % birds.length], trim = birds[(k + 3) % birds.length];
    const a = (k % 90) * Math.PI / 180, ux = Math.cos(a), uz = Math.sin(a);
    cbox(G, x, z, ux, uz, 1.1, 1.1, 0, 0.5, C255(205, 196, 178));             // stone plinth
    cbox(G, x, z, ux, uz, 0.75, 0.75, 0.5, 0.85, C255(190, 180, 160));
    cbox(G, x, z, ux, uz, 0.2, 0.2, 0.85, 4.4, col, false);                    // pillar
    cbox(G, x, z, ux, uz, 0.32, 0.32, 3.9, 4.4, trim, false);
    cbox(G, x, z, ux, uz, 1.05, 1.05, 4.4, 4.6, trim);                         // feeding platform
    for (const [sa, sc] of [[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]])
      cbox(G, x + (ux * sa - uz * sc), z + (uz * sa + ux * sc), ux, uz, 0.07, 0.07, 4.6, 5.6, col, false);
    cbox(G, x, z, ux, uz, 0.55, 0.55, 4.6, 5.5, col);                          // the little bird house
    cbox(G, x, z, ux, uz, 1.15, 1.15, 5.6, 5.75, trim);
    pyramid(G, x, z, ux, uz, 1.15, 5.75, 6.7, col);                            // canopy
    cbox(G, x, z, ux, uz, 0.07, 0.07, 6.7, 7.1, trim);                         // finial
  }
  if (!G.p.length) return;
  const m = G.mesh(POLX); m.renderOrder = 10; group.ground.add(m); POLMESH = m;
}
let POLMESH = null;

// ---------------------------------------------------------------- SVPI airport: runway 05/23, taxiways, apron, parked aircraft
const AIRFIELD = (() => {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.depthWrite = false; m.depthTest = false; m.side = THREE.DoubleSide;
  return hook(m, {
    flatGround: true,
    vHead: 'attribute vec4 aR; varying vec4 vR;', vBody: 'vR = aR;',
    fHead: `varying vec4 vR;
    float seg7(int d, vec2 q) {
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
      float t = 0.19;
      float A = step(1.0 - t, q.y), D = step(q.y, t), Gm = step(abs(q.y - 0.5), t * 0.5);
      float Lf = step(q.x, t), Rt = step(1.0 - t, q.x), up = step(0.5, q.y), lo = 1.0 - up;
      float a = A, b = Rt * up, c = Rt * lo, dd = D, e = Lf * lo, f = Lf * up, g = Gm;
      if (d == 0) return max(max(max(a, b), max(c, dd)), max(e, f));
      if (d == 2) return max(max(max(a, b), max(g, e)), dd);
      if (d == 3) return max(max(max(a, b), max(g, c)), dd);
      if (d == 5) return max(max(max(a, f), max(g, c)), dd);
      return 0.0;
    }`,
    fColor: `
    float a = vR.x, s = vR.y; int ty = int(vR.z + 0.5); float P = vR.w;
    vec2 p = vWPos.xz;
    float pxs = length(fwidth(p)); float det = 1.0 - smoothstep(2.5, 6.0, pxs);
    float lw = max(0.0, pxs * 0.35 - 0.3);   // thin lines widen a little when zoomed out instead of vanishing
    float aa = abs(a);
    vec3 c; float white = 0.0, yel = 0.0;
    if (ty == 0) {
      float hw = 22.5; float se = min(s, P - s);
      float conc = clamp(step(s, 330.0) + step(P - 330.0, s), 0.0, 1.0);
      c = mix(vec3(0.29, 0.29, 0.30), vec3(0.60, 0.59, 0.56), conc) * (0.93 + 0.1*vnoise(mod(p*0.5, 1024.0)));
      float tdz = smoothstep(260.0, 420.0, se) * (1.0 - smoothstep(650.0, 1000.0, se));
      c *= 1.0 - 0.45*tdz*(1.0 - smoothstep(2.0, 7.5, abs(aa - 4.5)))*vnoise(mod(vec2(s*0.04, a*1.5), 1024.0));
      if (aa > hw) c = vec3(0.50, 0.48, 0.44) * (0.9 + 0.1*vnoise(mod(p*0.7, 1024.0)));
      if (s < 0.0 || s > P) {
        float sd = s < 0.0 ? -s : s - P;
        c = vec3(0.33, 0.33, 0.33);
        yel += step(fract((sd + aa * 0.7) / 14.0), 0.22) * step(aa, hw);
      } else {
        white += step(6.0, se) * step(se, 36.0) * step(1.5, aa) * step(aa, hw - 2.0) * step(fract((aa - 1.5) / 3.6), 0.5);
        white += step(aa, 0.45 + lw) * step(80.0, se) * step(fract(s / 50.0), 0.6);
        white += step(abs(aa - (hw - 0.6)), 0.45 + lw);
        white += step(abs(se - 422.0), 22.5) * step(abs(aa - 10.5), 3.0);
        for (int k = 0; k < 5; k++) {
          float st = k == 0 ? 150.0 : k == 1 ? 300.0 : k == 2 ? 600.0 : k == 3 ? 750.0 : 900.0;
          float nb = k < 2 ? 3.0 : k < 4 ? 2.0 : 1.0;
          white += step(abs(se - st - 11.25), 11.25) * step(3.0, aa) * step(aa, 3.0 + nb * 2.4) * step(fract((aa - 3.0) / 2.4), 0.62);
        }
        // runway designators: "05" read by aircraft landing towards 23, "23" by those landing towards 05
        float dy0 = (s - 46.0) / 9.0, dy1 = ((P - s) - 46.0) / 9.0;
        white += seg7(0, vec2((3.9 - a) / 3.0, dy0)) + seg7(5, vec2((-0.9 - a) / 3.0, dy0));
        white += seg7(2, vec2((a + 3.9) / 3.0, dy1)) + seg7(3, vec2((a - 0.9) / 3.0, dy1));
      }
    } else if (ty == 1) {
      c = vec3(0.33, 0.33, 0.34) * (0.92 + 0.1*vnoise(mod(p*0.6, 1024.0)) + 0.04*vnoise(mod(p*4.0, 1024.0)));
    } else if (ty == 3) {
      c = vec3(0.47, 0.46, 0.43) * (0.9 + 0.1*vnoise(mod(p*0.7, 1024.0)));
    } else if (ty >= 4) {
      float on = step(aa, P + lw);
      if (ty == 5) on *= step(fract(s / 2.0), 0.5);
      if (on < 0.5) discard;
      c = vec3(0.90, 0.72, 0.16);
      c = mix(vec3(0.33, 0.33, 0.34), c, clamp(det + 0.35, 0.0, 1.0));
    } else {
      c = vec3(0.62, 0.61, 0.58) * (0.9 + 0.12*vnoise(mod(p*0.25, 1024.0)) + 0.05*vnoise(mod(p*3.0, 1024.0)));
      vec2 j = abs(fract(p / 7.5) - 0.5);
      c *= 1.0 - 0.10 * (1.0 - smoothstep(0.47, 0.49, max(j.x, j.y))) * det;
      c *= 1.0 - 0.18 * smoothstep(0.55, 0.9, fbm(mod(p * 0.05, 512.0)));
    }
    c = mix(c, vec3(0.93), clamp(white, 0.0, 1.0) * det);
    c = mix(c, vec3(0.90, 0.72, 0.16), clamp(yel, 0.0, 1.0) * det);
    diffuseColor.rgb = pow(c, vec3(2.2));`,
    fEmissive: `
    if (ty == 0) {
      float edge = step(abs(aa - 22.0), 0.6) * step(fract(s / 60.0), 0.06);
      float cl = step(aa, 0.4) * step(fract(s / 15.0), 0.12);
      xEm += (vec3(1.0, 0.95, 0.8) * edge + vec3(0.9, 0.95, 1.0) * cl * 0.7) * 2.0 * uNight;
    } else if (ty == 4) {
      xEm += vec3(0.2, 0.9, 0.3) * step(0.12, P) * step(fract(s / 15.0), 0.12) * 1.8 * uNight;
    } else if (ty == 1 || ty == 3) {
      xEm += vec3(0.0);
    } else {
      xEm += vec3(1.0, 0.75, 0.45) * 0.10 * uNight;
    }`,
  });
})();
function buildAirport() {
  const A = META.airport; if (!A) return;
  const P = [], R = [], I = [];
  const addTri = (T, ty) => { const b = P.length / 2; for (let k = 0; k < T.v.length; k += 2) { P.push(T.v[k], T.v[k + 1]); R.push(0, 0, ty, 0); } for (const t of T.i) I.push(b + t); };
  // apron (concrete), then shoulders, then filleted taxiway pavement
  { const fv = A.apron.flat(); const tri = earcut(fv, null, 2); const b = P.length / 2;
    for (const [x, z] of A.apron) { P.push(x, z); R.push(0, 0, 2, 0); } for (const t of tri) I.push(b + t); }
  if (A.shoulder) addTri(A.shoulder, 3);
  if (A.pave) addTri(A.pave, 1);
  const quad = (pts, rs) => { const b = P.length / 2; for (let k = 0; k < 4; k++) { P.push(pts[k][0], pts[k][1]); R.push(...rs[k]); } I.push(b, b + 1, b + 2, b, b + 2, b + 3); };
  {
    const [x0, z0, x1, z1, w] = A.rwy, L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, vx = -uz, vz = ux, O = w / 2 + 7.5, E = 60;
    // across coordinate a is positive on the aircraft's left when landing towards 23
    quad([[x0 - ux * E + vx * O, z0 - uz * E + vz * O], [x1 + ux * E + vx * O, z1 + uz * E + vz * O], [x1 + ux * E - vx * O, z1 + uz * E - vz * O], [x0 - ux * E - vx * O, z0 - uz * E - vz * O]],
      [[-O, -E, 0, L], [-O, L + E, 0, L], [O, L + E, 0, L], [O, -E, 0, L]]);
  }
  // markings: ribbons along each polyline (kind 4 solid yellow, 5 dashed yellow), drawn last
  for (const [kind, w, pts] of A.lines || []) {
    const n = pts.length / 2; if (n < 2) continue;
    const hw = w / 2 + 0.9, b = P.length / 2; let s = 0;
    for (let j = 0; j < n; j++) {
      const x = pts[j * 2], z = pts[j * 2 + 1];
      const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
      let dx = pts[j1 * 2] - pts[j0 * 2], dz = pts[j1 * 2 + 1] - pts[j0 * 2 + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (j > 0) s += Math.hypot(x - pts[j * 2 - 2], z - pts[j * 2 - 1]);
      P.push(x - dz * hw, z + dx * hw); R.push(hw, s, kind, w / 2);
      P.push(x + dz * hw, z - dx * hw); R.push(-hw, s, kind, w / 2);
      if (j > 0) { const q = b + (j - 1) * 2; I.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
  }
  const pos = new Float32Array(P), aR = new Float32Array(R);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 2)); g.setAttribute('aR', new THREE.BufferAttribute(aR, 4));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let k = 0; k < P.length; k += 2) { x0 = Math.min(x0, P[k]); x1 = Math.max(x1, P[k]); z0 = Math.min(z0, P[k + 1]); z1 = Math.max(z1, P[k + 1]); }
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2);
  const m = new THREE.Mesh(g, AIRFIELD); m.renderOrder = 3.6; m.receiveShadow = true; group.ground.add(m);
  buildAircraft(A);
  buildAirportWall(A);
}
// perimeter wall: 3 m rendered wall with pilasters, an anti-climb coil along the top and watch towers at intervals
function buildAirportWall(A) {
  if (!A.wall || !A.wall.length) return;
  const G = new Geo(false);
  const wallC = C255(214, 206, 190), pilC = C255(196, 188, 172), coil = C255(78, 80, 84), armC = C255(110, 112, 116), twrC = C255(226, 222, 212), glass = C255(40, 52, 62);
  const H = 3.0, T = 0.15;
  let acc = 0, tacc = 400;
  for (const pts of A.wall) {
    const n = pts.length / 2;
    for (let j = 0; j < n - 1; j++) {
      const x0 = pts[j * 2], z0 = pts[j * 2 + 1], x1 = pts[j * 2 + 2], z1 = pts[j * 2 + 3];
      const L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.05) continue;
      const ux = (x1 - x0) / L, uz = (z1 - z0) / L, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      cbox(G, cx, cz, ux, uz, L / 2 + T, T, 0, H, wallC);
      cbox(G, cx, cz, ux, uz, L / 2, 0.06, H, H + 0.55, armC, false);               // mesh panel of the anti-climb topping
      cbox(G, cx, cz, ux, uz, L / 2, 0.24, H + 0.55, H + 0.95, coil);              // concertina coil
      for (let s = (6 - acc % 6) % 6; s < L; s += 6) {                               // pilasters every 6 m
        const px = x0 + ux * s, pz = z0 + uz * s;
        cbox(G, px, pz, ux, uz, 0.22, 0.26, 0, H + 0.12, pilC);
      }
      for (let s = 0; s < L; s += 1) {
        if ((tacc += 1) < 750) continue;
        tacc = 0;
        const px = x0 + ux * s, pz = z0 + uz * s, vx = -uz, vz = ux, ox = px + vx * 3.2, oz = pz + vz * 3.2;   // inside the fence line
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cbox(G, ox + ux * a * 1.1 + vx * b * 1.1, oz + uz * a * 1.1 + vz * b * 1.1, ux, uz, 0.15, 0.15, 0, 6.2, twrC);
        cbox(G, ox, oz, ux, uz, 1.6, 1.6, 6.2, 6.5, twrC);
        cbox(G, ox, oz, ux, uz, 1.5, 1.5, 6.5, 8.0, glass);
        cbox(G, ox, oz, ux, uz, 1.8, 1.8, 8.0, 8.3, twrC);
      }
      acc += L;
    }
  }
  // gates for VIP / service entries: pillars, a striped boom barrier, guard booth inside, barricades outside
  const red = C255(200, 40, 36), wht = C255(238, 238, 236), booth = C255(222, 216, 204), bglass = C255(46, 60, 72);
  for (const [gx, gz, ux, uz] of A.gates || []) {
    const vx = -uz, vz = ux;
    for (const sg of [-1, 1]) { cbox(G, gx + ux * 4.7 * sg, gz + uz * 4.7 * sg, ux, uz, 0.45, 0.45, 0, 3.6, pilC); cbox(G, gx + ux * 4.7 * sg, gz + uz * 4.7 * sg, ux, uz, 0.6, 0.6, 3.6, 3.9, wallC); }
    for (let k = 0; k < 8; k++) cbox(G, gx + ux * (-3.9 + k * 1.0), gz + uz * (-3.9 + k * 1.0), ux, uz, 0.5, 0.06, 1.0, 1.12, k % 2 ? wht : red);   // boom
    cbox(G, gx + ux * 6.6 + vx * 3.2, gz + uz * 6.6 + vz * 3.2, ux, uz, 1.2, 1.2, 0, 2.5, booth);
    cbox(G, gx + ux * 6.6 + vx * 3.2, gz + uz * 6.6 + vz * 3.2, ux, uz, 1.22, 1.22, 1.2, 2.2, bglass, false);
    cbox(G, gx + ux * 6.6 + vx * 3.2, gz + uz * 6.6 + vz * 3.2, ux, uz, 1.5, 1.5, 2.5, 2.7, wallC);
    for (const t of [-3, 0, 3]) for (let k = 0; k < 2; k++) cbox(G, gx + ux * (t + (k - 0.5) * 0.7) - vx * 7, gz + uz * (t + (k - 0.5) * 0.7) - vz * 7, ux, uz, 0.35, 0.15, 0.2, 1.0, k ? wht : red);
  }
  const m = G.mesh(POLX); m.receiveShadow = true; group.ground.add(m);
}
// parked narrow-bodies (and the odd ATR) nose-in on the apron stands
function buildAircraft(A) {
  const G = new Geo(false);
  const white = C255(240, 241, 243), grey = C255(150, 155, 162), glass = C255(30, 36, 44);
  const tails = [C255(16, 36, 110), C255(16, 36, 110), C255(200, 30, 45), C255(240, 110, 40), C255(16, 36, 110), C255(210, 25, 30), C255(120, 30, 120)];
  (A.stands || []).forEach(([cx, cz, fx, fz, atr], k) => {
    const sx = -fz, sz = fx, tail = tails[k % tails.length], S = atr ? 0.62 : 1.0;
    cbox(G, cx, cz, fx, fz, 18.5 * S, 1.95 * S, 1.6 * S, 5.4 * S, white);
    cbox(G, cx + fx * 17.2 * S, cz + fz * 17.2 * S, fx, fz, 1.4 * S, 1.5 * S, 2.2 * S, 4.8 * S, white);
    G.quad([cx + fx * 17.6 * S - sx * 1.0 * S, 4.3 * S, cz + fz * 17.6 * S - sz * 1.0 * S], [cx + fx * 17.6 * S + sx * 1.0 * S, 4.3 * S, cz + fz * 17.6 * S + sz * 1.0 * S],
      [cx + fx * 18.6 * S + sx * 0.9 * S, 4.85 * S, cz + fz * 18.6 * S + sz * 0.9 * S], [cx + fx * 18.6 * S - sx * 0.9 * S, 4.85 * S, cz + fz * 18.6 * S - sz * 0.9 * S], [fx * 0.5, 0.86, fz * 0.5], glass);
    for (const sg of [1, -1]) {
      const r0 = [cx + fx * 3 * S + sx * 2 * S * sg, 2.6 * S, cz + fz * 3 * S + sz * 2 * S * sg], r1 = [cx - fx * 3 * S + sx * 2 * S * sg, 2.6 * S, cz - fz * 3 * S + sz * 2 * S * sg];
      const t1 = [cx - fx * 9 * S + sx * 17 * S * sg, 3.3 * S, cz - fz * 9 * S + sz * 17 * S * sg], t0 = [cx - fx * 6 * S + sx * 17 * S * sg, 3.3 * S, cz - fz * 6 * S + sz * 17 * S * sg];
      G.quad(r0, t0, t1, r1, [0, 1, 0], grey);
      if (!atr) cbox(G, cx + fx * 1.5 + sx * 5.8 * sg, cz + fz * 1.5 + sz * 5.8 * sg, fx, fz, 2.2, 0.95, 0.9, 2.7, grey);
      else cbox(G, cx + fx * 2.5 * S + sx * 4.2 * S * sg, cz + fz * 2.5 * S + sz * 4.2 * S * sg, fx, fz, 1.9, 0.6, 2.4 * S, 3.6 * S, white);
      const h0 = [cx - fx * 15 * S + sx * 1.2 * sg, 5.0 * S, cz - fz * 15 * S + sz * 1.2 * sg], h1 = [cx - fx * 18 * S + sx * 1.2 * sg, 5.0 * S, cz - fz * 18 * S + sz * 1.2 * sg];
      const h2 = [cx - fx * 19 * S + sx * 6.2 * S * sg, 5.2 * S, cz - fz * 19 * S + sz * 6.2 * S * sg], h3 = [cx - fx * 17 * S + sx * 6.2 * S * sg, 5.2 * S, cz - fz * 17 * S + sz * 6.2 * S * sg];
      G.quad(h0, h3, h2, h1, [0, 1, 0], white);
    }
    const b0 = [cx - fx * 12 * S, 5.4 * S, cz - fz * 12 * S], b1 = [cx - fx * 18.5 * S, 5.4 * S, cz - fz * 18.5 * S];
    const tp1 = [cx - fx * 20 * S, 11.5 * S, cz - fz * 20 * S], tp0 = [cx - fx * 16.5 * S, 11.5 * S, cz - fz * 16.5 * S];
    G.quad(b0, b1, tp1, tp0, [sx, 0, sz], tail); G.quad(b1, b0, tp0, tp1, [-sx, 0, -sz], tail);
  });
  if (!G.p.length) return;
  group.ground.add(G.mesh(POLX));
}

// ---------------------------------------------------------------- bespoke landmarks (Patang, ISKCON, Taj Skyline, Ellis Bridge)
// aR.x = surface kind: 0 concrete / render, 1 glass behind white box frames, 2 curtain wall, 3 carved sandstone,
// 4 revolving-restaurant glazing (aR.y = angle), 5 lamp ring, 6 steel, 7 floodlit concrete. aR.z = floor-line origin.
const LMK = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'attribute vec4 aR; varying vec4 vK; varying vec3 vWN;', vBody: 'vK = aR; vWN = normalize(mat3(modelMatrix) * normal);',
  fHead: 'varying vec4 vK; varying vec3 vWN;',
  fColor: `
  vec3 n = normalize(vWN);
  float wall = 1.0 - step(0.6, abs(n.y));
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float u = dot(vWPos.xz, t), v = vWPos.y;
  float px = fwidth(u) + fwidth(v);
  float det = 1.0 - smoothstep(0.15, 0.9, px);
  float k = floor(vK.x + 0.5);
  if (k == 1.0 && wall > 0.5) {
    float fl = 3.4, y = v - vK.z;
    float fx = fract(u / 9.6), fy = fract(y / (fl * 3.0));
    float fr = max(1.0 - smoothstep(0.0, 0.05 + px * 0.05, min(fx, 1.0 - fx)), 1.0 - smoothstep(0.0, 0.06 + px * 0.03, min(fy, 1.0 - fy)));
    float mul = 1.0 - smoothstep(0.0, 0.08, min(fract(u / 1.6), 1.0 - fract(u / 1.6)));
    float slab = 1.0 - smoothstep(0.0, 0.1, min(fract(y / fl), 1.0 - fract(y / fl)));
    vec2 cell = floor(vec2(u / 1.6, y / fl));
    vec3 glass = vec3(0.17, 0.24, 0.30) * (0.85 + 0.3 * h21(cell)) + vec3(0.10, 0.14, 0.18) * uDay * smoothstep(0.0, 70.0, v);
    vec3 col = mix(glass, vec3(0.30, 0.34, 0.37), max(mul, slab) * 0.7 * det);
    diffuseColor.rgb = mix(col, vec3(0.93, 0.92, 0.88), fr);
    xEm = vec3(1.0, 0.8, 0.55) * 0.6 * step(0.5, h21(cell + 3.1)) * (1.0 - fr) * (1.0 - slab) * uNight;
  } else if (k == 2.0 && wall > 0.5) {
    float fl = 3.6, y = v - vK.z;
    float mul = 1.0 - smoothstep(0.0, 0.06, min(fract(u / 1.5), 1.0 - fract(u / 1.5)));
    float spd = smoothstep(0.80, 0.84, fract(y / fl));
    vec2 cell = floor(vec2(u / 1.5, y / fl));
    vec3 col = mix(vec3(0.14, 0.25, 0.34) * (0.85 + 0.3 * h21(cell)) + vec3(0.10, 0.16, 0.22) * uDay, vec3(0.12, 0.18, 0.24), spd);
    diffuseColor.rgb = mix(col, vec3(0.70, 0.73, 0.75), mul * det);
    xEm = vec3(0.95, 0.9, 0.8) * 0.55 * step(0.45, h21(cell + 1.7)) * (1.0 - spd) * (1.0 - mul) * uNight;
  } else if (k == 3.0) {
    float band = 1.0 - smoothstep(0.0, 0.06, min(fract(v / 0.9), 1.0 - fract(v / 0.9)));
    diffuseColor.rgb *= (1.0 - 0.18 * band * det * wall) * (0.9 + 0.14 * vnoise(mod(vec2(u * 2.0, v * 4.0), 1024.0)));
    xEm = diffuseColor.rgb * vec3(1.0, 0.8, 0.6) * 0.32 * uNight * smoothstep(1.0, 12.0, v);
  } else if (k == 4.0) {
    float m = fract(vK.y / 0.1309);
    float mull = 1.0 - smoothstep(0.0, 0.07, min(m, 1.0 - m));
    diffuseColor.rgb = mix(vec3(0.16, 0.22, 0.28) + vec3(0.12, 0.16, 0.2) * uDay, vec3(0.85, 0.85, 0.82), mull);
    xEm = vec3(1.0, 0.78, 0.5) * 1.3 * uNight * (1.0 - mull);
  } else if (k == 5.0) {
    xEm = vec3(1.0, 0.86, 0.6) * 1.8 * uNight;
  } else if (k == 6.0) {
    diffuseColor.rgb *= 0.85 + 0.2 * vnoise(mod(vWPos.xz * 1.3 + vWPos.y, 1024.0));
    xEm = diffuseColor.rgb * 0.18 * uNight;
  } else {
    diffuseColor.rgb *= 0.9 + 0.12 * vnoise(mod(vWPos.xz * 0.9 + vWPos.y * 0.5, 1024.0));
    if (k == 7.0) xEm = diffuseColor.rgb * vec3(1.0, 0.85, 0.7) * 0.28 * uNight;
  }`,
});
// quad with explicit extra attribute; winding flipped to face n
function lq(G, p0, p1, p2, p3, n, e, col) {
  const ax = p2[0] - p0[0], ay = p2[1] - p0[1], az = p2[2] - p0[2], bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
  const a = G.v(...p0, ...n, e, col), b = G.v(...p1, ...n, e, col), c = G.v(...p2, ...n, e, col), d = G.v(...p3, ...n, e, col);
  if ((ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0) G.q(a, d, c, b); else G.q(a, b, c, d);
}
// surface of revolution around (cx, cz); prof = [[r, y], ...] traced up the outside
function lathe(G, cx, cz, prof, seg, col, kind, ez = 0) {
  for (let j = 0; j < prof.length - 1; j++) {
    const [r0, y0] = prof[j], [r1, y1] = prof[j + 1];
    let nr = y1 - y0, ny = -(r1 - r0); const nl = Math.hypot(nr, ny) || 1; nr /= nl; ny /= nl;
    for (let i = 0; i < seg; i++) {
      const A = (i / seg) * Math.PI * 2, B = ((i + 1) / seg) * Math.PI * 2, cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
      const p00 = [cx + r0 * cA, y0, cz + r0 * sA], p01 = [cx + r0 * cB, y0, cz + r0 * sB], p11 = [cx + r1 * cB, y1, cz + r1 * sB], p10 = [cx + r1 * cA, y1, cz + r1 * sA];
      const a = G.v(...p00, nr * cA, ny, nr * sA, [kind, A, ez, 0], col), b = G.v(...p01, nr * cB, ny, nr * sB, [kind, B, ez, 0], col);
      const c = G.v(...p11, nr * cB, ny, nr * sB, [kind, B, ez, 0], col), d = G.v(...p10, nr * cA, ny, nr * sA, [kind, A, ez, 0], col);
      const ax = p11[0] - p00[0], ay = p11[1] - p00[1], az = p11[2] - p00[2], bx = p10[0] - p01[0], by = p10[1] - p01[1], bz = p10[2] - p01[2];
      const fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx, mc = (cA + cB) / 2, ms = (sA + sB) / 2;
      if (fx * nr * mc + fy * ny + fz * nr * ms < 0) G.q(a, d, c, b); else G.q(a, b, c, d);
    }
  }
}
// rectangular member from a to b: w across (along sd projected off the axis), h in the remaining direction
function beam(G, a, b, w, h, col, kind, sd = null) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1, t = [dx / L, dy / L, dz / L];
  let s = sd ? [...sd] : [-t[2], 0, t[0]];
  const st = s[0] * t[0] + s[1] * t[1] + s[2] * t[2]; s = [s[0] - t[0] * st, s[1] - t[1] * st, s[2] - t[2] * st];
  let sl = Math.hypot(...s); if (sl < 1e-4) { s = [1, 0, 0]; sl = 1; } s = s.map((q) => q / sl);
  const up = [t[1] * s[2] - t[2] * s[1], t[2] * s[0] - t[0] * s[2], t[0] * s[1] - t[1] * s[0]];
  const P = (p, i, j) => [p[0] + s[0] * w / 2 * i + up[0] * h / 2 * j, p[1] + s[1] * w / 2 * i + up[1] * h / 2 * j, p[2] + s[2] * w / 2 * i + up[2] * h / 2 * j];
  const e = [kind, 0, 0, 0], ng = (q) => q.map((x) => -x);
  lq(G, P(a, 1, -1), P(b, 1, -1), P(b, 1, 1), P(a, 1, 1), s, e, col);
  lq(G, P(a, -1, -1), P(b, -1, -1), P(b, -1, 1), P(a, -1, 1), ng(s), e, col);
  lq(G, P(a, -1, 1), P(b, -1, 1), P(b, 1, 1), P(a, 1, 1), up, e, col);
  lq(G, P(a, -1, -1), P(b, -1, -1), P(b, 1, -1), P(a, 1, -1), ng(up), e, col);
}
// box in a landmark frame F: a along u (a0..a1), b along v (b0..b1), y0..y1
function fbox(G, F, a0, a1, b0, b1, y0, y1, col, kind, ez = 0, top = true) {
  const p = (a, b, y) => F(a, b, y), e = [kind, 0, ez, 0], U = [F.ux, 0, F.uz], V = [F.vx, 0, F.vz], ng = (q) => q.map((x) => -x);
  lq(G, p(a1, b0, y0), p(a1, b1, y0), p(a1, b1, y1), p(a1, b0, y1), U, e, col);
  lq(G, p(a0, b0, y0), p(a0, b1, y0), p(a0, b1, y1), p(a0, b0, y1), ng(U), e, col);
  lq(G, p(a0, b1, y0), p(a1, b1, y0), p(a1, b1, y1), p(a0, b1, y1), V, e, col);
  lq(G, p(a0, b0, y0), p(a1, b0, y0), p(a1, b0, y1), p(a0, b0, y1), ng(V), e, col);
  if (top) lq(G, p(a0, b0, y1), p(a1, b0, y1), p(a1, b1, y1), p(a0, b1, y1), [0, 1, 0], e, col);
}
function lmFrame(o) {
  const ux = o.ux, uz = o.uz, vx = o.uz, vz = -o.ux;   // v = 90 deg left of u in map terms (north for an east-facing u)
  const F = (a, b, y) => [o.x + ux * a + vx * b, y, o.z + uz * a + vz * b];
  Object.assign(F, { ux, uz, vx, vz });
  return F;
}
// Nagara shikhara: curvilinear spire on a stepped square plan, amalaka and kalash on top
function shikhara(G, F, a, b, y0, R, top, col, gold) {
  const c = F(a, b, 0), N = 14, M = 32, rings = [];
  for (let j = 0; j <= N; j++) {
    const t = j / N, y = y0 + t * (top - 4.2 - y0), r = R * (1 - 0.8 * Math.pow(t, 1.6));
    const ring = [];
    for (let i = 0; i <= M; i++) {
      const th = (i / M) * Math.PI * 2, cq = Math.cos(th), sq = Math.sin(th);
      const sqr = 1 / Math.max(Math.abs(cq), Math.abs(sq));                                    // square plan...
      const off = 1 - 0.07 * (Math.abs(Math.sin(th * 4)) > 0.7 ? 1 : 0);                         // ...with offset projections
      const rr = r * Math.min(sqr, 1.32) * off * (1 - 0.04 * (j % 2));                          // horizontal tiers
      ring.push([c[0] + (F.ux * cq + F.vx * sq) * rr, y, c[2] + (F.uz * cq + F.vz * sq) * rr]);
    }
    rings.push(ring);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < M; i++) {
    const p00 = rings[j][i], p01 = rings[j][i + 1], p11 = rings[j + 1][i + 1], p10 = rings[j + 1][i];
    const ax = p11[0] - p00[0], ay = p11[1] - p00[1], az = p11[2] - p00[2], bx = p10[0] - p01[0], by = p10[1] - p01[1], bz = p10[2] - p01[2];
    let n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]; const nl = Math.hypot(...n) || 1; n = n.map((q) => q / nl);
    const mx = (p00[0] + p01[0]) / 2 - c[0], mz = (p00[2] + p01[2]) / 2 - c[2]; if (n[0] * mx + n[2] * mz < 0) n = n.map((q) => -q);
    lq(G, p00, p01, p11, p10, n, [3, 0, 0, 0], col);
  }
  const ya = top - 4.2;
  lathe(G, c[0], c[2], [[R * 0.2, ya], [R * 0.34, ya + 0.5], [R * 0.36, ya + 1.0], [R * 0.3, ya + 1.5], [R * 0.12, ya + 1.7]], 20, col, 3);   // amalaka
  lathe(G, c[0], c[2], [[R * 0.12, ya + 1.7], [0.75, ya + 2.1], [0.85, ya + 2.7], [0.4, ya + 3.3], [0.22, ya + 3.6], [0.0, top]], 12, gold, 0);   // kalash
}
function buildIskcon(o) {
  const G = new Geo(true), F = lmFrame(o);
  const plinth = C255(214, 176, 148), hall = C255(240, 228, 208), pink = C255(228, 182, 150), trim = C255(205, 150, 120), gold = C255(222, 178, 70), flag = C255(242, 122, 32);
  fbox(G, F, -62, 50, -30, 30, 0, 1.6, plinth, 3);                                                     // stone platform
  for (let k = 0; k < 4; k++) fbox(G, F, 50, 56 - k * 1.5, -12, 12, 0, 1.6 - k * 0.4, plinth, 3);   // front steps
  fbox(G, F, -30, 40, -26, 26, 1.6, 13, hall, 3);                                                      // temple hall
  fbox(G, F, -31, 41, -27, 27, 13, 13.8, trim, 3);                                                     // cornice
  fbox(G, F, 40, 46, -10, 10, 1.6, 11, hall, 3);                                                       // entrance porch
  fbox(G, F, 39.5, 46.5, -10.5, 10.5, 11, 11.7, trim, 3);
  for (const [a, b] of [[-29, -25], [-29, 25], [39, -25], [39, 25]]) {                                 // corner chhatris
    for (const [da, db] of [[-1.2, -1.2], [1.2, -1.2], [1.2, 1.2], [-1.2, 1.2]]) fbox(G, F, a + da - 0.2, a + da + 0.2, b + db - 0.2, b + db + 0.2, 13.8, 16.2, hall, 3);
    const c = F(a, b, 0); lathe(G, c[0], c[2], [[1.9, 16.2], [1.9, 16.6], [1.6, 17.8], [0.9, 18.6], [0.2, 19.1], [0, 19.6]], 10, pink, 3);
  }
  for (const a of [26, 4]) {                                                                           // mandapa domes over the hall
    const c = F(a, 0, 0);
    lathe(G, c[0], c[2], [[7.2, 13.8], [7.2, 15.8], [6.8, 15.8], [6.6, 18.0], [5.6, 20.4], [3.8, 21.9], [1.8, 22.8], [0.5, 23.2], [0.0, 23.4]], 16, pink, 3);
    lathe(G, c[0], c[2], [[0.5, 23.2], [0.6, 23.8], [0.25, 24.6], [0, 25.2]], 8, gold, 0);
  }
  fbox(G, F, -58, -30, -26, 26, 1.6, 16, hall, 3);                                                     // sanctum block under the spires
  fbox(G, F, -59, -29, -27, 27, 16, 16.8, trim, 3);
  for (const [b, R, top] of [[-17, 6.9, 33], [0, 7.6, 37], [17, 6.9, 33]]) {                           // the three 50 ft shikharas
    shikhara(G, F, -44, b, 16.8, R, top, pink, gold);
    for (const [da, db] of [[-5.6, -5.6], [5.6, -5.6], [5.6, 5.6], [-5.6, 5.6]]) shikhara(G, F, -44 + da, b + db * 0.85, 16.8, 2.1, 25.5, pink, gold);   // urushringas
  }
  const fp = F(-44, 0, 0);                                                                             // flag on the central spire
  beam(G, [fp[0], 36.6, fp[2]], [fp[0], 40.5, fp[2]], 0.08, 0.08, C255(90, 80, 70), 0);
  lq(G, [fp[0], 40.4, fp[2]], [fp[0] + F.vx * 2.6, 39.9, fp[2] + F.vz * 2.6], [fp[0] + F.vx * 2.6, 39.9, fp[2] + F.vz * 2.6], [fp[0], 39.0, fp[2]], [F.ux, 0, F.uz], [0, 0, 0, 0], flag);
  lq(G, [fp[0], 40.4, fp[2]], [fp[0] + F.vx * 2.6, 39.9, fp[2] + F.vz * 2.6], [fp[0] + F.vx * 2.6, 39.9, fp[2] + F.vz * 2.6], [fp[0], 39.0, fp[2]], [-F.ux, 0, -F.uz], [0, 0, 0, 0], flag);
  group.ground.add(G.mesh(LMK));
}
// Patang (Hasmukh Patel, 1980-84): slim white shaft with a column of slot windows, a smooth bowl flaring out to the
// 62 ft revolving ring (white soffit band, a thin lower window row, balcony line, the main glazing band, white
// parapet), an open roof terrace with railing, and the core rising ~10 m above it with a red rim and a mast.
function buildPatang(o) {
  const G = new Geo(true), { x, z } = o;
  const white = C255(238, 236, 230), whiteD = C255(214, 212, 206), glass = C255(40, 56, 70), red = C255(178, 52, 40), steel = C255(150, 156, 162), dark = C255(52, 62, 72);
  const RS = 2.7, RR = 9.75;
  lathe(G, x, z, [[4.2, -0.2], [4.2, 1.0], [RS, 1.0]], 32, whiteD, 0);                                   // base
  lathe(G, x, z, [[RS, 1.0], [RS, 54.2]], 40, white, 7);                                                 // shaft
  lathe(G, x, z, [[RS, 54.2], [3.6, 56.2], [5.6, 58.2], [7.8, 59.4], [RR, 60.0]], 48, white, 7);        // bowl underside
  lathe(G, x, z, [[RR - 0.6, 59.75], [RR - 0.6, 59.85]], 64, white, 5);                                 // underside light ring
  lathe(G, x, z, [[RR, 60.0], [RR, 61.0]], 96, white, 0);                                                // soffit band
  lathe(G, x, z, [[RR - 0.05, 61.0], [RR - 0.05, 61.8]], 96, glass, 4);                                 // lower window row
  lathe(G, x, z, [[RR - 0.05, 61.8], [RR + 0.25, 61.8], [RR + 0.25, 62.55], [RR - 0.2, 62.6]], 96, white, 0);   // balcony line
  lathe(G, x, z, [[RR - 0.2, 62.6], [RR - 0.2, 65.8]], 96, glass, 4);                                   // revolving restaurant glazing
  lathe(G, x, z, [[RR - 0.2, 65.8], [RR, 65.9], [RR, 67.2], [RR - 0.3, 67.2], [2.75, 67.2]], 96, white, 0);    // parapet band + terrace
  lathe(G, x, z, [[RR - 0.32, 67.2], [RR - 0.32, 68.25], [RR - 0.38, 68.25], [RR - 0.38, 67.2]], 96, steel, 6); // terrace railing
  lathe(G, x, z, [[2.75, 67.2], [2.75, 77.2]], 40, white, 7);                                            // core above the terrace
  lathe(G, x, z, [[2.8, 77.2], [2.8, 77.65], [0.0, 77.65]], 40, red, 0);                                 // red rim / cap
  beam(G, [x, 77.6, z], [x, 81.0, z], 0.12, 0.12, steel, 0);                                             // mast
  for (const a of [0.35, 0.35 + Math.PI]) {                                                              // slot windows up the shaft and core
    const c = Math.cos(a), sn = Math.sin(a), tg = [-sn, 0, c];
    for (let y = 4; y < 52; y += 3.0) beam(G, [x + c * (RS + 0.02), y, z + sn * (RS + 0.02)], [x + c * (RS + 0.02), y + 1.7, z + sn * (RS + 0.02)], 0.75, 0.06, dark, 0, tg);
    for (let y = 69; y < 76; y += 2.4) beam(G, [x + c * 2.77, y, z + sn * 2.77], [x + c * 2.77, y + 1.4, z + sn * 2.77], 0.35, 0.05, dark, 0, tg);
  }
  for (let k = 0; k < 10; k++) {                                                                         // plant units round the core
    const a = (k / 10) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    beam(G, [x + c * 3.5, 67.2, z + sn * 3.5], [x + c * 3.5, 68.0, z + sn * 3.5], 1.1, 0.7, whiteD, 0, [-sn, 0, c]);
  }
  group.ground.add(G.mesh(LMK));
}
function buildTaj(o) {
  const G = new Geo(true), F = lmFrame(o);
  const white = C255(236, 234, 228), stone = C255(206, 198, 184);
  fbox(G, F, -58, 58, -23, 48, 0, 15, stone, 2, 0);                                     // podium (banquets, lobby)
  fbox(G, F, -59, 59, -24, 49, 15, 15.6, white, 0);
  for (const [a0, a1, b0, b1] of [[-56.5, -25.5, -19.5, 21.5], [-69.7, 6.3, 27.6, 47.6]]) {   // the two towers
    fbox(G, F, a0, a1, b0, b1, 15.6, 68, white, 1, 15.6);
    fbox(G, F, a0 - 0.4, a1 + 0.4, b0 - 0.4, b1 + 0.4, 68, 68.8, white, 0);
    const T = 0.5;                                                                        // open crown frame above the roof
    fbox(G, F, a0 - 0.4, a0 + T, b0 - 0.4, b1 + 0.4, 68.8, 74, white, 0);
    fbox(G, F, a1 - T, a1 + 0.4, b0 - 0.4, b1 + 0.4, 68.8, 74, white, 0);
    fbox(G, F, a0 - 0.4, a1 + 0.4, b0 - 0.4, b0 + T, 72.8, 74, white, 0);
    fbox(G, F, a0 - 0.4, a1 + 0.4, b1 - T, b1 + 0.4, 72.8, 74, white, 0);
    fbox(G, F, (a0 + a1) / 2 - 5, (a0 + a1) / 2 + 5, (b0 + b1) / 2 - 4, (b0 + b1) / 2 + 4, 68.8, 72, stone, 0);   // lift / plant room
  }
  group.ground.add(G.mesh(LMK));
}
function buildLandmarks3D() {
  for (const o of META.lm3d || []) {
    if (o.kind === 'patang') buildPatang(o);
    else if (o.kind === 'iskcon') buildIskcon(o);
    else if (o.kind === 'taj') buildTaj(o);
  }
  if (META.ellis) buildEllis(META.ellis);
}
// Ellis Bridge (1892): 14 bowstring lattice-truss spans, 433 m, between the concrete wings of Swami Vivekananda Bridge
function buildEllis(E) {
  const G = new Geo(true);
  const steel = C255(122, 132, 140), steelD = C255(88, 96, 104), deckC = C255(98, 90, 80), pierC = C255(132, 128, 120);
  const L = Math.hypot(E.x1 - E.x0, E.z1 - E.z0), ux = (E.x1 - E.x0) / L, uz = (E.z1 - E.z0) / L, vx = -uz, vz = ux;
  const SP = L / E.n, H = E.h, RISE = 4.8, HW = 3.4, NP = 8, wy = E.wy != null ? E.wy : -5.6;
  const P = (s, b, y) => [E.x0 + ux * s + vx * b, y, E.z0 + uz * s + vz * b], V = [vx, 0, vz], U = [ux, 0, uz];
  for (let k = 0; k < E.n; k++) {
    const s0 = k * SP + 0.35, s1 = (k + 1) * SP - 0.35;
    const arch = (t) => H + 0.35 + RISE * (1 - Math.pow(2 * t - 1, 2));
    for (const b of [-HW, HW]) {
      beam(G, P(s0, b, H), P(s1, b, H), 0.45, 0.75, steelD, 6, V);
      for (let i = 0; i < NP; i++) {
        const ta = i / NP, tb = (i + 1) / NP, sa = s0 + (s1 - s0) * ta, sb = s0 + (s1 - s0) * tb;
        beam(G, P(sa, b, arch(ta)), P(sb, b, arch(tb)), 0.5, 0.55, steel, 6, V);
        if (i > 0) beam(G, P(sa, b, H), P(sa, b, arch(ta)), 0.26, 0.3, steel, 6, V);
        beam(G, P(sa, b, H + 0.3), P(sb, b, arch(tb) - 0.2), 0.16, 0.2, steel, 6, V);
        beam(G, P(sb, b, H + 0.3), P(sa, b, arch(ta) - 0.2), 0.16, 0.2, steel, 6, V);
      }
    }
    for (let i = 2; i <= NP - 2; i++) { const t = i / NP, s = s0 + (s1 - s0) * t; beam(G, P(s, -HW, arch(t)), P(s, HW, arch(t)), 0.24, 0.28, steel, 6, U); }
    for (let i = 2; i < NP - 2; i++) {                    // top wind bracing
      const ta = i / NP, tb = (i + 1) / NP, sa = s0 + (s1 - s0) * ta, sb = s0 + (s1 - s0) * tb;
      beam(G, P(sa, -HW, arch(ta)), P(sb, HW, arch(tb)), 0.12, 0.12, steel, 6, U);
      beam(G, P(sa, HW, arch(ta)), P(sb, -HW, arch(tb)), 0.12, 0.12, steel, 6, U);
    }
    // deck plate and cross girders
    lq(G, P(s0, -HW, H + 0.36), P(s1, -HW, H + 0.36), P(s1, HW, H + 0.36), P(s0, HW, H + 0.36), [0, 1, 0], [0, 0, 0, 0], deckC);
    lq(G, P(s0, -HW, H - 0.3), P(s1, -HW, H - 0.3), P(s1, HW, H - 0.3), P(s0, HW, H - 0.3), [0, -1, 0], [6, 0, 0, 0], steelD);
    for (let i = 0; i <= NP; i++) { const s = s0 + (s1 - s0) * i / NP; beam(G, P(s, -HW, H - 0.05), P(s, HW, H - 0.05), 0.3, 0.6, steelD, 6, U); }
  }
  for (let k = 0; k <= E.n; k++) {                        // paired cylindrical piers on every support line
    const s = k * SP;
    for (const b of [-HW, HW]) {
      const c = P(s, b, 0);
      lathe(G, c[0], c[2], [[1.05, wy - 0.6], [1.05, H - 1.1], [1.25, H - 1.1], [1.25, H - 0.75], [0.0, H - 0.75]], 14, pierC, 0);
    }
    beam(G, P(s, -HW - 0.6, H - 0.55), P(s, HW + 0.6, H - 0.55), 0.9, 0.4, steelD, 6, U);
  }
  const m = G.mesh(LMK); m.receiveShadow = true; group.ground.add(m);
}

// ---------------------------------------------------------------- the historic darwajas (city gates)
const STONE = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'varying vec3 vWN;', vBody: 'vWN = normal;', fHead: 'varying vec3 vWN;',
  fColor: `
  vec3 n = normalize(vWN);
  float wall = 1.0 - step(0.7, abs(n.y));
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float u = wall > 0.5 ? dot(vWPos.xz, t) : vWPos.x;
  float v = wall > 0.5 ? vWPos.y : vWPos.z;
  float row = floor(v / 0.42);
  float jx = fract(u / 0.85 + 0.5 * mod(row, 2.0)), jy = fract(v / 0.42);
  float px = fwidth(u) + fwidth(v);
  float det = 1.0 - smoothstep(0.05, 0.2, px);
  float joint = (1.0 - smoothstep(0.0, 0.05, min(jx, 1.0 - jx) * 0.85)) + (1.0 - smoothstep(0.0, 0.05, min(jy, 1.0 - jy) * 0.42));
  diffuseColor.rgb *= 1.0 - 0.22 * clamp(joint, 0.0, 1.0) * det;
  diffuseColor.rgb *= 0.88 + 0.16 * h21(vec2(floor(u / 0.85 + 0.5 * mod(row, 2.0)), row));
  diffuseColor.rgb *= 0.78 + 0.28 * fbm(mod(vec2(u * 0.6, v * 0.35), 512.0));
  diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.0, 2.5, vWPos.y));`,
});
function buildDarwajas() {
  const G = new Geo(false);
  const stone = C255(205, 176, 128), stoneD = C255(150, 124, 88), iron = C255(70, 52, 36), dark = C255(52, 42, 34);
  for (const d of META.darwajas || []) {
    const ux = d.uz === undefined ? 1 : d.ux, uz = d.uz;           // along the street (through the arches)
    const vx = -uz, vz = ux;                                          // across the street (gate width)
    const nArch = 3, widths = [d.sw, d.cw, d.sw], heights = [d.sh, d.ch, d.sh];
    const pier = d.pr, W = d.cw + 2 * d.sw + 4 * pier, D = d.dp, Htop = d.ch + 2.6;
    const at = (x, y, z) => [d.x + vx * x + ux * z, y, d.z + vz * x + uz * z];   // local: x across, z along
    // facade outline (x, y) with pointed-arch notches cut up from the ground
    const outline = [[-W / 2, 0]];
    const arches = [];
    let cx = -W / 2 + pier;
    for (let k = 0; k < nArch; k++) {
      const w = widths[k], h = heights[k], rise = 0.55 * w, hs = h - rise, r = (rise * rise + w * w / 4) / w;
      const xl = cx, xr = cx + w, prof = [[xl, 0], [xl, hs]];
      const N = 10;
      const aL = Math.acos((r - w / 2) / r);   // sweep of each arc up to the apex
      for (let s = 1; s <= N; s++) { const a = Math.PI - aL * s / N; prof.push([xl + r + r * Math.cos(a), hs + r * Math.sin(a)]); }
      for (let s = N - 1; s >= 0; s--) { const a = aL * s / N; prof.push([xr - r + r * Math.cos(a), hs + r * Math.sin(a)]); }
      prof.push([xr, hs], [xr, 0]);
      arches.push(prof); outline.push(...prof);
      cx = xr + pier;
    }
    outline.push([W / 2, 0], [W / 2, Htop], [-W / 2, Htop]);
    const fv = outline.flat(); const tri = earcut(fv, null, 2);
    for (const side of [1, -1]) {   // front and back faces
      const base = G.p.length / 3;
      for (const [x, y] of outline) G.v(...at(x, y, side * D / 2), ux * side, 0, uz * side, null, stone);
      for (let t = 0; t < tri.length; t += 3) {
        const A0 = tri[t], B0 = tri[t + 1], C0 = tri[t + 2];
        const ax = fv[A0 * 2], ay = fv[A0 * 2 + 1], bx = fv[B0 * 2], by = fv[B0 * 2 + 1], cx2 = fv[C0 * 2], cy = fv[C0 * 2 + 1];
        const cr = (bx - ax) * (cy - ay) - (by - ay) * (cx2 - ax);
        // local (x right, y up) seen from +z: counter-clockwise faces +z; flip for the back face
        if ((cr > 0) === (side > 0)) G.i.push(base + A0, base + C0, base + B0); else G.i.push(base + A0, base + B0, base + C0);
      }
    }
    // arch soffits / jambs (the inside of each passage), iron-plated doors folded back against the jambs
    for (const prof of arches) {
      for (let k = 0; k < prof.length - 1; k++) {
        const [x0, y0] = prof[k], [x1, y1] = prof[k + 1];
        const ex = x1 - x0, ey = y1 - y0, el = Math.hypot(ex, ey) || 1;
        const nx = ey / el, ny = -ex / el;                 // normal pointing into the opening
        const n = [vx * nx, ny, vz * nx];
        G.quad(at(x0, y0, -D / 2), at(x1, y1, -D / 2), at(x1, y1, D / 2), at(x0, y0, D / 2), n, k < 2 || k > prof.length - 3 ? stoneD : stone);
      }
      const xl = prof[0][0], xr = prof[prof.length - 1][0], hs = prof[1][1];
      for (const [xx, sg] of [[xl, 1], [xr, -1]]) {
        const p0 = at(xx + sg * 0.12, 0, D / 2 - 0.3), p1 = at(xx + sg * 0.12, 0, D / 2 - 0.3 - Math.min(2.2, (xr - xl) / 2));
        G.quad(p0, p1, [p1[0], hs * 0.95, p1[2]], [p0[0], hs * 0.95, p0[2]], [vx * sg, 0, vz * sg], iron);
      }
    }
    // outer ends and the top
    G.quad(at(-W / 2, 0, D / 2), at(-W / 2, 0, -D / 2), at(-W / 2, Htop, -D / 2), at(-W / 2, Htop, D / 2), [-vx, 0, -vz], stone);
    G.quad(at(W / 2, 0, -D / 2), at(W / 2, 0, D / 2), at(W / 2, Htop, D / 2), at(W / 2, Htop, -D / 2), [vx, 0, vz], stone);
    G.quad(at(-W / 2, Htop, -D / 2), at(W / 2, Htop, -D / 2), at(W / 2, Htop, D / 2), at(-W / 2, Htop, D / 2), [0, 1, 0], stone);
    // cornice band and buttresses on the pier faces
    for (const side of [1, -1]) {
      cbox(G, ...[at(0, 0, side * (D / 2 + 0.15))].map((p) => [p[0], p[2]])[0], vx, vz, W / 2 + 0.15, 0.2, Htop - 0.9, Htop - 0.5, stoneD);
      let px = -W / 2 + pier / 2;
      for (let k = 0; k <= nArch; k++) {
        const p = at(px, 0, side * (D / 2 + 0.35));
        cbox(G, p[0], p[2], vx, vz, pier * 0.32, 0.35, 0, heights[Math.min(k, nArch - 1)] * 0.92, stone);
        cbox(G, p[0], p[2], vx, vz, pier * 0.38, 0.42, heights[Math.min(k, nArch - 1)] * 0.92, heights[Math.min(k, nArch - 1)] * 0.92 + 0.5, stoneD);
        if (k < nArch) px += pier + widths[k];
      }
    }
    // the roofed gun platform (or Teen Darwaza's open terrace) with a crenellated parapet
    let top = Htop;
    if (d.plat) {
      const [pw, pd] = d.plat, PH = 3.4;
      const c = at(0, 0, 0);
      cbox(G, c[0], c[2], vx, vz, pw / 2, Math.min(pd, D) / 2, Htop, Htop + PH, stone);
      for (const side of [1, -1]) for (const o of [-0.3, 0, 0.3]) {   // gun loops
        const q = at(o * pw, 0, side * (Math.min(pd, D) / 2 + 0.02));
        G.quad([q[0] - vx * 0.35, Htop + 1.2, q[2] - vz * 0.35], [q[0] + vx * 0.35, Htop + 1.2, q[2] + vz * 0.35], [q[0] + vx * 0.35, Htop + 2.2, q[2] + vz * 0.35], [q[0] - vx * 0.35, Htop + 2.2, q[2] - vz * 0.35], [ux * side, 0, uz * side], dark);
      }
      cbox(G, c[0], c[2], vx, vz, pw / 2 + 0.25, Math.min(pd, D) / 2 + 0.25, Htop + PH, Htop + PH + 0.3, stoneD);
      top = Htop;
    }
    const merl = (x0, x1, z) => { for (let x = x0 + 0.4; x < x1 - 0.2; x += 1.3) { const p = at(x, 0, z); cbox(G, p[0], p[2], vx, vz, 0.35, 0.3, top, top + 0.9, stone); } };
    merl(-W / 2, W / 2, D / 2 - 0.3); merl(-W / 2, W / 2, -D / 2 + 0.3);
  }
  if (!G.p.length) return;
  const m = G.mesh(STONE); m.renderOrder = 10; group.ground.add(m);
}

function geoTiles(G, mat, yr) {
  if (!G.p.length) return [];
  const pos = new Float32Array(G.p);
  const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.Float32BufferAttribute(G.n, 3) };
  if (G.x) attrs.aR = new THREE.Float32BufferAttribute(G.x, 4);
  if (G.c.length) attrs.color = new THREE.Float32BufferAttribute(G.c, 3);
  if (G.ids) attrs.aId = new THREE.Float32BufferAttribute(G.ids, 1);
  return tileSplit(attrs, G.i, (i) => pos[i * 3], (i) => pos[i * 3 + 2], yr, (g) => {
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; m.renderOrder = 10; return [m];
  });
}
let DECKIDX = null;
function buildDecks(decks, xy) {
  const D = new Geo(true, true), W = new Geo(false, true);
  const chainOf = META.deckChain || [];
  // pass 1: centre points, normals, heights and half-widths of every deck piece
  const DK = decks.map((d) => {
    const { p, L, H, z } = d, O = H + Math.max(d.O - H, 0.6), P = [];
    let s = 0;
    for (let j = 0; j < L; j++) {
      const x = xy[(p + j) * 2] * 0.5, zz = xy[(p + j) * 2 + 1] * 0.5, h = z[j] / 10 + 0.05;
      if (j > 0) s += Math.hypot(x - P[j - 1].x, zz - P[j - 1].z);
      const [nx, nz, ml] = miter(xy, p, L, j, 0.5);
      P.push({ x, z: zz, h, nx, nz, ml, s, tx: nz, tz: -nx });
    }
    return { P, O, wl: new Float32Array(L).fill(O), wr: new Float32Array(L).fill(O) };
  });
  // pass 2: twin carriageways mapped as two overlapping decks are trimmed so they meet along a shared median
  // instead of overlapping (overlapping decks z-fight and shadow each other into hatching)
  const CS = 32, grid = new Map(), key = (i, j) => i * 100003 + j;
  DK.forEach((k, ki) => { for (let j = 0; j < k.P.length - 1; j++) {
    const a = k.P[j], b = k.P[j + 1];
    for (let gx = Math.floor(Math.min(a.x, b.x) / CS); gx <= Math.floor(Math.max(a.x, b.x) / CS); gx++)
      for (let gz = Math.floor(Math.min(a.z, b.z) / CS); gz <= Math.floor(Math.max(a.z, b.z) / CS); gz++) {
        const g = key(gx, gz); let arr = grid.get(g); if (!arr) grid.set(g, (arr = [])); arr.push(ki, j);
      }
  } });
  DK.forEach((k, ki) => {
    for (let j = 0; j < k.P.length; j++) {
      const p = k.P[j], R = k.O + 14, seen = new Set();
      for (let gx = Math.floor((p.x - R) / CS); gx <= Math.floor((p.x + R) / CS); gx++)
        for (let gz = Math.floor((p.z - R) / CS); gz <= Math.floor((p.z + R) / CS); gz++) {
          const arr = grid.get(key(gx, gz)); if (!arr) continue;
          for (let q = 0; q < arr.length; q += 2) {
            const k2 = arr[q], j2 = arr[q + 1]; if (k2 === ki || seen.has(k2 * 4096 + j2)) continue; seen.add(k2 * 4096 + j2);
            const o = DK[k2], A = o.P[j2], B = o.P[j2 + 1];
            const ex = B.x - A.x, ez = B.z - A.z, el = ex * ex + ez * ez || 1;
            const t = Math.max(0, Math.min(1, ((p.x - A.x) * ex + (p.z - A.z) * ez) / el));
            const qx = A.x + ex * t, qz = A.z + ez * t, qh = A.h + (B.h - A.h) * t;
            if (Math.abs(qh - p.h) > 1.0) continue;                                   // a deck crossing above / below
            const dx = qx - p.x, dz = qz - p.z, lat = dx * p.nx + dz * p.nz, along = dx * p.tx + dz * p.tz;
            if (Math.abs(lat) >= k.O + o.O + 0.1 || Math.abs(along) > Math.abs(lat) + 1.5) continue;
            const ln = Math.sqrt(el); if (Math.abs((ex * p.tx + ez * p.tz) / ln) < 0.8) continue;   // not running alongside
            if (Math.abs(lat) < 1.2) { if (k2 < ki) { k.wl[j] = Math.min(k.wl[j], 0.05); k.wr[j] = Math.min(k.wr[j], 0.05); } continue; }
            const share = Math.max(0.8, Math.abs(lat) * k.O / (k.O + o.O) - 0.12);
            if (lat > 0) k.wl[j] = Math.min(k.wl[j], share); else k.wr[j] = Math.min(k.wr[j], share);
          }
        }
    }
    // smooth the trimmed edges so they never zig-zag
    for (const w of [k.wl, k.wr]) {
      const m = Float32Array.from(w);
      for (let j = 0; j < w.length; j++) m[j] = Math.min(w[j], w[Math.max(0, j - 1)], w[Math.min(w.length - 1, j + 1)]);
      for (let j = 0; j < w.length; j++) w[j] = (m[Math.max(0, j - 1)] + 2 * m[j] + m[Math.min(w.length - 1, j + 1)]) / 4;
    }
  });
  // pass 3: geometry
  decks.forEach((d, di) => {
    const { L, c, H } = d, k = DK[di], pts = k.P;
    const cid = chainOf[di] != null ? chainOf[di] : di; D.cur = cid; W.cur = cid;
    for (let j = 0; j < L; j++) {
      const { x, z: zz, h, nx, nz, ml, s } = pts[j], wl = k.wl[j], wr = k.wr[j];
      D.v(x + nx * wl * ml, h, zz + nz * wl * ml, 0, 1, 0, [wl, s, H, c]);
      D.v(x - nx * wr * ml, h, zz - nz * wr * ml, 0, 1, 0, [-wr, s, H, c]);
      if (j > 0) { const b = D.p.length / 3 - 4; D.i.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    }
    for (let j = 0; j < L - 1; j++) {
      const A = pts[j], B = pts[j + 1];
      if (A.h < 0.35 && B.h < 0.35) continue;
      for (const sg of [1, -1]) {
        const wa = sg > 0 ? k.wl[j] : k.wr[j], wb = sg > 0 ? k.wl[j + 1] : k.wr[j + 1];
        if (wa < 0.2 && wb < 0.2) continue;
        const ax = A.x + A.nx * wa * A.ml * sg, az = A.z + A.nz * wa * A.ml * sg, bx = B.x + B.nx * wb * B.ml * sg, bz = B.z + B.nz * wb * B.ml * sg;
        const n = [A.nx * sg, 0, A.nz * sg];
        W.quad([ax, Math.max(0, A.h - 1.3), az], [bx, Math.max(0, B.h - 1.3), bz], [bx, B.h + 0.85, bz], [ax, A.h + 0.85, az], n);
      }
    }
  });
  // piers: square column + hammerhead cap, positions aligned across twin carriageways (from the data build)
  for (const [x, zz, ux, uz, h, hc, cid, base = 0] of META.piers || []) {
    W.cur = cid;
    W.box(x, zz, ux, uz, 0.75, 0.85, base, h - 2.1);   // river piers stand on the bed of the sunken channel
    W.box(x, zz, ux, uz, 0.95, hc, h - 2.1, h - 1.3);
  }
  for (const m of geoTiles(D, DECK, [0, 14])) group.ground.add(m);
  for (const m of geoTiles(W, DECKWALL, [0, 14])) group.ground.add(m);
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
    const inCh = TR && TR.river && s > w0 - 13 && e < w1 + 13;     // abutment toes reach down to the lower promenade
    const sb = inCh ? TR.river.py : 0;
    const b0 = solid ? sb : y0 - 1.4, b1 = solid ? sb : y1 - 1.4;
    S.quad(at(s, -hw, y0), at(e, -hw, y1), at(e, hw, y1), at(s, hw, y0), [0, 1, 0]);
    S.quad(at(s, -hw, b0), at(e, -hw, b1), at(e, -hw, y1 + 1.1), at(s, -hw, y0 + 1.1), [-vx, 0, -vz]);
    S.quad(at(e, hw, b1), at(s, hw, b0), at(s, hw, y0 + 1.1), at(e, hw, y1 + 1.1), [vx, 0, vz]);
  }
  // piers: one at each bank, two in the river
  const RV = TR && TR.river;
  for (const sp of [w0, w0 + (w1 - w0) / 3, w0 + 2 * (w1 - w0) / 3, w1]) {
    const bank = sp === w0 || sp === w1, base = RV ? (bank ? RV.py : RV.wy - 0.6) : 0;
    S.box(A.x0 + ux * sp, A.z0 + uz * sp, ux, uz, 1.6, hw * 0.7, base, A.deck - 1.4);
  }
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
  const xyi = r.arr(Int32Array, np * 2);
  const xy = new Float32Array(np * 2); for (let k = 0; k < np * 2; k++) xy[k] = xyi[k] / 10;   // half-metre units, 5 cm precision
  const jxy = r.arr(Int16Array, nj * 2), jr = r.arr(Uint8Array, nj), jhw = r.arr(Uint8Array, nj), jcls = r.arr(Uint8Array, nj);
  const start = new Uint32Array(n + 1); for (let i = 0; i < n; i++) start[i + 1] = start[i] + lens[i];
  let nz = 0; for (let i = 0; i < n; i++) if (br[i]) nz += lens[i];
  const zz = r.arr(Uint8Array, nz);
  const pmask = r.arr(Uint8Array, np * 2);
  const rflag = r.arr(Uint8Array, n), bclr = r.arr(Uint8Array, n);
  const zp = new Float32Array(np); { let zo2 = 0; for (let i = 0; i < n; i++) if (br[i]) { for (let j = 0; j < lens[i]; j++) zp[start[i] + j] = zz[zo2 + j] / 10; zo2 += lens[i]; } }
  ROADS = { n, cls, br, hw, sw, name, lens, xy, start, flag: rflag, bclr, zp, pmask };
  const SEG = 12;
  let nv = np * 2 + nj * (SEG + 1), ni = 0;
  for (let i = 0; i < n; i++) ni += (lens[i] - 1) * 6;
  ni += nj * SEG * 3;
  const pos = new Float32Array(nv * 2), aR = new Float32Array(nv * 4), aM = new Float32Array(nv), idx = new Uint32Array(ni);
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
  const qDisc = q;
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
      const w = c + (br[i] ? 16 : 0) + (rflag[i] & 1 ? 32 : 0);
      pos[v * 2] = x + nx * O * ml; pos[v * 2 + 1] = z + nz * O * ml; aR[v * 4] = O; aR[v * 4 + 1] = s; aR[v * 4 + 2] = H; aR[v * 4 + 3] = w; aM[v] = pmask[(p + j) * 2] & 1; v++;
      pos[v * 2] = x - nx * O * ml; pos[v * 2 + 1] = z - nz * O * ml; aR[v * 4] = -O; aR[v * 4 + 1] = s; aR[v * 4 + 2] = H; aR[v * 4 + 3] = w; aM[v] = pmask[(p + j) * 2 + 1] & 1; v++;
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
  // culled tiles: junction discs first, then the ribbons, for each of the two passes (kerb, then asphalt + markings)
  const P2 = pos.subarray(0, v * 2), RA = { aR: new THREE.BufferAttribute(aR.subarray(0, v * 4), 4), aM: new THREE.BufferAttribute(aM.subarray(0, v), 1) };
  for (const m of flatTiles(P2, RA, idx.subarray(0, qDisc), [[ROAD0, 4], [ROAD1, 5]])) group.ground.add(m);
  for (const m of flatTiles(P2, RA, idx.subarray(qDisc, q), [[ROAD0, 4.1], [ROAD1, 5.1]])) group.ground.add(m);
  buildDecks(decks, xy);
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
let treeGeo, tankGeo, mumtyGeo, solarGeo;
const solarMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'varying vec3 vLN;', vBody: 'vLN = normal;', fHead: 'varying vec3 vLN;',
  fColor: `vec3 n = normalize(vLN);
  if (n.y > 0.6 && diffuseColor.r > 0.8) {
    vec2 q = vWPos.xz * vec2(6.0, 6.0);
    float grid = step(0.88, max(fract(q.x), fract(q.y * 0.6)));
    diffuseColor.rgb = mix(pow(vec3(0.10, 0.16, 0.30), vec3(2.2)), pow(vec3(0.75, 0.78, 0.82), vec3(2.2)), grid * 0.6);
  }`,
});
function initDetailGeos() {
  const canopy = new THREE.IcosahedronGeometry(1, 0); canopy.scale(3.0, 2.5, 3.0); canopy.translate(0, 5.0, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 3.4, 5); trunk.translate(0, 1.7, 0);
  const paint = (g, c) => { const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a.set(c, i * 3); g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g.index ? g.toNonIndexed() : g; };
  treeGeo = mergeGeometries([paint(canopy.toNonIndexed(), [1, 1, 1]), paint(trunk.toNonIndexed(), [0.55, 0.42, 0.33])]);
  // Sintex-style water tank: ribbed body, conical lid with a cap, on a small steel stand
  const body = new THREE.CylinderGeometry(0.62, 0.6, 1.2, 16, 1, true); body.translate(0, 0.32 + 0.6, 0);
  const lid = new THREE.CylinderGeometry(0.2, 0.63, 0.24, 16); lid.translate(0, 0.32 + 1.2 + 0.12, 0);
  const cap = new THREE.CylinderGeometry(0.17, 0.17, 0.1, 10); cap.translate(0, 0.32 + 1.2 + 0.24 + 0.05, 0);
  const bottom = new THREE.CylinderGeometry(0.6, 0.6, 0.04, 16); bottom.translate(0, 0.33, 0);
  const stand = new THREE.BoxGeometry(1.45, 0.3, 1.45); stand.translate(0, 0.15, 0);
  tankGeo = mergeGeometries([paint(body, [1, 1, 1]), paint(lid, [1.08, 1.08, 1.08]), paint(cap, [0.75, 0.75, 0.75]), paint(bottom, [1, 1, 1]), paint(stand, [0.45, 0.45, 0.47])]);
  // rooftop solar array: three tilted rows of panels on steel legs
  const parts = [];
  for (let r = 0; r < 3; r++) {
    const pnl = new THREE.BoxGeometry(6.4, 0.05, 1.15); pnl.rotateX(-0.38); pnl.translate(0, 0.75, -1.9 + r * 1.9);
    parts.push(paint(pnl, [1, 1, 1]));
    for (const lx of [-2.9, 0, 2.9]) { const leg = new THREE.BoxGeometry(0.06, 0.9, 0.06); leg.translate(lx, 0.45, -1.9 + r * 1.9 - 0.3); parts.push(paint(leg, [0.35, 0.36, 0.38])); }
  }
  solarGeo = mergeGeometries(parts);
  // stair room (mumty): the door onto the terrace faces local +x (the washing line side), under a small chajja,
  // with a step out and a vent window on one side
  const bx = (w, h, d, x, y, z, c) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return paint(g, c); };
  mumtyGeo = mergeGeometries([
    bx(3.4, 2.7, 3.4, 0, 1.35, 0, C255(216, 209, 195)),                 // walls and roof slab
    bx(0.05, 2.2, 1.16, 1.715, 1.1, 0, C255(176, 168, 154)),            // door frame
    bx(0.06, 2.06, 0.92, 1.73, 1.05, 0, C255(60, 106, 116)),            // painted steel door
    bx(0.07, 0.05, 0.8, 1.74, 1.45, 0, C255(104, 146, 152)),            // its rail
    bx(0.45, 0.09, 1.5, 1.92, 2.3, 0, C255(205, 198, 184)),             // chajja over the door
    bx(0.36, 0.12, 1.2, 1.88, 0.06, 0, C255(168, 162, 152)),            // step
    bx(0.62, 0.48, 0.05, 0.4, 1.95, 1.715, C255(58, 62, 66)),           // vent window
  ]);
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
// ---------------------------------------------------------------- terrace parapets: waist-high walls round every flat roof
// three kinds: plastered solid wall with a light coping, a cement jali with two rows of openings, and an MS railing
// on a low upstand. aPar = (metres along the edge x10, 0 at the roof / 1 at the top, kind, railing paint)
const PAR_CUT = `
float parCut(vec4 P, out float det, out float open) {
  float u = P.x * 0.1, v = P.y; int K = int(P.z + 0.5);
  det = 1.0 - smoothstep(0.05, 0.10, fwidth(u)); open = 0.0;
  if (K == 1) {
    float ru = fract(u / 0.28), rv = fract((v - 0.30) / 0.28);
    open = step(0.30, v) * step(v, 0.86) * step(0.2, ru) * step(ru, 0.8) * step(0.18, rv) * step(rv, 0.82);
  } else if (K == 2 && v > 0.34) {
    float solid = step(fract(u / 1.8), 0.04) + step(0.93, v) + step(0.60, v) * step(v, 0.65) + step(fract(u / 0.3), 0.3);
    open = 1.0 - min(solid, 1.0);
  }
  return open * step(0.5, det);
}`;
const parMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'attribute vec4 aPar; varying vec4 vPar;', vBody: 'vPar = aPar;', fHead: 'varying vec4 vPar;' + PAR_CUT,
  fColor: `float pDet, pOpen; if (parCut(vPar, pDet, pOpen) > 0.5) discard;
  int PK = int(vPar.z + 0.5), PC = int(vPar.w + 0.5);
  if (PK == 2 && vPar.y > 0.34) {
    vec3 steel = PC == 0 ? vec3(0.030, 0.032, 0.036) : PC == 1 ? vec3(0.035, 0.085, 0.060) : vec3(0.045, 0.075, 0.120);
    diffuseColor.rgb = mix(mix(diffuseColor.rgb * 0.55, steel, 0.6), steel, pDet);
  } else diffuseColor.rgb *= 1.0 - 0.3 * pOpen * (1.0 - pDet);`,
});
const parDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
parDepth.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aPar; varying vec4 vPar;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPar = aPar;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vPar;' + PAR_CUT)
    .replace('void main() {', 'void main() {\n  float pDet, pOpen; if (parCut(vPar, pDet, pOpen) > 0.5) discard;');
};
function parapetMesh(S, ox, oz) {
  const { n, floors, style, kind, rc, rl, abs, polT } = S;
  // which buildings: flat roofs only (no tiled pol roofs, sheds, special structures), at least one floor
  const ringStart = new Uint32Array(n + 1), ptStart = new Uint32Array(n + 1);
  let rr = 0, pp = 0, ne = 0;
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ringStart[i] = rr; ptStart[i] = pp;
    const r0 = rr; for (let k = 0; k < rc[i]; k++) pp += rl[rr++];
    const ws = PAL[style[i]].ws;
    if (kind[i] !== 0 || floors[i] < 1 || ws === 0 || ws === 10 || (polT[i] === 2 && rc[i] === 1)) continue;
    ok[i] = 1; ne += pp - ptStart[i];
  }
  ringStart[n] = rr; ptStart[n] = pp;
  if (!ne) return null;
  const NV = ne * 12;
  const pos = new Int16Array(NV * 3), nor = new Int8Array(NV * 3), col = new Uint8ClampedArray(NV * 3), par = new Int16Array(NV * 4), idx = new Uint32Array(ne * 18);
  let v = 0, q = 0;
  const V = (x, y, z, nx, ny, nz, c, u, h, K, C) => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
    col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
    par[v * 4] = u; par[v * 4 + 1] = h; par[v * 4 + 2] = K; par[v * 4 + 3] = C; return v++;
  };
  const quad = (a, b, c, d) => { idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = a; idx[q++] = c; idx[q++] = d; };
  const IX = new Float64Array(4096), IZ = new Float64Array(4096), NX = new Float64Array(4096), NZ = new Float64Array(4096);
  for (let b = 0; b < n; b++) {
    if (!ok[b]) continue;
    const fl = floors[b], H = fl * 31 + 5, pal = PAL[style[b]], h1 = hash1(b * 4271 + ox * 3 + oz);
    const jit = 0.93 + 0.12 * hash1(b * 7919 + ox);                               // same wall colour as the building
    const wc = [pal.w[0] * jit, pal.w[1] * jit, pal.w[2] * jit];
    // kind by building type: towers solid or railing, pol houses solid or jali, ordinary houses any of the three
    const K = polT[b] ? (h1 < 0.55 ? 0 : 1) : fl >= 5 || pal.ws === 2 ? (h1 < 0.65 ? 0 : 2) : (h1 < 0.5 ? 0 : h1 < 0.75 ? 1 : 2);
    const C = Math.floor(hash1(b * 37 + 11) * 3), T = K === 2 ? 0.8 : 2.2, PH = 10;   // dm: wall thickness, height
    const cap = K === 2 ? wc : [wc[0] * 0.75 + 60, wc[1] * 0.75 + 60, wc[2] * 0.75 + 60];
    const inC = [wc[0] * 0.9, wc[1] * 0.9, wc[2] * 0.9];
    let pt = ptStart[b];
    for (let k = ringStart[b]; k < ringStart[b + 1]; k++) {
      const m = rl[k]; if (m < 3 || m > 4000) { pt += m; continue; }
      for (let e = 0; e < m; e++) {   // outward edge normals
        const a = (pt + e) * 2, c2 = (pt + (e + 1) % m) * 2, dx = abs[c2] - abs[a], dz = abs[c2 + 1] - abs[a + 1], L = Math.hypot(dx, dz) || 1;
        NX[e] = -dz / L; NZ[e] = dx / L;
      }
      for (let e = 0; e < m; e++) {   // inner edge of the wall: mitred offset, capped at 3x on sharp corners
        const p = (e + m - 1) % m; let mx = NX[p] + NX[e], mz = NZ[p] + NZ[e]; const ml = Math.hypot(mx, mz);
        if (ml < 1e-3) { mx = NX[e]; mz = NZ[e]; } else { mx /= ml; mz /= ml; }
        const d = Math.min(3 * T, T / Math.max(0.33, mx * NX[e] + mz * NZ[e]));
        IX[e] = abs[(pt + e) * 2] - mx * d; IZ[e] = abs[(pt + e) * 2 + 1] - mz * d;
      }
      for (let e = 0; e < m; e++) {
        const f = (e + 1) % m, ax = abs[(pt + e) * 2], az = abs[(pt + e) * 2 + 1], bx = abs[(pt + f) * 2], bz = abs[(pt + f) * 2 + 1];
        const L = Math.min(32000, Math.round(Math.hypot(bx - ax, bz - az)));
        const nx = Math.round(NX[e] * 127), nz = Math.round(NZ[e] * 127);
        const iax = Math.round(IX[e]), iaz = Math.round(IZ[e]), ibx = Math.round(IX[f]), ibz = Math.round(IZ[f]);
        let o = v;   // outer face
        V(ax, H, az, nx, 0, nz, wc, 0, 0, K, C); V(bx, H, bz, nx, 0, nz, wc, L, 0, K, C); V(bx, H + PH, bz, nx, 0, nz, wc, L, 1, K, C); V(ax, H + PH, az, nx, 0, nz, wc, 0, 1, K, C);
        quad(o, o + 1, o + 2, o + 3);
        o = v;       // inner face (facing the terrace)
        V(ibx, H, ibz, -nx, 0, -nz, inC, L, 0, K, C); V(iax, H, iaz, -nx, 0, -nz, inC, 0, 0, K, C); V(iax, H + PH, iaz, -nx, 0, -nz, inC, 0, 1, K, C); V(ibx, H + PH, ibz, -nx, 0, -nz, inC, L, 1, K, C);
        quad(o, o + 1, o + 2, o + 3);
        o = v;       // coping
        V(ax, H + PH, az, 0, 127, 0, cap, 0, 1, K, C); V(bx, H + PH, bz, 0, 127, 0, cap, L, 1, K, C); V(ibx, H + PH, ibz, 0, 127, 0, cap, L, 1, K, C); V(iax, H + PH, iaz, 0, 127, 0, cap, 0, 1, K, C);
        quad(o, o + 1, o + 2, o + 3);
      }
      pt += m;
    }
  }
  if (!v) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
  g.setAttribute('aPar', new THREE.BufferAttribute(par.subarray(0, v * 4), 4));
  g.setIndex(new THREE.BufferAttribute(idx.subarray(0, q), 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, parMat);
  mesh.customDepthMaterial = parDepth;
  mesh.scale.setScalar(0.1); mesh.position.set(ox, 0, oz); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 10;
  mesh.dispose = () => g.dispose();
  return mesh;
}
function buildProps(ch) {
  ch.props = [];
  for (const [buf, off, len] of [[BUF.bld, ch.bo, ch.bl], [BUF.cells, ch.co, ch.cl]]) {   // parapets on buildings and cell houses
    if (!buf || !len) continue;
    const pm = parapetMesh(decodeBld(buf, off), ch.ox, ch.oz);
    if (pm) { group.near.add(pm); ch.props.push(pm); }
  }
  if (!ch.pl || !BUF.props) return;
  const r = new Reader(BUF.props, ch.po); const n = r.u32();
  const X = r.arr(Int16Array, n), Z = r.arr(Int16Array, n), Y = r.arr(Uint16Array, n), T = r.arr(Uint8Array, n), RO = r.arr(Uint8Array, n), SC = r.arr(Uint8Array, n);
  let nt = 0, nm = 0, ns = 0; for (let i = 0; i < n; i++) T[i] === 0 ? nt++ : T[i] === 2 ? ns++ : nm++;   // 1 and 3: stair rooms
  const tanks = new THREE.InstancedMesh(tankGeo, tankMat, Math.max(nt, 1)); tanks.count = nt;
  const mum = new THREE.InstancedMesh(mumtyGeo, mumtyMat, Math.max(nm, 1)); mum.count = nm;
  const sol = new THREE.InstancedMesh(solarGeo, solarMat, Math.max(ns, 1)); sol.count = ns;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    _p.set(X[i] * 0.1, Y[i] * 0.1, Z[i] * 0.1);
    const s = SC[i] / 20;
    if (T[i] === 0) { _q.identity(); _s.set(s, s, s); _m.compose(_p, _q, _s); tanks.setColorAt(a, TANK_COLS[Math.floor(hash1(i * 13 + ch.cx * 7 + ch.cy * 3) * TANK_COLS.length)]); tanks.setMatrixAt(a++, _m); }
    else if (T[i] !== 2) { _e.set(0, (RO[i] / 255) * Math.PI, 0); _q.setFromEuler(_e); _s.set(s, s > 1.2 ? 1.3 : 1, s); _m.compose(_p, _q, _s); mum.setMatrixAt(b++, _m); }
    else { _e.set(0, (RO[i] / 255) * Math.PI, 0); _q.setFromEuler(_e); _s.set(1, 1, 1); _m.compose(_p, _q, _s); sol.setMatrixAt(c++, _m); }
  }
  for (const im of [tanks, mum, sol]) { im.position.set(ch.ox, 0, ch.oz); im.castShadow = true; im.receiveShadow = true; im.renderOrder = 10; im.computeBoundingSphere(); group.near.add(im); ch.props.push(im); }
  const life = rooftopLife(ch, X, Z, Y, T, RO, SC, n);   // washing lines, people and chairs on some terraces
  if (life) { life.dispose = () => life.geometry.dispose(); group.near.add(life); ch.props.push(life); }
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
const NEAR_MPP = 2.6, TREE_MPP = 1.6, PROP_MPP = 1.05;
let queue = [];
function updateLOD(Q) {
  setFarLod(view.mpp > 6.5);
  if (POLMESH) POLMESH.visible = view.mpp < 3.2;
  for (const m of RIVER_FINE) m.visible = view.mpp < 2.6;
  U.uMpp.value = view.mpp;
  if (IND) { IND.stacks.visible = view.mpp < 12; IND.tanks.visible = view.mpp < 3; for (const m of IND.ponds) m.visible = view.mpp < 2.2; IND.smoke.visible = settings.smoke !== false; }
  for (const m of BRTS_FINE) m.visible = view.mpp < 2.6;
  const showRoutes = view.mpp > 2.2 && settings.labels;
  for (const m of ROUTE_MESHES) m.visible = showRoutes;
  ROUTE_U.uW.value = clamp(view.mpp * 1.9, 4, 90);
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
  const icon = { lake: '~', river: '~', monument: '★', stadium: '◎', airport: '✈', campus: '◆', park: '♣', gate: '∩', tower: '▲', industry: '⚙︎' };
  for (const l of META.landmarks) LBL.poi.push({ el: mk('poi ' + l.kind, `<span class="pin">${icon[l.kind] || '★'}</span>${l.name}`), x: l.x, z: l.z, min: l.kind === 'gate' ? 5 : 14 });
  for (const s of META.stations) LBL.poi.push({ el: mk('poi station', `<span class="pin">🚆︎</span>${s.name}`), x: s.x, z: s.z, min: 6 });
  if (TR) for (const s of TR.metro.stations) {
    if (s.corr === 'red' && s.id === 'GMRCL_OLD_HIGH_COURT') continue;
    const dots = s.lines.map((l) => `<i style="background:${COLS[l]}"></i>`).join('');
    LBL.poi.push({ el: mk('poi metro', `<span class="pin">M</span>${s.n}<span class="ml">${dots}</span>`), x: s.x, z: s.z, y: s.ug ? 4 : s.rl + 9, min: 7 });
  }
  if (TR && TR.brts) for (const s of TR.brts.stations) LBL.poi.push({ el: mk('poi brts', `<span class="pin">B</span>${s.n}`), x: s.x, z: s.z, y: 6, min: 3.2 });
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
    const [sx, sy] = worldToScreen(o.x, o.y || 0, o.z);
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
  if (TR) for (const s of TR.metro.stations) if (!(s.corr === 'red' && s.id === 'GMRCL_OLD_HIGH_COURT')) SEARCH.push({ t: s.n + ' Metro', k: 'station', x: s.x, z: s.z, m: 0.7 });
  if (TR && TR.brts) for (const s of TR.brts.stations) SEARCH.push({ t: s.n + ' BRTS', k: 'station', x: s.x, z: s.z, m: 0.6 });
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

// ---------------------------------------------------------------- transit geometry helpers
// TGeo: positions, normals, vertex colours and a vec4 'aK' (kind, across-offset, chainage, spare) for the
// metro and riverfront shaders; meshes are split into the same culled tiles as the ground layers.
let TR = null;
class TGeo {
  constructor() { this.p = []; this.n = []; this.c = []; this.k = []; this.i = []; }
  v(x, y, z, nx, ny, nz, col, k) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); this.k.push(k[0], k[1], k[2], k[3] || 0);
    return this.p.length / 3 - 1;
  }
  quad(p0, p1, p2, p3, n, col, k = [0, 0, 0, 0]) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    if ((ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0) { const t = p1; p1 = p3; p3 = t; }
    const a = this.v(...p0, ...n, col, k), b = this.v(...p1, ...n, col, k), c = this.v(...p2, ...n, col, k), d = this.v(...p3, ...n, col, k);
    this.i.push(a, b, c, a, c, d);
  }
  // box in a local frame: centre (cx,cz), along (ux,uz) half ha, across half hc, y0..y1
  box(cx, cz, ux, uz, ha, hc, y0, y1, col, k, faces = 31) {
    const vx = -uz, vz = ux, P = (sa, sc, y) => [cx + ux * ha * sa + vx * hc * sc, y, cz + uz * ha * sa + vz * hc * sc];
    if (faces & 1) this.quad(P(-1, -1, y0), P(1, -1, y0), P(1, -1, y1), P(-1, -1, y1), [-vx, 0, -vz], col, k);
    if (faces & 2) this.quad(P(1, 1, y0), P(-1, 1, y0), P(-1, 1, y1), P(1, 1, y1), [vx, 0, vz], col, k);
    if (faces & 4) this.quad(P(1, -1, y0), P(1, 1, y0), P(1, 1, y1), P(1, -1, y1), [ux, 0, uz], col, k);
    if (faces & 8) this.quad(P(-1, 1, y0), P(-1, -1, y0), P(-1, -1, y1), P(-1, 1, y1), [-ux, 0, -uz], col, k);
    if (faces & 16) this.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), [0, 1, 0], col, k);
    if (faces & 32) this.quad(P(-1, -1, y0), P(1, -1, y0), P(1, 1, y0), P(-1, 1, y0), [0, -1, 0], col, k);
  }
  // vertical prism from a convex polygon given in a local (along, across) frame
  prism(cx, cz, ux, uz, poly, y0, y1, col, k, top = true) {
    const vx = -uz, vz = ux, W = poly.map(([a, c]) => [cx + ux * a + vx * c, cz + uz * a + vz * c]);
    for (let i = 0; i < W.length; i++) {
      const A = W[i], B = W[(i + 1) % W.length], ex = B[0] - A[0], ez = B[1] - A[1], l = Math.hypot(ex, ez) || 1;
      const mx = (A[0] + B[0]) / 2 - cx, mz = (A[1] + B[1]) / 2 - cz;
      let nx = ez / l, nz = -ex / l; if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
      this.quad([A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]], [nx, 0, nz], col, k);
    }
    if (top) for (let i = 1; i < W.length - 1; i++) {
      const a = this.v(W[0][0], y1, W[0][1], 0, 1, 0, col, k), b = this.v(W[i][0], y1, W[i][1], 0, 1, 0, col, k), c = this.v(W[i + 1][0], y1, W[i + 1][1], 0, 1, 0, col, k);
      this.i.push(a, c, b);
    }
  }
  tiles(mat, yr, { shadow = true, order = 10 } = {}) {
    if (!this.p.length) return [];
    const pos = new Float32Array(this.p);
    const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.Float32BufferAttribute(this.n, 3),
      color: new THREE.Float32BufferAttribute(this.c, 3), aK: new THREE.Float32BufferAttribute(this.k, 4) };
    return tileSplit(attrs, this.i, (i) => pos[i * 3], (i) => pos[i * 3 + 2], yr, (g) => {
      const m = new THREE.Mesh(g, mat); m.castShadow = shadow; m.receiveShadow = true; m.renderOrder = order; m.matrixAutoUpdate = false; return [m];
    });
  }
}
const lin = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
// left normals (miter) of a flat [x,z,...] polyline, as in roads
function lnormals(P) {
  const n = P.length / 2, N = new Float32Array(n * 2), M = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    let dx0, dz0, dx1, dz1;
    if (j > 0) { dx0 = P[j * 2] - P[j * 2 - 2]; dz0 = P[j * 2 + 1] - P[j * 2 - 1]; const l = Math.hypot(dx0, dz0) || 1; dx0 /= l; dz0 /= l; }
    if (j < n - 1) { dx1 = P[j * 2 + 2] - P[j * 2]; dz1 = P[j * 2 + 3] - P[j * 2 + 1]; const l = Math.hypot(dx1, dz1) || 1; dx1 /= l; dz1 /= l; }
    if (j === 0) { dx0 = dx1; dz0 = dz1; } if (j === n - 1) { dx1 = dx0; dz1 = dz0; }
    // 'map-left' of travel in three.js coordinates (z = -north) is (dz, -dx)
    let mx = dz0 + dz1, mz = -(dx0 + dx1); const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = dz1; mz = -dx1; } else { mx /= ml; mz /= ml; }
    const dot = mx * dz1 + mz * -dx1;
    N[j * 2] = mx; N[j * 2 + 1] = mz; M[j] = Math.min(1 / Math.max(dot, 0.3), 3);
  }
  return [N, M];
}

const TR_SHADE = `
  vec3 wn = normalize(vLN);
  float kind = vK.x;`;
// metro concrete, rails on the trough floor, station glass / roof / platforms (aK.x = kind, aK.y = across offset, aK.z = chainage)
const MET = hook(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
  vHead: 'attribute vec4 aK; varying vec4 vK; varying vec3 vLN;', vBody: 'vK = aK; vLN = normal;',
  fHead: 'varying vec4 vK; varying vec3 vLN;',
  fColor: TR_SHADE + `
  vec3 c = diffuseColor.rgb;
  float px = length(fwidth(vWPos.xz)); float det = 1.0 - smoothstep(0.06, 0.22, px);
  if (kind > 3.5 && kind < 4.5) {          // trough / track floor: plinths, running rails, third rail
    float v = vK.y; float at = abs(v); float tv = abs(at - 2.35);
    vec3 b = vec3(0.56,0.55,0.52) * (0.9 + 0.12*vnoise(mod(vWPos.xz*2.0, 1024.0)));
    float plinth = 1.0 - step(0.95, tv);
    b = mix(b, vec3(0.64,0.63,0.60), plinth);
    float fast = step(fract(vK.z / 0.65), 0.18) * plinth;
    b = mix(b, vec3(0.30,0.30,0.30), fast * det);
    float rail = 1.0 - smoothstep(0.035, 0.07, abs(tv - 0.7175));
    b = mix(b, vec3(0.80,0.80,0.82), rail * max(det, 0.6));
    float third = (1.0 - smoothstep(0.04, 0.08, abs(at - 3.85))) ;
    b = mix(b, vec3(0.62,0.58,0.40), third * det);
    c = pow(b, vec3(2.2));
  } else if (kind > 0.5 && kind < 1.5) {   // glass with mullions + warm interior at night
    vec2 t = normalize(vec2(-wn.z, wn.x)); float u = dot(vWPos.xz, t);
    float m = max(1.0 - smoothstep(0.03, 0.06, abs(fract(u / 1.8) - 0.5) * 1.8 - 0.84), 1.0 - smoothstep(0.03, 0.06, abs(fract(vWPos.y / 2.0) - 0.5) * 2.0 - 0.94));
    vec3 g = mix(vec3(0.20,0.29,0.34), vec3(0.42,0.55,0.62), smoothstep(0.0, 1.0, fract(vWPos.y / 2.0)));
    c = pow(mix(g, vec3(0.78,0.79,0.80), m * det), vec3(2.2));
    xEm = vec3(1.0, 0.86, 0.62) * 1.1 * uNight * (1.0 - m);
  } else if (kind > 1.5 && kind < 2.5) {   // roof sheeting: standing seams along the station
    float seam = 1.0 - smoothstep(0.02, 0.05, abs(fract(vK.y / 0.6) - 0.5) * 0.6 - 0.25);
    c *= 0.92 + 0.08 * seam * det + 0.06*vnoise(mod(vWPos.xz*0.3, 1024.0));
    float sky = step(abs(vK.y), 1.3);
    c = mix(c, pow(vec3(0.55,0.68,0.76), vec3(2.2)), sky);
  } else if (kind > 2.5 && kind < 3.5) {   // platform: granite + yellow tactile edge strip
    float e = abs(vK.y);
    c = pow(vec3(0.74,0.72,0.69) * (0.94 + 0.08*vnoise(mod(vWPos.xz*3.0, 1024.0))), vec3(2.2));
    c = mix(c, pow(vec3(0.95,0.78,0.10), vec3(2.2)), step(e, 4.55) * step(4.0, e));
    xEm = vec3(1.0,0.92,0.78) * 0.6 * uNight;
  } else if (kind > 4.5 && kind < 5.5) {   // tunnel mouth
    c = vec3(0.01);
  } else {
    c *= 0.9 + 0.12*vnoise(mod(vWPos.xz*0.6 + vWPos.y*0.4, 1024.0));
    c *= mix(0.86, 1.0, smoothstep(0.0, 3.0, vWPos.y));
  }
  diffuseColor.rgb = c;`,
});
// cars: white body, dark window band, line-colour stripe (instanceColor), cab glazing on the end faces
const TRAINMAT = hook(new THREE.MeshLambertMaterial({ color: 0xffffff }), {
  vHead: 'varying vec3 vLN;', vBody: 'vLN = normal;', fHead: 'varying vec3 vLN;',
  fColor: `
  vec3 lc = diffuseColor.rgb; vec3 n = normalize(vLN); float y = vWPos.y; float x = vWPos.x;
  vec3 c = vec3(0.86,0.87,0.88);
  float side = step(0.6, abs(n.z)); float endf = step(0.6, abs(n.x));
  float win = step(1.75, y) * step(y, 2.85) * side * step(0.18, abs(fract(x / 2.75) - 0.5));
  float door = side * step(abs(fract((x + 0.4) / 5.45) - 0.5), 0.12) * step(0.95, y) * step(y, 3.05);
  c = mix(c, vec3(0.70,0.72,0.74), door);
  c = mix(c, vec3(0.10,0.13,0.16), max(win, door * step(1.75, y) * step(y, 2.85)));
  c = mix(c, pow(lc, vec3(1.0/2.2)), step(1.38, y) * step(y, 1.62) * side);
  c = mix(c, vec3(0.08,0.10,0.12), endf * step(1.9, y) * step(y, 3.0));
  c = mix(c, vec3(0.25,0.26,0.27), step(y, 0.95));
  c = mix(c, vec3(0.72,0.73,0.74), step(0.9, n.y));
  diffuseColor.rgb = pow(c, vec3(2.2));
  xEm = vec3(1.0,0.92,0.75) * 0.9 * uNight * max(win, endf * step(1.9, y) * step(y, 3.0) * 0.6);`,
});
// riverfront: retaining walls (formwork panels, coping, water staining), promenade paving, steps
const RIVER_UWY = { value: -5.6 }, RIVER_UPY = { value: -4.5 };
const RIVERMAT = hook(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), {
  vHead: 'attribute vec4 aK; varying vec4 vK; varying vec3 vLN;', vBody: 'vK = aK; vLN = normal;',
  fHead: 'varying vec4 vK; varying vec3 vLN; uniform float uWY; uniform float uPY;', uniforms: { uWY: RIVER_UWY, uPY: RIVER_UPY },
  fColor: TR_SHADE + `
  vec3 c = diffuseColor.rgb; float y = vWPos.y;
  float px = length(fwidth(vWPos.xz)) + fwidth(y); float det = 1.0 - smoothstep(0.08, 0.3, px);
  float wall = 1.0 - step(0.6, abs(wn.y));
  if (kind > 0.5 && kind < 1.5) {          // promenade floor: running-bond pavers
    vec2 q = vWPos.xz / vec2(0.9, 0.45); q.x += 0.5 * step(1.0, mod(floor(q.y), 2.0));
    vec2 f = abs(fract(q) - 0.5);
    float j = max(smoothstep(0.43, 0.5, f.x), smoothstep(0.38, 0.5, f.y));
    c *= 0.94 + 0.10 * h21(floor(q));
    c = mix(c, c * 0.72, j * det);
    c *= 0.92 + 0.1*vnoise(mod(vWPos.xz*0.5, 1024.0));
    xEm = c * vec3(1.0, 0.85, 0.62) * 0.55 * uNight;                        // lit by the wall lamps
  } else if (wall > 0.5) {
    vec2 t = normalize(vec2(-wn.z, wn.x)); float u = dot(vWPos.xz, t);
    float jy = 1.0 - smoothstep(0.015, 0.04, min(fract(y / 1.2), 1.0 - fract(y / 1.2)) * 1.2);
    float jx = 1.0 - smoothstep(0.015, 0.04, min(fract(u / 2.4), 1.0 - fract(u / 2.4)) * 2.4);
    c *= 0.95 + 0.07 * h21(vec2(floor(u / 2.4), floor(y / 1.2)));
    c = mix(c, c * 0.8, max(jx, jy) * det * 0.8);
    c = mix(c, c * 1.12, step(-0.35, y) * step(y, 0.02));                      // coping
    c *= mix(0.62, 1.0, smoothstep(uWY + 0.1, uWY + 1.3, y));                   // wet line / algae
    c *= 0.94 + 0.08*vnoise(mod(vec2(u * 0.4, y * 2.0), 1024.0));
    // wall-mounted promenade lamps every 14 m, 2.6 m above the lower promenade, and their wash on the wall
    float dl = abs(fract(u / 14.0) - 0.5) * 14.0; float ly = y - (uPY + 2.6);
    float lamp = (1.0 - smoothstep(0.18, 0.3, dl)) * (1.0 - smoothstep(0.08, 0.16, abs(ly)));
    float wash = exp(-dl * dl / 8.0) * exp(-ly * ly / 3.0);
    xEm = vec3(1.0, 0.82, 0.55) * (lamp * 4.0 + wash * 0.45) * uNight;
  } else {
    c *= 0.93 + 0.1*vnoise(mod(vWPos.xz*0.8, 1024.0));
  }
  diffuseColor.rgb = c;`,
});
const RWATER = hook(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), { fColor: WATER_FC });
// railings: a vertical ribbon, the shader cuts posts and rails out of it (aK.y = height 0..1, aK.z = chainage)
const RAILING = hook(new THREE.MeshLambertMaterial({ color: '#8d959c', side: THREE.DoubleSide }), {
  vHead: 'attribute vec4 aK; varying vec4 vK;', vBody: 'vK = aK;', fHead: 'varying vec4 vK;',
  fColor: `
  float h = vK.y; float s = vK.z;
  float fs = fract(s / 2.2); float post = 1.0 - step(0.04, min(fs, 1.0 - fs) * 2.2);
  float bar = step(0.92, h) + (1.0 - step(0.03, abs(h - 0.5))) + (1.0 - step(0.03, abs(h - 0.12)));
  if (post + bar < 0.5 && fwidth(s) < 0.25) discard;
  if (fwidth(s) >= 0.25 && h < 0.85) discard;`,
});
const UPPERMAT = groundMat(`
  vec2 p = vWPos.xz;
  vec2 q = p / vec2(0.6, 0.3); q.x += 0.5 * step(1.0, mod(floor(q.y), 2.0));
  vec2 f = abs(fract(q) - 0.5); float px = length(fwidth(p)); float det = 1.0 - smoothstep(0.05, 0.2, px);
  vec3 c = mix(vec3(0.70,0.55,0.47), vec3(0.76,0.66,0.58), step(0.5, h21(floor(q / vec2(6.0, 12.0)))));
  c *= 0.93 + 0.1 * h21(floor(q));
  c = mix(c, c * 0.8, max(smoothstep(0.42, 0.5, f.x), smoothstep(0.36, 0.5, f.y)) * det);
  c = mix(c, vec3(0.86,0.84,0.80), smoothstep(2.0, 9.0, length(fwidth(vWPos.xz))) * 0.5);
  diffuseColor.rgb = pow(c, vec3(2.2));
  xEm = diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * 0.5 * uNight;`);
const LIDMAT = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
const LAMPMAT = hook(new THREE.MeshLambertMaterial({ color: '#5d6266' }), {
  fEmissive: 'xEm += step(4.9, vWPos.y) * vec3(1.0,0.82,0.52) * 6.0 * uNight;',
});

function triVZ(t, y) {   // {v:[x,z,...], i:[...]} -> 3D positions at height y
  const n = t.v.length / 2, pos = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) { pos[k * 3] = t.v[k * 2]; pos[k * 3 + 1] = y; pos[k * 3 + 2] = t.v[k * 2 + 1]; }
  return pos;
}
function flatMeshTiles(t, y, mat, order, extra = {}) {
  if (!t || !t.v.length) return [];
  const pos = triVZ(t, y), n = pos.length / 3, nor = new Float32Array(n * 3), col = new Float32Array(n * 3).fill(1), k = new Float32Array(n * 4);
  for (let q = 0; q < n; q++) { nor[q * 3 + 1] = 1; k[q * 4] = extra.kind || 0; }
  if (extra.col) for (let q = 0; q < n; q++) { col[q * 3] = extra.col[0]; col[q * 3 + 1] = extra.col[1]; col[q * 3 + 2] = extra.col[2]; }
  const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nor, 3), color: new THREE.BufferAttribute(col, 3), aK: new THREE.BufferAttribute(k, 4) };
  return tileSplit(attrs, new Uint32Array(t.i), (i) => pos[i * 3], (i) => pos[i * 3 + 2], [y, y], (g) => {
    const m = new THREE.Mesh(g, mat); m.renderOrder = order; m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false; return [m];
  });
}
// vertical ribbon along a polyline (flat [x,z]); y0/y1 absolute; normal on the 'inside' (map-left) when side > 0
function wallStrip(T, P, y0, y1, col, kind, side = 1) {
  const n = P.length / 2;
  for (let j = 0; j < n - 1; j++) {
    const ax = P[j * 2], az = P[j * 2 + 1], bx = P[j * 2 + 2], bz = P[j * 2 + 3];
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 0.05) continue;
    const nx = dz / l * side, nz = -dx / l * side;
    T.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], [nx, 0, nz], col, [kind, 0, 0, 0]);
  }
}
function densify(P, step) {
  const out = [P[0], P[1]];
  for (let j = 1; j < P.length / 2; j++) {
    const ax = P[j * 2 - 2], az = P[j * 2 - 1], bx = P[j * 2], bz = P[j * 2 + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let q = 1; q <= n; q++) out.push(ax + (bx - ax) * q / n, az + (bz - az) * q / n);
  }
  return out;
}
function railStrip(T, P, y0, h, off = 0, skip = null) {
  const n = P.length / 2; let s = 0;
  const [N] = off ? lnormals(P) : [null];
  let pa = null;
  for (let j = 0; j < n; j++) {
    const x = P[j * 2] + (off ? N[j * 2] * off : 0), z = P[j * 2 + 1] + (off ? N[j * 2 + 1] * off : 0);
    if (skip && skip(x, z)) { if (pa) s += Math.hypot(x - pa[0], z - pa[1]); pa = null; continue; }
    if (pa) s += Math.hypot(x - pa[0], z - pa[1]);
    const yb = typeof y0 === 'function' ? y0(j) : y0;
    T.v(x, yb, z, 0, 0, 1, [1, 1, 1], [0, 0, s, 0]); T.v(x, yb + h, z, 0, 0, 1, [1, 1, 1], [0, 1, s, 0]);
    if (pa) { const b = T.p.length / 3 - 4; T.i.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    pa = [x, z];
  }
}

// ---------------------------------------------------------------- Sabarmati Riverfront
// The river runs in a 275 m channel between retaining walls: water ~1 m below a lower promenade, which sits
// ~4.5 m below the upper promenade / riverfront road. A depth-only 'lid' around the channel lets the land in
// front of the near bank hide the sunken parts, so the ground layers can stay flat and depth-free.
function buildRiverfront() {
  const R = TR && TR.river; if (!R) return;
  const wy = R.wy, py = R.py; RIVER_UWY.value = wy; RIVER_UPY.value = py;
  const out = [];
  const lid = flatMeshTiles(R.lid, 0.0, LIDMAT, 5.5); for (const m of lid) m.receiveShadow = false;
  out.push(...lid);
  out.push(...flatMeshTiles(R.water, wy, RWATER, 6));
  out.push(...flatMeshTiles(R.prom, py, RIVERMAT, 6, { kind: 1, col: lin('#c9c0b2') }));
  // upper promenade paving: a flat ground layer between parks and roads
  if (R.upper && R.upper.v.length) {
    const V = new Float32Array(R.upper.v);
    out.push(...flatTiles(V, {}, new Uint32Array(R.upper.i), [[UPPERMAT, 1.2]]));
  }
  const W = new TGeo(), wallCol = lin('#c4beb3');
  const onBarrage = (x, z) => R.barrages.some((b) => {
    const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], L = Math.hypot(dx, dz), t = ((x - b.a[0]) * dx + (z - b.a[1]) * dz) / (L * L);
    return t > -0.05 && t < 1.05 && Math.abs((x - b.a[0]) * dz - (z - b.a[1]) * dx) / L < 2.5;
  });
  for (const P of R.walls) {
    // retaining wall face from below the waterline up to city level; skip the stretches closed by the barrages
    const n = P.length / 2;
    for (let j = 0; j < n - 1; j++) {
      const ax = P[j * 2], az = P[j * 2 + 1], bx = P[j * 2 + 2], bz = P[j * 2 + 3];
      if (onBarrage(ax, az) && onBarrage(bx, bz)) continue;
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 0.05) continue;
      W.quad([ax, wy - 0.3, az], [bx, wy - 0.3, bz], [bx, 0.0, bz], [ax, 0.0, az], [dz / l, 0, -dx / l], wallCol, [0, 0, 0, 0]);
    }
  }
  for (const P of R.edges) wallStrip(W, P, wy - 0.3, py, lin('#bab3a6'), 0, 1);
  // stairs between the upper and lower promenades, as built on the riverfront: a solid concrete flight cast against
  // the retaining wall, entered from a landing flush with the upper promenade through an opening in the wall-top
  // railing, with steel handrails on the open side, landing on the lower promenade with a last step
  const stairCol = lin('#cfc8bb'), stairSide = lin('#c2bbae');
  const STAIR = { run: 9.6, land: 3.2, c0: -0.3, c1: 2.9, N: 26 };
  const RLs = new TGeo();
  for (const [x, z, ux, uz] of R.stairs) {
    const nx = uz, nz = -ux, { run, land, c0, c1, N } = STAIR, a00 = -run / 2;
    const P = (a, c, y) => [x + ux * a + nx * c, y, z + uz * a + nz * c];
    const ty = (k) => (py * (k + 1)) / (N + 1);   // tread k; the last tread is one riser above the promenade
    // landing: solid from the lower promenade up to city level
    W.quad(P(a00 - land, c0, 0), P(a00, c0, 0), P(a00, c1, 0), P(a00 - land, c1, 0), [0, 1, 0], stairCol);
    W.quad(P(a00 - land, c1, py), P(a00, c1, py), P(a00, c1, 0), P(a00 - land, c1, 0), [nx, 0, nz], stairSide);
    W.quad(P(a00 - land, c0, py), P(a00 - land, c1, py), P(a00 - land, c1, 0), P(a00 - land, c0, 0), [-ux, 0, -uz], stairSide);
    let yp = 0;
    for (let k = 0; k < N; k++) {
      const a0 = a00 + (run * k) / N, a1 = a0 + run / N, yt = ty(k);
      W.quad(P(a0, c0, yt), P(a1, c0, yt), P(a1, c1, yt), P(a0, c1, yt), [0, 1, 0], stairCol);          // tread
      W.quad(P(a0, c0, yt), P(a0, c1, yt), P(a0, c1, yp), P(a0, c0, yp), [ux, 0, uz], stairCol);        // riser
      W.quad(P(a0, c1, py), P(a1, c1, py), P(a1, c1, yt), P(a0, c1, yt), [nx, 0, nz], stairSide);      // solid side
      yp = yt;
    }
    W.quad(P(-a00, c0, yp), P(-a00, c1, yp), P(-a00, c1, py), P(-a00, c0, py), [ux, 0, uz], stairCol);   // last step down
    // handrail: round the landing's open end and side, then down the flight
    const rail = [P(a00 - land, c0 + 0.15, 0), P(a00 - land, c1 - 0.06, 0), P(a00, c1 - 0.06, 0), P(-a00, c1 - 0.06, yp)];
    railStrip(RLs, rail.flatMap((q) => [q[0], q[2]]), (j) => rail[j][1], 1.0, 0);
  }
  const inStairGap = (px, pz) => R.stairs.some(([x, z, ux, uz]) => {
    const dx = px - x, dz = pz - z, a = dx * ux + dz * uz;
    return Math.abs(dx * uz - dz * ux) < 1.6 && a > -STAIR.run / 2 - STAIR.land + 0.1 && a < -STAIR.run / 2 - 0.05;
  });
  const inGhatGap = (px, pz) => R.ghats.some(([x, z, ux, uz, w]) => {
    const dx = px - x, dz = pz - z;
    return Math.abs(dx * uz - dz * ux) < 1.6 && Math.abs(dx * ux + dz * uz) < w / 2 - 1.0;
  });
  // ghats: broad steps from the lower promenade down into the water
  const ghatCol = lin('#d6cfc1');
  for (const [x, z, ux, uz, w] of R.ghats) {
    const nx = uz, nz = -ux;   // towards the water
    const N = 4, dep = 0.9, drop = (py - (wy - 0.35)) / N;
    for (let k = 0; k < N; k++) {
      const c0 = k * dep, c1 = (k + 1) * dep, yt = py - drop * (k + 1);
      W.box(x + nx * (c0 + c1) / 2, z + nz * (c0 + c1) / 2, ux, uz, w / 2 - k * 0.8, dep / 2, wy - 0.4, yt, ghatCol, [0, 0, 0, 0], 1 | 2 | 4 | 8 | 16);
    }
  }
  out.push(...W.tiles(RIVERMAT, [wy - 1, 1]));
  // railings: along the wall top (upper promenade) and the lower promenade's water edge
  const RL = new TGeo();
  // the wall-top railing opens onto each stair landing, the water-edge railing onto each ghat
  for (const P of R.walls) railStrip(RL, densify(P, 0.8), 0.0, 1.05, -0.15, inStairGap);
  for (const P of R.edges) railStrip(RL, densify(P, 0.8), py, 1.0, -0.25, inGhatGap);
  RL.p.push(...RLs.p); RL.n.push(...RLs.n); RL.c.push(...RLs.c); RL.k.push(...RLs.k);
  { const off = RL.p.length / 3 - RLs.p.length / 3; for (const i of RLs.i) RL.i.push(i + off); }
  const rails = RL.tiles(RAILING, [wy, 1.5], { shadow: false });
  out.push(...rails); RIVER_FINE.push(...rails);
  // lamp posts on the upper promenade
  if (R.lamps.length) {
    const g = lampGeo(), im = new THREE.InstancedMesh(g, LAMPMAT, R.lamps.length), m4 = new THREE.Matrix4();
    R.lamps.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); im.setMatrixAt(i, m4); });
    im.computeBoundingSphere(); im.castShadow = true; im.renderOrder = 10; out.push(im); RIVER_FINE.push(im);
  }
  buildBarrages(R, out);
  for (const m of out) group.ground.add(m);
  // minimap: the channel walls
  mapCtx.strokeStyle = '#8b8174'; mapCtx.lineWidth = 0.8;
  for (const P of R.walls) { mapCtx.beginPath(); for (let j = 0; j < P.length / 2; j++) { const [mx, mz] = mapXY(P[j * 2], P[j * 2 + 1]); j ? mapCtx.lineTo(mx, mz) : mapCtx.moveTo(mx, mz); } mapCtx.stroke(); }
}
const RIVER_FINE = [];
function lampGeo() {
  const T = new TGeo(), c = [1, 1, 1], k = [0, 0, 0, 0];
  T.prism(0, 0, 1, 0, [[0.09, 0], [0.045, 0.078], [-0.045, 0.078], [-0.09, 0], [-0.045, -0.078], [0.045, -0.078]], 0, 5.2, c, k);
  T.box(0.45, 0, 1, 0, 0.55, 0.2, 4.95, 5.25, c, k, 63);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(T.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(T.n, 3));
  g.setIndex(T.i); return g;
}
// Vasna Barrage (gated, road on top) and the rubber-dam barrage-cum-bridge at Acher that closes the channel upstream
function buildBarrages(R, out) {
  const B = new TGeo(), con = lin('#c9c3b8'), steel = lin('#4f5c63'), rub = lin('#2b2d2f'), k0 = [0, 0, 0, 0];
  for (const b of R.barrages) {
    const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const at = (t) => [b.a[0] + ux * t, b.a[1] + uz * t];
    if (b.kind === 'vasna') {
      const N = Math.max(8, Math.round(L / 17.5)), sp = L / N;
      for (let i = 0; i <= N; i++) { const [x, z] = at(i * sp); B.box(x, z, ux, uz, 1.4, 7.5, R.wy - 0.6, 6.2, con, k0); }
      for (let i = 0; i < N; i++) {
        const [x, z] = at((i + 0.5) * sp);
        B.box(x, z, ux, uz, sp / 2 - 1.4, 0.35, R.wy - 0.3, 1.3, steel, k0);                  // gate leaf
        B.box(x, z, ux, uz, sp / 2 - 1.4, 0.6, 9.6, 10.4, steel, k0, 1 | 2 | 16 | 32);        // hoist girder
      }
      const [cx, cz] = at(L / 2);
      B.box(cx + -uz * -4.5, cz + ux * -4.5, ux, uz, L / 2 + 2, 3.6, 5.4, 6.2, con, k0);    // road deck
      B.box(cx, cz, ux, uz, L / 2, 6.0, R.wy - 0.6, R.wy - 0.1, con, k0, 16);               // sill / apron
    } else {
      const N = Math.max(6, Math.round(L / 32)), sp = L / N, vx = -uz, vz = ux;
      for (let i = 0; i <= N; i++) { const [x, z] = at(i * sp); B.box(x, z, ux, uz, 1.0, 6.0, R.wy - 0.6, 1.2, con, k0); }
      for (let i = 0; i < N; i++) {   // inflated rubber membrane, crest just above the upstream water
        const t0 = i * sp + 1.0, t1 = (i + 1) * sp - 1.0;
        const prof = [[-3.6, R.wy], [-2.2, -1.6], [-1.0, 0.05], [0.2, 0.35], [1.2, -0.4], [2.2, R.wy]];
        for (let q = 0; q < prof.length - 1; q++) {
          const [c0, y0] = prof[q], [c1, y1] = prof[q + 1];
          const [ax, az] = at(t0), [bx, bz] = at(t1);
          const nx_ = -(y1 - y0), ny_ = (c1 - c0), nl = Math.hypot(nx_, ny_);
          B.quad([ax + vx * c0, y0, az + vz * c0], [bx + vx * c0, y0, bz + vz * c0], [bx + vx * c1, y1, bz + vz * c1], [ax + vx * c1, y1, az + vz * c1],
            [vx * nx_ / nl, ny_ / nl, vz * nx_ / nl], rub, k0);
        }
      }
    }
  }
  out.push(...B.tiles(RIVERMAT, [R.wy - 1, 11]));
}

// ---------------------------------------------------------------- Ahmedabad Metro
// Twin single-track U-girders on single-column piers with hammerhead caps, two-level elevated stations
// (concourse below, side platforms above), street entrances for the four underground stations, tunnel portals
// at the two ramps, and trains running to the GTFS timetable on the left-hand track.
const TRACK = 2.35, GW = 4.65, SOFF = 2.3;
let METRO = null;
function corridorS(C) {
  const P = C.pts, n = P.length / 2, s = new Float32Array(n);
  for (let j = 1; j < n; j++) s[j] = s[j - 1] + Math.hypot(P[j * 2] - P[j * 2 - 2], P[j * 2 + 1] - P[j * 2 - 1]);
  return s;
}
function nearestIdx(P, x, z) {
  let bi = 0, bd = 1e18;
  for (let j = 0; j < P.length / 2; j++) { const d = (P[j * 2] - x) ** 2 + (P[j * 2 + 1] - z) ** 2; if (d < bd) { bd = d; bi = j; } }
  return [bi, Math.sqrt(bd)];
}
function buildMetro() {
  const M = TR && TR.metro; if (!M) return;
  const T = new TGeo(), pre = prepTrains(M), XO = metroCrossovers(pre);
  const conc = lin('#cdc7bc'), concD = lin('#bdb7ac');
  const ELEV = M.stations.filter((s) => !s.ug);
  const stOf = (s) => (s.corr === 'red' && s.id === 'GMRCL_OLD_HIGH_COURT') ? 'over' : 'full';
  // ---- viaduct
  for (const C of M.corr) {
    const P = C.pts, n = P.length / 2, s = corridorS(C);
    // crossover zones on this corridor (corridor distance): the twin troughs open into one deck there
    const gaps = [];
    for (const [r, s0, s1] of XO) {
      const a0 = routeAt(r, s0 - 5, { ..._ta }), a1 = routeAt(r, s1 + 5, { ..._ta });
      const [i0, d0] = nearestIdx(P, a0.x, a0.z), [i1, d1] = nearestIdx(P, a1.x, a1.z);
      if (d0 < 8 && d1 < 8) gaps.push([Math.min(s[i0], s[i1]), Math.max(s[i0], s[i1])]);
    }
    // points inside an elevated station on this level are left to the station structure
    const inSt = new Uint8Array(n);
    for (const st of ELEV) {
      for (let j = 0; j < n; j++) {
        const dx = P[j * 2] - st.x, dz = P[j * 2 + 1] - st.z;
        if (Math.abs(dx * st.ux + dz * st.uz) < st.L / 2 - 1 && Math.abs(-dx * st.uz + dz * st.ux) < 3 && Math.abs(C.rl[j] - st.rl) < 1.5) inSt[j] = 1;
      }
    }
    let j = 0;
    while (j < n) {
      if (C.ug[j] || inSt[j] || C.rl[j] < 1.3) { j++; continue; }   // below 1.3 m the line runs at grade (ballast track)
      let e = j; while (e < n && !C.ug[e] && !inSt[e] && C.rl[e] >= 1.3) e++;
      // decimate straight, evenly graded stretches
      const keep = [j]; let last = j;
      for (let q = j + 1; q < e - 1; q++) {
        const h0 = Math.atan2(P[last * 2 + 3] - P[last * 2 + 1], P[last * 2 + 2] - P[last * 2]);
        const h1 = Math.atan2(P[q * 2 + 3] - P[q * 2 + 1], P[q * 2 + 2] - P[q * 2]);
        let dh = Math.abs(h1 - h0); if (dh > Math.PI) dh = 2 * Math.PI - dh;
        const curv = Math.abs(C.rl[q + 1] - 2 * C.rl[q] + C.rl[q - 1]);
        const edge = gaps.some(([g0, g1]) => (s[last] < g0) !== (s[q + 1] < g0) || (s[last] < g1) !== (s[q + 1] < g1));
        if (dh > 0.008 || curv > 2e-3 || s[q] - s[last] > 24 || edge) { keep.push(q); last = q; }
      }
      if (e - 1 > j) keep.push(e - 1);
      const Q = new Float32Array(keep.length * 2), rl = keep.map((q) => C.rl[q]), ss = keep.map((q) => s[q]);
      keep.forEach((q, i) => { Q[i * 2] = P[q * 2]; Q[i * 2 + 1] = P[q * 2 + 1]; });
      viaductRun(T, Q, rl, ss, conc, concD, gaps);
      j = e;
    }
  }
  // ---- piers
  for (const [x, z, ux, uz, top, base] of M.piers) {
    const capB = top - 2.1;
    const r = 0.95, poly = []; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; poly.push([Math.cos(a) * r, Math.sin(a) * r * 1.15]); }
    T.prism(x, z, ux, uz, poly, base, capB + 0.2, concD, [0, 0, 0, 0], false);
    T.prism(x, z, ux, uz, [[-1.1, -1.7], [1.1, -1.7], [1.1, 1.7], [-1.1, 1.7]], capB, capB + 0.7, conc, [0, 0, 0, 0], false);
    // hammerhead: widens from the column to carry both girders
    const vx = -uz, vz = ux, Pt = (a, c, y) => [x + ux * a + vx * c, y, z + uz * a + vz * c];
    for (const sg of [1, -1]) {
      T.quad(Pt(-1.1, 1.7 * sg, capB + 0.7), Pt(1.1, 1.7 * sg, capB + 0.7), Pt(1.1, 4.7 * sg, top - 0.5), Pt(-1.1, 4.7 * sg, top - 0.5), [0, -0.6, 0], conc);
      T.quad(Pt(-1.1, 4.7 * sg, top - 0.5), Pt(1.1, 4.7 * sg, top - 0.5), Pt(1.1, 4.7 * sg, top), Pt(-1.1, 4.7 * sg, top), [vx * sg, 0, vz * sg], conc);
      T.quad(Pt(sg * 1.1, -1.7, capB + 0.7), Pt(sg * 1.1, 1.7, capB + 0.7), Pt(sg * 1.1, 1.7, top), Pt(sg * 1.1, -1.7, top), [ux * sg, 0, uz * sg], conc);
      T.quad(Pt(sg * 1.1, 1.7, capB + 0.7), Pt(sg * 1.1, 4.7, top - 0.5), Pt(sg * 1.1, 4.7, top), Pt(sg * 1.1, 1.7, top), [ux * sg, 0, uz * sg], conc);
      T.quad(Pt(sg * 1.1, -1.7, capB + 0.7), Pt(sg * 1.1, -4.7, top - 0.5), Pt(sg * 1.1, -4.7, top), Pt(sg * 1.1, -1.7, top), [ux * sg, 0, uz * sg], conc);
    }
    T.quad(Pt(-1.1, -4.7, top), Pt(1.1, -4.7, top), Pt(1.1, 4.7, top), Pt(-1.1, 4.7, top), [0, 1, 0], conc);
  }
  // ---- stations
  const blueOHC = M.stations.find((s) => s.id === 'GMRCL_OLD_HIGH_COURT' && s.corr === 'blue');
  for (const st of M.stations) {
    const col = lin(COLS[st.lines.find((l) => l === st.corr) || st.lines[0]] || '#888');
    if (st.ug) ugEntrances(T, st, col); else stationBox(T, st, col, stOf(st), stOf(st) === 'over' ? blueOHC : null);
  }
  // ---- tunnel portals of the Blue Line (west ramp by the river, east ramp before Apparel Park)
  for (const [x, z, ux, uz] of M.portals) portal(T, x, z, ux, uz);
  for (const m of T.tiles(MET, [-1, 32])) group.ground.add(m);
  // ---- minimap
  for (const C of M.corr) {
    const P = C.pts; mapCtx.strokeStyle = C.col; mapCtx.lineWidth = 2;
    let ug = -1;
    for (let j = 0; j < P.length / 2; j++) {
      if (C.ug[j] !== ug) { if (j) mapCtx.stroke(); mapCtx.beginPath(); mapCtx.setLineDash(C.ug[j] ? [3, 3] : []); ug = C.ug[j]; const [mx, mz] = mapXY(P[j * 2], P[j * 2 + 1]); mapCtx.moveTo(mx, mz); continue; }
      const [mx, mz] = mapXY(P[j * 2], P[j * 2 + 1]); mapCtx.lineTo(mx, mz);
    }
    mapCtx.stroke(); mapCtx.setLineDash([]);
  }
  buildCrossovers(XO);
  buildDepot(M, pre);
  initTrains(M, pre);
  buildRouteOverlay(M);
}
// city-scale route map: line-coloured ribbons over the viaducts (dashed where the Blue Line runs underground),
// screen-constant width, shown when zoomed out
const ROUTE_U = { uW: { value: 8 } };
const ROUTE_MAT = new THREE.ShaderMaterial({
  uniforms: ROUTE_U, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: `attribute float aSide; attribute vec2 aNrm; attribute vec3 aCol; attribute float aS; attribute float aUg;
    uniform float uW; varying vec3 vCol; varying float vS; varying float vUg;
    void main() { vCol = aCol; vS = aS; vUg = aUg; vec3 p = position + vec3(aNrm.x, 0.0, aNrm.y) * aSide * uW * mix(1.0, 0.7, aUg);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
  fragmentShader: `varying vec3 vCol; varying float vS; varying float vUg; uniform float uW;
    void main() { if (vUg > 0.5 && fract(vS / (uW * 5.0)) > 0.55) discard; gl_FragColor = vec4(vCol, 1.0); }`,
});
const ROUTE_MESHES = [];
function buildRouteOverlay(M) {
  for (const C of M.corr) {
    const P = C.pts, n = P.length / 2, [N, ML] = lnormals(P), s = corridorS(C);
    const pos = [], side = [], nrm = [], col = [], ss = [], ug = [], idx = [];
    const c = new THREE.Color(C.col); const cc = [c.r, c.g, c.b]; c.convertLinearToSRGB(); const sc = [c.r, c.g, c.b];
    for (let j = 0; j < n; j++) {
      const y = C.ug[j] ? 0.5 : Math.max(0.5, C.rl[j] + 1.2);
      for (const sd of [1, -1]) { pos.push(P[j * 2], y, P[j * 2 + 1]); side.push(sd); nrm.push(N[j * 2] * ML[j], N[j * 2 + 1] * ML[j]); col.push(...sc); ss.push(s[j]); ug.push(C.ug[j]); }
      if (j) { const b = j * 2 - 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 2)); g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(ss, 1)); g.setAttribute('aUg', new THREE.Float32BufferAttribute(ug, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, ROUTE_MAT); m.frustumCulled = false; m.renderOrder = 20; m.visible = false;
    group.ground.add(m); ROUTE_MESHES.push(m);
  }
}
const COLS = { blue: '#1e63c8', red: '#d7262b', yellow: '#f2b705', violet: '#7d3cc2' };
// one elevated run of the twin U-girder viaduct
function viaductRun(T, Q, rl, ss, conc, concD, gaps = []) {
  const n = Q.length / 2; if (n < 2) return;
  const [N, ML] = lnormals(Q);
  const at = (j, v, y) => [Q[j * 2] + N[j * 2] * v * ML[j], y, Q[j * 2 + 1] + N[j * 2 + 1] * v * ML[j]];
  // section strips: [v0, h0, v1, h1, normal kind, kind]; h relative to rail level; 'g' = down to the ground on ramps
  const S = [];
  for (const t of [1, -1]) {
    S.push([t * GW, 'g', t * GW, 0.95, 'o' + t, 0]);
    S.push([t * GW, 0.95, t * (GW - 0.32), 0.95, 'u', 0]);
    S.push([t * (GW - 0.32), 0.95, t * (GW - 0.32), -0.55, 'o' + -t, 0]);
    S.push([t * 0.37, -0.55, t * 0.37, 0.95, 'o' + t, 0]);
    S.push([t * 0.37, 0.95, t * 0.05, 0.95, 'u', 0]);
    S.push([t * GW, -SOFF, t * 0.05, -SOFF, 'd', 0]);
  }
  S.push([GW - 0.32, -0.55, -(GW - 0.32), -0.55, 'u', 4]);
  for (const [v0, h0, v1, h1, nk, kind] of S) {
    let prev = null;
    for (let j = 0; j < n; j++) {
      const low = rl[j] - SOFF < 1.4;
      if (nk === 'd' && low) { prev = null; continue; }
      if (Math.abs(v0) < 0.5 && Math.abs(v1) < 0.5 && gaps.some(([g0, g1]) => ss[j] > g0 && ss[j] < g1)) { prev = null; continue; }   // no centre walls over a crossover
      const y0 = h0 === 'g' ? (low ? 0 : rl[j] - SOFF) : rl[j] + h0, y1 = rl[j] + h1;
      const A = at(j, v0, y0), B = at(j, v1, y1);
      let nrm;
      if (nk === 'u') nrm = [0, 1, 0]; else if (nk === 'd') nrm = [0, -1, 0];
      else { const sg = nk === 'o1' ? 1 : -1; nrm = [N[j * 2] * sg, 0, N[j * 2 + 1] * sg]; }
      const col = nk === 'd' ? concD : conc;
      const ia = T.v(...A, ...nrm, col, [kind, v0, ss[j], 0]), ib = T.v(...B, ...nrm, col, [kind, v1, ss[j], 0]);
      if (prev) {
        const [pa, pb] = prev;
        // wind each quad (pa, ia, ib, pb) so its face normal agrees with nrm
        const p = T.p, ex = p[ia * 3] - p[pa * 3], ey = p[ia * 3 + 1] - p[pa * 3 + 1], ez = p[ia * 3 + 2] - p[pa * 3 + 2];
        const fx = p[ib * 3] - p[pa * 3], fy = p[ib * 3 + 1] - p[pa * 3 + 1], fz = p[ib * 3 + 2] - p[pa * 3 + 2];
        const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
        if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] >= 0) T.i.push(pa, ia, ib, pa, ib, pb); else T.i.push(pa, ib, ia, pa, pb, ib);
      }
      prev = [ia, ib];
    }
  }
}
function stationBox(T, st, lcol, mode, avoid) {
  const { x, z, ux, uz, rl, L, W } = st, hl = L / 2, hw = W / 2, vx = -uz, vz = ux;
  const P = (a, c, y) => [x + ux * a + vx * c, y, z + uz * a + vz * c];
  const conc = lin('#d4cfc5'), panel = lin('#e4e1da'), glass = lin('#ffffff'), roof = lin('#eceeef'), dark = lin('#8f9399');
  const K = (k, v = 0) => [k, v, 0, 0];
  const box = (a, c, ha, hc, y0, y1, col, k = K(0), faces = 63) => T.box(x + ux * a + vx * c, z + uz * a + vz * c, ux, uz, ha, hc, y0, y1, col, k, faces);
  const blocked = (a, c) => {
    if (!avoid) return false;
    const [px, , pz] = P(a, c, 0), dx = px - avoid.x, dz = pz - avoid.z;
    return Math.abs(dx * avoid.ux + dz * avoid.uz) < avoid.L / 2 + 2 && Math.abs(-dx * avoid.uz + dz * avoid.ux) < avoid.W / 2 + 2;
  };
  const concY0 = rl - 6.3, concY1 = rl - 5.5, platY0 = rl - 1.4;
  // portal-frame columns from the street
  for (let a = -60; a <= 60; a += 12) for (const c of [-6.5, 6.5]) {
    if (blocked(a, c)) continue;
    box(a, c, 0.6, 0.6, 0, mode === 'over' ? platY0 : concY0, conc);
  }
  if (mode === 'full') {
    box(0, 0, hl, hw, concY0, concY1, conc);                                    // concourse slab
    box(0, hw + 0.06, hl - 0.5, 0.06, concY0, concY1, lcol, K(0), 2);            // line-colour fascia
    box(0, -hw - 0.06, hl - 0.5, 0.06, concY0, concY1, lcol, K(0), 1);
    box(0, 0, hl - 9, hw - 0.6, concY1, platY0, glass, K(1));                   // glazed concourse
    for (const sg of [-1, 1]) box(sg * (hl - 9.5), 0, 0.5, hw - 0.4, concY1, platY0, panel, K(0), 4 | 8);
    for (const a of [-hl + 14, hl - 14]) for (const c of [-(hw - 3), hw - 3]) box(a, c, 6, 2.2, 0, concY0, panel); // stair / lift cores
  }
  box(0, 0, hl, 8.6, platY0, rl - 0.55, conc, K(0), 1 | 2 | 4 | 8 | 32);      // platform-level slab
  // track bed between the platforms (rails continue through)
  T.quad(P(-hl, -(GW - 0.32), rl - 0.55), P(hl, -(GW - 0.32), rl - 0.55), P(hl, GW - 0.32, rl - 0.55), P(-hl, GW - 0.32, rl - 0.55), [0, 1, 0], conc, [4, 0, 0, 0]);
  for (const sg of [-1, 1]) {
    // side platforms (top carries the tactile strip via aK.y = across offset)
    const c0 = sg * 3.95, c1 = sg * 8.4;
    T.quad(P(-hl + 2, c0, rl + 1.05), P(hl - 2, c0, rl + 1.05), P(hl - 2, c1, rl + 1.05), P(-hl + 2, c1, rl + 1.05), [0, 1, 0], conc, [3, 3.95 + 0.6, 0, 0]);
    // re-emit with per-vertex offsets so the yellow strip lands at the platform edge
    const iA = T.p.length / 3 - 4;
    for (let q = 0; q < 4; q++) T.k[(iA + q) * 4 + 1] = Math.abs((T.p[(iA + q) * 3] - x) * vx + (T.p[(iA + q) * 3 + 2] - z) * vz);
    T.quad(P(-hl + 2, c0, rl - 0.55), P(hl - 2, c0, rl - 0.55), P(hl - 2, c0, rl + 1.05), P(-hl + 2, c0, rl + 1.05), [-vx * sg, 0, -vz * sg], dark);
    box(0, sg * 8.55, hl - 2, 0.15, rl - 0.55, rl + 3.0, panel, K(0), sg > 0 ? 2 | 16 : 1 | 16);   // side screens
    for (let a = -60; a <= 60; a += 12) box(a, sg * 7.9, 0.22, 0.22, rl + 1.05, rl + 6.4, dark); // roof columns
  }
  for (const sg of [-1, 1]) for (const cs_ of [-1, 1]) {   // platform ends
    T.quad(P(sg * (hl - 2), cs_ * 3.95, rl - 0.55), P(sg * (hl - 2), cs_ * 8.4, rl - 0.55), P(sg * (hl - 2), cs_ * 8.4, rl + 1.05), P(sg * (hl - 2), cs_ * 3.95, rl + 1.05), [ux * sg, 0, uz * sg], conc);
  }
  // curved roof (double-sided), skylight along the crest
  const cs = [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10], yr = (c) => rl + 6.2 + 1.7 * (1 - (c / 10) ** 2);
  for (let i = 0; i < cs.length - 1; i++) {
    const c0 = cs[i], c1 = cs[i + 1], y0 = yr(c0), y1 = yr(c1), dn = Math.hypot(y1 - y0, c1 - c0);
    const nrm = [-vx * (y1 - y0) / dn, (c1 - c0) / dn, -vz * (y1 - y0) / dn];
    T.quad(P(-hl - 3, c0, y0), P(hl + 3, c0, y0), P(hl + 3, c1, y1), P(-hl - 3, c1, y1), nrm, roof, [2, (c0 + c1) / 2, 0, 0]);
  }
}
function ugEntrances(T, st, lcol) {
  const { ux, uz } = st;
  const panel = lin('#e2ded6'), glass = lin('#ffffff'), roof = lin('#d9dcdf');
  for (const [cx, cz] of st.ent || []) {   // positions chosen in the build: on open ground beside the road
    T.box(cx, cz, ux, uz, 5.2, 3.2, 0, 3.6, glass, [1, 0, 0, 0], 1 | 2 | 4 | 8);
    T.box(cx, cz, ux, uz, 5.9, 3.8, 3.6, 4.1, roof);
    T.box(cx, cz, ux, uz, 5.95, 3.85, 3.2, 3.6, lcol, [0, 0, 0, 0], 1 | 2 | 4 | 8);   // line-colour band
    T.box(cx + ux * 4.6, cz + uz * 4.6, ux, uz, 0.8, 3.4, 0, 3.6, panel, [0, 0, 0, 0], 1 | 2 | 4 | 8);
  }
}
function portal(T, x, z, ux, uz) {
  // headwall facing back along the ramp (−u), dark opening, wing walls along the approach
  const vx = -uz, vz = ux, P = (a, c, y) => [x + ux * a + vx * c, y, z + uz * a + vz * c];
  const con = lin('#c8c2b6');
  T.box(x + ux * 1.0, z + uz * 1.0, ux, uz, 1.0, 7.2, 0, 7.0, con);
  T.quad(P(-0.02, -4.9, 0), P(-0.02, 4.9, 0), P(-0.02, 4.9, 5.6), P(-0.02, -4.9, 5.6), [-ux, 0, -uz], con, [5, 0, 0, 0]);
  for (const sg of [-1, 1]) {
    for (let a = 0; a > -60; a -= 6) {
      const h0 = 7.0 * (1 + a / 70), h1 = 7.0 * (1 + (a - 6) / 70);
      T.quad(P(a, sg * 6.0, 0), P(a - 6, sg * 6.0, 0), P(a - 6, sg * 6.0, h1), P(a, sg * 6.0, h0), [vx * sg, 0, vz * sg], con);
      T.quad(P(a, sg * 5.4, 0), P(a - 6, sg * 5.4, 0), P(a - 6, sg * 5.4, h1), P(a, sg * 5.4, h0), [-vx * sg, 0, -vz * sg], con);
      T.quad(P(a, sg * 5.4, h0), P(a - 6, sg * 5.4, h1), P(a - 6, sg * 6.0, h1), P(a, sg * 6.0, h0), [0, 1, 0], con);
    }
  }
}

// ---------------------------------------------------------------- trains on the GTFS timetable
// Times run from the clock the time-of-day button stands for (morning 08:30, noon 12:30, golden hour 18:15,
// night 21:00, India Standard Time) at real speed; the service pattern (weekday / Saturday / Sunday) follows today's date.
const TOD_CLOCK = { morning: 8.5 * 3600, noon: 12.5 * 3600, golden: 18.25 * 3600, night: 21 * 3600 };
let TRAINS = null;
// ---- metro service: a train every few stations, each terminal turned back over a scissors crossover on the tail
// tracks beyond the platforms (arrive, run on to the siding while crossing to the other track, change ends, come
// back into the other platform, board, depart). Times are built so trains never meet: every service's round trip is
// a whole number of headways and the two N-S services share the trunk half a headway apart.
const MET_SYN = { 'GMRCL_LINE-1': { h: 2 }, 'GMRCL_LINE-3': { h: 4, ph: 0, ns: true }, 'GMRCL_LINE-4': { h: 4, ph: 0.5, ns: true } };
const TV = 22, TA = 1.0, TVY = 8, TAY = 0.6, TDW = 25, TLAY = 40, TREV = 15, TTAIL = 230, XO0 = 80, XO1 = 125, CAR = 22.6;
function runTime(D, V, a) { const da = V * V / (2 * a); return D >= 2 * da ? D / V + V / a : 2 * Math.sqrt(D / a); }
function runPos(t, D, V, a) {   // distance covered t seconds into an accelerate / cruise / brake run of length D
  const ta = V / a, da = V * V / (2 * a);
  if (D >= 2 * da) {
    const tc = (D - 2 * da) / V, T = 2 * ta + tc; t = clamp(t, 0, T);
    if (t <= ta) return 0.5 * a * t * t; if (t <= ta + tc) return da + V * (t - ta); const r = T - t; return D - 0.5 * a * r * r;
  }
  const tp = Math.sqrt(D / a); t = clamp(t, 0, 2 * tp);
  if (t <= tp) return 0.5 * a * t * t; const r = 2 * tp - t; return D - 0.5 * a * r * r;
}
function metroService(routes) {
  const R3 = routes.find((r) => r.id === 'GMRCL_LINE-3'), R4 = routes.find((r) => r.id === 'GMRCL_LINE-4');
  let div = 0;   // last station the two N-S services share (from APMC)
  if (R3 && R4) while (div + 1 < R3.st.length && div + 1 < R4.st.length && R3.st[div + 1][1] === R4.st[div + 1][1]) div++;
  const secT = (S, k) => runTime(Math.abs(S[k + 1] - S[k]), TV, TA) + TDW;
  let Hns = 0;
  if (R4 && div > 0) { const S = R4.st.map((q) => q[0]); let t = 0; for (let k = 0; k < div; k++) t += secT(S, k); Hns = MET_SYN['GMRCL_LINE-4'].h * t / div; }
  const svc = [];
  for (const r of routes) {
    const cfg = MET_SYN[r.id]; if (!cfg || !r.st || r.st.length < 2) continue;
    const S = r.st.map((q) => q[0]), n = S.length, Lr = r.s[r.n - 1], dv = cfg.ns ? div : 0, T = TRACK;
    const tA = Math.max(40, S[0] - TTAIL), tB = Math.min(Lr - 40, S[n - 1] + TTAIL);
    const xA = [S[0] - Math.min(XO0, (S[0] - tA) * 0.35), S[0] - Math.min(XO1, (S[0] - tA) * 0.55)];
    const xB = [S[n - 1] + Math.min(XO0, (tB - S[n - 1]) * 0.35), S[n - 1] + Math.min(XO1, (tB - S[n - 1]) * 0.55)];
    const segs = [], pad = []; let t = 0;
    const dwell = (s, d, v, p) => { if (p) pad.push(segs.length); segs.push({ t0: t, d, s0: s, v, run: false }); t += d; };
    const run = (s0, s1, V, a, v, x) => { const D = Math.abs(s1 - s0), d = runTime(D, V, a); segs.push({ t0: t, d, s0, sg: Math.sign(s1 - s0), D, V, a, v, x, run: true }); t += d; };
    dwell(S[0], TLAY, T, false);
    for (let k = 0; k < n - 1; k++) { run(S[k], S[k + 1], TV, TA, T); if (k + 1 < n - 1) dwell(S[k + 1], TDW, T, k + 1 > dv); }
    dwell(S[n - 1], TDW, T, false);
    run(S[n - 1], tB, TVY, TAY, T, [xB[0], xB[1], T, -T]);
    dwell(tB, TREV, -T, false);
    run(tB, S[n - 1], TVY, TAY, -T);
    dwell(S[n - 1], TLAY, -T, true);
    for (let k = n - 1; k > 0; k--) { run(S[k], S[k - 1], TV, TA, -T); if (k - 1 > 0) dwell(S[k - 1], TDW, -T, k - 1 > dv); }
    dwell(S[0], TDW, -T, false);
    run(S[0], tA, TVY, TAY, -T, [xA[0], xA[1], -T, T]);
    dwell(tA, TREV, T, false);
    run(tA, S[0], TVY, TAY, T);
    let H = Hns && cfg.ns ? Hns : 0;
    if (!H) { let q = 0; for (let k = 0; k < n - 1; k++) q += secT(S, k); H = cfg.h * q / (n - 1); }
    const N = Math.max(1, Math.ceil(t / H)), slack = N * H - t;
    if (slack > 0) { for (const q of pad) segs[q].d += slack / pad.length; let tt = 0; for (const sg of segs) { sg.t0 = tt; tt += sg.d; } t = tt; }
    svc.push({ r, segs, Tc: t, H, N, ph: (cfg.ph || 0) * H, ends: [[S[0], xA, tA], [S[n - 1], xB, tB]] });
  }
  return svc;
}
function prepTrains(M) {
  const routes = M.routes.map((r) => {
    const P = r.pts, n = P.length / 2, s = new Float32Array(n);
    for (let j = 1; j < n; j++) s[j] = s[j - 1] + Math.hypot(P[j * 2] - P[j * 2 - 2], P[j * 2 + 1] - P[j * 2 - 1]);
    const [N, ML] = lnormals(P);
    return { ...r, s, N, ML, n, col: new THREE.Color(COLS[r.line]) };
  });
  return { routes, svc: metroService(routes) };
}
const _ta = { x: 0, y: 0, z: 0, nx: 0, nz: 0, ug: 0, inb: 0 }, _tb = { x: 0, y: 0, z: 0, nx: 0, nz: 0, ug: 0, inb: 0 };
function routeAt(r, sv, o) {   // centreline point, rail level and (miter-scaled, interpolated) normal on a route
  const s = r.s; let lo = 0, hi = r.n - 1;
  sv = clamp(sv, 0, s[hi]);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= sv) lo = m; else hi = m; }
  const f = (sv - s[lo]) / Math.max(1e-6, s[hi] - s[lo]), g = 1 - f, P = r.pts;
  o.x = P[lo * 2] * g + P[hi * 2] * f; o.z = P[lo * 2 + 1] * g + P[hi * 2 + 1] * f; o.y = r.rl[lo] * g + r.rl[hi] * f;
  o.nx = r.N[lo * 2] * r.ML[lo] * g + r.N[hi * 2] * r.ML[hi] * f; o.nz = r.N[lo * 2 + 1] * r.ML[lo] * g + r.N[hi * 2 + 1] * r.ML[hi] * f;
  o.ug = (r.ug[lo] || r.ug[hi]) ? 1 : 0; o.inb = (r.inb[lo] && r.inb[hi]) ? 1 : 0;
  return o;
}
function trackOff(sg, s) {   // lateral track position at route distance s during a schedule segment (crossover moves change it)
  if (!sg.x) return sg.v;
  const [x0, x1, vA, vB] = sg.x, u = clamp((s - x0) / (x1 - x0), 0, 1);
  return vA + (vB - vA) * u * u * (3 - 2 * u);
}
function initTrains(M, pre) {
  const { routes, svc } = pre;
  const geo = carGeo(), MAXC = 300;
  const im = new THREE.InstancedMesh(geo, TRAINMAT, MAXC);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let k = 0; k < MAXC; k++) im.setColorAt(k, _vc.set(1, 1, 1));
  im.frustumCulled = false; im.castShadow = false; im.receiveShadow = true; im.renderOrder = 10; im.count = 0;
  group.ground.add(im);
  const bg = new THREE.BoxGeometry(1, 1, 1), mkm = (col, ro) => {
    const q = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ color: col, depthTest: false, depthWrite: false }), 120);
    q.instanceMatrix.setUsage(THREE.DynamicDrawUsage); q.frustumCulled = false; q.renderOrder = ro; q.count = 0; q.visible = false; group.ground.add(q); return q;
  };
  TRAINS = { routes, svc, im, mk: mkm(0xffffff, 22), mko: mkm(0x15181d, 21), colOf: new Array(MAXC).fill(null), clock: TOD_CLOCK[todName] || TOD_CLOCK.noon, last: todName };
}
function carGeo() {
  const T = new TGeo(), c = [1, 1, 1], k = [0, 0, 0, 0];
  T.box(0, 0, 1, 0, 10.9, 1.44, 0.35, 3.55, c, k, 63);
  // chamfered roof
  const P = (a, cc, y) => [a, y, cc];
  T.quad(P(-10.9, -1.44, 3.55), P(10.9, -1.44, 3.55), P(10.9, -1.05, 3.85), P(-10.9, -1.05, 3.85), [0, 0.7, -0.7], c);
  T.quad(P(-10.9, 1.44, 3.55), P(10.9, 1.44, 3.55), P(10.9, 1.05, 3.85), P(-10.9, 1.05, 3.85), [0, 0.7, 0.7], c);
  T.quad(P(-10.9, -1.05, 3.85), P(10.9, -1.05, 3.85), P(10.9, 1.05, 3.85), P(-10.9, 1.05, 3.85), [0, 1, 0], c);
  T.box(-6.6, 0, 1, 0, 1.3, 1.1, 0.0, 0.5, c, k, 63); T.box(6.6, 0, 1, 0, 1.3, 1.1, 0.0, 0.5, c, k, 63); // bogies
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(T.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(T.n, 3));
  g.setIndex(T.i); return g;
}
function putYawS(arr, k, x, y, z, hx, hz, sx, sy, sz) {
  const o = k * 16;
  arr[o] = hx * sx; arr[o + 1] = 0; arr[o + 2] = hz * sx; arr[o + 3] = 0; arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = -hz * sz; arr[o + 9] = 0; arr[o + 10] = hx * sz; arr[o + 11] = 0; arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}
function stepTrains(dt) {
  if (!TRAINS) return false;
  const TT = TRAINS;
  if (TT.last !== todName) { TT.clock = TOD_CLOCK[todName] || TT.clock; TT.last = todName; }
  TT.clock += dt;
  const show = view.mpp < 9, mk = view.mpp > 2.2 && settings.labels;   // zoomed out: train "pills" on the route ribbons
  TT.im.visible = show; TT.mk.visible = mk; TT.mko.visible = mk;
  if (!show && !mk) return false;
  const arr = TT.im.instanceMatrix.array, cap = TT.im.instanceMatrix.count, ma = TT.mk.instanceMatrix.array, mo = TT.mko.instanceMatrix.array;
  const uW = ROUTE_U.uW.value, Lm = Math.max(68, view.mpp * 18);
  let c = 0, m = 0, cd = false;
  for (const sv of TT.svc) {
    const r = sv.r, G = sv.segs;
    for (let k = 0; k < sv.N; k++) {
      let tau = (TT.clock + sv.ph + k * sv.H) % sv.Tc; if (tau < 0) tau += sv.Tc;
      let lo = 0, hi = G.length - 1; while (lo < hi) { const q = (lo + hi + 1) >> 1; if (G[q].t0 <= tau) lo = q; else hi = q - 1; }
      const sg = G[lo], sc = sg.run ? sg.s0 + sg.sg * runPos(tau - sg.t0, sg.D, sg.V, sg.a) : sg.s0;
      if (mk && m < 120) {
        const a = routeAt(r, sc + 10, _ta), b = routeAt(r, sc - 10, _tb);
        if (a.inb && b.inb) {
          let hx = a.x - b.x, hz = a.z - b.z; const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
          const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, y = Math.max(1, (a.y + b.y) / 2 + 2);
          putYawS(mo, m, x, y, z, hx, hz, Lm + uW * 1.4, 1, uW * 3.4); putYawS(ma, m, x, y + 0.1, z, hx, hz, Lm, 1, uW * 2.2); m++;
        }
      }
      if (!show) continue;
      for (let q = -1; q <= 1 && c < cap; q++) {
        const s = sc + q * CAR, sa = s + 6.6, sb = s - 6.6;   // the two bogies of this car
        const a = routeAt(r, sa, _ta), b = routeAt(r, sb, _tb);
        if (a.ug || b.ug || !a.inb || !b.inb) continue;
        const va = trackOff(sg, sa), vb = trackOff(sg, sb);
        const ax = a.x + a.nx * va, az = a.z + a.nz * va, bx = b.x + b.nx * vb, bz = b.z + b.nz * vb;
        let hx = ax - bx, hz = az - bz; const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        putYaw(arr, c, (ax + bx) / 2, (a.y + b.y) / 2, (az + bz) / 2, hx, hz, 1);
        if (TT.colOf[c] !== r.line) { TT.im.setColorAt(c, r.col); TT.colOf[c] = r.line; cd = true; }
        c++;
      }
    }
  }
  TT.im.count = c; flushInst(TT.im.instanceMatrix, c);
  if (cd) TT.im.instanceColor.needsUpdate = true;
  TT.mk.count = m; TT.mko.count = m; flushInst(TT.mk.instanceMatrix, m); flushInst(TT.mko.instanceMatrix, m);
  return c > 0 || m > 0;
}
// scissors crossovers on the tail tracks: [route, s0, s1] per terminal that is drawn (elevated, inside the map)
function metroCrossovers(pre) {
  const out = [], seen = [];
  for (const sv of pre.svc) for (const [st, x] of sv.ends) {
    const r = sv.r, a = routeAt(r, x[0], { ..._ta }), b = routeAt(r, x[1], { ..._tb }), m = routeAt(r, st, { ..._ta });
    if (a.ug || b.ug || m.ug || !a.inb || !b.inb) continue;
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    if (seen.some(([x2, z2]) => Math.hypot(x2 - cx, z2 - cz) < 30)) continue;
    seen.push([cx, cz]); out.push([r, Math.min(x[0], x[1]), Math.max(x[0], x[1])]);
  }
  return out;
}
function buildCrossovers(XO) {
  if (!XO.length) return;
  const G = new Geo(false), steel = C255(84, 80, 76);
  for (const [r, s0, s1] of XO) {
    const steps = Math.ceil((s1 - s0) / 2.5), P = { ..._ta };
    // the two diagonals, each a pair of rails at standard gauge, laid on the trough floor
    for (const [vA, vB] of [[TRACK, -TRACK], [-TRACK, TRACK]]) {
      const sgm = { x: [s0, s1, vA, vB] };
      for (const g of [-0.7175, 0.7175]) {
        let px = null, pz = null, py = 0;
        for (let k = 0; k <= steps; k++) {
          const s = s0 + (s1 - s0) * k / steps; routeAt(r, s, P);
          const v = trackOff(sgm, s) + g, x = P.x + P.nx * v, z = P.z + P.nz * v, y = P.y - 0.55;
          if (px !== null) {
            const dx = x - px, dz = z - pz, L = Math.hypot(dx, dz) || 1;
            cbox(G, (x + px) / 2, (z + pz) / 2, dx / L, dz / L, L / 2 + 0.03, 0.035, py + 0.03, py + 0.16, steel, true);
          }
          px = x; pz = z; py = y;
        }
      }
    }
  }
  const m = G.mesh(POLX); m.castShadow = false; group.ground.add(m);
}

// ---------------------------------------------------------------- Janmarg BRTS
// Median bus lanes with kerbs and railings on both sides (open at crossing streets), island stations in the middle
// with glass walls, an arched roof and a ramp down to a zebra crossing, and buses running to the GTFS timetable.
const BRTS_FINE = [];
const BRTS_ST_LEN = 44, BRTS_ST_W = 4.6, BRTS_HW = 4.1, BRTS_BAY = 8, BRTS_DOORS = [-10.3, -5.7, 5.7, 10.3];   // bays at +-8 m; bus doors at +-2.3 m
const BRTSMAT = groundMat(`
  float a = vR.x, s = vR.y, hw = vR.z, k = vR.w;
  float pa = fwidth(a), ps = fwidth(s), det = 1.0 - smoothstep(0.15, 0.6, pa);
  vec3 c;
  if (k < 0.5) {
    c = vec3(0.47, 0.37, 0.34) * (0.92 + 0.12 * vnoise(mod(vWPos.xz * 0.5, 1024.0)));      // bus-lane surfacing
    float edge = 1.0 - smoothstep(0.0, 0.12 + pa, abs(abs(a) - (hw - 0.55)));
    float cen = (1.0 - smoothstep(0.0, 0.08 + pa, abs(a))) * step(fract(s / 9.0), 0.45) * step(vR.z, ${(BRTS_HW + 0.05).toFixed(2)});
    c = mix(c, vec3(0.93, 0.92, 0.86), max(edge, cen) * det);
  } else {
    c = vec3(0.33, 0.33, 0.34);
    float st = step(0.5, fract(a / 1.1));
    c = mix(c, vec3(0.93, 0.93, 0.9), st * det);
  }
  diffuseColor.rgb = pow(c, vec3(2.2));`, '', {
  vHead: 'attribute vec4 aR; varying vec4 vR;', vBody: 'vR = aR;', fHead: 'varying vec4 vR;',
});
let BUSES = null, BRTS_DOOR = null;
function stepDoors(dt) {   // leaves slide apart (1.05 m each) in ~1.2 s while a bus is docked at that bay
  const D = BRTS_DOOR; if (!D) return;
  let moved = !D.init;
  for (let k = 0; k < D.open.length; k++) { const v = D.open[k], t = D.tgt[k]; if (v !== t) { D.open[k] = t ? Math.min(1, v + dt / 1.2) : Math.max(0, v - dt / 1.2); moved = true; } }
  if (!moved) return;
  D.init = true;
  const arr = D.im.instanceMatrix.array, W2 = BRTS_ST_W / 2;
  for (let q = 0; q < D.base.length / 4; q++) {
    const si = D.base[q * 4], sb = D.base[q * 4 + 1], ad = D.base[q * 4 + 2], lr = D.base[q * 4 + 3], st = D.st[si];
    const o = D.open[si * 4 + (sb > 0 ? 0 : 2) + (ad > 0 ? 0 : 1)], e = o * o * (3 - 2 * o);
    const a = ad + lr * (0.55 + 1.05 * e), b = sb * (W2 - 0.16), vx = st.uz, vz = -st.ux;
    putYawS(arr, q, st.x + st.ux * a + vx * b, 1.92, st.z + st.uz * a + vz * b, st.ux, st.uz, 1.1, 2.0, 0.05);
  }
  flushInst(D.im.instanceMatrix, D.base.length / 4);
}
function buildBRTS() {
  const B = TR && TR.brts; if (!B) return;
  const PG = [], RG = [], IG = [];
  const kerbG = new TGeo(), RL = new TGeo();
  const kerbC = lin('#c9c4ba'), kerbY = lin('#d8b23a');
  const stOn = B.lines.map(() => []);
  B.stations.forEach((st) => stOn[st.li].push(st.s));
  B.lines.forEach((ln, li) => {
    if (ln.paint === 0) return;   // bus-only connector through a junction
    const P = densify(ln.pts, 2), n = P.length / 2;
    const [N] = lnormals(P);
    const S = new Float32Array(n); for (let j = 1; j < n; j++) S[j] = S[j - 1] + Math.hypot(P[j * 2] - P[j * 2 - 2], P[j * 2 + 1] - P[j * 2 - 1]);
    const HW = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let f = 0;
      for (const ss of stOn[li]) { const d = Math.abs(S[j] - ss) - (BRTS_ST_LEN / 2 + 3); f = Math.max(f, clamp(1 - d / 20, 0, 1)); }
      HW[j] = BRTS_HW + (BRTS_ST_W / 2 + 0.2) * f * f * (3 - 2 * f);
    }
    const atStation = (sv) => stOn[li].some((ss) => Math.abs(sv - ss) < BRTS_ST_LEN / 2 + 9.5);
    const inGap = (sv) => !atStation(sv) && ln.gaps.some(([g0, g1]) => sv > g0 && sv < g1);
    const zeb = stOn[li].flatMap((ss) => [ss - (BRTS_ST_LEN / 2 + 11), ss + (BRTS_ST_LEN / 2 + 11)]);
    const atZebra = (sv) => zeb.some((zs) => Math.abs(sv - zs) < 2.6);   // kerb and railing open where a station's zebra crosses
    const b0 = PG.length / 2;
    for (let j = 0; j < n; j++) {            // lane surfacing stops at junctions (no paint through the crossing)
      const x = P[j * 2], z = P[j * 2 + 1], nx = N[j * 2], nz = N[j * 2 + 1], h = HW[j];
      PG.push(x + nx * h, z + nz * h, x - nx * h, z - nz * h);
      RG.push(h, S[j], h, 0, -h, S[j], h, 0);
      if (j && !inGap(S[j]) && !inGap(S[j - 1])) { const q = b0 + (j - 1) * 2; IG.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
    }
    for (const sg of [1, -1]) {     // kerb + railing on each side, broken at crossing streets
      let run = [];
      const flush = () => {
        if (run.length >= 4) {
          railStrip(RL, run, 0.24, 1.0, 0);
          for (let k = 0; k + 3 < run.length; k += 2) {
            const ax = run[k], az = run[k + 1], bx = run[k + 2], bz = run[k + 3], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
            kerbG.box((ax + bx) / 2, (az + bz) / 2, (bx - ax) / L, (bz - az) / L, L / 2 + 0.05, 0.18, 0, 0.24, k % 8 < 4 ? kerbC : kerbY, [0, 0, 0, 0], 1 | 2 | 16);
          }
        }
        run = [];
      };
      for (let j = 0; j < n; j++) {
        if (inGap(S[j]) || atZebra(S[j])) { flush(); continue; }
        const h = HW[j] - 0.2;
        run.push(P[j * 2] + N[j * 2] * h * sg, P[j * 2 + 1] + N[j * 2 + 1] * h * sg);
      }
      flush();
    }
  });
  // zebra crossings at both ramp ends of every station
  for (const st of B.stations) for (const se of [1, -1]) {
    const vx = st.uz, vz = -st.ux, cx = st.x + st.ux * se * (BRTS_ST_LEN / 2 + 11), cz = st.z + st.uz * se * (BRTS_ST_LEN / 2 + 11), W = 15, D = 2.2;
    const b = PG.length / 2;
    for (const [aa, dd] of [[-W, -D], [W, -D], [W, D], [-W, D]]) { PG.push(cx + vx * aa + st.ux * dd, cz + vz * aa + st.uz * dd); RG.push(aa, dd, W, 1); }
    IG.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const out = flatTiles(new Float32Array(PG), { aR: new THREE.Float32BufferAttribute(RG, 4) }, new Uint32Array(IG), [[BRTSMAT, 5.3]]);
  for (const m of out) group.ground.add(m);
  const kerbs = kerbG.tiles(POLX, [0, 0.3], { shadow: false });
  const rails = RL.tiles(RAILING, [0, 1.3], { shadow: false });
  for (const m of [...kerbs, ...rails]) { group.ground.add(m); BRTS_FINE.push(m); }
  // stations
  const G = new Geo(true);
  const conc = C255(190, 188, 182), white = C255(236, 236, 232), steel = C255(150, 156, 162), fascia = C255(38, 104, 168), dark = C255(70, 74, 78);
  for (const st of B.stations) {
    const F = lmFrame({ x: st.x, z: st.z, ux: st.ux, uz: st.uz }), L2 = BRTS_ST_LEN / 2, W2 = BRTS_ST_W / 2;
    fbox(G, F, -L2, L2, -W2, W2, 0, 0.9, conc, 0);
    for (const sb of [-1, 1]) {   // glass walls, open at the sliding doors of two bus bays (each bus has two doors)
      let a0 = -L2 + 1;
      for (const ad of BRTS_DOORS) {
        fbox(G, F, a0, ad - 1.15, sb * W2 - 0.06, sb * W2 + 0.06, 0.9, 3.0, white, 2, 0.9);
        fbox(G, F, ad - 1.25, ad - 1.13, sb * W2 - 0.1, sb * W2 + 0.1, 0.9, 3.0, steel, 0); fbox(G, F, ad + 1.13, ad + 1.25, sb * W2 - 0.1, sb * W2 + 0.1, 0.9, 3.0, steel, 0);
        fbox(G, F, ad - 1.15, ad + 1.15, sb * W2 - 0.08, sb * W2 + 0.08, 2.95, 3.0, steel, 0);                                  // header
        fbox(G, F, ad - 1.1, ad + 1.1, sb * W2 + 0.02, sb * W2 + 0.2, 0.9, 0.93, C255(230, 196, 40), 0);                       // yellow edge strip at the door
        a0 = ad + 1.15;
      }
      fbox(G, F, a0, L2 - 1, sb * W2 - 0.06, sb * W2 + 0.06, 0.9, 3.0, white, 2, 0.9);
      for (let a = -L2 + 1; a <= L2 - 1 + 0.01; a += 6) if (!BRTS_DOORS.some((ad) => Math.abs(a - ad) < 1.5)) fbox(G, F, a - 0.12, a + 0.12, sb * W2 - 0.12, sb * W2 + 0.12, 0.9, 4.0, steel, 0);
    }
    const arch = [[-W2 - 0.7, 3.95], [-W2 * 0.55, 4.4], [0, 4.6], [W2 * 0.55, 4.4], [W2 + 0.7, 3.95]];
    for (let k = 0; k < arch.length - 1; k++) {
      const [b0, y0] = arch[k], [b1, y1] = arch[k + 1];
      const nb = -(y1 - y0), ny = b1 - b0, nl = Math.hypot(nb, ny), n = [(F.vx * nb) / nl, ny / nl, (F.vz * nb) / nl];
      lq(G, F(-L2 - 1, b0, y0), F(L2 + 1, b0, y0), F(L2 + 1, b1, y1), F(-L2 - 1, b1, y1), n, [0, 0, 0, 0], white);
      lq(G, F(-L2 - 1, b0, y0 - 0.12), F(L2 + 1, b0, y0 - 0.12), F(L2 + 1, b1, y1 - 0.12), F(-L2 - 1, b1, y1 - 0.12), n.map((q) => -q), [0, 0, 0, 0], white);
    }
    for (const sb of [-1, 1]) fbox(G, F, -L2 - 1, L2 + 1, sb * (W2 + 0.7) - 0.08, sb * (W2 + 0.7) + 0.08, 3.6, 3.98, fascia, 0);   // fascia band
    // a ramp down to a zebra crossing at each end, with handrails
    for (const se of [1, -1]) {
      const r0 = se * L2, r1 = se * (L2 + 9.5);
      lq(G, F(r0, -1.2, 0.9), F(r1, -1.2, 0.02), F(r1, 1.2, 0.02), F(r0, 1.2, 0.9), [0, 1, 0], [0, 0, 0, 0], conc);
      for (const sb of [-1, 1]) {
        lq(G, F(r0, sb * 1.2, 0.0), F(r1, sb * 1.2, 0.0), F(r1, sb * 1.2, 0.02), F(r0, sb * 1.2, 0.9), [F.vx * sb, 0, F.vz * sb], [0, 0, 0, 0], conc);
        beam(G, F(r0, sb * 1.15, 1.9), F(r1, sb * 1.15, 1.0), 0.06, 0.06, steel, 0);
      }
      fbox(G, F, Math.min(r1, r1 - se * 0.3), Math.max(r1, r1 - se * 0.3), -1.25, 1.25, 0, 0.03, conc, 0);   // landing pad at the foot
    }
    fbox(G, F, -L2 + 1.5, -L2 + 4.5, -W2 + 0.25, -1.0, 0.9, 3.0, dark, 0);                            // ticket / control booth, clear of the ramp door
  }
  const sm = G.mesh(LMK); group.ground.add(sm);
  {
    const nL = B.stations.length * 16, base = new Float32Array(nL * 4);
    let q = 0;
    B.stations.forEach((st, si) => { for (const sb of [1, -1]) for (const ad of BRTS_DOORS) for (const lr of [-1, 1]) { base.set([si, sb, ad, lr], q * 4); q++; } });
    const dm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x9fbcc6 }), nL);
    dm.instanceMatrix.setUsage(THREE.DynamicDrawUsage); dm.frustumCulled = false; dm.castShadow = false;
    group.ground.add(dm); BRTS_FINE.push(dm);
    BRTS_DOOR = { im: dm, base, open: new Float32Array(B.stations.length * 4), tgt: new Uint8Array(B.stations.length * 4), st: B.stations, init: false };
    stepDoors(0);
  }
  // buses: 12 m AC Janmarg bus, 2.2 m doors on the right (station) side, LED destination board, roof units
  const BG = new Geo(true), C = VCOL;
  const body = C255(242, 242, 238), skirt = C255(28, 92, 160), roofu = C255(200, 204, 206);
  vbox(BG, -6.0, 6.0, 0.32, 1.0, -1.27, 1.27, skirt);
  vbox(BG, -6.0, 6.0, 1.0, 1.25, -1.27, 1.27, body);
  vbox(BG, -5.6, 5.5, 1.25, 2.45, -1.28, 1.28, C.glass, 4);
  vbox(BG, -6.0, 6.0, 2.45, 3.08, -1.27, 1.27, body);
  vbox(BG, -6.0, -5.6, 1.25, 2.45, -1.27, 1.27, body); vbox(BG, 5.5, 6.0, 1.25, 2.45, -1.27, 1.27, body);
  vbox(BG, 5.98, 6.03, 0.95, 2.5, -1.15, 1.15, C.glass); vbox(BG, 5.98, 6.04, 2.55, 2.9, -0.9, 0.9, C.dark, 3);
  vbox(BG, 6.0, 6.05, 0.55, 0.75, -1.15, -0.8, C.lamp, 1); vbox(BG, 6.0, 6.05, 0.55, 0.75, 0.8, 1.15, C.lamp, 1);
  vbox(BG, -6.05, -6.0, 0.6, 1.0, -1.2, -1.0, C.tail, 2); vbox(BG, -6.05, -6.0, 0.6, 1.0, 1.0, 1.2, C.tail, 2);
  for (const [x0, x1] of [[1.2, 3.4], [-3.4, -1.2]]) vbox(BG, x0, x1, 0.4, 2.6, 1.27, 1.31, C.glass);
  vbox(BG, -2.4, 2.4, 3.08, 3.45, -0.95, 0.95, roofu); vbox(BG, -5.6, -3.2, 3.08, 3.3, -0.9, 0.9, roofu);
  wheels(BG, [-3.6, 3.6], 1.12, 0.5, 0.32, C.tyre);
  const bg = BG.mesh(VEHMAT).geometry;
  const im = new THREE.InstancedMesh(bg, VEHMAT, 700); im.count = 0; im.castShadow = false; im.receiveShadow = true; im.renderOrder = 10; im.frustumCulled = false;
  group.ground.add(im);
  const legs = B.legs.map((lg) => {
    const p = lg.p, n = p.length / 3, s = new Float32Array(n);
    for (let j = 1; j < n; j++) s[j] = s[j - 1] + Math.hypot(p[j * 3] - p[j * 3 - 3], p[j * 3 + 1] - p[j * 3 - 2]);
    return { p, o: lg.o, s, L: s[n - 1] };
  });
  const seen = new Set(), trips = [];
  for (const row of B.trips) {   // the feed repeats trips for several service calendars: one bus per run
    const key = row.join(','); if (seen.has(key)) continue; seen.add(key);
    const t = [row[0]], lg = [];
    for (let k = 1; k + 1 < row.length; k += 2) { lg.push(row[k]); t.push(t[t.length - 1] + row[k + 1]); }
    trips.push({ t, lg });
  }
  BUSES = { im, legs, trips, clock: TOD_CLOCK[todName] || 12.5 * 3600, last: todName };
  busSchedule(B);
}
const _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3(1, 1, 1), _by = new THREE.Vector3(0, 1, 0), _bm = new THREE.Matrix4();
function legAt(L, rev, sv) {   // position on a bus path (rev = driven the other way), with left-lane offset
  const p = L.p, s = L.s, n = s.length, d = rev ? L.L - sv : sv;
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= d) lo = m; else hi = m; }
  const f = clamp((d - s[lo]) / Math.max(1e-3, s[hi] - s[lo]), 0, 1);
  const x = p[lo * 3] + (p[hi * 3] - p[lo * 3]) * f, z = p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * f, y = p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * f;
  let dx = p[hi * 3] - p[lo * 3], dz = p[hi * 3 + 1] - p[lo * 3 + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  if (rev) { dx = -dx; dz = -dz; }
  const off = L.o[lo] + (L.o[hi] - L.o[lo]) * f;
  return [x + dz * off, y, z - dx * off, dx, dz];   // map-left of travel is (dz, -dx)
}
// Which station (and which side / travel sense) every stop of every trip is at, then a schedule built in arrival order:
// a bus docks in the front bay if the stop is empty, in the rear bay if only the front is taken (and leaves after the
// bus ahead), otherwise it waits behind; runs average at most ~9 m/s (32 km/h) and never catch up the bus ahead on a leg.
function busSchedule(B) {
  const BS = BUSES, legs = BS.legs, sts = B.stations, cache = new Map();
  const at = (ref, end) => { const L = legs[ref < 0 ? -ref - 1 : ref]; return legAt(L, ref < 0, end ? L.L : 0); };
  const stopInfo = (ref, end) => {
    const key = ref * 2 + end; if (cache.has(key)) return cache.get(key);
    const [x, , z, dx, dz] = at(ref, end); let bi = -1, bd = 900;
    sts.forEach((st, i) => { const d = (st.x - x) ** 2 + (st.z - z) ** 2; if (d < bd) { bd = d; bi = i; } });
    let info = null;
    if (bi >= 0) { const st = sts[bi], ts = dx * st.ux + dz * st.uz >= 0 ? 1 : -1, b = (x - st.x) * st.uz + (z - st.z) * -st.ux; info = { si: bi, ts, side: b >= 0 ? 0 : 1 }; }
    cache.set(key, info); return info;
  };
  const DW = 20, VAVG = 9, heap = [];
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  BS.trips.forEach((tr, ti) => { const n = tr.t.length; tr.A = new Float64Array(n); tr.D = new Float64Array(n); tr.off = new Float32Array(n); tr.bay = new Int16Array(n).fill(-1); tr.A[0] = tr.t[0]; push([tr.t[0], ti, 0]); });
  const occ = new Map(), legLast = new Map();
  while (heap.length) {
    let [A0, ti, k] = pop(); const tr = BS.trips[ti], n = tr.t.length, last = k === n - 1;
    const info = last ? stopInfo(tr.lg[n - 2], 1) : stopInfo(tr.lg[k], 0);
    const dw = last ? DW : Math.min(DW, Math.max(8, (tr.t[k + 1] - tr.t[k]) * 0.3));
    let dep = A0 + dw, off = 0;
    if (info) {
      const key = info.si * 2 + (info.ts > 0 ? 0 : 1); let o = occ.get(key); if (!o) occ.set(key, (o = []));
      for (let q = o.length - 1; q >= 0; q--) if (o[q].dep < A0 - 14) o.splice(q, 1);   // a bus pulling out still blocks the stop for ~14 s
      if (k === 0 && o.length) { A0 = Math.max(...o.map((q) => q.dep + 3)); dep = A0 + dw; o.length = 0; }   // a trip starts once its stop is clear
      if (last) {   // the final stop has no leg beyond it: rear bay, or wait behind
        if (!o.length) off = -BRTS_BAY; else { off = -22 - 14 * o.filter((q) => q.off <= -22).length; dep = Math.max(dep, ...o.map((q) => q.dep + 3)); }
      } else if (!o.length) off = BRTS_BAY;
      else if (o.length === 1 && o[0].off === BRTS_BAY) { off = -BRTS_BAY; dep = Math.max(dep, o[0].dep + 6); }
      else { off = -22 - 14 * o.filter((q) => q.off <= -22).length; dep = Math.max(dep, ...o.map((q) => q.dep + 3)); }   // queue up behind the bays
      o.push({ dep, off });
      if (off > -20) tr.bay[k] = info.si * 4 + info.side * 2 + (info.ts * off > 0 ? 0 : 1);
    }
    tr.A[k] = A0; tr.D[k] = dep; tr.off[k] = off;
    if (!last) {
      const ref = tr.lg[k], L = legs[ref < 0 ? -ref - 1 : ref];
      let arr = Math.max(tr.t[k + 1], dep + Math.max(20, (L ? L.L : 0) / VAVG));
      const prev = legLast.get(ref);   // never faster than, nor arriving within 10 s of, the bus ahead on this leg
      if (prev && prev[0] > dep - 120) arr = Math.max(arr, prev[1] + 10, dep + (prev[1] - prev[0]));
      legLast.set(ref, [dep, arr]);
      push([arr, ti, k + 1]);
    }
  }
}
function busPos(tr, k, s, out) {   // distance s along leg k, spilling onto the neighbouring legs
  const BS = BUSES, n = tr.lg.length;
  let ref = tr.lg[k], L = BS.legs[ref < 0 ? -ref - 1 : ref];
  if (s < 0 && k > 0) { ref = tr.lg[k - 1]; L = BS.legs[ref < 0 ? -ref - 1 : ref]; s += L.L; }
  else if (s > L.L && k + 1 < n) { s -= L.L; ref = tr.lg[k + 1]; L = BS.legs[ref < 0 ? -ref - 1 : ref]; }
  return legAt(L, ref < 0, clamp(s, 0, L.L));
}
function stepBuses(dt) {
  if (!BUSES) return false;
  const BS = BUSES;
  if (BS.last !== todName) { BS.clock = TOD_CLOCK[todName] || BS.clock; BS.last = todName; for (const tr of BS.trips) tr.dl = 0; }
  BS.clock += dt;
  const show = view.mpp < 6;
  BS.im.visible = show; if (!show) return false;
  const T0 = BS.clock % 86400; let c = 0;
  const DR = BRTS_DOOR; if (DR) DR.tgt.fill(0);
  const act = BS.act || (BS.act = []); act.length = 0;
  for (const tr of BS.trips) {
    const A = tr.A, Dp = tr.D, n = A.length, T = T0 - (tr.dl || 0);   // a bus held up by the one ahead runs that much late
    if (T < A[0] || T > Dp[n - 1]) continue;
    let k = 0; while (k < n - 1 && T >= A[k + 1]) k++;
    let kl = Math.min(k, n - 2), sv;
    const Lk = BS.legs[tr.lg[kl] < 0 ? -tr.lg[kl] - 1 : tr.lg[kl]]; if (!Lk) continue;
    if (T <= Dp[k]) {   // docked (or waiting behind the bays)
      sv = k === n - 1 ? Lk.L + Math.min(0, tr.off[k]) : tr.off[k];
      if (DR && tr.bay[k] >= 0 && T - A[k] > 0.8 && Dp[k] - T > 2.2) DR.tgt[tr.bay[k]] = 1;
    } else {            // between stops: accelerate / cruise / brake (peak ~1.25x the average)
      const u = clamp((T - Dp[k]) / Math.max(1, A[k + 1] - Dp[k]), 0, 1), f = 0.2;
      const e = u < f ? u * u / (2 * f * (1 - f)) : u > 1 - f ? 1 - (1 - u) ** 2 / (2 * f * (1 - f)) : (u - f / 2) / (1 - f);
      const s0 = tr.off[k], s1 = Lk.L + (k + 1 === n - 1 ? Math.min(0, tr.off[k + 1]) : tr.off[k + 1]);
      sv = s0 + (s1 - s0) * e;
    }
    if (c >= BS.im.instanceMatrix.count) break;
    const [fx, fy, fz] = busPos(tr, kl, sv + 3.6), [bx, by, bz] = busPos(tr, kl, sv - 3.6), L = Lk, rev = tr.lg[kl] < 0;
    let hx = fx - bx, hz = fz - bz; const hl = Math.hypot(hx, hz);
    if (hl < 0.5) { const q = legAt(L, rev, clamp(sv, 0, L.L)); hx = q[3]; hz = q[4]; } else { hx /= hl; hz /= hl; }   // heading from the two axles: no snapping at vertices
    putYaw(BS.im.instanceMatrix.array, c++, (fx + bx) / 2, (fy + by) / 2, (fz + bz) / 2, hx, hz, 1);
    act.push(tr, (fx + bx) / 2, (fz + bz) / 2, hx, hz);
  }
  BS.im.count = c; flushInst(BS.im.instanceMatrix, c);
  // keep a gap: a bus closing on the one ahead in its lane eases off (its clock slows), stopping a couple of metres short
  const H = BS.hash || (BS.hash = new Map()); H.clear();
  for (let q = 0; q < act.length; q += 5) { const key = hk(Math.floor(act[q + 1] / 20), Math.floor(act[q + 2] / 20)); let l = H.get(key); if (!l) H.set(key, (l = [])); l.push(q); }
  for (let q = 0; q < act.length; q += 5) {
    const x = act[q + 1], z = act[q + 2], hx = act[q + 3], hz = act[q + 4]; let gap = 1e9;
    const gx = Math.floor(x / 20), gz = Math.floor(z / 20);
    for (let u = gx - 1; u <= gx + 1; u++) for (let w = gz - 1; w <= gz + 1; w++) for (const o of H.get(hk(u, w)) || []) {
      if (o === q) continue; const rx = act[o + 1] - x, rz = act[o + 2] - z, al = rx * hx + rz * hz;
      if (al <= 0 || al > 30 || Math.abs(rx * hz - rz * hx) > 2.4 || hx * act[o + 3] + hz * act[o + 4] < 0.6) continue;
      gap = Math.min(gap, al - 12);
    }
    if (gap < 6) { const tr = act[q]; tr.dl = (tr.dl || 0) + dt * clamp((6 - gap) / 4, 0, 1); }
  }
  if (DR && view.mpp < 2.6) stepDoors(dt);
  return c > 0;
}

// ---------------------------------------------------------------- street life: signals, traffic, pedestrians
// aR.x lamp kind (1 head, 2 tail, 3 indicator/LED, 4 cabin), aR.y = 1 where the instance colour paints the body
const VEHMAT = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'attribute vec4 aR; varying vec4 vK;',
  vBody: 'vK = aR;\n#ifdef USE_INSTANCING_COLOR\nvColor.xyz = aR.y > 0.5 ? color.xyz * instanceColor.xyz : color.xyz;\n#endif',
  fHead: 'varying vec4 vK;',
  fColor: `
  float lk = floor(vK.x + 0.5);
  if (lk == 1.0) xEm = vec3(1.0, 0.95, 0.82) * (0.12 + 6.0 * uNight);
  else if (lk == 2.0) xEm = vec3(1.0, 0.08, 0.04) * (0.1 + 4.0 * uNight);
  else if (lk == 3.0) xEm = vec3(1.0, 0.55, 0.12) * (0.6 + 1.3 * uNight);
  else if (lk == 4.0) xEm = vec3(1.0, 0.88, 0.62) * 0.7 * uNight;`,
});
function vbox(G, x0, x1, y0, y1, z0, z1, col, lamp = 0, paint = 0) {
  const e = [lamp, paint, 0, 0];
  lq(G, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], e, col);
  lq(G, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], e, col);
  lq(G, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], e, col);
  lq(G, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], e, col);
  lq(G, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], e, col);
}
// raked glasshouse: x0..x1 at the belt line (y0), xt0..xt1 at the roof (y1), half-width hz
function vcabin(G, x0, x1, xt0, xt1, y0, y1, hz, col, lamp = 0) {
  const e = [lamp, 0, 0, 0], dy = y1 - y0, ht = hz * 0.9;
  const nf = [dy, x1 - xt1, 0], nb = [-dy, xt0 - x0, 0];
  const nl = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
  lq(G, [x1, y0, -hz], [x1, y0, hz], [xt1, y1, ht], [xt1, y1, -ht], nl(nf), e, col);
  lq(G, [x0, y0, -hz], [x0, y0, hz], [xt0, y1, ht], [xt0, y1, -ht], nl(nb), e, col);
  lq(G, [x0, y0, hz], [x1, y0, hz], [xt1, y1, ht], [xt0, y1, ht], [0, 0.1, 1], e, col);
  lq(G, [x0, y0, -hz], [x1, y0, -hz], [xt1, y1, -ht], [xt0, y1, -ht], [0, 0.1, -1], e, col);
}
function wheels(G, xs, hz, r, w, col) { for (const x of xs) for (const z of [-hz, hz]) vbox(G, x - r, x + r, 0, 2 * r, z - w / 2, z + w / 2, col); }
const VCOL = { W: [1, 1, 1], glass: C255(28, 36, 44), tyre: C255(22, 22, 24), lamp: C255(250, 246, 225), tail: C255(190, 30, 24), dark: C255(50, 52, 56),
  green: C255(34, 118, 62), yellow: C255(242, 200, 46), skin: C255(150, 104, 76), pants: C255(40, 46, 70), shirt: C255(220, 218, 210), helmet: C255(30, 30, 34) };
function rider(G, x, seatY, shirt) {
  vbox(G, x - 0.12, x + 0.32, seatY, seatY + 0.2, -0.2, 0.2, VCOL.pants);
  vbox(G, x - 0.2, x + 0.08, seatY + 0.18, seatY + 0.78, -0.2, 0.2, shirt);
  vbox(G, x - 0.15, x + 0.08, seatY + 0.78, seatY + 1.04, -0.12, 0.12, VCOL.skin);
  vbox(G, x - 0.17, x + 0.1, seatY + 0.95, seatY + 1.1, -0.14, 0.14, VCOL.helmet);
}
const VTYPES = [
  { name: 'hatch', len: 3.8, w: 1.7, f: 1.0, build(G) { const C = VCOL;
    vbox(G, -1.9, 1.9, 0.3, 0.82, -0.84, 0.84, C.W, 0, 1); vcabin(G, -1.75, 0.8, -1.55, 0.12, 0.82, 1.38, 0.8, C.glass); vbox(G, -1.55, 0.14, 1.38, 1.46, -0.74, 0.74, C.W, 0, 1);
    vbox(G, 1.88, 1.93, 0.58, 0.72, -0.78, -0.5, C.lamp, 1); vbox(G, 1.88, 1.93, 0.58, 0.72, 0.5, 0.78, C.lamp, 1);
    vbox(G, -1.93, -1.88, 0.62, 0.76, -0.8, -0.56, C.tail, 2); vbox(G, -1.93, -1.88, 0.62, 0.76, 0.56, 0.8, C.tail, 2); wheels(G, [-1.25, 1.25], 0.8, 0.3, 0.22, C.tyre); } },
  { name: 'sedan', len: 4.5, w: 1.75, f: 1.05, build(G) { const C = VCOL;
    vbox(G, -2.25, 2.25, 0.3, 0.84, -0.87, 0.87, C.W, 0, 1); vcabin(G, -1.35, 0.9, -0.95, 0.15, 0.84, 1.42, 0.83, C.glass); vbox(G, -0.97, 0.17, 1.42, 1.48, -0.76, 0.76, C.W, 0, 1);
    vbox(G, 2.23, 2.28, 0.6, 0.74, -0.8, -0.52, C.lamp, 1); vbox(G, 2.23, 2.28, 0.6, 0.74, 0.52, 0.8, C.lamp, 1);
    vbox(G, -2.28, -2.23, 0.64, 0.78, -0.82, -0.55, C.tail, 2); vbox(G, -2.28, -2.23, 0.64, 0.78, 0.55, 0.82, C.tail, 2); wheels(G, [-1.45, 1.45], 0.83, 0.31, 0.22, C.tyre); } },
  { name: 'suv', len: 4.6, w: 1.85, f: 1.0, build(G) { const C = VCOL;
    vbox(G, -2.3, 2.3, 0.4, 1.05, -0.92, 0.92, C.W, 0, 1); vcabin(G, -2.22, 1.05, -2.12, 0.42, 1.05, 1.74, 0.88, C.glass); vbox(G, -2.14, 0.44, 1.74, 1.82, -0.82, 0.82, C.W, 0, 1);
    vbox(G, 2.28, 2.33, 0.78, 0.92, -0.85, -0.55, C.lamp, 1); vbox(G, 2.28, 2.33, 0.78, 0.92, 0.55, 0.85, C.lamp, 1);
    vbox(G, -2.33, -2.28, 0.85, 1.0, -0.88, -0.6, C.tail, 2); vbox(G, -2.33, -2.28, 0.85, 1.0, 0.6, 0.88, C.tail, 2); wheels(G, [-1.5, 1.5], 0.88, 0.36, 0.26, C.tyre); } },
  { name: 'auto', len: 2.7, w: 1.4, f: 0.72, build(G) { const C = VCOL;
    vbox(G, -1.3, 0.95, 0.22, 0.85, -0.68, 0.68, C.green); vbox(G, 0.95, 1.36, 0.22, 1.02, -0.34, 0.34, C.green);
    vbox(G, 0.82, 0.96, 0.85, 1.5, -0.55, 0.55, C.glass); vbox(G, -1.36, 1.0, 1.52, 1.7, -0.72, 0.72, C.yellow);
    for (const [x, z] of [[-1.3, -0.66], [-1.3, 0.66], [0.9, -0.6], [0.9, 0.6]]) vbox(G, x - 0.03, x + 0.03, 0.85, 1.52, z - 0.03, z + 0.03, C.dark);
    vbox(G, -1.2, -0.3, 0.85, 1.25, -0.6, 0.6, C.dark); vbox(G, 1.34, 1.38, 0.7, 0.85, -0.12, 0.12, C.lamp, 1); vbox(G, -1.33, -1.3, 0.5, 0.62, -0.6, -0.45, C.tail, 2);
    vbox(G, 1.0, 1.36, 0, 0.44, -0.07, 0.07, C.tyre); vbox(G, -1.07, -0.63, 0, 0.44, -0.72, -0.58, C.tyre); vbox(G, -1.07, -0.63, 0, 0.44, 0.58, 0.72, C.tyre); } },
  { name: 'scooter', len: 1.85, w: 0.7, f: 0.9, two: true, build(G) { const C = VCOL;
    vbox(G, -0.75, 0.45, 0.25, 0.72, -0.21, 0.21, C.W, 0, 1); vbox(G, 0.45, 0.63, 0.25, 1.0, -0.24, 0.24, C.W, 0, 1); vbox(G, 0.52, 0.62, 1.0, 1.07, -0.36, 0.36, C.dark);
    vbox(G, 0.6, 0.65, 0.82, 0.92, -0.1, 0.1, C.lamp, 1); vbox(G, -0.78, -0.74, 0.55, 0.65, -0.1, 0.1, C.tail, 2);
    vbox(G, 0.42, 0.88, 0, 0.46, -0.05, 0.05, C.tyre); vbox(G, -0.85, -0.39, 0, 0.46, -0.05, 0.05, C.tyre); rider(G, -0.25, 0.72, C.shirt); } },
  { name: 'bike', len: 2.0, w: 0.75, f: 1.05, two: true, build(G) { const C = VCOL;
    vbox(G, -0.7, 0.55, 0.35, 0.78, -0.13, 0.13, C.W, 0, 1); vbox(G, 0.0, 0.5, 0.78, 0.95, -0.17, 0.17, C.W, 0, 1); vbox(G, -0.6, 0.05, 0.8, 0.9, -0.15, 0.15, C.dark);
    vbox(G, 0.5, 0.58, 0.95, 1.02, -0.4, 0.4, C.dark); vbox(G, 0.62, 0.68, 0.8, 0.95, -0.1, 0.1, C.lamp, 1); vbox(G, -0.74, -0.7, 0.62, 0.72, -0.08, 0.08, C.tail, 2);
    vbox(G, 0.52, 1.02, 0, 0.5, -0.05, 0.05, C.tyre); vbox(G, -0.98, -0.48, 0, 0.5, -0.06, 0.06, C.tyre); rider(G, -0.3, 0.82, C.shirt); } },
  { name: 'tempo', len: 3.8, w: 1.55, f: 0.8, build(G) { const C = VCOL;
    vbox(G, 0.9, 1.86, 0.35, 1.85, -0.75, 0.75, C.W, 0, 1); vbox(G, 1.84, 1.88, 1.1, 1.7, -0.68, 0.68, C.glass); vbox(G, -1.86, 0.9, 0.35, 0.72, -0.78, 0.78, C.dark);
    vbox(G, -1.86, 0.9, 0.72, 1.12, -0.78, -0.72, C.W, 0, 1); vbox(G, -1.86, 0.9, 0.72, 1.12, 0.72, 0.78, C.W, 0, 1); vbox(G, -1.86, -1.8, 0.72, 1.12, -0.78, 0.78, C.W, 0, 1);
    vbox(G, 1.86, 1.9, 0.55, 0.68, -0.72, -0.48, C.lamp, 1); vbox(G, 1.86, 1.9, 0.55, 0.68, 0.48, 0.72, C.lamp, 1); vbox(G, -1.9, -1.86, 0.45, 0.58, -0.76, -0.56, C.tail, 2);
    wheels(G, [-1.2, 1.3], 0.72, 0.27, 0.2, C.tyre); } },
  { name: 'truck', len: 7.6, w: 2.4, f: 0.68, build(G) { const C = VCOL, cargo = C255(214, 120, 40), cab = C255(232, 190, 60);
    vbox(G, 2.2, 3.8, 0.55, 2.95, -1.2, 1.2, cab); vbox(G, 3.78, 3.82, 1.7, 2.6, -1.1, 1.1, C.glass); vbox(G, -3.8, 2.1, 0.7, 3.25, -1.25, 1.25, cargo, 0, 1);
    vbox(G, 3.8, 3.85, 0.75, 0.95, -1.1, -0.8, C.lamp, 1); vbox(G, 3.8, 3.85, 0.75, 0.95, 0.8, 1.1, C.lamp, 1); vbox(G, -3.85, -3.8, 0.75, 0.95, -1.2, -0.9, C.tail, 2);
    wheels(G, [-2.6, -1.6, 2.9], 1.15, 0.5, 0.35, C.tyre); } },
];
let SIGS = null, TRAF = null, PEDS = null;
const _vm = new THREE.Matrix4(), _vp = new THREE.Vector3(), _vq = new THREE.Quaternion(), _vs = new THREE.Vector3(1, 1, 1), _vy = new THREE.Vector3(0, 1, 0), _vc = new THREE.Color();
function sigState(si, ph) {   // 0 red, 1 amber, 2 green; 72 s cycle, two phases
  const t = ((performance.now() / 1000 + SIGS.off[si]) % 72 + 72) % 72;
  if (ph === 0) return t < 30 ? 2 : t < 34 ? 1 : 0;
  return t >= 36 && t < 66 ? 2 : t >= 66 && t < 70 ? 1 : 0;
}
function buildSignals() {
  const S = META.signals; if (!S || !S.length) return;
  const G = new Geo(false), pole = C255(70, 74, 78), housing = C255(26, 28, 30);
  const PG = [], RG = [], IG = [], heads = [], armKey = new Map(), mouth = new Map(), off = [];
  const strip = (x0, z0, ux, uz, a0, a1, s0, s1, kind, W) => {   // ground quad: along u from s0..s1, across a0..a1
    const vx = -uz, vz = ux, b = PG.length / 2;
    for (const [a, sv] of [[a0, s0], [a1, s0], [a1, s1], [a0, s1]]) { PG.push(x0 + ux * sv + vx * a, z0 + uz * sv + vz * a); RG.push(a, sv, W, kind); }
    IG.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  S.forEach(([cx, cz, of, arms], si) => {
    off.push(of);
    for (const [k, e, rz, ph, inb, ow, hw, sw, sx, sz, dx, dz] of arms) {
      strip(sx, sz, dx, dz, -hw, hw, 0, 3.6, 1, hw);                                        // zebra crossing
      mouth.set(k * 2 + e, rz + 4.7);                                                        // junction box edge on this arm
      if (!inb) continue;
      const Lx = -dz, Lz = dx;                                                               // left of incoming traffic
      if (ow) strip(sx, sz, dx, dz, -hw, hw, 4.2, 4.65, 2, hw); else strip(sx, sz, dx, dz, 0, hw, 4.2, 4.65, 2, hw);   // stop line
      armKey.set(k * 2 + e, { si, ph, stop: rz + 4.6 });
      const px = sx + dx * 4.9 + Lx * (hw + 0.9), pz = sz + dz * 4.9 + Lz * (hw + 0.9), tall = hw >= 5;
      cbox(G, px, pz, dx, dz, 0.09, 0.09, 0, tall ? 6.3 : 3.7, pole);
      heads.push([px + Lx * 0.0, 2.55, pz, dx, dz, si, ph]);
      if (tall) {
        const ax = px - Lx * hw * 0.42, az = pz - Lz * hw * 0.42;
        cbox(G, ax, az, -dz, dx, hw * 0.42, 0.07, 6.05, 6.2, pole);
        heads.push([px - Lx * hw * 0.8, 4.95, pz - Lz * hw * 0.8, dx, dz, si, ph]);
      }
    }
  });
  for (const [hx, hy, hz, dx, dz] of heads) {
    cbox(G, hx, hz, dx, dz, 0.15, 0.2, hy, hy + 1.0, housing);
    cbox(G, hx + dx * 0.18, hz + dz * 0.18, dx, dz, 0.04, 0.22, hy + 1.0, hy + 1.04, housing);
  }
  const m = G.mesh(POLX); m.castShadow = false; group.ground.add(m);
  const PAINT = groundMat(`
    float a = vR.x, s = vR.y, k = vR.w; float pa = fwidth(a);
    if (k < 1.5) { if (fract(a / 1.1) > 0.55) discard; }
    diffuseColor.rgb = pow(vec3(0.92, 0.92, 0.88), vec3(2.2));`, '', { vHead: 'attribute vec4 aR; varying vec4 vR;', vBody: 'vR = aR;', fHead: 'varying vec4 vR;' });
  const paint = flatTiles(new Float32Array(PG), { aR: new THREE.Float32BufferAttribute(RG, 4) }, new Uint32Array(IG), [[PAINT, 5.2]]);
  for (const t of paint) group.ground.add(t);
  // lamps: three per head, recoloured as the phases change
  const lg = new THREE.BoxGeometry(0.06, 0.29, 0.29);
  const lamps = new THREE.InstancedMesh(lg, new THREE.MeshBasicMaterial({ color: 0xffffff }), heads.length * 3);
  lamps.frustumCulled = false; lamps.renderOrder = 10;
  heads.forEach(([hx, hy, hz, dx, dz], h) => {
    for (let q = 0; q < 3; q++) {
      _vp.set(hx + dx * 0.17, hy + 0.82 - q * 0.31, hz + dz * 0.17); _vq.setFromAxisAngle(_vy, Math.atan2(-dz, dx)); _vm.compose(_vp, _vq, _vs);
      lamps.setMatrixAt(h * 3 + q, _vm);
    }
  });
  group.ground.add(lamps);
  SIGS = { off, heads, lamps, armKey, mouth, mesh: m, paint, last: -1 };
  updateSignalLamps(true);
}
const SIG_ON = [C255(255, 40, 30).map((v) => v * 4), C255(255, 170, 20).map((v) => v * 4), C255(40, 255, 110).map((v) => v * 4)], SIG_OFF = [C255(60, 18, 16), C255(62, 46, 14), C255(16, 52, 30)];
function updateSignalLamps(force) {
  if (!SIGS) return;
  const tick = Math.floor(performance.now() / 250); if (!force && tick === SIGS.last) return; SIGS.last = tick;
  SIGS.heads.forEach(([, , , , , si, ph], h) => {
    const st = sigState(si, ph);
    for (let q = 0; q < 3; q++) { const lit = (q === 0 && st === 0) || (q === 1 && st === 1) || (q === 2 && st === 2); SIGS.lamps.setColorAt(h * 3 + q, _vc.fromArray(lit ? SIG_ON[q] : SIG_OFF[q])); }
  });
  SIGS.lamps.instanceColor.needsUpdate = true;
}
// ---- road graph for traffic and people
// Per point: a smoothed tangent and a miter-scaled left normal (drawn direction), so lane offsets bend smoothly round
// vertices instead of jumping; per node: how many road ends meet there and the widest carriageway (junction box size).
function streetGraph() {
  const R = ROADS, n = R.n, np = R.xy.length / 2, S = new Float32Array(np), L = new Float32Array(n), ends = new Int32Array(n * 2), nodes = new Map(), list = [];
  const TX = new Float32Array(np), TZ = new Float32Array(np), MX = new Float32Array(np), MZ = new Float32Array(np);
  const key = (x, z) => (Math.round(x) + 60000) * 200000 + (Math.round(z) + 60000);
  for (let i = 0; i < n; i++) {
    const p = R.start[i], c = R.lens[i];
    S[p] = 0; for (let j = 1; j < c; j++) S[p + j] = S[p + j - 1] + Math.hypot(R.xy[(p + j) * 2] - R.xy[(p + j - 1) * 2], R.xy[(p + j) * 2 + 1] - R.xy[(p + j - 1) * 2 + 1]) * 0.5;
    L[i] = S[p + c - 1];
    for (let j = 0; j < c; j++) {
      const q = p + j; let ix = 0, iz = 0, ox = 0, oz = 0;
      if (j > 0) { ix = R.xy[q * 2] - R.xy[q * 2 - 2]; iz = R.xy[q * 2 + 1] - R.xy[q * 2 - 1]; const l = Math.hypot(ix, iz) || 1; ix /= l; iz /= l; }
      if (j < c - 1) { ox = R.xy[q * 2 + 2] - R.xy[q * 2]; oz = R.xy[q * 2 + 3] - R.xy[q * 2 + 1]; const l = Math.hypot(ox, oz) || 1; ox /= l; oz /= l; }
      if (j === 0) { ix = ox; iz = oz; } if (j === c - 1) { ox = ix; oz = iz; }
      let tx = ix + ox, tz = iz + oz; const tl = Math.hypot(tx, tz);
      if (tl < 1e-3) { tx = ox; tz = oz; } else { tx /= tl; tz /= tl; }
      const ch = Math.max(0.55, tx * ox + tz * oz);
      TX[q] = tx; TZ[q] = tz; MX[q] = tz / ch; MZ[q] = -tx / ch;
    }
    for (const e of [0, 1]) {
      const q = e ? p + c - 1 : p, k = key(R.xy[q * 2] * 0.5, R.xy[q * 2 + 1] * 0.5);
      let id = nodes.get(k); if (id == null) { id = list.length; nodes.set(k, id); list.push([]); }
      ends[i * 2 + e] = id; list[id].push(i * 2 + e);
    }
  }
  const deg = new Uint8Array(list.length), nodeH = new Float32Array(list.length), NX = new Float32Array(list.length), NZ = new Float32Array(list.length);
  list.forEach((a, id) => {
    deg[id] = Math.min(255, a.length);
    for (const ke of a) nodeH[id] = Math.max(nodeH[id], R.hw[ke >> 1] / 10);
    const ke = a[0], i = ke >> 1, q = ke & 1 ? R.start[i] + R.lens[i] - 1 : R.start[i]; NX[id] = R.xy[q * 2] * 0.5; NZ[id] = R.xy[q * 2 + 1] * 0.5;
  });
  // junction clusters: the nodes of one crossing (dual carriageways meet in 2-4 nodes) share one junction box
  const jc = new Int32Array(list.length).map((_, k) => k), find = (k) => { while (jc[k] !== k) { jc[k] = jc[jc[k]]; k = jc[k]; } return k; };
  const ng = new Map(), JC = 32;
  for (let id = 0; id < list.length; id++) if (deg[id] >= 3) { const g = Math.floor(NX[id] / JC) * 65536 + Math.floor(NZ[id] / JC); let b = ng.get(g); if (!b) ng.set(g, (b = [])); b.push(id); }
  for (let id = 0; id < list.length; id++) {
    if (deg[id] < 3) continue; const gx = Math.floor(NX[id] / JC), gz = Math.floor(NZ[id] / JC);
    for (let u = gx - 1; u <= gx + 1; u++) for (let w = gz - 1; w <= gz + 1; w++) for (const o of ng.get(u * 65536 + w) || []) {
      if (o !== id && (NX[o] - NX[id]) ** 2 + (NZ[o] - NZ[id]) ** 2 < 28 * 28) { const ra = find(id), rb = find(o); if (ra !== rb) jc[ra] = rb; }
    }
  }
  for (let id = 0; id < list.length; id++) jc[id] = find(id);
  // roads drawn on top of another carriageway for most of their length (duplicate service ways, overlapping links):
  // closed to traffic, or cars on the two would drive through each other
  const ghost = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (L[i] < 25) continue; const p = R.start[i], c = R.lens[i]; let m = 0;
    for (let j = 0; j < c; j++) if ((R.pmask[(p + j) * 2] & 1) && (R.pmask[(p + j) * 2 + 1] & 1)) m++;
    if (m > c * 0.6) ghost[i] = 1;
  }
  const CELL = 200, grid = new Map();
  for (let i = 0; i < n; i++) {
    const p = R.start[i], c = R.lens[i];
    for (let j = 0; j < c; j += 3) { const g = Math.floor(R.xy[(p + j) * 2] * 0.5 / CELL) * 4096 + Math.floor(R.xy[(p + j) * 2 + 1] * 0.5 / CELL); let a = grid.get(g); if (!a) grid.set(g, (a = [])); if (a[a.length - 1] !== i) a.push(i); }
  }
  Object.assign(R, { S, L, ends, nodes: list, grid, CELL, TX, TZ, MX, MZ, deg, nodeH, jc, ghost });
  busClear();
}
// Measured against the busway as drawn: every road the bus lanes run along gives up the width they (and their kerb and
// railing) take; a road with the busway down its middle that wasn't widened for it is closed to cars.
function busClear() {
  const R = ROADS, B = TR && TR.brts; if (!B || !B.lines) return;
  const C = 20, G = new Map(), S = []; R.bmid = new Int8Array(R.n);
  for (const ln of B.lines) {
    const p = ln.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const s = S.length; S.push(p[k], p[k + 1], p[k + 2], p[k + 3]);
      for (let gx = Math.floor(Math.min(p[k], p[k + 2]) / C); gx <= Math.floor(Math.max(p[k], p[k + 2]) / C); gx++)
        for (let gz = Math.floor(Math.min(p[k + 1], p[k + 3]) / C); gz <= Math.floor(Math.max(p[k + 1], p[k + 3]) / C); gz++) { const key = hk(gx, gz); let a = G.get(key); if (!a) G.set(key, (a = [])); a.push(s); }
    }
  }
  // stations: the busway is wider beside each island (bus lanes both sides), and nothing crosses an island or its ramps
  const STN = B.stations || [], SC2 = 60, SG = new Map();
  STN.forEach((s, k) => { const key = hk(Math.floor(s.x / SC2), Math.floor(s.z / SC2)); let l = SG.get(key); if (!l) SG.set(key, (l = [])); l.push(k); });
  const nearSt = (x, z, r) => { for (let gx = Math.floor((x - r) / SC2); gx <= Math.floor((x + r) / SC2); gx++) for (let gz = Math.floor((z - r) / SC2); gz <= Math.floor((z + r) / SC2); gz++) for (const k of SG.get(hk(gx, gz)) || []) { const s = STN[k]; if ((s.x - x) ** 2 + (s.z - z) ** 2 < r * r) return s; } return null; };
  const SA = BRTS_ST_LEN / 2 + 9.5, SB = BRTS_ST_W / 2 + BRTS_HW + 0.4;
  const segHitsIsland = (s, x0, z0, x1, z1) => {   // Liang-Barsky clip of a segment against the island rectangle in its own frame
    const a0 = (x0 - s.x) * s.ux + (z0 - s.z) * s.uz, b0 = (x0 - s.x) * s.uz - (z0 - s.z) * s.ux;
    const a1 = (x1 - s.x) * s.ux + (z1 - s.z) * s.uz, b1 = (x1 - s.x) * s.uz - (z1 - s.z) * s.ux;
    let t0 = 0, t1 = 1; const da = a1 - a0, db = b1 - b0;
    for (const [p, q] of [[-da, a0 + SA], [da, SA - a0], [-db, b0 + SB], [db, SB - b0]]) {
      if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  R.bwide = new Uint8Array(R.n);
  let nc = 0, nx = 0, ni = 0;
  for (let i = 0; i < R.n; i++) {
    if (R.cls[i] === 7 || R.br[i]) continue;
    {   // does this road run through a station island?
      const p0 = R.start[i], c = R.lens[i]; let hit = false, along = false;
      for (let j = 0; j + 1 < c && !hit; j++) {
        const q = p0 + j, x0 = R.xy[q * 2] * 0.5, z0 = R.xy[q * 2 + 1] * 0.5, x1 = R.xy[q * 2 + 2] * 0.5, z1 = R.xy[q * 2 + 3] * 0.5;
        const s = nearSt((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + 40); if (!s) continue;
        if (segHitsIsland(s, x0, z0, x1, z1)) { if (R.flag[i] & 2) along = true; else hit = true; }
      }
      if (hit) { R.ghost[i] = 1; ni++; continue; }
      if (along) R.bwide[i] = 1;   // a widened BRTS road past a station: traffic keeps outside the station's bus lanes
    }
    const p0 = R.start[i], c = R.lens[i], H = R.hw[i] / 10, reach = H + 4.8, centre = R.flag[i] & 2, ms = [];
    let cnt = 0, mid = 0, mL = 0, mR = 0, inside = 0;
    for (let j = 0; j < c; j++) {
      const q = p0 + j, x = R.xy[q * 2] * 0.5, z = R.xy[q * 2 + 1] * 0.5, tx = R.TX[q], tz = R.TZ[q];
      let best = 1e9, bm = 0, near = 1e9;
      for (let gx = Math.floor(x / C) - 1; gx <= Math.floor(x / C) + 1; gx++) for (let gz = Math.floor(z / C) - 1; gz <= Math.floor(z / C) + 1; gz++) {
        const a = G.get(hk(gx, gz)); if (!a) continue;
        for (const s of a) {
          const ax = S[s], az = S[s + 1], dx = S[s + 2] - ax, dz = S[s + 3] - az, l2 = dx * dx + dz * dz; if (l2 < 1e-4) continue;
          const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1), ex = ax + dx * t - x, ez = az + dz * t - z, d = Math.hypot(ex, ez);
          if (d < near) near = d;
          const l = Math.sqrt(l2); if (Math.abs((dx * tx + dz * tz) / l) < 0.5) continue;           // only where the busway runs alongside
          if (d < best && d < reach) { best = d; bm = ex * tz - ez * tx; }                          // + = busway left of the drawn direction
        }
      }
      if (near < 4.3) inside++;
      if (best > 1e8) continue;
      cnt++; ms.push(bm); if (Math.abs(bm) < 2.5) mid++;
      const bh = nearSt(x, z, 30) ? 7.3 : 4.8;   // beside a station the bus lanes run either side of the island
      const intr = bh - (Math.abs(bm) - H); if (intr > 0) { if (bm > 0) mL = Math.max(mL, intr); else mR = Math.max(mR, intr); }
    }
    if (!cnt && !(R.cls[i] === 4 && inside >= 2)) continue;
    if (centre) {   // widened BRTS road: keep traffic outside the bus lanes wherever they actually run
      ms.sort((p, q) => p - q); const m = ms[ms.length >> 1]; R.bmid[i] = clamp(Math.round(m * 10), -127, 127); continue;
    }
    if (mid > c * 0.3 || inside > c * 0.35 || (R.cls[i] === 4 && inside >= 2) || Math.min(mL, mR) > 0) { R.ghost[i] = 1; nx++; continue; }   // slip links through the busway too   // busway down the middle (or both sides): no room for cars
    const v = Math.max(mL, mR); if (!v) continue;
    if (v > 2 * H - 2.6) { R.ghost[i] = 1; nx++; continue; }
    const cur = R.bclr[i] / 10; if (v > cur) { R.bclr[i] = Math.min(255, Math.round(v * 10)); R.flag[i] = (R.flag[i] & ~4) | (mL > mR ? 4 : 0); nc++; }
  }
  STATS.busClear = [nc, nx, ni];
}
function roadAt(i, s, dir, off, out) {   // world position + heading at distance s along road i, `off` metres left of travel
  const R = ROADS, p = R.start[i], c = R.lens[i], S = R.S, len = R.L[i];
  s = s < 0 ? 0 : s > len ? len : s;
  let lo = 0, hi = c - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[p + m] <= s) lo = m; else hi = m; }
  const f = clamp((s - S[p + lo]) / Math.max(1e-3, S[p + hi] - S[p + lo]), 0, 1), g = 1 - f, a = p + lo, b = p + hi, o = off * dir;
  out.x = (R.xy[a * 2] * g + R.xy[b * 2] * f) * 0.5 + (R.MX[a] * g + R.MX[b] * f) * o;
  out.z = (R.xy[a * 2 + 1] * g + R.xy[b * 2 + 1] * f) * 0.5 + (R.MZ[a] * g + R.MZ[b] * f) * o;
  const hx = (R.TX[a] * g + R.TX[b] * f) * dir, hz = (R.TZ[a] * g + R.TZ[b] * f) * dir, hl = Math.hypot(hx, hz) || 1;
  out.hx = hx / hl; out.hz = hz / hl;
  out.y = R.br[i] ? R.zp[a] * g + R.zp[b] * f + 0.06 : 0.03;
  return out;
}
// usable band for traffic moving `dir` on road i, in metres left of travel: one-way roads use the whole carriageway,
// two-way roads the left half (outside the bus lanes on BRTS roads), minus whatever the busway takes beside it
const _ls = [0, 0];
function laneSpan(i, dir, out) {
  const R = ROADS, H = R.hw[i] / 10, fl = R.flag[i], bc = R.bclr[i] / 10;
  let lo = -H, hi = H;
  if (bc > 0) { if (fl & 4) hi -= bc; else lo += bc; }
  const bm = R.bmid ? R.bmid[i] / 10 : 0, bi = R.bwide && R.bwide[i] ? 7.4 : 4.8;
  if (fl & 1) {
    if (fl & 2) { if (H - (bm + bi) >= (bm - bi) + H) { out[0] = bm + bi; out[1] = hi; } else { out[0] = lo; out[1] = bm - bi; } }   // the wider side of the bus lanes
    else { out[0] = dir > 0 ? lo : -hi; out[1] = dir > 0 ? hi : -lo; }
  } else if (fl & 2) { if (dir > 0) { out[0] = bm + bi; out[1] = hi; } else { out[0] = bi - bm; out[1] = -lo; } }
  else { out[0] = 0.3; out[1] = dir > 0 ? hi : -lo; }
  return out[1] - out[0];
}
function laneCount(i, dir) { const w = laneSpan(i, dir, _ls); return w < 1.6 ? 0 : Math.max(1, Math.floor(w / 3.2)); }
function laneOff(i, lane, dir) {   // lane 0 = kerb side
  const w = laneSpan(i, dir, _ls); if (w < 1.6) return (_ls[0] + _ls[1]) / 2;
  const nl = Math.max(1, Math.floor(w / 3.2)); return _ls[1] - (Math.min(lane, nl - 1) + 0.5) * w / nl;
}
function nextRoad(i, dir, walk) {   // pick the road to carry on onto at the node ahead
  const R = ROADS, node = R.ends[i * 2 + (dir > 0 ? 1 : 0)], opts = [], wts = [], dots = [];
  const q = dir > 0 ? R.start[i] + R.lens[i] - 1 : R.start[i], tx = R.TX[q] * dir, tz = R.TZ[q] * dir;
  for (const ke of R.nodes[node]) {
    const j = ke >> 1, e = ke & 1; if (j === i) continue;
    const d2 = e === 0 ? 1 : -1;
    if (R.cls[j] === 7) continue;                                     // the busway is for buses (and nobody walks it)
    if (walk) { if (R.br[j] || R.ghost[j] || R.sw[j] < 5) continue; }
    else { if ((R.flag[j] & 1) && d2 < 0) continue; if (R.cls[j] === 0 && R.cls[i] > 2) continue; if (R.ghost[j] || !laneCount(j, d2)) continue; }
    const a = e === 0 ? R.start[j] : R.start[j] + R.lens[j] - 1, dot = tx * R.TX[a] * d2 + tz * R.TZ[a] * d2;
    opts.push(j, d2); wts.push((0.25 + Math.max(0, dot) ** 2 * 2.5) * (walk ? 1 : 0.6 + R.cls[j] * 0.25)); dots.push(dot);
  }
  if (!wts.length) return null;
  if (!walk && dots.some((d) => d >= -0.55)) dots.forEach((d, k) => { if (d < -0.55) wts[k] = 0; });   // no hairpins unless there is no other way
  let r = Math.random() * wts.reduce((a, b) => a + b, 0);
  for (let k = 0; k < wts.length; k++) { r -= wts[k]; if (r <= 0) return [opts[k * 2], opts[k * 2 + 1]]; }
  return [opts[opts.length - 2], opts[opts.length - 1]];
}
// visible ground box (bounding box of the view quad), refreshed whenever the view changes
let VBOX = null;
function setViewBox(Q) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [x, z] of Q) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  VBOX = { x0, x1, z0, z1 };
}
const inBox = (B, x, z, m = 0) => x > B.x0 - m && x < B.x1 + m && z > B.z0 - m && z < B.z1 + m;
// writes a yaw-only instance transform (local +x forward) straight into an instance matrix array
function putYaw(arr, k, x, y, z, hx, hz, sc) {
  const o = k * 16;
  arr[o] = hx * sc; arr[o + 1] = 0; arr[o + 2] = hz * sc; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sc; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = -hz * sc; arr[o + 9] = 0; arr[o + 10] = hx * sc; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}
function flushInst(attr, n) {
  attr.needsUpdate = true;
  if (attr.clearUpdateRanges) { attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(1, n) * attr.itemSize); }
}

// ---- vehicles: car-following (IDM), lane keeping, curved turns through junction boxes that are reserved before entry
const TYPE_MIX = {   // by road class group: hatch sedan suv auto scooter bike tempo truck
  big: [0.21, 0.15, 0.14, 0.16, 0.15, 0.12, 0.055, 0.015], mid: [0.18, 0.1, 0.08, 0.21, 0.23, 0.15, 0.05, 0], small: [0.1, 0.04, 0.04, 0.2, 0.38, 0.2, 0.04, 0],
};
const CAR_COLS = [[0.34, '#f2f2ee'], [0.18, '#b9bdc2'], [0.1, '#6d7278'], [0.1, '#b3261e'], [0.08, '#1f4e9c'], [0.08, '#202226'], [0.05, '#7a2632'], [0.04, '#c99a3c'], [0.03, '#2e6b4a']];
const TWO_COLS = [[0.25, '#e9e9e6'], [0.2, '#1c1c1f'], [0.15, '#a8221c'], [0.12, '#2b4f9e'], [0.1, '#9aa0a6'], [0.08, '#c08a2a'], [0.1, '#5c6066']];
const pickCol = (tab) => { let r = Math.random(); for (const [w, c] of tab) { r -= w; if (r <= 0) return new THREE.Color(c); } return new THREE.Color(tab[0][1]); };
const IDM = { car: { a: 1.5, b: 3.0, T: 1.2, s0: 1.8 }, two: { a: 2.2, b: 3.5, T: 0.8, s0: 1.2 }, heavy: { a: 0.9, b: 2.5, T: 1.6, s0: 2.5 } };
const TR_CELL = 12, CAR_CAP = 160, SPAWN_W = [0.03, 0.12, 0.15, 0.45, 0.4, 0.9, 1, 0, 1, 1];
const hk = (gx, gz) => (gx + 8192) * 16384 + (gz + 8192);
function initTraffic() {
  streetGraph();
  const meshes = VTYPES.map((t) => {
    const G = new Geo(true); t.build(G);
    const im = new THREE.InstancedMesh(G.mesh(VEHMAT).geometry, VEHMAT, CAR_CAP);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < CAR_CAP; k++) im.setColorAt(k, _vc.set(1, 1, 1));
    im.count = 0; im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; im.renderOrder = 10; im.visible = false;
    group.ground.add(im); return im;
  });
  planWorks(); buildWorks();
  TRAF = { cars: [], fresh: [], meshes, slots: VTYPES.map(() => []), cdirty: VTYPES.map(() => false), H: new Map(), nxt: new Int32Array(2048),
    box: new Map(), wait: new Map(), id: 0, shown: false, stat: [0, 0, 0] };
}
function carNear(x, z, r) {
  const TT = TRAF, g0 = Math.floor((x - r) / TR_CELL), g1 = Math.floor((x + r) / TR_CELL), h0 = Math.floor((z - r) / TR_CELL), h1 = Math.floor((z + r) / TR_CELL);
  for (let a = g0; a <= g1; a++) for (let b = h0; b <= h1; b++) {
    for (let o = TT.H.get(hk(a, b)) ?? -1; o >= 0; o = TT.nxt[o]) { const d = TT.cars[o]; if ((d.x - x) ** 2 + (d.z - z) ** 2 < r * r) return true; }
  }
  for (const d of TT.fresh) if ((d.x - x) ** 2 + (d.z - z) ** 2 < r * r) return true;
  return false;
}
function spawnCar(B, V, inside) {
  const RD = ROADS, TT = TRAF;
  for (let tries = 0; tries < 10; tries++) {
    const x = B.x0 + Math.random() * (B.x1 - B.x0), z = B.z0 + Math.random() * (B.z1 - B.z0);
    if (!inside && inBox(V, x, z)) continue;
    const cell = RD.grid.get(Math.floor(x / RD.CELL) * 4096 + Math.floor(z / RD.CELL)); if (!cell) continue;
    const i = cell[(Math.random() * cell.length) | 0], c = RD.cls[i];
    if (RD.ghost[i] || Math.random() > SPAWN_W[c]) continue;
    const len = RD.L[i], n0 = RD.ends[i * 2], n1 = RD.ends[i * 2 + 1];
    const m0 = RD.deg[n0] >= 3 ? RD.nodeH[n0] + 6 : 3, m1 = RD.deg[n1] >= 3 ? RD.nodeH[n1] + 6 : 3;
    if (len - m0 - m1 < 4) continue;
    const dir = RD.flag[i] & 1 ? 1 : Math.random() < 0.5 ? 1 : -1, nl = laneCount(i, dir); if (!nl) continue;
    const mix = c >= 5 ? TYPE_MIX.big : c >= 3 ? TYPE_MIX.mid : TYPE_MIX.small;
    let rr = Math.random(), t = 0; for (; t < mix.length - 1; t++) { rr -= mix[t]; if (rr <= 0) break; }
    if (TT.slots[t].length >= CAR_CAP) continue;
    const T = VTYPES[t], vmax = [5, 7, 8, 10, 9, 12, 14, 9, 16, 19][c] * T.f * (0.85 + Math.random() * 0.25);
    const s = m0 + Math.random() * (len - m0 - m1), wk = WORKBY.get(i), jit = T.two ? (Math.random() - 0.5) * 1.1 : 0;
    let lane = (Math.random() * nl) | 0; if (wk && wk.dir === dir && lane === 0) lane = 1;   // kerb lane is shut there
    const car = { id: ++TT.id, t, i, dir, s, lane, jit, off: laneOff(i, lane, dir) + jit, v: 0, vmax, w: T.w, len: T.len, idm: T.two ? IDM.two : t >= 6 ? IDM.heavy : IDM.car,
      col: t === 3 ? new THREE.Color(1, 1, 1) : pickCol(T.two ? TWO_COLS : t === 7 ? [[1, '#e0a030']] : CAR_COLS),
      x: 0, y: 0, z: 0, hx: 1, hz: 0, rx: 1, rz: 0, mode: 0, cs: 0, plan: null, fa: inside ? 0 : 1, fade: 0, wait: 0, stuck: 0, blk: 0, slot: -1, dead: false };
    roadAt(i, s, dir, car.off, car);
    if (!inBox(B, car.x, car.z) || (!inside && inBox(V, car.x, car.z)) || carNear(car.x, car.z, 9)) continue;
    car.v = vmax * 0.6; car.rx = car.hx; car.rz = car.hz;
    car.slot = TT.slots[t].length; TT.slots[t].push(car); TT.meshes[t].setColorAt(car.slot, car.col); TT.cdirty[t] = true;
    TT.cars.push(car); TT.fresh.push(car); TT.stat[inside && inBox(V, car.x, car.z) ? 0 : 1]++;
    return car;
  }
  return null;
}
function releaseBox(c) {
  const pl = c.plan; if (!pl) return;
  if (pl.held) { const a = TRAF.box.get(pl.node); if (a) { const k = a.indexOf(c); if (k >= 0) a.splice(k, 1); if (!a.length) TRAF.box.delete(pl.node); } pl.held = false; }
  if (pl.queued) { const a = TRAF.wait.get(pl.node); if (a) { const k = a.indexOf(c); if (k >= 0) a.splice(k, 1); if (!a.length) TRAF.wait.delete(pl.node); } pl.queued = false; }
}
function dropCar(c) {
  const TT = TRAF, sl = TT.slots[c.t], last = sl.pop();
  if (last !== c) { sl[c.slot] = last; last.slot = c.slot; TT.meshes[c.t].setColorAt(last.slot, last.col); TT.cdirty[c.t] = true; }
  releaseBox(c); c.dead = true;
}
// cubic Bezier helpers for turns (P = [x0,z0, x1,z1, x2,z2, x3,z3])
const _bz = { x: 0, z: 0, hx: 1, hz: 0 }, _pa = { x: 0, y: 0, z: 0, hx: 1, hz: 0, len: 0 }, _pb = { x: 0, y: 0, z: 0, hx: 1, hz: 0, len: 0 };
function bez(P, u, o) {
  const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
  o.x = a * P[0] + b * P[2] + c * P[4] + d * P[6]; o.z = a * P[1] + b * P[3] + c * P[5] + d * P[7];
  const da = -3 * v * v, db = 3 * v * v - 6 * v * u, dc = 6 * v * u - 3 * u * u, dd = 3 * u * u;
  const hx = da * P[0] + db * P[2] + dc * P[4] + dd * P[6], hz = da * P[1] + db * P[3] + dc * P[5] + dd * P[7], l = Math.hypot(hx, hz);
  if (l > 1e-6) { o.hx = hx / l; o.hz = hz / l; }
  return o;
}
function bezCtrl(P, a, b, tight) {
  const ch = Math.hypot(b.x - a.x, b.z - a.z), k = tight ? Math.max(ch * 0.42, 3.2) : ch * 0.42;
  P[0] = a.x; P[1] = a.z; P[2] = a.x + a.hx * k; P[3] = a.z + a.hz * k; P[4] = b.x - b.hx * k; P[5] = b.z - b.hz * k; P[6] = b.x; P[7] = b.z;
}
function bezTable(P, t) {
  let px = P[0], pz = P[1]; t[0] = 0; _bz.hx = 1; _bz.hz = 0;
  for (let k = 1; k <= 16; k++) { bez(P, k / 16, _bz); t[k] = t[k - 1] + Math.hypot(_bz.x - px, _bz.z - pz); px = _bz.x; pz = _bz.z; }
  return t[16];
}
function bezAt(P, t, d, o) {
  if (d >= t[16]) return bez(P, 1, o); if (d <= 0) return bez(P, 0, o);
  let k = 0; while (k < 15 && t[k + 1] < d) k++;
  return bez(P, (k + (d - t[k]) / Math.max(1e-6, t[k + 1] - t[k])) / 16, o);
}
// plan the movement through the node ahead: next road, lane, mouth distances, the curve and a comfortable speed
function planTurn(c) {
  const RD = ROADS, i = c.i, dir = c.dir, len = RD.L[i], e = dir > 0 ? 1 : 0, node = RD.ends[i * 2 + e];
  let nx = nextRoad(i, dir, false), ut = false;
  if (!nx) { if (RD.flag[i] & 1) return { fade: true }; nx = [i, -dir]; ut = true; }
  const j = nx[0], d2 = nx[1], lj = RD.L[j];
  const qa = dir > 0 ? RD.start[i] + RD.lens[i] - 1 : RD.start[i], qb = d2 > 0 ? RD.start[j] : RD.start[j] + RD.lens[j] - 1;
  const t0x = RD.TX[qa] * dir, t0z = RD.TZ[qa] * dir, t3x = RD.TX[qb] * d2, t3z = RD.TZ[qb] * d2;
  const dot = clamp(t0x * t3x + t0z * t3z, -1, 1), th = Math.acos(dot), side = t3x * t0z - t3z * t0x;   // side > 0: turning left
  const deg = ut || laneCount(j, d2) < laneCount(i, dir) ? Math.max(3, RD.deg[node]) : RD.deg[node];   // U-turns and lane drops reserve the box too
  let ma, mb;
  if (ut) ma = mb = Math.min(5, len * 0.35);
  else if (deg >= 3) {
    const base = RD.nodeH[node] + 2.2, M = SIGS && SIGS.mouth;
    // wait a little further back than where turning cars finish, so right turns never sweep a waiting car's nose
    ma = Math.max(base + 3.0, (M && M.get(i * 2 + e)) || 0); mb = Math.max(base, (M && M.get(j * 2 + (d2 > 0 ? 0 : 1))) || 0);
  } else ma = mb = 1.0 + th * 2.6;
  ma = clamp(ma, 0.6, len * 0.45); mb = clamp(mb, 0.6, lj * 0.45);
  const nl2 = Math.max(1, laneCount(j, d2)), lane2 = ut ? nl2 - 1 : side > 0.3 ? 0 : side < -0.3 ? nl2 - 1 : Math.min(c.lane, nl2 - 1);
  const sA = dir > 0 ? len - ma : ma, sB = ut ? sA : d2 > 0 ? mb : lj - mb, offB = laneOff(j, lane2, d2) + c.jit;
  roadAt(i, sA, dir, laneOff(i, c.lane, dir) + c.jit, _pa); roadAt(j, sB, d2, offB, _pb);
  const tight = ut || dot < -0.5, P = new Float32Array(8); bezCtrl(P, _pa, _pb, tight);
  const ch = Math.hypot(_pb.x - _pa.x, _pb.z - _pa.z);
  const vlim = th < 0.12 ? 99 : clamp(Math.sqrt(2.6 * Math.max(1.5, ch / (2 * Math.max(0.05, Math.sin(th / 2))))), 2.2, 99);
  const sp = new Float32Array(26); for (let k = 0; k <= 12; k++) { bez(P, k / 12, _bz); sp[k * 2] = _bz.x; sp[k * 2 + 1] = _bz.z; }
  return { fade: false, turn: ut ? 1 : side > 0.3 ? -1 : side < -0.3 ? 1 : 0, j, d2, ma, sB, lane2, offB, P, sp, tbl: new Float32Array(17), L: 0, vlim, node: RD.jc[node], deg, from: i * 2 + e, y0: _pa.y, y1: _pb.y, tight, held: false, queued: false };
}
function pathsClash(a, b) {
  const A = a.plan.sp, B = b.plan.sp, lim = (a.w + b.w) / 2 + 0.6, l2 = lim * lim;
  for (let p = 0; p < 13; p++) for (let q = 0; q < 13; q++) { const dx = A[p * 2] - B[q * 2], dz = A[p * 2 + 1] - B[q * 2 + 1]; if (dx * dx + dz * dz < l2) return true; }
  return false;
}
function requestBox(c) {   // a junction box is entered only when no car inside (or waiting long) has a path that crosses ours
  const TT = TRAF, pl = c.plan, occ = TT.box.get(pl.node), wl = TT.wait.get(pl.node);
  if (occ) for (const o of occ) if (o !== c && o.plan && !(o.plan.from === pl.from && o.plan.j === pl.j && o.plan.lane2 === pl.lane2 && o.lane === c.lane) && pathsClash(c, o)) return false;   // same lane, same exit: just follow
  if (wl) for (const o of wl) {
    if (o === c || !o.plan) continue;
    if (o.wait > 4 && o.wait > c.wait + 0.5 && o.plan.from !== pl.from && pathsClash(c, o)) return false;
  }
  // never sweep through a car standing in the way (waiting at the box edge, stopped at the lights, queued on the exit)
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; const sp = pl.sp;
  for (let k = 0; k < 13; k++) { x0 = Math.min(x0, sp[k * 2]); x1 = Math.max(x1, sp[k * 2]); z0 = Math.min(z0, sp[k * 2 + 1]); z1 = Math.max(z1, sp[k * 2 + 1]); }
  for (let gx = Math.floor((x0 - 6) / TR_CELL); gx <= Math.floor((x1 + 6) / TR_CELL); gx++) for (let gz = Math.floor((z0 - 6) / TR_CELL); gz <= Math.floor((z1 + 6) / TR_CELL); gz++) {
    for (let k = TT.H.get(hk(gx, gz)) ?? -1; k >= 0; k = TT.nxt[k]) {
      const o = TT.cars[k]; if (o === c || o.dead || (o.mode === 1 && o.v > 0.5)) continue;
      if (o.i === c.i && o.dir === c.dir && (o.x - c.x) * c.hx + (o.z - c.z) * c.hz < 0) continue;   // behind me on my approach
      if (o.i === pl.j && o.dir === pl.d2 && o.mode === 0) continue;                 // ahead on my exit: just follow it
      const lim = (c.w + o.w) / 2 + 0.4, bx = o.hx * o.len / 2, bz = o.hz * o.len / 2;
      for (let q = 0; q < 13; q++) if (segD2(o.x - bx, o.z - bz, o.x + bx, o.z + bz, sp[q * 2], sp[q * 2 + 1]) < lim * lim) return false;
    }
  }
  if (pl.queued && wl) { const k = wl.indexOf(c); if (k >= 0) wl.splice(k, 1); if (!wl.length) TT.wait.delete(pl.node); pl.queued = false; }
  let a = occ; if (!a) TT.box.set(pl.node, (a = [])); a.push(c); pl.held = true; c.wait = 0;
  return true;
}
function idmAcc(P, v, v0, gap, vl) {
  let acc = P.a * (1 - (v / Math.max(0.5, v0)) ** 4);
  if (gap < 1e8) { const ss = P.s0 + Math.max(0, v * P.T + v * (v - vl) / (2 * Math.sqrt(P.a * P.b))); acc -= P.a * (ss / Math.max(0.1, gap)) ** 2; }
  return acc;
}
function stepTraffic(dt) {
  if (!TRAF) return false;
  const TT = TRAF, RD = ROADS, show = view.mpp < 1.7 && VBOX;
  if (!show) {
    if (TT.shown) { for (const c of TT.cars) dropCar(c); TT.cars.length = 0; TT.box.clear(); TT.wait.clear(); for (const m of TT.meshes) { m.count = 0; m.visible = false; } TT.shown = false; }
    return false;
  }
  if (!TT.shown) { for (const m of TT.meshes) m.visible = true; TT.shown = true; TT.fill = true; }
  if (TT.pause) return true;
  const V = VBOX, M = 70, B = { x0: V.x0 - M, x1: V.x1 + M, z0: V.z0 - M, z1: V.z1 + M };
  const want = Math.round(clamp(Math.round((B.x1 - B.x0) * (B.z1 - B.z0) / 1e6 * 150), 110, 260) * (TT.boost || 1));
  // retire cars that are out of sight beyond the margin, or have faded out
  let w = 0;
  for (const c of TT.cars) {
    if (c.dead) continue;
    if (!inBox(V, c.x, c.z, M + 50) || (c.fade && c.fa <= 0)) { dropCar(c); continue; }
    TT.cars[w++] = c;
  }
  TT.cars.length = w;
  if (TT.nxt.length < w + 64) TT.nxt = new Int32Array((w + 64) * 2);
  TT.H.clear();
  for (let k = 0; k < w; k++) { const c = TT.cars[k], key = hk(Math.floor(c.x / TR_CELL), Math.floor(c.z / TR_CELL)); TT.nxt[k] = TT.H.get(key) ?? -1; TT.H.set(key, k); }
  // top up: off-screen in the margin ring, or (when far short, e.g. right after zooming in) anywhere, growing in
  TT.fresh.length = 0;
  if (TT.cars.length >= want * 0.8) TT.fill = false;
  const inside = TT.fill || TT.cars.length < want * 0.3;
  for (let k = 0; k < 24 && TT.cars.length < want; k++) spawnCar(B, V, inside);
  const nAll = TT.cars.length; TT.nstep = (TT.nstep || 0) + 1; TT.lastDt = dt;
  for (let k = 0; k < nAll; k++) {
    const c = TT.cars[k], P = c.idm, len = RD.L[c.i];
    if (c.fade) c.fa = Math.max(0, c.fa - dt * 1.5); else if (c.fa < 1) c.fa = Math.min(1, c.fa + dt * 1.5);
    let de = c.dir > 0 ? len - c.s : c.s;
    if (c.mode === 0 && !c.plan && de < 45 + c.v * 2) {
      c.plan = planTurn(c);
      if (!c.plan.fade && c.plan.turn && de > 25) { const nl = laneCount(c.i, c.dir); if (nl > 1) { c.lane = c.plan.turn < 0 ? 0 : nl - 1; c.plan = planTurn(c); } }   // get in lane for the turn
    }
    const pl = c.plan;
    // whoever is in front of us (same way: follow; crossing right in front: the later arrival waits)
    let gap = 1e9, vl = 0;
    const gx = Math.floor((c.x + c.hx * 15) / TR_CELL), gz = Math.floor((c.z + c.hz * 15) / TR_CELL);
    for (let a = gx - 1; a <= gx + 1; a++) for (let b = gz - 1; b <= gz + 1; b++) {
      for (let o = TT.H.get(hk(a, b)) ?? -1; o >= 0; o = TT.nxt[o]) {
        if (o === k) continue; const d = TT.cars[o]; if (d.dead) continue;
        const rx = d.x - c.x, rz = d.z - c.z, al = rx * c.hx + rz * c.hz; if (al <= -c.len / 2 || al > 34) continue;
        const latA = Math.abs(rx * c.hz - rz * c.hx);
        const hd0 = c.hx * d.hx + c.hz * d.hz;
        if (hd0 > 0.2 && hd0 < 0.92 && c.id > d.id && al < 14) {   // converging at an angle (merges without a shared node): closest approach in the next 1.5 s
          const vx = d.v * d.hx - c.v * c.hx, vz = d.v * d.hz - c.v * c.hz, vv = vx * vx + vz * vz;
          const t = vv > 1e-4 ? clamp(-(rx * vx + rz * vz) / vv, 0, 1.5) : 0, mx = rx + vx * t, mz = rz + vz * t;
          if (mx * mx + mz * mz < ((c.w + d.w) / 2 + 0.7) ** 2) { gap = Math.min(gap, Math.max(0, Math.hypot(rx, rz) - (c.len + d.len) / 2)); vl = 0; }
        }
        if (al <= 0.05) { if (latA < (c.w + d.w) / 2 + 0.15 && c.id > d.id && hd0 > 0.2) { gap = Math.min(gap, 0); vl = 0; } continue; }
        if (latA > (c.w + d.w) / 2 + 0.25) continue;
        const hd = c.hx * d.hx + c.hz * d.hz, g = al - (c.len + d.len) / 2;
        if (hd > 0.5) { if (g < gap) { gap = g; vl = d.v * hd; } }
        else if (g < 5) { const yieldTo = (d.mode === 1 && c.mode === 0) || ((d.mode === 1) === (c.mode === 1) && d.id < c.id); if (yieldTo && g < gap) { gap = g; vl = 0; } }
      }
    }
    let v0 = c.vmax, og = 1e9;   // og: distance to a point we must be able to stop at (red light, busy junction, dead end)
    if (c.mode === 1) {   // on a curve: never sweep into anything standing on the rest of the path
      let hit = 1e9;
      for (const ahead of [2.5, 5, 8]) {
        bezAt(pl.P, pl.tbl, c.cs + ahead + c.len / 2, _pa);
        const gx = Math.floor(_pa.x / TR_CELL), gz = Math.floor(_pa.z / TR_CELL);
        for (let a = gx - 1; a <= gx + 1; a++) for (let b = gz - 1; b <= gz + 1; b++) for (let o = TT.H.get(hk(a, b)) ?? -1; o >= 0; o = TT.nxt[o]) {
          const d = TT.cars[o]; if (d === c || d.dead || d.v > 0.5) continue;
          const lim = (c.w + d.w) / 2 + 0.3, bx = d.hx * d.len / 2, bz = d.hz * d.len / 2;
          if (segD2(d.x - bx, d.z - bz, d.x + bx, d.z + bz, _pa.x, _pa.z) < lim * lim) hit = Math.min(hit, ahead - 0.6);
        }
        if (hit < 1e8) break;
      }
      if (hit < 1e8) {
        og = Math.min(og, hit + P.s0);
        if (pl.held && c.v < 0.3 && (c.blk += dt) > 1.0) releaseBox(c);   // stuck behind someone waiting for the box: let them have it
      } else if (!pl.held) { if (requestBox(c)) c.blk = 0; else og = Math.min(og, P.s0); }   // take the box back before moving on
    }
    if (c.mode === 0) {   // dug-up kerb lane ahead: move out of it in good time, or stop short of the cones
      const z = workZone(c);
      if (z) { const al = c.dir > 0 ? c.s : len - c.s; if (al > z[0] - 60 && al < z[1] + 2) { if (c.lane === 0) c.lane = 1; if (al < z[0] && Math.abs(c.off - (laneOff(c.i, 0, c.dir) + c.jit)) < 1.3) og = Math.min(og, z[0] - al - c.len / 2 + P.s0); } }
    }
    if (PEDS && PEDS.cross.length) for (const q of PEDS.cross) {   // somebody on the carriageway ahead: stop for them
      const rx = q.x - c.x, rz = q.z - c.z, al = rx * c.hx + rz * c.hz;
      if (al > 0 && al < 30 && Math.abs(rx * c.hz - rz * c.hx) < c.w / 2 + 0.9) og = Math.min(og, al - c.len / 2 - 1.2 + P.s0);
    }
    if (c.mode === 0 && pl) {
      if (pl.fade) { og = de - 0.5 - c.len / 2 + P.s0; if (de < 6 && c.v < 0.5) c.fade = 1; }
      else {
        const dcs = de - pl.ma, front = dcs - c.len / 2;
        v0 = Math.min(v0, Math.sqrt(pl.vlim * pl.vlim + 4.0 * Math.max(0, dcs)));
        let red = false;
        if (SIGS) {
          const arm = SIGS.armKey.get(c.i * 2 + (c.dir > 0 ? 1 : 0));
          if (arm) {
            const st = sigState(arm.si, arm.ph), dist = de - Math.max(arm.stop, pl.ma) - c.len / 2;
            if (st !== 2 && dist > -0.5 && (st === 0 || dist > 7)) { red = true; og = Math.min(og, dist + P.s0); if (pl.held) releaseBox(c); }
          }
        }
        if (!red && pl.deg >= 3 && !pl.held) {
          if (front < c.v * c.v / 4 + 14 && gap > front - 1 && !requestBox(c)) {
            if (!pl.queued) { let a = TT.wait.get(pl.node); if (!a) TT.wait.set(pl.node, (a = [])); a.push(c); pl.queued = true; }
            c.wait += dt;
          }
          if (!pl.held && front < c.v * c.v / 4 + 18) og = Math.min(og, front + P.s0);
        }
        if (!red && pl.deg >= 3 && !pl.held) {   // not cleared: keep well clear of the paths of the cars already in the box
          const occ = TT.box.get(pl.node);
          if (occ) for (const o of occ) { const sp = o.plan && o.plan.sp; if (!sp || o === c) continue;
            const lim = (c.w + o.w) / 2 + 1.0;
            for (let q = 0; q < 13; q++) { const rx = sp[q * 2] - c.x, rz = sp[q * 2 + 1] - c.z, al = rx * c.hx + rz * c.hz;
              if (al > -c.len / 2 && Math.abs(rx * c.hz - rz * c.hx) < lim) og = Math.min(og, al - c.len / 2 - o.w / 2 - 0.9 + P.s0); } }
        }
      }
    } else if (c.mode === 1) v0 = Math.min(v0, pl.vlim);
    let acc = idmAcc(P, c.v, v0, gap, vl);
    if (og < 1e8) acc = Math.min(acc, idmAcc(P, c.v, v0, og, 0));
    acc = clamp(acc, -9, P.a);
    c.v = Math.max(0, c.v + acc * dt);
    if (gap < 0.15 || og < P.s0 - 1.2) c.v = Math.min(c.v, 0.3 * Math.max(0, Math.min(gap, og - P.s0 + 1.2)));
    c.stuck = c.v < 0.05 ? c.stuck + dt : 0;
    if (c.stuck > 45 && !c.fade) { c.fade = 1; releaseBox(c); TT.stat[2]++; }
    // move
    if (c.mode === 0) {
      c.s += c.v * dt * c.dir; de = c.dir > 0 ? len - c.s : c.s;
      const tgt = laneOff(c.i, c.lane, c.dir) + c.jit, dl = tgt - c.off;
      if (Math.abs(dl) > 0.05) {   // changing lane: only into a gap (nobody alongside on that side)
        let free = true; const gx0 = Math.floor(c.x / TR_CELL), gz0 = Math.floor(c.z / TR_CELL);
        for (let a = gx0 - 1; a <= gx0 + 1 && free; a++) for (let b = gz0 - 1; b <= gz0 + 1 && free; b++) {
          for (let o = TT.H.get(hk(a, b)) ?? -1; o >= 0; o = TT.nxt[o]) {
            const d = TT.cars[o]; if (d === c || d.dead) continue;
            const rx = d.x - c.x, rz = d.z - c.z, al = rx * c.hx + rz * c.hz, lat = rx * c.hz - rz * c.hx;
            if (c.hx * d.hx + c.hz * d.hz > 0.5 && Math.abs(al) < (c.len + d.len) / 2 + 1.5 && lat * dl > 0 && Math.abs(lat) < (c.w + d.w) / 2 + Math.abs(dl) + 0.3) { free = false; break; }
          }
        }
        if (free) c.off += clamp(dl, -1.1 * dt, 1.1 * dt); else c.v = Math.max(0, c.v - 1.5 * dt);
      }
      if (pl && pl.fade) { if (de < 0.3) { c.s = c.dir > 0 ? len - 0.3 : 0.3; c.v = 0; c.fade = 1; } }
      else if (pl && de <= pl.ma) {
        if (pl.deg >= 3 && !pl.held) c.v = 0;   // not cleared yet: wait at the edge of the box
        else {
          roadAt(c.i, c.dir > 0 ? len - pl.ma : pl.ma, c.dir, c.off, _pa); roadAt(pl.j, pl.sB, pl.d2, pl.offB, _pb);
          bezCtrl(pl.P, _pa, _pb, pl.tight); pl.L = bezTable(pl.P, pl.tbl); pl.y0 = _pa.y; pl.y1 = _pb.y;
          const moved = Math.abs(pl.sp[0] - _pa.x) + Math.abs(pl.sp[1] - _pa.z) > 0.4;
          for (let k = 0; k <= 12; k++) { bez(pl.P, k / 12, _bz); pl.sp[k * 2] = _bz.x; pl.sp[k * 2 + 1] = _bz.z; }
          if (moved && pl.deg >= 3) { releaseBox(c); if (!requestBox(c)) c.v = 0; }   // the real path differs from the planned one: check it again
          if (pl.deg < 3 || pl.held) { c.mode = 1; c.cs = pl.ma - de; c.blk = 0; }
        }
      }
    } else {
      c.cs += c.v * dt;
      if (c.cs >= pl.L) {
        const over = c.cs - pl.L; releaseBox(c);
        c.i = pl.j; c.dir = pl.d2; c.lane = pl.lane2; c.off = pl.offB; c.s = clamp(pl.sB + over * pl.d2, 0, RD.L[pl.j]); c.mode = 0; c.plan = null;
      }
    }
    if (c.mode === 0) roadAt(c.i, c.s, c.dir, c.off, c);
    else { bezAt(pl.P, pl.tbl, c.cs, _bz); c.x = _bz.x; c.z = _bz.z; c.hx = _bz.hx; c.hz = _bz.hz; c.y = pl.y0 + (pl.y1 - pl.y0) * clamp(c.cs / Math.max(0.1, pl.L), 0, 1); }
    {   // drawn heading turns at a bounded rate (no snapping on tight curves)
      const cr = c.rx * c.hz - c.rz * c.hx, dp = c.rx * c.hx + c.rz * c.hz, ang = Math.atan2(cr, dp), mx = 3.2 * dt;
      const t = clamp(ang, -mx, mx), ct = Math.cos(t), st = Math.sin(t), nx = c.rx * ct - c.rz * st, nz = c.rx * st + c.rz * ct;
      c.rx = nx; c.rz = nz;
    }
  }
  const zf = 1 - 0.85 * smoothstep(1.35, 1.7, view.mpp);   // shrink away as the flow streaks take over
  // draw: every car owns a fixed instance slot, so colours are uploaded only when cars come and go
  for (let t = 0; t < VTYPES.length; t++) {
    const im = TT.meshes[t], sl = TT.slots[t], arr = im.instanceMatrix.array;
    for (let q = 0; q < sl.length; q++) { const c = sl[q], f = c.fa, sc = (f >= 1 ? 1 : 0.2 + 0.8 * f * f * (3 - 2 * f)) * zf; putYaw(arr, q, c.x, c.y, c.z, c.rx, c.rz, sc); }
    im.count = sl.length; flushInst(im.instanceMatrix, sl.length);
    if (TT.cdirty[t]) { im.instanceColor.needsUpdate = true; TT.cdirty[t] = false; }
  }
  return true;
}
// ---- pedestrians on the footpaths: keep left, sidestep oncoming walkers, queue or overtake slower ones, never overlap
const PEDMAT = new THREE.MeshLambertMaterial({ color: 0xffffff });
PEDMAT.onBeforeCompile = (sh) => {
  sh.uniforms.uTime = U.uTime;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aR; attribute vec3 iShirt; attribute vec3 iPants; attribute float iPhase; uniform float uTime; varying vec3 vPC;')
    .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
      float swg = sin(uTime * 7.2 + iPhase);
      if (abs(aR.y) > 0.5) { float k = abs(aR.y) > 1.5 ? -0.5 : 0.42; transformed.x += swg * sign(aR.y) * k * (aR.z - position.y); }
      transformed.y += abs(swg) * 0.025;`)
    .replace('#include <color_vertex>', `#include <color_vertex>
      float pt = floor(aR.x + 0.5);
      vec3 skin = mix(vec3(0.16, 0.08, 0.04), vec3(0.42, 0.24, 0.15), fract(iPhase * 0.173));
      vPC = pt < 0.5 ? skin : (pt < 1.5 ? iShirt : (pt < 2.5 ? iPants : vec3(0.012, 0.01, 0.01)));`);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPC;').replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vPC;');
};
const SHIRTS = ['#f1f1ec', '#9cc3e6', '#f29a2e', '#7a1f2b', '#2f7d4f', '#e8c547', '#d9578f', '#2b2d33', '#5a7fc2', '#c8463a', '#e7d9b9', '#4c3a6e'].map((c) => new THREE.Color(c));
const PANTS = ['#1f2a44', '#151517', '#8a7a5a', '#54575c', '#2c3e5c', '#6b4a33'].map((c) => new THREE.Color(c));
const PED_CAP = 240, PED_CELL = 3;
function initPeds() {
  const G = new Geo(true), P = (G2, x0, x1, y0, y1, z0, z1, part, swing, piv) => {
    const e = [part, swing, piv, 0], c = [1, 1, 1];
    lq(G2, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], e, c); lq(G2, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], e, c);
    lq(G2, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], e, c); lq(G2, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], e, c);
    lq(G2, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], e, c);
  };
  P(G, -0.08, 0.08, 0.0, 0.84, 0.02, 0.15, 2, 1, 0.84); P(G, -0.08, 0.08, 0.0, 0.84, -0.15, -0.02, 2, -1, 0.84);
  P(G, -0.11, 0.11, 0.82, 1.4, -0.19, 0.19, 1, 0, 0); P(G, -0.06, 0.06, 0.86, 1.38, 0.19, 0.27, 1, -2, 1.38); P(G, -0.06, 0.06, 0.86, 1.38, -0.27, -0.19, 1, 2, 1.38);
  P(G, -0.07, 0.07, 1.4, 1.46, -0.06, 0.06, 0, 0, 0); P(G, -0.1, 0.1, 1.45, 1.68, -0.09, 0.09, 0, 0, 0); P(G, -0.11, 0.08, 1.62, 1.72, -0.1, 0.1, 3, 0, 0);
  const geo = G.mesh(PEDMAT).geometry;
  const shirt = new THREE.InstancedBufferAttribute(new Float32Array(PED_CAP * 3), 3), pants = new THREE.InstancedBufferAttribute(new Float32Array(PED_CAP * 3), 3), ph = new THREE.InstancedBufferAttribute(new Float32Array(PED_CAP), 1);
  geo.setAttribute('iShirt', shirt); geo.setAttribute('iPants', pants); geo.setAttribute('iPhase', ph);
  const im = new THREE.InstancedMesh(geo, PEDMAT, PED_CAP); im.count = 0; im.castShadow = false; im.frustumCulled = false; im.renderOrder = 10; im.visible = false;
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.ground.add(im);
  PEDS = { list: [], im, shirt, pants, ph, H: new Map(), nxt: new Int32Array(PED_CAP + 16), adirty: false, shown: false, cross: [] };
}
function pedAttrs(k, p) {
  const P = PEDS, sh = p.shirt, pa = p.pants || p.shirt;
  P.shirt.setXYZ(k, sh.r, sh.g, sh.b); P.pants.setXYZ(k, pa.r, pa.g, pa.b); P.ph.setX(k, p.ph); P.adirty = true;
}
const pedSideOk = (i, side) => { const R = ROADS; if (!R.bclr[i]) return true; return (R.flag[i] & 4 ? 1 : -1) !== side; };   // that side is busway
const pedW = (i) => Math.max(1.3, ROADS.sw[i] / 10 - 0.4);   // narrow footpaths: people spill onto the verge to pass
function pedPose(p) {   // on the footpath: side is in the road's drawn frame, lat runs across the footpath (0 kerb .. 1 outside)
  const RD = ROADS; roadAt(p.i, p.s, 1, p.side * (RD.hw[p.i] / 10 + 0.3 + p.lat * pedW(p.i)), p); p.hx *= p.dir; p.hz *= p.dir;
}
function footMasked(i, s, side) {   // footpath at s lies on another carriageway (a junction mouth, a slip road)?
  const RD = ROADS, p = RD.start[i], c = RD.lens[i], S = RD.S; let lo = 0, hi = c - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[p + m] <= s) lo = m; else hi = m; }
  const k = side > 0 ? 0 : 1; return (RD.pmask[(p + lo) * 2 + k] & 2) && (RD.pmask[(p + hi) * 2 + k] & 2);
}
function spawnPed(B, V, inside) {
  const RD = ROADS, P = PEDS;
  for (let tries = 0; tries < 10; tries++) {
    const x = B.x0 + Math.random() * (B.x1 - B.x0), z = B.z0 + Math.random() * (B.z1 - B.z0);
    if (!inside && inBox(V, x, z)) continue;
    const cell = RD.grid.get(Math.floor(x / RD.CELL) * 4096 + Math.floor(z / RD.CELL)); if (!cell) continue;
    const i = cell[(Math.random() * cell.length) | 0];
    if (RD.br[i] || RD.ghost[i] || RD.sw[i] < 6 || RD.cls[i] === 7 || Math.random() > 0.35 + RD.cls[i] * 0.08) continue;
    const len = RD.L[i]; if (len < 25) continue;
    const side = Math.random() < 0.5 ? 1 : -1, s = 4 + Math.random() * (len - 8);
    if (!pedSideOk(i, side) || footMasked(i, s, side)) continue;
    const lat = 0.2 + Math.random() * 0.6;
    const p = { i, dir: Math.random() < 0.5 ? 1 : -1, s, side, lat, pl: lat, v: 1.0 + Math.random() * 0.6, cv: 1.0, ph: Math.random() * 100, sc: 0.9 + Math.random() * 0.2,
      shirt: SHIRTS[(Math.random() * SHIRTS.length) | 0], pants: Math.random() < 0.25 ? null : PANTS[(Math.random() * PANTS.length) | 0],
      x: 0, y: 0, z: 0, hx: 1, hz: 0, rx: 1, rz: 0, mode: 0, cn: null, cd: 0, chk: Math.random() * 0.4, fa: inside ? 0 : 1, fade: 0 };
    pedPose(p);
    if (!inBox(B, p.x, p.z) || (!inside && inBox(V, p.x, p.z))) continue;
    let clash = false; for (const o of P.list) if ((o.x - p.x) ** 2 + (o.z - p.z) ** 2 < 1.0) { clash = true; break; }
    if (clash) continue;
    p.rx = p.hx; p.rz = p.hz; p.cv = p.v;
    pedAttrs(P.list.length, p); P.list.push(p); return p;
  }
  return null;
}
function pedNextRoad(p) {   // walked off the end of this footpath: carry on round the corner / across the mouth, or turn back
  const RD = ROADS, nx = nextRoad(p.i, p.dir, true);
  if (!nx) { p.dir = -p.dir; return; }
  const [j, d2] = nx, ts = p.side * p.dir, L2 = RD.L[j];
  const q = { i: j, dir: d2, s: d2 > 0 ? 0.3 : L2 - 0.3, side: ts * d2, lat: p.lat, x: 0, y: 0, z: 0, hx: 1, hz: 0 };
  pedPose(q);
  const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
  let run = 0; while (run < 20 && footMasked(j, q.s + d2 * (1 + run), q.side)) run += 2;   // its footpath starts across the mouth: fine if short
  if (d > 28 || run >= 20 || !pedSideOk(j, q.side)) { p.dir = -p.dir; return; }
  if (d < 0.4) { p.i = j; p.dir = d2; p.s = q.s; p.side = q.side; return; }
  p.mode = 2; p.cd = 0; p.wt = 0; p.cn = { ax: p.x, az: p.z, ay: p.y, bx: q.x, bz: q.z, by: q.y, L: d, j, d2, s: q.s, side: q.side };   // wait at the kerb
}
function segD2(ax, az, bx, bz, px, pz) { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1), ex = ax + dx * t - px, ez = az + dz * t - pz; return ex * ex + ez * ez; }
function segSeg2(ax, az, bx, bz, cx, cz, dx, dz) {   // squared distance between segments AB and CD
  const o = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const o1 = o(ax, az, bx, bz, cx, cz), o2 = o(ax, az, bx, bz, dx, dz), o3 = o(cx, cz, dx, dz, ax, az), o4 = o(cx, cz, dx, dz, bx, bz);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(segD2(ax, az, bx, bz, cx, cz), segD2(ax, az, bx, bz, dx, dz), segD2(cx, cz, dx, dz, ax, az), segD2(cx, cz, dx, dz, bx, bz));
}
function roadClear(c) {   // no vehicle on the crossing, or due to reach it within ~4 s
  if (!TRAF || !TRAF.shown) return true;
  const TT = TRAF, g0 = Math.floor((Math.min(c.ax, c.bx) - 30) / TR_CELL), g1 = Math.floor((Math.max(c.ax, c.bx) + 30) / TR_CELL);
  const h0 = Math.floor((Math.min(c.az, c.bz) - 30) / TR_CELL), h1 = Math.floor((Math.max(c.az, c.bz) + 30) / TR_CELL);
  for (let a = g0; a <= g1; a++) for (let b = h0; b <= h1; b++) for (let o = TT.H.get(hk(a, b)) ?? -1; o >= 0; o = TT.nxt[o]) {
    const d = TT.cars[o]; if (!d || d.dead) continue;
    const look = Math.min(30, d.v * 4 + d.len / 2 + 1);
    if (segSeg2(c.ax, c.az, c.bx, c.bz, d.x - d.hx * d.len / 2, d.z - d.hz * d.len / 2, d.x + d.hx * look, d.z + d.hz * look) < 2.6 * 2.6) return false;
  }
  return true;
}
function stepPeds(dt) {
  if (!PEDS) return false;
  const P = PEDS, RD = ROADS, show = view.mpp < 0.9 && VBOX;
  if (!show) { if (P.shown) { P.list.length = 0; P.cross.length = 0; P.im.count = 0; P.im.visible = false; P.shown = false; } return false; }
  if (!P.shown) { P.im.visible = true; P.shown = true; P.fill = true; }
  const V = VBOX, M = 30, B = { x0: V.x0 - M, x1: V.x1 + M, z0: V.z0 - M, z1: V.z1 + M };
  const want = clamp(Math.round((B.x1 - B.x0) * (B.z1 - B.z0) / 1e6 * 110), 60, 200), L = P.list;
  for (let k = L.length - 1; k >= 0; k--) {   // retire (swap the last walker into the freed slot)
    const p = L[k]; if (inBox(V, p.x, p.z, M + 30) && !(p.fade && p.fa <= 0)) continue;
    const last = L.pop(); if (k < L.length) { L[k] = last; pedAttrs(k, last); }
  }
  if (L.length >= want * 0.8) P.fill = false;
  const inside = P.fill || L.length < want * 0.3;
  for (let k = 0; k < 10 && L.length < want && L.length < PED_CAP; k++) spawnPed(B, V, inside);
  P.H.clear();
  for (let k = 0; k < L.length; k++) { const p = L[k], key = hk(Math.floor(p.x / PED_CELL), Math.floor(p.z / PED_CELL)); P.nxt[k] = P.H.get(key) ?? -1; P.H.set(key, k); }
  const arr = P.im.instanceMatrix.array;
  for (let k = 0; k < L.length; k++) {
    const p = L[k];
    if (p.fade) p.fa = Math.max(0, p.fa - dt * 1.5); else if (p.fa < 1) p.fa = Math.min(1, p.fa + dt * 1.5);
    // neighbours: push = wanted sideways speed (m/s, + = to my left); lead = distance to someone I must not walk into
    let push = 0, lead = 1e9, leadV = 0;
    const gx = Math.floor(p.x / PED_CELL), gz = Math.floor(p.z / PED_CELL);
    for (let a = gx - 1; a <= gx + 1; a++) for (let b = gz - 1; b <= gz + 1; b++) {
      for (let o = P.H.get(hk(a, b)) ?? -1; o >= 0; o = P.nxt[o]) {
        if (o === k) continue; const q = L[o];
        const rx = q.x - p.x, rz = q.z - p.z, d2 = rx * rx + rz * rz; if (d2 > 6.25) continue;
        const al = rx * p.hx + rz * p.hz, lat = rx * p.hz - rz * p.hx, hd = p.hx * q.hx + p.hz * q.hz, d = Math.sqrt(d2);
        if (al > 0 && al < 2.4 && Math.abs(lat) < 0.6) {
          if (hd < -0.2) push += lat > 0.05 ? -0.35 : 0.75;            // oncoming: keep left (or stay right of someone already on my left)
          else if (q.cv < p.cv - 0.05) { push -= 0.5; if (al < lead) { lead = al; leadV = q.cv; } }   // slower ahead: overtake on the right
          else if (al < lead) { lead = al; leadV = q.cv * Math.max(0, hd); }
        }
        if (d < 0.6 && d > 1e-4) { push -= (lat >= 0 ? 1 : -1) * (0.6 - d) * 4; if (al > 0 && al < lead) { lead = al; leadV = Math.min(leadV, q.cv * Math.max(0, hd)); } }
      }
    }
    if (p.mode === 0) {
      const w = pedW(p.i), dl = 1 / (p.side * p.dir * w);
      if (push === 0) p.lat += clamp(p.pl - p.lat, -0.12 * dt, 0.12 * dt); else p.lat += clamp(push, -0.8, 0.8) * dt * dl;
      p.lat = clamp(p.lat, 0.04, 0.96);
    }
    let tv = p.v; if (lead < 1.8) tv = Math.min(tv, Math.max(0, leadV + (lead - 0.75) * 0.9));
    p.cv += clamp(tv - p.cv, -2.5 * dt, 1.0 * dt);
    if (p.mode === 0) {
      p.s += p.cv * dt * p.dir;
      if ((p.chk -= dt) < 0) {   // a long stretch of footpath on another carriageway ahead: turn back instead
        p.chk = 0.4;
        p.onRoad = footMasked(p.i, p.s, p.side);
        if (footMasked(p.i, p.s + p.dir * 1.5, p.side)) { let run = 0; while (run < 18 && footMasked(p.i, p.s + p.dir * (1.5 + run), p.side)) run += 2; if (run >= 18) p.dir = -p.dir; }
      }
      const Lr = RD.L[p.i];
      if (p.s < 0 || p.s > Lr) { p.s = clamp(p.s, 0, Lr); pedNextRoad(p); }
      if (p.mode === 0) pedPose(p);
    }
    if (p.mode === 2) {   // at the kerb: cross when the road is clear (or after a long wait, when drivers will stop anyway)
      const c = p.cn; p.wt += dt; p.cv = 0; p.hx = (c.bx - c.ax) / c.L; p.hz = (c.bz - c.az) / c.L;
      if (p.wt > 0.6 && (roadClear(c) || p.wt > 14)) p.mode = 1;
    }
    if (p.mode === 1) {
      const c = p.cn; p.cd += p.cv * dt;
      if (p.cd >= c.L) { p.mode = 0; p.i = c.j; p.dir = c.d2; p.s = c.s; p.side = c.side; p.cn = null; pedPose(p); }
      else { const f = p.cd / c.L; p.x = c.ax + (c.bx - c.ax) * f; p.z = c.az + (c.bz - c.az) * f; p.y = c.ay + (c.by - c.ay) * f; p.hx = (c.bx - c.ax) / c.L; p.hz = (c.bz - c.az) / c.L; }
    }
    const kk = Math.min(1, dt * 9); p.rx += (p.hx - p.rx) * kk; p.rz += (p.hz - p.rz) * kk; const rl = Math.hypot(p.rx, p.rz) || 1; p.rx /= rl; p.rz /= rl;
    const f = p.fa, sc = p.sc * (f >= 1 ? 1 : 0.2 + 0.8 * f * f * (3 - 2 * f));
    putYaw(arr, k, p.x, p.y, p.z, p.rx, p.rz, sc);
  }
  P.cross.length = 0; for (const p of L) if (p.mode === 1 || (p.mode === 0 && p.onRoad)) P.cross.push(p);
  P.im.count = L.length; flushInst(P.im.instanceMatrix, L.length);
  if (P.adirty) { P.shirt.needsUpdate = true; P.pants.needsUpdate = true; P.ph.needsUpdate = true; P.adirty = false; }
  return true;
}
function stepStreet(dt) {
  updateSignalLamps(false);
  if (SIGS) { const sv = view.mpp < 3.2; SIGS.mesh.visible = sv; SIGS.lamps.visible = sv; }
  const a = stepTraffic(dt), b = stepPeds(dt), c = stepPlay();
  return a || b || c;
}

// ---------------------------------------------------------------- road works and construction sites
// Road works: on a few wide roads the kerb lane of one direction is dug up for ~40 m behind a taper of cones and
// barricades, with a sign ahead, an excavator, a spoil heap and two workers; traffic merges out of that lane.
// Construction sites: chosen in the data build (mid-size plots beside big roads); a concrete frame part-way up, brick
// infill on the lower floors, a tower crane, tin hoarding and material heaps.
let WORKS = [], WORKBY = new Map();
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function planWorks() {
  const RD = ROADS, rnd = seeded(7071), cand = [], picked = [];
  for (let i = 0; i < RD.n; i++) { const c = RD.cls[i]; if (c < 3 || c > 6 || c === 4 || RD.br[i] || (RD.flag[i] & 2) || RD.bclr[i] || RD.L[i] < 110) continue; cand.push(i); }
  for (let k = cand.length - 1; k > 0; k--) { const j = (rnd() * (k + 1)) | 0; [cand[k], cand[j]] = [cand[j], cand[k]]; }
  const P = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
  for (const i of cand) {
    if (WORKS.length >= 18) break;
    const dir = RD.flag[i] & 1 ? 1 : rnd() < 0.5 ? 1 : -1; if (laneCount(i, dir) < 2) continue;
    const L = RD.L[i]; roadAt(i, L / 2, 1, 0, P);
    if (picked.some(([x, z]) => (x - P.x) ** 2 + (z - P.z) ** 2 < 1300 * 1300)) continue;
    // keep clear of signal stop lines and junction mouths: the zone sits in the middle of the piece
    const len = Math.min(42, L * 0.3), s0 = (L - len) / 2, w = { i, dir, s0, s1: s0 + len, x: P.x, z: P.z };
    picked.push([P.x, P.z]); WORKS.push(w); WORKBY.set(i, w);
  }
}
function workZone(c) {   // [start, end] of the closed kerb lane ahead of / around car c in its travel distance, or null
  const w = WORKBY.get(c.i); if (!w || w.dir !== c.dir) return null;
  const L = ROADS.L[c.i]; return c.dir > 0 ? [w.s0, w.s1] : [L - w.s1, L - w.s0];
}
function buildWorks() {
  if (!WORKS.length) return;
  const G = new Geo(false), P = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
  const orange = C255(236, 98, 24), white = C255(238, 236, 230), dirt = C255(118, 96, 72), dark = C255(40, 40, 42), yellow = C255(238, 184, 36),
    glass = C255(40, 52, 60), skin = C255(150, 104, 76), vest = C255(250, 120, 20), helm = C255(250, 220, 40), pants = C255(46, 52, 74), grey = C255(120, 120, 116);
  const at = (w, s, off) => { roadAt(w.i, w.dir > 0 ? s : ROADS.L[w.i] - s, w.dir, off, P); return P; };   // s: distance along travel
  const cone = (x, z, y) => { cbox(G, x, z, 1, 0, 0.2, 0.2, y, y + 0.05, dark); cbox(G, x, z, 1, 0, 0.13, 0.13, y + 0.05, y + 0.32, orange); cbox(G, x, z, 1, 0, 0.1, 0.1, y + 0.32, y + 0.42, white); cbox(G, x, z, 1, 0, 0.07, 0.07, y + 0.42, y + 0.6, orange); };
  const worker = (x, z, y, hx, hz) => { cbox(G, x, z, hx, hz, 0.1, 0.17, y, y + 0.84, pants); cbox(G, x, z, hx, hz, 0.13, 0.22, y + 0.84, y + 1.42, vest); cbox(G, x, z, hx, hz, 0.1, 0.1, y + 1.42, y + 1.66, skin); cbox(G, x, z, hx, hz, 0.13, 0.13, y + 1.64, y + 1.76, helm); };
  for (const w of WORKS) {
    laneSpan(w.i, w.dir, _ls);
    const nl = laneCount(w.i, w.dir), lw = (_ls[1] - _ls[0]) / nl, kerb = _ls[1] - 0.35, edge = _ls[1] - lw - 0.05, mid = (kerb + edge) / 2;
    const L = ROADS.L[w.i], a0 = w.dir > 0 ? w.s0 : L - w.s1, a1 = w.dir > 0 ? w.s1 : L - w.s0;   // travel distances
    // dug strip
    for (let s = a0; s < a1 - 0.1; s += 3) { const e = Math.min(a1, s + 3); at(w, (s + e) / 2, mid); cbox(G, P.x, P.z, P.hx, P.hz, (e - s) / 2 + 0.05, Math.abs(kerb - edge) / 2 - 0.15, P.y, P.y + 0.035, dirt, true); }
    // cone taper in, cone line along the open lane, taper back out
    for (let s = a0 - 16; s <= a1 + 6; s += 2.4) {
      const off = s < a0 ? kerb + (edge - kerb) * (s - (a0 - 16)) / 16 : s > a1 ? edge + (kerb - edge) * (s - a1) / 6 : edge;
      at(w, s, off); cone(P.x, P.z, P.y);
    }
    // barricade boards across the closed lane at both ends (striped), sign ahead on the kerb
    for (const s of [a0 - 1, a1 + 1]) {
      at(w, s, mid); const vx = -P.hz, vz = P.hx, half = Math.abs(kerb - edge) / 2 - 0.2;
      for (const sg of [-1, 1]) cbox(G, P.x + vx * sg * half, P.z + vz * sg * half, P.hx, P.hz, 0.06, 0.06, P.y, P.y + 1.0, grey);
      for (let k = 0; k < 6; k++) { const f = -half + (k + 0.5) * (2 * half / 6); cbox(G, P.x + vx * f, P.z + vz * f, P.hx, P.hz, 0.04, half / 6, P.y + 0.62, P.y + 0.92, k % 2 ? white : orange); }
    }
    at(w, a0 - 34, _ls[1] + 0.6); cbox(G, P.x, P.z, P.hx, P.hz, 0.05, 0.05, P.y, P.y + 1.9, grey);
    cbox(G, P.x - P.hx * 0.06, P.z - P.hz * 0.06, P.hx, P.hz, 0.03, 0.5, P.y + 1.6, P.y + 2.5, yellow);
    // excavator, spoil heap, workers
    const xm = (a0 + a1) / 2; at(w, xm, mid); const ex = P.x, ez = P.z, ey = P.y, hx = P.hx, hz = P.hz, vx = -hz, vz = hx;
    cbox(G, ex, ez, hx, hz, 1.8, 1.1, ey, ey + 0.6, dark);
    cbox(G, ex, ez, hx, hz, 1.5, 1.0, ey + 0.6, ey + 1.5, yellow);
    cbox(G, ex + hx * 0.5 + vx * 0.4, ez + hz * 0.5 + vz * 0.4, hx, hz, 0.6, 0.5, ey + 1.5, ey + 2.6, glass);
    cbox(G, ex + hx * 2.6, ez + hz * 2.6, hx, hz, 1.3, 0.18, ey + 2.2, ey + 2.6, yellow);
    cbox(G, ex + hx * 3.8, ez + hz * 3.8, hx, hz, 0.18, 0.18, ey + 0.8, ey + 2.4, yellow);
    cbox(G, ex + hx * 3.9, ez + hz * 3.9, hx, hz, 0.35, 0.45, ey + 0.35, ey + 0.85, dark);
    at(w, xm - 9, mid); cbox(G, P.x, P.z, P.hx, P.hz, 2.2, Math.abs(kerb - edge) / 2 - 0.4, P.y, P.y + 0.55, dirt); cbox(G, P.x, P.z, P.hx, P.hz, 1.2, Math.abs(kerb - edge) / 2 - 0.9, P.y + 0.55, P.y + 0.95, dirt);
    at(w, xm + 7, mid + 0.5); worker(P.x, P.z, P.y, P.hx, P.hz);
    at(w, xm - 4, mid - 0.4); worker(P.x, P.z, P.y, -P.hz, P.hx);
  }
  const m = G.mesh(POLX); m.castShadow = false; m.receiveShadow = true; group.ground.add(m); WORKS.mesh = m;
}
function buildSites() {
  const S = META.sites; if (!S || !S.length) return;
  const G = new Geo(false);
  const conc = C255(196, 192, 182), concD = C255(160, 156, 148), brick = C255(178, 98, 70), steel = C255(70, 70, 72), yellow = C255(240, 186, 30),
    tin = C255(44, 96, 168), tinW = C255(232, 232, 228), sand = C255(206, 172, 120), net = C255(52, 120, 70), glass = C255(40, 52, 60), red = C255(196, 40, 30);
  for (const [x, z, ux, uz, W, D, fl, sd] of S) {
    const vx = -uz, vz = ux, F = (a, b) => [x + ux * a + vx * b, z + uz * a + vz * b], hw = W / 2 - 3, hd = D / 2 - 3;
    const built = Math.max(2, Math.round(fl * (0.3 + 0.6 * sd))), FH = 3.2, top = built * FH;
    // tin hoarding round the plot, with a gate gap on the long front
    for (const [a0, b0, a1, b1] of [[-W / 2, -D / 2, W / 2, -D / 2], [W / 2, -D / 2, W / 2, D / 2], [W / 2, D / 2, 3, D / 2], [-3 - 3, D / 2, -W / 2, D / 2], [-W / 2, D / 2, -W / 2, -D / 2]]) {
      const [px, pz] = F((a0 + a1) / 2, (b0 + b1) / 2), L = Math.hypot(a1 - a0, b1 - b0); if (L < 0.5) continue;
      const dx = (ux * (a1 - a0) + vx * (b1 - b0)) / L, dz = (uz * (a1 - a0) + vz * (b1 - b0)) / L;
      cbox(G, px, pz, dx, dz, L / 2, 0.05, 0, 2.3, tin); cbox(G, px, pz, dx, dz, L / 2, 0.06, 2.3, 2.45, tinW);
    }
    // columns, slabs, brick infill below the working floors, a green safety net on the top floors' long face
    const nx = Math.max(2, Math.round(2 * hw / 6) + 1), nz = Math.max(2, Math.round(2 * hd / 6) + 1);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const [px, pz] = F(-hw + 2 * hw * i / (nx - 1), -hd + 2 * hd * j / (nz - 1));
      cbox(G, px, pz, ux, uz, 0.28, 0.28, 0, top + 1.4, i % 2 ? conc : concD);
    }
    for (let f = 1; f <= built; f++) {
      const [px, pz] = F(0, 0), part = f === built ? 0.55 : 1;
      const [qx, qz] = F(-hw * (1 - part), 0);
      cbox(G, qx, qz, ux, uz, hw * part + 0.3, hd + 0.3, f * FH - 0.25, f * FH, conc);
      if (f <= built - 2) for (const sg of [-1, 1]) {
        const [bx, bz] = F(0, sg * hd); cbox(G, bx, bz, ux, uz, hw, 0.12, (f - 1) * FH, f * FH - 0.25, brick);
        const [cx2, cz2] = F(sg * hw, 0); cbox(G, cx2, cz2, vx, vz, hd, 0.12, (f - 1) * FH, f * FH - 0.25, brick);
      }
      if (f > built - 2) { const [nxp, nzp] = F(0, hd + 0.5); cbox(G, nxp, nzp, ux, uz, hw + 0.4, 0.04, (f - 1) * FH, f * FH, net); }
    }
    // tower crane beside the frame: mast, slewing jib (angle varies by site), counter-jib with weights, cab, hook
    const [mx, mz] = F(-W / 2 - 3.5, -D / 2 + 4), mh = top + 16, ang = sd * Math.PI * 2, jx = Math.cos(ang), jz = Math.sin(ang), jl = Math.max(W, D) * 1.05;
    cbox(G, mx, mz, 1, 0, 2.2, 2.2, 0, 0.8, concD);
    for (let y = 0.8; y < mh; y += 4) cbox(G, mx, mz, 1, 0, 0.8, 0.8, y, Math.min(mh, y + 3.6), yellow);
    cbox(G, mx, mz, jx, jz, 0.9, 0.9, mh, mh + 2.2, yellow); cbox(G, mx + jx * 0.4 - jz * 1.2, mz + jz * 0.4 + jx * 1.2, jx, jz, 0.7, 0.5, mh + 0.2, mh + 1.8, glass);
    cbox(G, mx + jx * jl / 2, mz + jz * jl / 2, jx, jz, jl / 2, 0.5, mh + 1.4, mh + 2.3, yellow);
    cbox(G, mx - jx * 6, mz - jz * 6, jx, jz, 6, 0.5, mh + 1.4, mh + 2.3, yellow);
    cbox(G, mx - jx * 10, mz - jz * 10, jx, jz, 1.4, 0.9, mh - 0.4, mh + 1.4, concD);
    cbox(G, mx, mz, 1, 0, 0.3, 0.3, mh + 2.2, mh + 6.5, yellow); cbox(G, mx, mz, 1, 0, 0.18, 0.18, mh + 6.5, mh + 6.9, red);
    const hk = jl * (0.45 + 0.4 * ((sd * 7) % 1)), hx = mx + jx * hk, hz2 = mz + jz * hk;
    cbox(G, hx, hz2, 1, 0, 0.03, 0.03, top + 6, mh + 1.4, steel); cbox(G, hx, hz2, 1, 0, 0.35, 0.35, top + 5.2, top + 6, yellow);
    // sand and aggregate heaps, a rebar bundle
    const [sx, sz] = F(W / 2 - 4, D / 2 - 1.8); cbox(G, sx, sz, ux, uz, 2.0, 1.2, 0, 0.6, sand); cbox(G, sx, sz, ux, uz, 1.1, 0.7, 0.6, 1.0, sand);
    const [rx, rz] = F(-W / 2 + 6, D / 2 - 1.4); cbox(G, rx, rz, ux, uz, 3.5, 0.35, 0, 0.3, steel);
  }
  const m = G.mesh(POLX); m.castShadow = true; m.receiveShadow = true; group.ground.add(m);
}

// ---------------------------------------------------------------- Gyaspur depot (yard fan, stabled trains) and at-grade track
function railRun(G, pts, y, ballast, steel) {   // pts: [x,z,...] centreline of one track laid at grade
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L, mx = (ax + bx) / 2, mz = (az + bz) / 2, vx = -uz, vz = ux;
    cbox(G, mx, mz, ux, uz, L / 2 + 0.05, 1.5, y, y + 0.22, ballast, true);
    for (const g of [-0.7175, 0.7175]) cbox(G, mx + vx * g, mz + vz * g, ux, uz, L / 2 + 0.03, 0.035, y + 0.22, y + 0.36, steel, true);
  }
}
// ---------------------------------------------------------------- industry: stacks, process tanks, effluent tanks, smoke
let IND = null;
const stackMat = hook(new THREE.MeshLambertMaterial({ color: '#ffffff' }), {
  vHead: 'attribute float iLook; varying float vLook; varying float vV;', vBody: 'vLook = iLook; vV = position.y;',
  fHead: 'varying float vLook; varying float vV;',
  fColor: `int LK = int(vLook + 0.5);
  vec3 c = LK == 1 ? vec3(0.40, 0.15, 0.09) * (0.88 + 0.16 * step(0.5, fract(vWPos.y * 3.2))) : LK == 2 ? vec3(0.62, 0.61, 0.58) : vec3(0.40, 0.41, 0.43);
  if (LK == 2) { float b = step(0.84, vV) * step(0.5, fract((vV - 0.84) / 0.032 * 0.5)); c = mix(c, vec3(0.62, 0.05, 0.03), b); }
  else c *= 0.92 + 0.12 * step(0.5, fract(vWPos.y / 3.0));       // weld seams / brick lifts
  c = mix(c, vec3(0.03), smoothstep(0.90, 1.0, vV) * 0.85);      // soot round the mouth
  diffuseColor.rgb = c;
  if (LK == 2 && vV > 0.975) xEm = vec3(1.0, 0.05, 0.02) * 2.5 * uNight * step(0.5, fract(uTime * 0.6));`,
});
const smokeMat = new THREE.ShaderMaterial({
  uniforms: U, transparent: true, depthWrite: false,
  vertexShader: `attribute vec3 aSrc; attribute vec4 aPar;
  uniform float uTime; uniform float uMpp; uniform vec2 uWind;
  varying vec2 vUv; varying float vA; varying float vK; varying float vSeed;
  void main() {
    float kind = aPar.x, ph = aPar.y, kk = aPar.z, sc = aPar.w;
    vec3 c; float size, alpha;
    if (kind < 3.5) {
      bool pw = kind > 2.5, tx = kind > 0.5 && kind < 1.5;
      float a = fract(uTime * (pw ? 0.045 : 0.07) + kk + ph);
      float rise = pw ? 75.0 : tx ? 24.0 : 19.0, drift = pw ? 320.0 : tx ? 95.0 : 100.0;
      float jit = fract(sin(kk * 91.7 + ph * 13.1) * 43758.5) - 0.5;
      float wob = (sin(uTime * 0.55 + ph * 40.0 + kk * 9.0) * (pw ? 14.0 : 5.0) + jit * (pw ? 40.0 : 14.0)) * a;
      vec2 d = uWind * drift * a * (0.45 + 0.55 * a) + vec2(-uWind.y, uWind.x) * wob;
      c = vec3(aSrc.x + d.x, aSrc.y + rise * (1.0 - pow(1.0 - a, 2.4)), aSrc.z + d.y);
      size = sc * (1.3 + (pw ? 20.0 : tx ? 9.0 : 10.0) * a);
      alpha = smoothstep(0.0, 0.04, a) * pow(1.0 - a, tx ? 1.25 : 0.85);
    } else {   // haze over the estate: slow, broad, only from a distance
      float a = fract(uTime * 0.005 + ph);
      vec2 d = uWind * (a - 0.5) * 180.0;
      c = vec3(aSrc.x + d.x, aSrc.y, aSrc.z + d.y);
      size = sc * clamp(uMpp / 2.5, 1.0, 3.2); alpha = sin(3.14159 * a) * smoothstep(0.35, 1.6, uMpp);
    }
    if (alpha < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }   // fully faded: no fill cost
    vec4 mv = viewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy; vA = alpha; vK = kind; vSeed = ph * 31.0 + kk * 7.0;
  }`,
  fragmentShader: NOISE + `varying vec2 vUv; varying float vA; varying float vK; varying float vSeed;
  void main() {
    int K = int(vK + 0.5);
    // chemical units: grey-brown; dye-house boilers on coal / lignite: near black; workshops: light grey; the power
    // station: white-grey; estate haze: a dull grey wash that takes the colour out of the ground
    vec3 col = K == 0 ? vec3(0.30, 0.29, 0.26) : K == 1 ? vec3(0.05, 0.05, 0.055) : K == 2 ? vec3(0.55, 0.55, 0.56) : K == 3 ? vec3(0.90, 0.90, 0.91) : vec3(0.36, 0.35, 0.34);
    float base = K == 0 ? 0.85 : K == 1 ? 0.72 : K == 2 ? 0.55 : K == 3 ? 0.85 : 0.18;
    float r = length(vUv) * 2.0, n = vnoise(vUv * 2.6 + vSeed) * 0.65 + vnoise(vUv * 5.3 + vSeed * 1.7) * 0.35;
    float a = (1.0 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.6)) * vA * base;
    if (a < 0.004) discard;
    col *= (0.82 + 0.36 * (vUv.y + 0.5)) * (0.75 + 0.5 * n);
    col = mix(col * vec3(0.30, 0.30, 0.36) + vec3(0.025, 0.02, 0.015), col, uDay) * mix(vec3(1.0), uSunCol, 0.5);
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`,
});
function buildIndustry() {
  const D = META.industry; if (!D) return;
  IND = { stacks: null, tanks: null, ponds: [], smoke: null };
  // stacks: tapered, open-topped; steel, brick or banded concrete
  const sg = new THREE.CylinderGeometry(0.72, 1.0, 1, 10, 1, true); sg.translate(0, 0.5, 0);
  const st = D.stacks, look = new Float32Array(st.length);
  const im = new THREE.InstancedMesh(sg, stackMat, st.length);
  st.forEach(([x, z, b, h, r, k, a, lk], i) => { _p.set(x, b, z); _q.identity(); _s.set(r, h, r); _m.compose(_p, _q, _s); im.setMatrixAt(i, _m); look[i] = lk; });
  sg.setAttribute('iLook', new THREE.InstancedBufferAttribute(look, 1));
  im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); group.ground.add(im); IND.stacks = im;
  // process / solvent tanks
  const tg = new THREE.CylinderGeometry(1, 1, 1, 14); tg.translate(0, 0.5, 0);
  const TCOL = ['#d9d6cf', '#a9adb1', '#8a5a3c', '#9fb6c8'].map((h) => new THREE.Color(h));
  const tk = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, D.tanks.length));
  D.tanks.forEach(([x, z, r, h, c], i) => { _p.set(x, 0, z); _q.identity(); _s.set(r, h, r); _m.compose(_p, _q, _s); tk.setMatrixAt(i, _m); tk.setColorAt(i, TCOL[c]); });
  tk.count = D.tanks.length; tk.castShadow = true; tk.receiveShadow = true; tk.computeBoundingSphere(); group.ground.add(tk); IND.tanks = tk;
  // effluent tanks: a concrete box brim-full of whatever the dye house ran that day
  const n = Math.max(1, D.ponds.length);
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const wat = new THREE.PlaneGeometry(1, 1); wat.rotateX(-Math.PI / 2);
  const pb = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: '#b9b4a8' }), n), pw = new THREE.InstancedMesh(wat, new THREE.MeshLambertMaterial({ color: '#ffffff' }), n);
  const WCOL = ['#2a2363', '#5a1020', '#1d3a26', '#4a3416'].map((h) => new THREE.Color(h));
  D.ponds.forEach(([x, z, ux, uz, w, d, c], i) => {
    _e.set(0, Math.atan2(-uz, ux), 0); _q.setFromEuler(_e);
    _p.set(x, 0, z); _s.set(w, 0.9, d); _m.compose(_p, _q, _s); pb.setMatrixAt(i, _m);
    _p.set(x, 0.92, z); _s.set(w - 0.5, 1, d - 0.5); _m.compose(_p, _q, _s); pw.setMatrixAt(i, _m); pw.setColorAt(i, WCOL[c]);
  });
  pb.count = pw.count = D.ponds.length;
  for (const m of [pb, pw]) { m.receiveShadow = true; m.castShadow = m === pb; m.computeBoundingSphere(); group.ground.add(m); IND.ponds.push(m); }
  // smoke: every particle's path is computed on the GPU from the clock, so it costs no JS per frame
  const act = st.filter((s) => s[6]), haze = D.haze, NP = (k) => (k === 3 ? 26 : 16);
  let N = haze.length * 3; for (const s of act) N += NP(s[5]);
  const src = new Float32Array(N * 3), par = new Float32Array(N * 4); let q = 0;
  for (const [x, z, b, h, r, k] of act) {
    const ph = hash1(x * 0.37 + z * 0.11), np = NP(k);
    for (let j = 0; j < np; j++) { src.set([x, b + h, z], q * 3); par.set([k, ph, j / np, k === 3 ? r * 2.4 : Math.max(2.2, r * 3.2)], q * 4); q++; }
  }
  for (const [x, z] of haze) for (let j = 0; j < 3; j++) { src.set([x + (j - 1) * 50, 22 + 12 * j, z], q * 3); par.set([4, hash1(x + z * 3 + j * 7.7), 0, 190 + 60 * j], q * 4); q++; }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('aSrc', new THREE.InstancedBufferAttribute(src, 3)); g.setAttribute('aPar', new THREE.InstancedBufferAttribute(par, 4));
  g.instanceCount = q;
  const sm = new THREE.Mesh(g, smokeMat); sm.frustumCulled = false; sm.renderOrder = 40; group.ground.add(sm); IND.smoke = sm;
  STATS.smoke = q;
}

function buildDepot(M, pre) {
  const D = M.depot; if (!D) return;
  const G = new Geo(false), ballast = C255(146, 136, 124), steel = C255(84, 80, 76);
  // the at-grade end of the depot line (the viaduct stops where the rail level comes down to the ground)
  for (const C of M.corr) {
    const P = C.pts, n = P.length / 2; if (n < 2) continue;
    const [N] = lnormals(P);
    for (const sg of [1, -1]) {
      let run = [];
      const flush = () => { if (run.length >= 4) railRun(G, run, 0.02, ballast, steel); run = []; };
      for (let j = 0; j < n; j++) {
        if (C.ug[j] || C.rl[j] >= 1.3) { flush(); continue; }
        run.push(P[j * 2] + N[j * 2] * TRACK * sg, P[j * 2 + 1] + N[j * 2 + 1] * TRACK * sg);
      }
      flush();
    }
  }
  // yard: each running line feeds a ladder of five stabling roads (turnouts in sequence, 1:3.5 diagonals), all ten
  // roads straight for the last ~80 m into the shed's open face; a scissors crossover just outside the throat lets a
  // train on either running line reach any road
  const [fx, fz] = D.face, [ux, uz] = D.u, vx = -uz, vz = ux;
  const W = (pt) => [fx + ux * pt[0] + vx * pt[1], fz + uz * pt[0] + vz * pt[1]];
  const FR = (x, z) => [(x - fx) * ux + (z - fz) * uz, (x - fx) * vx + (z - fz) * vz];
  const RC = M.corr.find((C) => C.k === 'red'), RP = RC.pts, [RN] = lnormals(RP);
  const runEnd = [1, -1].map((sg) => FR(RP[0] + RN[0] * TRACK * sg, RP[1] + RN[1] * TRACK * sg));
  runEnd.sort((p, q) => q[1] - p[1]);                       // [higher lateral, lower lateral]
  const lM = (runEnd[0][1] + runEnd[1][1]) / 2, tracks = [];
  for (let k = 0; k < 10; k++) tracks.push(clamp(lM + (k - 4.5) * 4.6, -D.W / 2 + 6, D.W / 2 - 6));
  for (const [g, ks] of [[0, [5, 6, 7, 8, 9]], [1, [4, 3, 2, 1, 0]]]) {
    const [aR, lR] = runEnd[g];
    ks.forEach((k, j) => {
      const L = tracks[k], dv = Math.abs(L - lR), aj = aR - 8 - 7 * j, ad = aj - Math.max(2, dv * 3.5);
      railRun(G, [[aR, lR], [aj, lR], [ad, L], [-2, L]].flatMap((p) => W(p)), 0.02, ballast, steel);
    });
  }
  {   // scissors crossover between the running lines, 12-40 m out from the throat
    const S = corridorS(RC), at = (sv, v) => { let j = 0; while (j < S.length - 2 && S[j + 1] < sv) j++; const f = (sv - S[j]) / Math.max(1e-6, S[j + 1] - S[j]);
      const x = RP[j * 2] + (RP[j * 2 + 2] - RP[j * 2]) * f, z = RP[j * 2 + 1] + (RP[j * 2 + 3] - RP[j * 2 + 1]) * f, nx = RN[j * 2] + (RN[j * 2 + 2] - RN[j * 2]) * f, nz = RN[j * 2 + 1] + (RN[j * 2 + 3] - RN[j * 2 + 1]) * f;
      return [x + nx * v, z + nz * v]; };
    for (const [vA, vB] of [[TRACK, -TRACK], [-TRACK, TRACK]]) {
      const pts = []; for (let q = 0; q <= 12; q++) { const u = q / 12, e = u * u * (3 - 2 * u); pts.push(...at(12 + 28 * u, vA + (vB - vA) * e)); }
      railRun(G, pts, 0.02, ballast, steel);
    }
  }
  // shed doors: a dark opening over every road
  for (const L of tracks) { const [x, z] = W([0.2, L]); cbox(G, x, z, ux, uz, 0.25, 2.2, 0, 5.2, C255(40, 42, 44), true); }
  const m = G.mesh(POLX); m.castShadow = false; m.receiveShadow = true; group.ground.add(m);
  // stabled trains (three cars) on the straight ends of some roads
  const im = new THREE.InstancedMesh(carGeo(), TRAINMAT, 15), col = new THREE.Color(COLS.red); let c = 0;
  for (const k of [1, 3, 4, 6, 8]) for (let q = 0; q < 3; q++) {
    const [x, z] = W([10 + 11.3 + q * 22.6 + (k % 2) * 6, tracks[k]]);
    putYaw(im.instanceMatrix.array, c, x, 0.38, z, ux, uz, 1); im.setColorAt(c, col); c++;
  }
  im.count = c; im.castShadow = true; im.receiveShadow = true; group.ground.add(im);
}

// ---------------------------------------------------------------- rooftop life: washing lines, people, plastic chairs
const CLOTH_COLS = ['#d0262e', '#f2b705', '#f07d1a', '#1e63c8', '#2f9a55', '#e85a9a', '#f4f1ea', '#7a3fb2', '#16a3a3', '#b8322a'].map(lin);
function personBox(G, x, z, y, ux, uz, shirt, pants, skin, seated) {
  const vx = -uz, vz = ux;
  if (seated) {
    cbox(G, x + ux * 0.15, z + uz * 0.15, ux, uz, 0.25, 0.16, y + 0.42, y + 0.56, pants, true);                  // thighs
    cbox(G, x + ux * 0.4, z + uz * 0.4, ux, uz, 0.07, 0.15, y, y + 0.44, pants, true);                          // shins
    cbox(G, x - ux * 0.08, z - uz * 0.08, ux, uz, 0.11, 0.19, y + 0.56, y + 1.12, shirt, true);                  // torso
    cbox(G, x - ux * 0.08, z - uz * 0.08, ux, uz, 0.1, 0.09, y + 1.12, y + 1.36, skin, true);                   // head
  } else {
    cbox(G, x, z, ux, uz, 0.08, 0.15, y, y + 0.84, pants, true);
    cbox(G, x, z, ux, uz, 0.11, 0.2, y + 0.84, y + 1.42, shirt, true);
    cbox(G, x, z, ux, uz, 0.1, 0.09, y + 1.42, y + 1.68, skin, true);
    cbox(G, x + ux * 0.18 + vx * 0.2, z + uz * 0.18 + vz * 0.2, ux, uz, 0.05, 0.05, y + 1.2, y + 1.85, skin, true);   // arm up to the line
  }
}
function rooftopLife(ch, X, Z, Y, T, RO, SC, n) {
  const G = new Geo(false), pole = C255(120, 120, 118), line = C255(40, 40, 40), chairW = C255(236, 236, 232), chairR = C255(180, 40, 36), skin = C255(150, 104, 76);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (T[i] !== 3) continue;   // only on terraces the pipeline marked: a stair room with a door to come out of, layout clear of the parapet
    const th = (RO[i] / 255) * Math.PI, ux = Math.cos(th), uz = -Math.sin(th), vx = -uz, vz = ux;
    const x = X[i] * 0.1, z = Z[i] * 0.1, y = Y[i] * 0.1, sd = hash1(i * 7 + 3);
    // washing line in front of the stair-room door
    const cx = x + ux * 3.2, cz = z + uz * 3.2;
    for (const s of [-1.3, 1.3]) cbox(G, cx + vx * s, cz + vz * s, ux, uz, 0.03, 0.03, y, y + 1.75, pole, true);
    cbox(G, cx, cz, vx, vz, 1.3, 0.012, y + 1.72, y + 1.74, line, true);
    const nc = 3 + Math.floor(sd * 3);
    for (let k = 0; k < nc; k++) {
      const f = -1.05 + (k + 0.5) * 2.1 / nc, w = 0.18 + hash1(i + k * 5) * 0.14, hh = 0.45 + hash1(i * 3 + k) * 0.5;
      cbox(G, cx + vx * f, cz + vz * f, vx, vz, w, 0.015, y + 1.72 - hh, y + 1.72, CLOTH_COLS[Math.floor(hash1(i * 11 + k * 7) * CLOTH_COLS.length)], true);
    }
    const sh = CLOTH_COLS[Math.floor(sd * 10) % CLOTH_COLS.length];
    personBox(G, cx + ux * 0.45 + vx * (sd - 0.5) * 1.6, cz + uz * 0.45 + vz * (sd - 0.5) * 1.6, y, -ux, -uz, sh, C255(46, 52, 74), skin, false);
    // a plastic chair and somebody sitting out on half of them
    if (sd > 0.45) {
      const px = x - ux * 3.0 + vx * 1.2, pz = z - uz * 3.0 + vz * 1.2, cc = sd > 0.75 ? chairR : chairW;
      cbox(G, px, pz, ux, uz, 0.24, 0.24, y + 0.4, y + 0.45, cc, true);
      cbox(G, px - ux * 0.24, pz - uz * 0.24, ux, uz, 0.03, 0.24, y + 0.45, y + 0.95, cc, true);
      for (const [a, b] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) cbox(G, px + ux * a + vx * b, pz + uz * a + vz * b, ux, uz, 0.02, 0.02, y, y + 0.42, cc, true);
      personBox(G, px + ux * 0.02, pz + uz * 0.02, y, ux, uz, CLOTH_COLS[Math.floor(sd * 37) % CLOTH_COLS.length], C255(60, 58, 64), skin, true);
    }
    any = true;
  }
  if (!any) return null;
  const m = G.mesh(POLX); m.position.set(ch.ox, 0, ch.oz); m.castShadow = true; m.receiveShadow = true; m.renderOrder = 10; m.geometry.computeBoundingSphere();
  return m;
}

// ---------------------------------------------------------------- kids playing street cricket in the parks
let PLAY = null;
function initPlay() {
  const S = META.play; if (!S || !S.length || !PEDS) return;
  const geo = PEDS.im.geometry, MAXK = S.length * 9;
  const shirt = new THREE.InstancedBufferAttribute(new Float32Array(MAXK * 3), 3), pants = new THREE.InstancedBufferAttribute(new Float32Array(MAXK * 3), 3), ph = new THREE.InstancedBufferAttribute(new Float32Array(MAXK), 1);
  const g2 = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color', 'aR']) if (geo.attributes[k]) g2.setAttribute(k, geo.attributes[k]);
  g2.setIndex(geo.index); g2.setAttribute('iShirt', shirt); g2.setAttribute('iPants', pants); g2.setAttribute('iPhase', ph);
  const im = new THREE.InstancedMesh(g2, PEDMAT, MAXK); im.count = 0; im.frustumCulled = false; im.castShadow = false; im.renderOrder = 10; im.visible = false;
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.ground.add(im);
  // pitch, stumps and bats: one static mesh
  const G = new Geo(false), dirt = C255(176, 150, 112), wood = C255(214, 190, 140);
  const kids = [];
  S.forEach(([x, z, ux, uz, sd], pi) => {
    const vx = -uz, vz = ux, P = (a, b) => [x + ux * a + vx * b, z + uz * a + vz * b];
    cbox(G, x, z, ux, uz, 10.5, 1.4, 0.02, 0.05, dirt, true);
    for (const e of [-9.5, 9.5]) for (const b of [-0.1, 0, 0.1]) { const [sx, sz] = P(e, b); cbox(G, sx, sz, ux, uz, 0.02, 0.02, 0.05, 0.75, wood, true); }
    // roles: bowler (runs in, back), batsman (shuffles), keeper, fielders jogging small loops, two kids running round
    const roles = [['bowl', 6], ['bat', -8.6], ['keep', -11.2], ['field', 0], ['field', 0], ['field', 0], ['field', 0], ['run', 0], ['run', 0]];
    roles.forEach(([r, a0], k) => {
      const ang = (k * 2.399 + sd * 6.28), rad = 7 + (k % 3) * 3.5;
      kids.push({ pi, r, x, z, ux, uz, a0, cx: r === 'field' ? Math.cos(ang) * rad * 1.2 : 0, cz: r === 'field' ? Math.sin(ang) * rad * 0.8 : 0,
        rad: r === 'run' ? 9 + k : 1.2 + (k % 2), ph: sd * 40 + k * 3.1, sp: 0.6 + ((k * 0.37 + sd) % 0.5),
        shirt: SHIRTS[(k * 5 + pi) % SHIRTS.length], pants: PANTS[(k + pi * 3) % PANTS.length] });
    });
  });
  const m = G.mesh(POLX); m.castShadow = false; m.receiveShadow = true; group.ground.add(m);
  PLAY = { im, kids, shirt, pants, phA: ph, deco: m, set: false };
}
function stepPlay() {
  const P = PLAY; if (!P) return false;
  const show = view.mpp < 0.9 && VBOX; P.im.visible = show; P.deco.visible = view.mpp < 2.6; if (!show) return false;
  const t = U.uTime.value, arr = P.im.instanceMatrix.array, V = VBOX; let c = 0;
  for (const k of P.kids) {
    if (!inBox(V, k.x, k.z, 40)) continue;
    let a, b, hx, hz;
    if (k.r === 'bowl') { const u = (t * 0.16 + k.ph) % 1, f = u < 0.5 ? u * 2 : 2 - u * 2; a = k.a0 + 8 * f; b = 0.6; hx = u < 0.5 ? 1 : -1; hz = 0; }   // walks back, runs in
    else if (k.r === 'bat') { a = k.a0 + Math.sin(t * 1.3 + k.ph) * 0.25; b = 0.5; hx = 1; hz = 0; }
    else if (k.r === 'keep') { a = k.a0 + Math.sin(t * 0.9 + k.ph) * 0.2; b = Math.sin(t * 0.7 + k.ph) * 0.4; hx = 1; hz = 0; }
    else { const w = t * k.sp / k.rad + k.ph; a = k.cx + Math.cos(w) * k.rad; b = k.cz + Math.sin(w) * k.rad * 0.7; hx = -Math.sin(w); hz = Math.cos(w) * 0.7; }
    const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
    const vx = -k.uz, vz = k.ux, x = k.x + k.ux * a + vx * b, z = k.z + k.uz * a + vz * b;
    const wx = k.ux * hx + vx * hz, wz = k.uz * hx + vz * hz;   // heading from the pitch frame to the world
    putYaw(arr, c, x, 0.05, z, wx, wz, 0.72);
    if (!P.set) { P.shirt.setXYZ(c, k.shirt.r, k.shirt.g, k.shirt.b); P.pants.setXYZ(c, k.pants.r, k.pants.g, k.pants.b); P.phA.setX(c, k.ph); }
    c++;
  }
  // instance slots follow the visible kids: refresh their colours whenever the visible set changes
  const sig = c * 7919 + Math.round(V.x0 / 50) * 31 + Math.round(V.z0 / 50);
  if (sig !== P.sig) { P.sig = sig; let q = 0; for (const k of P.kids) { if (!inBox(V, k.x, k.z, 40)) continue; P.shirt.setXYZ(q, k.shirt.r, k.shirt.g, k.shirt.b); P.pants.setXYZ(q, k.pants.r, k.pants.g, k.pants.b); P.phA.setX(q, k.ph); q++; } P.shirt.needsUpdate = P.pants.needsUpdate = P.phA.needsUpdate = true; }
  P.im.count = c; flushInst(P.im.instanceMatrix, c);
  return c > 0;
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), lastRender = 0, ready = false, simAcc = 0, liveLvl = 0;
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
    const Q = visibleQuad(); setViewBox(Q);
    updateSunDir(); updateLOD(Q); fitShadow(Q); updateLabels(); drawRadar(Q);
    whereDirty = true;
  }
  const built = runQueue(dirty ? 6 : 12);
  if (whereDirty) {
    const [x, z] = mouse.in && !drag ? screenToGround(mouse.x, mouse.y) : [view.tx, view.tz];
    updateWhere(x, z); whereDirty = false;
  }
  // while nothing is being dragged the scene redraws at a capped rate: ~30 fps with traffic on screen, ~20 fps with
  // trains / buses, ~12-15 fps otherwise. Vehicles and people only step on frames that are drawn.
  U.uFlow.value = smoothstep(1.3, 1.75, view.mpp) * (1 - smoothstep(6, 9, view.mpp));
  const idle = now - lastInteract > 1500 && todT >= 1;
  const minGap = idle ? (liveLvl === 2 ? 33 : liveLvl === 1 ? 50 : U.uNight.value > 0.5 ? 66 : 80) : 0;
  simAcc += dt;
  if (dirty || built) renderer.shadowMap.needsUpdate = true;
  if (dirty || built || now - lastRender > minGap) {
    const sdt = Math.min(0.12, simAcc); simAcc = 0;
    const t0s = performance.now(), tr = stepTrains(sdt), bs = stepBuses(sdt), st = stepStreet(sdt);
    STATS.simMs = (STATS.simMs || 0) * 0.9 + (performance.now() - t0s) * 0.1; STATS.simMax = Math.max((STATS.simMax || 0) * 0.995, performance.now() - t0s);
    liveLvl = st ? 2 : tr || bs || U.uFlow.value > 0.01 ? 1 : 0;
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
  const s = META.sizes; const tot = s.bld + s.roads + s.ground + (s.transit || 0);
  let got = { bld: 0, roads: 0, ground: 0, transit: 0 };
  const prog = (k) => (p) => { got[k] = p * s[k]; const g = got.bld + got.roads + got.ground + got.transit; setProgress(0.04 + 0.5 * g / tot, `Downloading city data… ${(g / 1048576).toFixed(1)} / ${(tot / 1048576).toFixed(1)} MB`); };
  [BUF.bld, BUF.roads, BUF.ground, BUF.transit] = await Promise.all([fetchBin('bld', s.bld, prog('bld')), fetchBin('roads', s.roads, prog('roads')), fetchBin('ground', s.ground, prog('ground')),
    s.transit ? fetchBin('transit', s.transit, prog('transit')) : Promise.resolve(null)]);
  if (BUF.transit) TR = JSON.parse(new TextDecoder().decode(BUF.transit));
  setProgress(0.56, 'Laying water, parks and rail…'); await tick();
  buildGround();
  setProgress(0.6, `Paving ${META.counts.roads.toLocaleString()} road segments…`); await tick();
  buildRoads();
  buildAirport(); buildPolExtras(); buildDarwajas(); buildLandmarks3D();
  setProgress(0.61, 'Building the riverfront and the metro…'); await tick();
  buildRiverfront(); buildMetro(); buildBRTS(); buildSignals(); initTraffic(); initPeds(); buildSites(); initPlay(); buildIndustry();
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
window.AMD = { get IND() { return IND; }, U, STATS, view, flyTo, setTime, settings, sun, renderer, TIMES, group, get TR() { return TR; }, get TRAINS() { return TRAINS; }, get TRAF() { return TRAF; }, get PEDS() { return PEDS; }, get META() { return META; }, get WORKS() { return WORKS; }, get ROADS() { return ROADS; }, get BUSES() { return BUSES; }, get tod() { return tod; }, stopFly: () => { fly = null; }, poke: () => { dirty = true; }, chunks, get queue() { return queue.length; } };
requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  // one automatic retry: a half-updated browser cache is the usual cause after a redeploy
  let retried = false; try { retried = sessionStorage.getItem('amd-retry') === '1'; if (!retried) sessionStorage.setItem('amd-retry', '1'); } catch (_) { retried = true; }
  if (!retried) { location.reload(); return; }
  showErr('Failed to start: ' + e.message + ' — try a hard refresh (Ctrl/Cmd+Shift+R).');
});

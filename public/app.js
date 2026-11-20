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
const tankMat = hook(new THREE.MeshLambertMaterial({ vertexColors: true }), {
  vHead: 'varying vec3 vLN;', vBody: 'vLN = normal;', fHead: 'varying vec3 vLN;',
  fColor: `float top = step(0.7, normalize(vLN).y);
  float ribs = 0.80 + 0.20*smoothstep(0.35, 0.5, abs(fract(vWPos.y * 4.2) - 0.5) * 2.0);
  diffuseColor.rgb *= mix(ribs, 1.3, top);`,
});
const TANK_COLS = ['#1f2124', '#1f2124', '#1f2124', '#26292d', '#e8e4da', '#3a6fb0'].map((h) => new THREE.Color(h));
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

// ---------------------------------------------------------------- bespoke landmarks (Patang, ISKCON, Taj Skyline, Pinnacle, Ellis Bridge)
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
function buildPatang(o) {
  const G = new Geo(true), { x, z } = o;
  const conc = C255(224, 218, 206), concD = C255(196, 190, 178), roof = C255(238, 234, 226), glass = C255(40, 56, 70);
  lathe(G, x, z, [[7.5, -0.2], [7.5, 1.0], [4.6, 1.0]], 32, concD, 0);                                                // base
  lathe(G, x, z, [[4.6, 1.0], [4.6, 51.5], [9.0, 57.8], [9.7, 57.8], [9.7, 58.6], [9.35, 58.6]], 48, conc, 7);       // shaft, chabutaro capital, floor slab
  lathe(G, x, z, [[9.35, 58.6], [9.6, 64.1]], 96, glass, 4);                                                          // revolving-restaurant glazing (62 ft ring, 18 ft high)
  lathe(G, x, z, [[9.6, 64.1], [10.35, 64.3], [10.35, 64.9]], 96, roof, 0);                                           // eave of the 68 ft umbrella roof
  lathe(G, x, z, [[10.4, 64.36], [10.4, 64.6]], 96, roof, 5);                                                         // light ring
  lathe(G, x, z, [[10.35, 64.9], [6.5, 66.1], [2.2, 66.9], [0.9, 67.1], [0.35, 67.3], [0.22, 70.5], [0.0, 70.6]], 48, roof, 0);
  for (let i = 0; i < 8; i++) {                                                                                        // spars up the shaft, flaring under the capital
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8, c = Math.cos(a), s = Math.sin(a), tg = [-s, 0, c];
    beam(G, [x + c * 4.85, 1.0, z + s * 4.85], [x + c * 4.85, 51.2, z + s * 4.85], 0.5, 0.7, conc, 7, tg);
    beam(G, [x + c * 4.85, 51.2, z + s * 4.85], [x + c * 8.7, 57.5, z + s * 8.7], 0.5, 0.7, conc, 7, tg);
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
// Pinnacle Business Park: U-plan around a landscaped forecourt; each wing ends in white-rimmed "sail" blocks whose
// glazed roofs sweep down to the ground, the outer sails stepped back; central atrium block under a tensile cone
function sailBlock(G, F, ai, ao, b0, b1, Ht, glassK, white, stone) {
  const sg = Math.sign(ao - ai), w = Math.abs(ao - ai), N = 14, U = [F.ux, 0, F.uz], V = [F.vx, 0, F.vz], ng = (q) => q.map((x) => -x);
  const cv = []; for (let k = 0; k <= N; k++) { const d = w * Math.sin((k / N) * Math.PI / 2); cv.push([ai + sg * d, Ht * Math.sqrt(Math.max(0, 1 - (d / w) ** 2)), d]); }
  const e2 = [glassK, 0, 0, 0];
  for (let k = 0; k < N; k++) {
    const [a0, y0] = cv[k], [a1, y1] = cv[k + 1];
    lq(G, F(ai, b1, 0), F(a0, b1, y0), F(a1, b1, y1), F(a1, b1, y1), V, e2, white);       // front elevation (fan)
    lq(G, F(ai, b0, 0), F(a0, b0, y0), F(a1, b0, y1), F(a1, b0, y1), ng(V), e2, white);   // back elevation
    const dm = (cv[k][2] + cv[k + 1][2]) / 2, ym = (y0 + y1) / 2;
    let na = sg * dm / (w * w), ny = ym / (Ht * Ht); const nl = Math.hypot(na, ny) || 1; na /= nl; ny /= nl;
    const n = [F.ux * na, ny, F.uz * na];
    lq(G, F(a0, b0, y0), F(a1, b0, y1), F(a1, b1, y1), F(a0, b1, y0), n, e2, white);      // glazed sweep
    // white rim along the front edge of the sail, standing proud of the face
    const o0 = [na * 0.45, ny * 0.45], p0 = F(a0 + sg * 0, b1 + 0.35, y0), p1 = F(a1, b1 + 0.35, y1);
    beam(G, [p0[0] + F.ux * o0[0], p0[1] + o0[1], p0[2] + F.uz * o0[0]], [p1[0] + F.ux * o0[0], p1[1] + o0[1], p1[2] + F.uz * o0[0]], 1.5, 0.9, white, 0, V);
  }
  lq(G, F(ai, b0, 0), F(ai, b1, 0), F(ai, b1, Ht), F(ai, b0, Ht), sg > 0 ? ng(U) : U, e2, white);   // inner wall
  beam(G, F(ai, b1 + 0.35, 0), F(ai, b1 + 0.35, Ht + 2.2), 1.5, 0.9, white, 0, V);                  // rim up the inner edge to the tip
  const d1 = 1.6, d2 = 3.8, yt = Ht * Math.sqrt(1 - (d2 / w) ** 2) - 0.8;                             // perforated stone strip
  fbox(G, F, Math.min(ai + sg * d1, ai + sg * d2), Math.max(ai + sg * d1, ai + sg * d2), b1, b1 + 0.3, 0, yt, stone, 0);
}
function buildPinnacle(o) {
  if (!o.W) return;
  const G = new Geo(true), F = lmFrame(o), hw = o.W / 2, hd = o.D / 2;
  const white = C255(240, 240, 236), stone = C255(186, 186, 182), green = C255(92, 138, 66), paving = C255(214, 204, 186), water = C255(70, 132, 172);
  const H = 40, hc = 0.12 * o.W, ti = 0.45 * (hw - hc), rec = 8;
  for (const sg of [-1, 1]) {                                     // the two towers: flat-roofed block + one sail at the outer end
    const a0 = sg * hc, a1 = sg * (hc + ti), lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    fbox(G, F, lo, hi, -hd, hd, 0, H, white, 2, 0);
    fbox(G, F, lo - 0.2, hi + 0.2, -hd - 0.2, hd + 0.2, H, H + 0.8, white, 0);
    sailBlock(G, F, a1, sg * hw, -hd, hd, H + 5, 2, white, stone);
    for (const [s0, s1] of [[hc, hc + 2.6], [hc + ti - 3.2, hc + ti]]) fbox(G, F, Math.min(sg * s0, sg * s1), Math.max(sg * s0, sg * s1), hd, hd + 0.45, 0, H + 1.4, stone, 0);
  }
  fbox(G, F, -hc, hc, -hd, hd - rec, 0, H - 1.5, white, 2, 0);   // internal link block, set back
  fbox(G, F, -hc, hc, -hd, hd - rec, H - 1.5, H - 0.8, white, 0);
  fbox(G, F, -4.2, 4.2, hd - rec, hd - rec + 1.2, 0, H - 4, white, 2, 0);   // glazed atrium
  const cc = F(0, (-hd + hd - rec) / 2, 0);
  lathe(G, cc[0], cc[2], [[6.2, H - 0.8], [6.0, H - 0.2], [1.3, H + 4.6], [0.55, H + 5.0], [0.0, H + 5.1]], 28, white, 0);   // tensile cone
  fbox(G, F, -hc + 0.3, hc - 0.3, hd - rec + 1.3, hd + 6, 0, 0.16, paving, 0);              // forecourt garden in the recess
  fbox(G, F, -hc + 2, hc - 2, hd - rec + 3, hd + 4, 0.16, 0.3, green, 0);
  const fc = F(0, hd - rec / 2 + 1.5, 0);
  lathe(G, fc[0], fc[2], [[2.6, 0.3], [2.6, 0.85], [2.25, 0.85], [2.25, 0.66], [0.0, 0.66]], 24, stone, 0);
  lathe(G, fc[0], fc[2], [[2.2, 0.68], [0.0, 0.68]], 24, water, 0);
  lathe(G, fc[0], fc[2], [[0.4, 0.68], [0.28, 1.5], [0.0, 1.6]], 8, white, 0);
  group.ground.add(G.mesh(LMK));
}
function buildLandmarks3D() {
  for (const o of META.lm3d || []) {
    if (o.kind === 'patang') buildPatang(o);
    else if (o.kind === 'iskcon') buildIskcon(o);
    else if (o.kind === 'taj') buildTaj(o);
    else if (o.kind === 'pinnacle') buildPinnacle(o);
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
  // culled tiles: junction discs first, then the ribbons, for each of the two passes (kerb, then asphalt + markings)
  const P2 = pos.subarray(0, v * 2), RA = { aR: new THREE.BufferAttribute(aR.subarray(0, v * 4), 4) };
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
  let nt = 0, nm = 0, ns = 0; for (let i = 0; i < n; i++) T[i] === 0 ? nt++ : T[i] === 1 ? nm++ : ns++;
  const tanks = new THREE.InstancedMesh(tankGeo, tankMat, Math.max(nt, 1)); tanks.count = nt;
  const mum = new THREE.InstancedMesh(mumtyGeo, mumtyMat, Math.max(nm, 1)); mum.count = nm;
  const sol = new THREE.InstancedMesh(solarGeo, solarMat, Math.max(ns, 1)); sol.count = ns;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    _p.set(X[i] * 0.1, Y[i] * 0.1, Z[i] * 0.1);
    const s = SC[i] / 20;
    if (T[i] === 0) { _q.identity(); _s.set(s, s, s); _m.compose(_p, _q, _s); tanks.setColorAt(a, TANK_COLS[Math.floor(hash1(i * 13 + ch.cx * 7 + ch.cy * 3) * TANK_COLS.length)]); tanks.setMatrixAt(a++, _m); }
    else if (T[i] === 1) { _e.set(0, (RO[i] / 255) * Math.PI, 0); _q.setFromEuler(_e); _s.set(s, s > 1.2 ? 1.3 : 1, s); _m.compose(_p, _q, _s); mum.setMatrixAt(b++, _m); }
    else { _e.set(0, (RO[i] / 255) * Math.PI, 0); _q.setFromEuler(_e); _s.set(1, 1, 1); _m.compose(_p, _q, _s); sol.setMatrixAt(c++, _m); }
  }
  for (const im of [tanks, mum, sol]) { im.position.set(ch.ox, 0, ch.oz); im.castShadow = true; im.receiveShadow = true; im.renderOrder = 10; im.computeBoundingSphere(); group.near.add(im); ch.props.push(im); }
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
  const icon = { lake: '~', river: '~', monument: '★', stadium: '◎', airport: '✈', campus: '◆', park: '♣', gate: '∩', tower: '▲' };
  for (const l of META.landmarks) LBL.poi.push({ el: mk('poi ' + l.kind, `<span class="pin">${icon[l.kind] || '★'}</span>${l.name}`), x: l.x, z: l.z, min: l.kind === 'gate' ? 5 : 14 });
  for (const s of META.stations) LBL.poi.push({ el: mk('poi station', `<span class="pin">🚆︎</span>${s.name}`), x: s.x, z: s.z, min: 6 });
  if (TR) for (const s of TR.metro.stations) {
    if (s.corr === 'red' && s.id === 'GMRCL_OLD_HIGH_COURT') continue;
    const dots = s.lines.map((l) => `<i style="background:${COLS[l]}"></i>`).join('');
    LBL.poi.push({ el: mk('poi metro', `<span class="pin">M</span>${s.n}<span class="ml">${dots}</span>`), x: s.x, z: s.z, y: s.ug ? 4 : s.rl + 9, min: 7 });
  }
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
  const T = new TGeo();
  const conc = lin('#cdc7bc'), concD = lin('#bdb7ac');
  const ELEV = M.stations.filter((s) => !s.ug);
  const stOf = (s) => (s.corr === 'red' && s.id === 'GMRCL_OLD_HIGH_COURT') ? 'over' : 'full';
  // ---- viaduct
  for (const C of M.corr) {
    const P = C.pts, n = P.length / 2, s = corridorS(C);
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
      if (C.ug[j] || inSt[j] || C.rl[j] < 0.3) { j++; continue; }
      let e = j; while (e < n && !C.ug[e] && !inSt[e] && C.rl[e] >= 0.3) e++;
      // decimate straight, evenly graded stretches
      const keep = [j]; let last = j;
      for (let q = j + 1; q < e - 1; q++) {
        const h0 = Math.atan2(P[last * 2 + 3] - P[last * 2 + 1], P[last * 2 + 2] - P[last * 2]);
        const h1 = Math.atan2(P[q * 2 + 3] - P[q * 2 + 1], P[q * 2 + 2] - P[q * 2]);
        let dh = Math.abs(h1 - h0); if (dh > Math.PI) dh = 2 * Math.PI - dh;
        const curv = Math.abs(C.rl[q + 1] - 2 * C.rl[q] + C.rl[q - 1]);
        if (dh > 0.008 || curv > 2e-3 || s[q] - s[last] > 24) { keep.push(q); last = q; }
      }
      if (e - 1 > j) keep.push(e - 1);
      const Q = new Float32Array(keep.length * 2), rl = keep.map((q) => C.rl[q]), ss = keep.map((q) => s[q]);
      keep.forEach((q, i) => { Q[i * 2] = P[q * 2]; Q[i * 2 + 1] = P[q * 2 + 1]; });
      viaductRun(T, Q, rl, ss, conc, concD);
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
  initTrains(M);
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
function viaductRun(T, Q, rl, ss, conc, concD) {
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
function initTrains(M) {
  const routes = M.routes.map((r) => {
    const P = r.pts, n = P.length / 2, s = new Float32Array(n);
    for (let j = 1; j < n; j++) s[j] = s[j - 1] + Math.hypot(P[j * 2] - P[j * 2 - 2], P[j * 2 + 1] - P[j * 2 - 1]);
    const [N] = lnormals(P);
    return { ...r, s, N, n, col: new THREE.Color(COLS[r.line]) };
  });
  const trips = M.trips.map(([ri, dir, svc, ss, dt]) => { const t = [dt[0]]; for (let k = 1; k < dt.length; k++) t.push(t[k - 1] + dt[k]); return { ri, dir, svc, ss, t }; });
  const geo = carGeo(), MAXC = 240;
  const im = new THREE.InstancedMesh(geo, TRAINMAT, MAXC);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.setColorAt(0, new THREE.Color(1, 1, 1));
  im.frustumCulled = false; im.castShadow = false; im.receiveShadow = true; im.renderOrder = 10; im.count = 0;
  group.ground.add(im);
  const ist = new Date(Date.now() + 5.5 * 3600e3), wd = ist.getUTCDay();
  const svcOk = (v) => v === 0 || (v === 1 && wd >= 1 && wd <= 5) || (v === 2 && wd === 6) || (v === 3 && wd === 0);
  TRAINS = { routes, trips: trips.filter((t) => svcOk(t.svc)), im, clock: TOD_CLOCK[todName] || TOD_CLOCK.noon, last: todName };
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
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3(), _ts = new THREE.Vector3(1, 1, 1), _ty = new THREE.Vector3(0, 1, 0);
function routeAt(r, sv) {
  const s = r.s; let lo = 0, hi = r.n - 1;
  if (sv <= 0) sv = 0; if (sv >= s[hi]) sv = s[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= sv) lo = m; else hi = m; }
  const f = (sv - s[lo]) / Math.max(1e-6, s[hi] - s[lo]), P = r.pts;
  return [P[lo * 2] + (P[hi * 2] - P[lo * 2]) * f, P[lo * 2 + 1] + (P[hi * 2 + 1] - P[lo * 2 + 1]) * f, r.rl[lo] + (r.rl[hi] - r.rl[lo]) * f,
    P[hi * 2] - P[lo * 2], P[hi * 2 + 1] - P[lo * 2 + 1], r.N[lo * 2], r.N[lo * 2 + 1], (r.ug[lo] || r.ug[hi]) ? 1 : 0, (r.inb[lo] && r.inb[hi]) ? 1 : 0];
}
function stepTrains(dt) {
  if (!TRAINS) return false;
  const TT = TRAINS;
  if (TT.last !== todName) { TT.clock = TOD_CLOCK[todName] || TT.clock; TT.last = todName; }
  TT.clock += dt;
  const show = view.mpp < 9;
  TT.im.visible = show;
  if (!show) return false;
  const T = TT.clock; let c = 0;
  const DWELL = 25, CAR = 22.6;
  for (const tr of TT.trips) {
    const t = tr.t, n = t.length;
    if (T < t[0] - 40 || T > t[n - 1] + 40) continue;
    let sv;
    if (T <= t[0]) sv = tr.ss[0]; else if (T >= t[n - 1]) sv = tr.ss[n - 1];
    else {
      let k = 0; while (k < n - 2 && T >= t[k + 1]) k++;
      const span = t[k + 1] - t[k], dw = Math.min(DWELL, span * 0.3), u = clamp((T - t[k] - dw) / Math.max(1, span - dw), 0, 1);
      const e = u * u * (3 - 2 * u);
      sv = tr.ss[k] + (tr.ss[k + 1] - tr.ss[k]) * e;
    }
    const r = TT.routes[tr.ri], sg = tr.dir === 0 ? 1 : -1;
    for (let q = 0; q < 3; q++) {
      if (c >= TT.im.instanceMatrix.count) break;
      const sc = sv - sg * (q * CAR + CAR / 2);
      const [x, z, y, dx, dz, nx, nz, ug, inb] = routeAt(r, sc);
      if (ug || !inb) continue;
      _tp.set(x + nx * TRACK * sg, y, z + nz * TRACK * sg);
      _tq.setFromAxisAngle(_ty, Math.atan2(-dz * sg, dx * sg));
      _tm.compose(_tp, _tq, _ts);
      TT.im.setMatrixAt(c, _tm); TT.im.setColorAt(c, r.col); c++;
    }
  }
  TT.im.count = c;
  TT.im.instanceMatrix.needsUpdate = true; if (TT.im.instanceColor) TT.im.instanceColor.needsUpdate = true;
  return false;
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), lastRender = 0, ready = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (!ready) return;
  U.uTime.value = now / 1000;
  let changed = stepAnims(dt) | stepKeys(dt);
  stepTrains(dt);
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
  buildRiverfront(); buildMetro();
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
window.AMD = { STATS, view, flyTo, setTime, settings, sun, renderer, TIMES, group, get TR() { return TR; }, get TRAINS() { return TRAINS; }, get tod() { return tod; }, stopFly: () => { fly = null; }, poke: () => { dirty = true; }, chunks, get queue() { return queue.length; } };
requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  // one automatic retry: a half-updated browser cache is the usual cause after a redeploy
  let retried = false; try { retried = sessionStorage.getItem('amd-retry') === '1'; if (!retried) sessionStorage.setItem('amd-retry', '1'); } catch (_) { retried = true; }
  if (!retried) { location.reload(); return; }
  showErr('Failed to start: ' + e.message + ' — try a hard refresh (Ctrl/Cmd+Shift+R).');
});

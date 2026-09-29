import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#eeede8');
const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, .1, 2000);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch {
  $('loading-text').textContent = 'This viewer needs a browser with WebGL enabled.';
  throw new Error('WebGL is unavailable');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('canvas-wrap').append(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '3D architectural model. Drag to orbit, scroll to zoom.');
renderer.domElement.setAttribute('role', 'img');

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = .075;
controls.minPolarAngle = .12;
controls.maxPolarAngle = Math.PI / 2.04;
controls.enablePan = true;
controls.rotateSpeed = .55;
controls.zoomSpeed = .8;
controls.minZoom = .4;
controls.maxZoom = 4;
scene.add(new THREE.HemisphereLight('#fffdf5', '#959c8b', 1.8));
const sun = new THREE.DirectionalLight('#fff6e9', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -.0002;
sun.shadow.normalBias = .055;
sun.shadow.radius = 4;
scene.add(sun, sun.target);
const fill = new THREE.DirectionalLight('#e6edf1', .85);
fill.position.set(-60, 30, -30);
scene.add(fill);

const palettes = {
  plaster: { color: '#e4e0d5', roughness: .87 },
  concrete: { color: '#c5c6b9', roughness: .92 },
  slab: { color: '#dedacc', roughness: .85 },
  roof: { color: '#c4c7b6', roughness: .82 },
  metal: { color: '#697264', roughness: .58, metalness: .25 },
  glass: { color: '#9fbbb5', roughness: .23, metalness: .13, transparent: true, opacity: .37, depthWrite: false },
  wood: { color: '#aa9474', roughness: .85 },
  site: { color: '#b6bca5', roughness: 1 },
  furniture: { color: '#c3b8a1', roughness: .85 },
  upholstery: { color: '#84917a', roughness: 1 }
};
const materials = Object.fromEntries(Object.entries(palettes).map(([key, props]) => [key, new THREE.MeshStandardMaterial({ ...props, side: THREE.DoubleSide })]));
const root = new THREE.Group();
scene.add(root);
const assemblies = [];
const labels = [];
let model, extent = 50, baseCenter = new THREE.Vector3(), progress = 0, target = 0, animation = null, lastTime = performance.now(), dirty = true;
let cameraAutomatic = true, fitHeight = 50, lastLabelTime = 0;
const cameraDirection = new THREE.Vector3(1, .83, 1.1).normalize();
const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function geometryFromRecord(record, buffer) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, record.positions.offset, record.positions.count), 3));
  if (record.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buffer, record.normals.offset, record.normals.count), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, record.indices.offset, record.indices.count), 1));
  if (!record.normals) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function updateUI(value) {
  const percent = Math.round(value * 100);
  $('separation').value = percent;
  $('separation').style.setProperty('--fill', percent + '%');
  $('percentage').innerHTML = percent + '<span>%</span>';
  const full = value > .999, closed = value < .001;
  $('assemble').classList.toggle('active', closed);
  $('explode').classList.toggle('active', full);
  $('assemble').setAttribute('aria-pressed', String(closed));
  $('explode').setAttribute('aria-pressed', String(full));
  $('state-name').textContent = closed ? 'ASSEMBLED' : full ? 'EXPLODED' : 'IN TRANSITION';
  $('view-state').textContent = closed ? '01' : '02';
}

function assemblyProgress(value, index) {
  // Small sequential offsets disappear at both endpoints; the path is reversible.
  const delay = .10 * index / Math.max(assemblies.length - 1, 1);
  return ease(THREE.MathUtils.clamp((value - delay) / (1 - delay), 0, 1));
}

function applyProgress(value) {
  progress = THREE.MathUtils.clamp(value, 0, 1);
  assemblies.forEach((assembly, i) => {
    assembly.group.position.y = assembly.data.lift * assemblyProgress(progress, i);
  });
  if (cameraAutomatic) frameModel(false);
  updateUI(progress);
  dirty = true;
}

function setSeparation(value, animate = true) {
  cameraAutomatic = true;
  target = THREE.MathUtils.clamp(value, 0, 1);
  if (animate && !reducedMotion.matches) animation = { from: progress, to: target, start: performance.now(), duration: 1600 * Math.max(.5, Math.abs(target - progress)) };
  else { animation = null; applyProgress(target); }
  $('notice').textContent = target === 0 ? 'Assembling model' : target === 1 ? 'Exploding architectural assemblies' : 'Separation ' + Math.round(target * 100) + ' percent';
}

function frameModel(resetDirection) {
  if (!model) return;
  const w = innerWidth, h = $('viewer').clientHeight, aspect = w / h;
  const mobile = w < 700;
  const expandedHeight = Math.max(...assemblies.map(a => (a.data.maxHeight ?? model.bounds.max[1]) + a.group.position.y)) - model.bounds.min[1];
  const center = baseCenter.clone();
  center.y = model.bounds.min[1] + expandedHeight / 2;
  const region = mobile
    ? {left:18,right:w-18,top:208,bottom:h-202}
    : {left:w >= 1100 ? Math.max(280,w*.21) : 215,right:w-(w>=1100 ? 202 : 24),top:105,bottom:h-155};
  const direction = resetDirection ? cameraDirection : camera.position.clone().sub(controls.target).normalize();
  const right = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right,direction).normalize();
  const sizeX = model.bounds.max[0] - model.bounds.min[0], sizeZ = model.bounds.max[2] - model.bounds.min[2];
  const projectedWidth = Math.abs(right.x)*sizeX + Math.abs(right.y)*expandedHeight + Math.abs(right.z)*sizeZ;
  const projectedHeight = Math.abs(up.x)*sizeX + Math.abs(up.y)*expandedHeight + Math.abs(up.z)*sizeZ;
  fitHeight = Math.max(projectedHeight*h/Math.max(150,region.bottom-region.top), projectedWidth*w/Math.max(220,region.right-region.left)/aspect)*1.06;
  camera.left = -fitHeight * aspect / 2;
  camera.right = fitHeight * aspect / 2;
  camera.top = fitHeight / 2;
  camera.bottom = -fitHeight / 2;
  if (resetDirection) {
    camera.zoom = 1;
    camera.position.copy(center).addScaledVector(cameraDirection, extent * 3 + model.maxLift);
    controls.target.copy(center);
  } else {
    const delta = center.clone().sub(controls.target);
    camera.position.add(delta);
    controls.target.copy(center);
  }
  // A slight horizontal shift balances the editorial title on wide screens.
  const offsetX = (.5-(region.left+region.right)/2/w)*fitHeight*aspect;
  const offsetY = ((region.top+region.bottom)/2/h-.5)*fitHeight;
  camera.left += offsetX; camera.right += offsetX;
  camera.top += offsetY; camera.bottom += offsetY;
  camera.updateProjectionMatrix();
  controls.update();
}

function updateLabels() {
  const width = innerWidth, height = $('viewer').clientHeight;
  labels.forEach(({element, assembly, anchor}) => {
    const p = anchor.clone();
    p.y += assembly.group.position.y;
    p.project(camera);
    const x = (p.x * .5 + .5) * width, y = (-p.y * .5 + .5) * height;
    const inFrame = x > width * .2 && x < width - 70 && y > 90 && y < height - 170;
    element.style.left = (x + 8) + 'px';
    element.style.top = y + 'px';
    element.style.opacity = inFrame ? Math.max(0, (progress - .45) / .55) * .85 : 0;
  });
}

async function loadModel() {
  const response = await fetch('./model/scene.json');
  if (!response.ok) throw new Error('The model assets could not be loaded.');
  model = await response.json();
  const meshResponse = await fetch('./model/geometry.bin');
  if (!meshResponse.ok) throw new Error('The model geometry could not be loaded.');
  const binary = await meshResponse.arrayBuffer();
  const bounds = new THREE.Box3(new THREE.Vector3(...model.bounds.min), new THREE.Vector3(...model.bounds.max));
  const size = bounds.getSize(new THREE.Vector3());
  extent = Math.max(size.x, size.z);
  bounds.getCenter(baseCenter);
  model.maxLift = Math.max(...model.assemblies.map(a => a.lift));
  const prototypes = model.prototypes.map(prototype => prototype.meshes.map(record => ({record, geometry:geometryFromRecord(record, binary)})));
  model.assemblies.forEach((data, i) => {
    const group = new THREE.Group(); group.name = data.label;
    const instanceBatches = new Map();
    for (const instance of data.instances || []) {
      if (!instanceBatches.has(instance.prototype)) instanceBatches.set(instance.prototype, []);
      instanceBatches.get(instance.prototype).push(instance);
    }
    for (const [prototypeId, instances] of instanceBatches) {
      for (const {record, geometry} of prototypes[prototypeId]) {
        const mesh = new THREE.InstancedMesh(geometry, materials[record.material] || materials.plaster, instances.length);
        instances.forEach((instance, index) => mesh.setMatrixAt(index, new THREE.Matrix4().fromArray(instance.matrix)));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = record.material !== 'glass'; mesh.receiveShadow = record.material !== 'glass';
        mesh.computeBoundingBox(); mesh.computeBoundingSphere(); group.add(mesh);
      }
    }
    data.meshes.forEach(record => {
      const geometry = geometryFromRecord(record, binary);
      const mesh = new THREE.Mesh(geometry, materials[record.material] || materials.plaster);
      mesh.castShadow = record.material !== 'glass';
      mesh.receiveShadow = record.material !== 'glass';
      group.add(mesh);
      if (record.edges) {
        const edgeGeometry = new THREE.BufferGeometry();
        edgeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(binary, record.edges.offset, record.edges.count), 3));
        const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: '#535a4d', transparent: true, opacity: .16 }));
        group.add(edges);
      }
    });
    root.add(group);
    const assembly = {group, data}; assemblies.push(assembly);
    const li = document.createElement('li');
    const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = palettes[data.material || 'plaster'].color;
    const label = document.createElement('span'); label.textContent = data.label;
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1).padStart(2, '0');
    li.append(swatch, label, num); $('assembly-list').prepend(li);
    if (data.anchor && data.lift > 0) {
      const element = document.createElement('div'); element.className = 'model-label';
      const number = document.createElement('span'); number.className = 'label-number'; number.textContent = String(i + 1).padStart(2, '0'); element.append(number);
      $('model-labels').append(element); labels.push({element, assembly, anchor: new THREE.Vector3(...data.anchor)});
    }
  });
  $('model-summary').textContent = model.description || 'An architectural assembly study.';
  const groundGeometry = new THREE.PlaneGeometry(extent * 200, extent * 200);
  const ground = new THREE.Mesh(groundGeometry, new THREE.ShadowMaterial({ color: '#76806a', opacity: .16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = bounds.min.y - extent * .004;
  ground.receiveShadow = true; scene.add(ground);
  sun.position.set(-extent * .5, extent * 1.7, extent * .6);
  sun.target.position.copy(baseCenter);
  const shadowSpan = extent * 1.05 + model.maxLift * .6;
  Object.assign(sun.shadow.camera, {left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: .1, far: extent * 8});
  sun.shadow.camera.updateProjectionMatrix();
  camera.far = extent * 20;
  frameModel(true); applyProgress(0);
  $('loading').classList.add('done');
  setTimeout(() => $('loading').hidden = true, 700);
  window.viewerReady = true;
}

$('assemble').addEventListener('click', () => setSeparation(0));
$('explode').addEventListener('click', () => setSeparation(1));
$('separation').addEventListener('input', event => setSeparation(Number(event.target.value) / 100, false));
$('reset').addEventListener('click', () => { cameraAutomatic = true; frameModel(true); dirty = true; $('notice').textContent = 'Axonometric view restored'; });
controls.addEventListener('start', () => { cameraAutomatic = false; });
controls.addEventListener('change', () => { dirty = true; });
window.addEventListener('resize', () => { renderer.setSize(innerWidth, $('viewer').clientHeight); frameModel(false); dirty = true; });
renderer.setSize(innerWidth, $('viewer').clientHeight);

function render(time) {
  requestAnimationFrame(render);
  if (animation) {
    const t = Math.min(1, (time - animation.start) / animation.duration);
    applyProgress(THREE.MathUtils.lerp(animation.from, animation.to, ease(t)));
    if (t >= 1) animation = null;
  }
  controls.update();
  if (dirty) { renderer.render(scene, camera); updateLabels(); dirty = false; }
  lastTime = time;
}
requestAnimationFrame(render);

// Read-only inspection surface for repeatable browser verification.
window.assemblyStudy = {
  getState: () => ({ready: !!window.viewerReady, progress, target, animating: !!animation, assemblies: assemblies.map(a => ({name:a.data.label, lift:a.group.position.y, expectedLift:a.data.lift})), draws:renderer.info.render.calls, triangles:renderer.info.render.triangles, camera:camera.position.toArray(), targetPoint:controls.target.toArray()}),
  setSeparation: value => setSeparation(value),
  resetView: () => $('reset').click()
};

loadModel().catch(error => {
  console.error(error);
  $('loading-text').textContent = error.message + ' Please refresh to try again.';
  document.querySelector('.loading-track').hidden = true;
});

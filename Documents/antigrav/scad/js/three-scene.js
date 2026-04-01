/* ═══════════════════════════════════════════════════════
   Three.js Scene — Premium 3D preview environment
   ═══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Creates a premium 3D scene with environment, grid, and post-processing.
 */
export function createScene(canvas) {
  // ── Renderer ──────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const parent = canvas.parentElement;
  renderer.setSize(parent.clientWidth, parent.clientHeight);

  // ── Scene ─────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08080d);
  scene.fog = new THREE.Fog(0x08080d, 200, 1500);

  // ── Camera ────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    45,
    parent.clientWidth / parent.clientHeight,
    0.1,
    2000
  );
  camera.position.set(6, 5, 8);
  camera.lookAt(0, 0, 0);

  // ── Controls ──────────────────────────────────────
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;
  controls.minDistance = 1;
  controls.maxDistance = 1000;
  controls.target.set(0, 0, 0);

  // ── Lights ────────────────────────────────────────
  // Ambient
  const ambientLight = new THREE.AmbientLight(0x404060, 0.6);
  scene.add(ambientLight);

  // Key light (warm directional)
  const keyLight = new THREE.DirectionalLight(0xfff0e6, 1.5);
  keyLight.position.set(8, 12, 8);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 50;
  keyLight.shadow.camera.left = -15;
  keyLight.shadow.camera.right = 15;
  keyLight.shadow.camera.top = 15;
  keyLight.shadow.camera.bottom = -15;
  keyLight.shadow.bias = -0.0005;
  scene.add(keyLight);

  // Fill light (cool)
  const fillLight = new THREE.DirectionalLight(0x6688cc, 0.5);
  fillLight.position.set(-5, 3, -5);
  scene.add(fillLight);

  // Rim light (accent cyan)
  const rimLight = new THREE.PointLight(0x00f0ff, 0.8, 30);
  rimLight.position.set(-4, 6, -3);
  scene.add(rimLight);

  // Bottom accent (purple)
  const bottomLight = new THREE.PointLight(0xa855f7, 0.3, 20);
  bottomLight.position.set(0, -2, 0);
  scene.add(bottomLight);

  // ── Grid ──────────────────────────────────────────
  const gridHelper = createCustomGrid(40, 40, 0x1a1a2e, 0x111122);
  scene.add(gridHelper);

  // Ground plane (for shadows)
  const groundGeo = new THREE.PlaneGeometry(100, 100);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── Model Container ───────────────────────────────
  const modelGroup = new THREE.Group();
  modelGroup.name = 'model';
  scene.add(modelGroup);

  // ── Post-Processing (Bloom) ────────────────────────
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(parent.clientWidth, parent.clientHeight),
    0.3,   // strength — subtle
    0.6,   // radius
    0.85   // threshold
  );
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // ── Animation ─────────────────────────────────────
  const clock = new THREE.Clock();
  let animId;
  let fpsCounter = 0;
  let fpsTime = 0;
  let currentFps = 60;
  let wireframeMode = false;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDown = null;
  let faceSelectHandler = null;
  let selectedMesh = null;

  function animate() {
    animId = requestAnimationFrame(animate);
    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    controls.update();

    // Subtle rim light movement
    rimLight.position.x = Math.sin(elapsed * 0.3) * 6;
    rimLight.position.z = Math.cos(elapsed * 0.3) * 6;

    composer.render();

    // FPS counter
    fpsCounter++;
    fpsTime += delta;
    if (fpsTime >= 0.5) {
      currentFps = Math.round(fpsCounter / fpsTime);
      fpsCounter = 0;
      fpsTime = 0;
    }
  }

  animate();

  // ── Resize ────────────────────────────────────────
  function resize() {
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(parent);

  function clearSelectionHighlight() {
    if (!selectedMesh) return;
    const backup = selectedMesh.userData?.__selectionBackup;
    if (Array.isArray(backup)) {
      const materials = Array.isArray(selectedMesh.material) ? selectedMesh.material : [selectedMesh.material];
      materials.forEach((material, idx) => {
        const state = backup[idx];
        if (!material || !state) return;
        if (state.emissive && material.emissive) material.emissive.copy(state.emissive);
        if (typeof state.emissiveIntensity === 'number' && typeof material.emissiveIntensity === 'number') {
          material.emissiveIntensity = state.emissiveIntensity;
        }
        if (state.color && material.color) material.color.copy(state.color);
      });
    }
    delete selectedMesh.userData.__selectionBackup;
    selectedMesh = null;
  }

  function applySelectionHighlight(mesh) {
    clearSelectionHighlight();
    selectedMesh = mesh;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.userData.__selectionBackup = materials.map((material) => ({
      emissive: material?.emissive ? material.emissive.clone() : null,
      emissiveIntensity: typeof material?.emissiveIntensity === 'number' ? material.emissiveIntensity : null,
      color: material?.color ? material.color.clone() : null,
    }));

    materials.forEach((material) => {
      if (!material) return;
      if (material.emissive) {
        material.emissive.set(0x223300);
        if (typeof material.emissiveIntensity === 'number') {
          material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.55);
        }
      } else if (material.color) {
        material.color.offsetHSL(0, 0, 0.08);
      }
    });
  }

  function selectFaceFromPointerEvent(event) {
    if (modelGroup.children.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster
      .intersectObjects(modelGroup.children, true)
      .filter((hit) => hit.object?.isMesh && !hit.object?.userData?.isWireframe);

    if (hits.length === 0) return;

    const hit = hits[0];
    applySelectionHighlight(hit.object);

    const worldNormal = hit.face?.normal
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    const localNormal = hit.face?.normal
      ? hit.face.normal.clone()
      : new THREE.Vector3(0, 1, 0);
    const localPoint = hit.object.worldToLocal(hit.point.clone());

    if (faceSelectHandler) {
      faceSelectHandler({
        faceIndex: Number.isInteger(hit.faceIndex) ? hit.faceIndex : null,
        worldPoint: [hit.point.x, hit.point.y, hit.point.z],
        worldNormal: [worldNormal.x, worldNormal.y, worldNormal.z],
        localPoint: [localPoint.x, localPoint.y, localPoint.z],
        localNormal: [localNormal.x, localNormal.y, localNormal.z],
        screenPoint: { x: event.clientX, y: event.clientY },
        uv: hit.uv ? [hit.uv.x, hit.uv.y] : null,
        meta: hit.object.userData?.scadMeta || null,
      });
    }
  }

  function onPointerDown(event) {
    pointerDown = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
    };
  }

  function onPointerUp(event) {
    if (!pointerDown) return;
    const delta = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    const elapsed = performance.now() - pointerDown.time;
    pointerDown = null;
    if (delta <= 5 && elapsed < 500) {
      selectFaceFromPointerEvent(event);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  // ── Public API ────────────────────────────────────
  return {
    scene,
    camera,
    renderer,
    controls,
    modelGroup,
    gridHelper,

    /** Replace the model with new geometry */
    setModel(threeGroup) {
      clearSelectionHighlight();
      // Clear old model
      while (modelGroup.children.length > 0) {
        const child = modelGroup.children[0];
        modelGroup.remove(child);
        disposeObject(child);
      }
      if (threeGroup) {
        modelGroup.add(threeGroup);
        // Auto-fit camera
        this.fitCamera(threeGroup);
      }
    },

    /** Fit camera to object bounds */
    fitCamera(object) {
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = camera.fov * (Math.PI / 180);
      let dist = (maxDim / 2) / Math.tan(fov / 2);
      dist = Math.max(dist * 1.8, 3);

      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(center).addScaledVector(dir, dist);
      controls.target.copy(center);
      controls.update();
    },

    /** Camera preset views */
    setView(view) {
      const target = controls.target.clone();
      const dist = camera.position.distanceTo(target);

      const positions = {
        front:    new THREE.Vector3(0, 0, dist),
        top:      new THREE.Vector3(0, dist, 0.001),
        right:    new THREE.Vector3(dist, 0, 0),
        iso:      new THREE.Vector3(dist * 0.6, dist * 0.5, dist * 0.6),
      };

      const newPos = positions[view];
      if (!newPos) return;

      // Smooth transition with simple lerp
      const startPos = camera.position.clone();
      const duration = 600;
      const startTime = performance.now();

      function animateView(time) {
        const t = Math.min((time - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
        camera.position.lerpVectors(startPos, target.clone().add(newPos), ease);
        camera.lookAt(target);
        if (t < 1) requestAnimationFrame(animateView);
      }
      requestAnimationFrame(animateView);
    },

    /** Toggle wireframe on all model materials */
    toggleWireframe() {
      wireframeMode = !wireframeMode;
      modelGroup.traverse(child => {
        if (child.isMesh && child.material) {
          child.material.wireframe = wireframeMode;
        }
      });
      return wireframeMode;
    },

    /** Toggle grid visibility */
    toggleGrid() {
      gridHelper.visible = !gridHelper.visible;
      return gridHelper.visible;
    },

    /** Reset camera to default position */
    resetCamera() {
      this.setView('iso');
    },

    onFaceSelected(handler) {
      faceSelectHandler = typeof handler === 'function' ? handler : null;
    },

    clearFaceSelection() {
      clearSelectionHighlight();
    },

    /** Get current FPS */
    getFps() { return currentFps; },

    /** Cleanup */
    dispose() {
      cancelAnimationFrame(animId);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      clearSelectionHighlight();
      controls.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Create a custom grid with subdivision lines.
 */
function createCustomGrid(divisions, size, mainColor, subColor) {
  const group = new THREE.Group();

  // Main grid
  const mainGrid = new THREE.GridHelper(size, divisions, mainColor, subColor);
  mainGrid.material.transparent = true;
  mainGrid.material.opacity = 0.4;
  group.add(mainGrid);

  // Axis lines
  const axisLen = size / 2;
  // X axis (red)
  const xGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.01, 0),
    new THREE.Vector3(axisLen, 0.01, 0),
  ]);
  const xLine = new THREE.Line(xGeo, new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.5 }));
  group.add(xLine);

  // Z axis (blue) — which maps to Y in SCAD
  const zGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0.01, 0),
    new THREE.Vector3(0, 0.01, axisLen),
  ]);
  const zLine = new THREE.Line(zGeo, new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.5 }));
  group.add(zLine);

  // Y axis (green) — which maps to Z in SCAD
  const yGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, axisLen, 0),
  ]);
  const yLine = new THREE.Line(yGeo, new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.5 }));
  group.add(yLine);

  return group;
}

/**
 * Recursively dispose of Three.js objects.
 */
function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach(m => m.dispose());
    } else {
      obj.material.dispose();
    }
  }
  if (obj.children) {
    obj.children.forEach(child => disposeObject(child));
  }
}

/**
 * Initialize the axes orientation HUD.
 */
export function createAxesHUD(canvas) {
  const size = 80;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(2, 1.5, 2);
  camera.lookAt(0, 0, 0);

  // Axes
  const axesHelper = new THREE.AxesHelper(0.8);
  scene.add(axesHelper);

  // Labels (simplified as colored spheres)
  const labelSize = 0.08;
  const labels = [
    { pos: [1, 0, 0], color: 0xff4444 },  // X
    { pos: [0, 1, 0], color: 0x44ff44 },  // Y (up)
    { pos: [0, 0, 1], color: 0x4488ff },  // Z
  ];
  labels.forEach(({ pos, color }) => {
    const geo = new THREE.SphereGeometry(labelSize, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0] * 0.9, pos[1] * 0.9, pos[2] * 0.9);
    scene.add(mesh);
  });

  return {
    update(mainCamera, target) {
      // Mirror the main camera orientation
      const dir = new THREE.Vector3();
      mainCamera.getWorldDirection(dir);
      const dist = 3;
      camera.position.copy(dir.multiplyScalar(-dist));
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
  };
}

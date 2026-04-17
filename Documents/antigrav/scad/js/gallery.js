import { getGalleryLatest, isSupabaseConfigured, getUser } from './supabase.js';
import { parseSCAD } from './scad-parser.js';
import * as THREE from 'three';

// ── Elements ─────────────────────────────────────────
const loadingEl = document.getElementById('gallery-loading');
const emptyEl = document.getElementById('gallery-empty');
const gridEl = document.getElementById('gallery-grid');
const uploadCta = document.querySelector('.gallery-hero__cta');
const codeModal = document.getElementById('code-modal');
const codeModalPre = document.getElementById('code-modal-source');
const codeModalTitle = document.getElementById('code-modal-title');
const codeModalClose = document.getElementById('code-modal-close');
const codeModalCopy = document.getElementById('code-modal-copy');

// ── State ────────────────────────────────────────────
const activeViewers = new Map(); // cardId -> { renderer, animId, canvas }
let intersectionObserver = null;

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderGallery();
  setupCodeModal();
});

// ── Gallery Render ───────────────────────────────────
async function renderGallery() {
  if (!isSupabaseConfigured()) {
    showError("Database not configured. Run the Supabase SQL scripts.");
    return;
  }

  try {
    const items = await getGalleryLatest(50);
    loadingEl.style.display = 'none';

    if (items.length === 0) {
      emptyEl.style.display = 'block';
    } else {
      gridEl.style.display = 'grid';
      gridEl.innerHTML = items.map(buildCardHtml).join('');

      // Setup lazy 3D viewer initialization
      setupLazyViewers();

      // Animate cards in
      if (typeof gsap !== 'undefined') {
        gsap.from('.gallery-card', {
          y: 40,
          opacity: 0,
          duration: 0.6,
          stagger: 0.1,
          ease: "power3.out"
        });
      }
    }

    // Toggle CTA based on auth
    const user = await getUser();
    if (user && uploadCta) {
      uploadCta.innerHTML = `<a href="render.html" class="btn btn-primary">Publish New Design</a>`;
    }

  } catch (err) {
    loadingEl.style.display = 'none';
    showError("Failed to load gallery items: " + err.message);
  }
}

// ── Card HTML Builder ────────────────────────────────
function buildCardHtml(item) {
  const dateStr = new Date(item.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const title = encodeHtml(item.title || 'Untitled');
  const author = encodeHtml(item.author_name || 'Anonymous');
  const desc = encodeHtml(item.description || 'No description provided.');
  const hasCode = item.scad_code && item.scad_code.trim().length > 0;
  const cardId = `gallery-card-${item.id}`;

  // Build the thumbnail area: either a live 3D canvas or a static image fallback
  let thumbnailHtml;
  if (hasCode) {
    thumbnailHtml = `
      <div class="gallery-card__canvas-wrap" id="${cardId}-canvas-wrap">
        <canvas class="gallery-card__canvas" id="${cardId}-canvas"></canvas>
        <div class="gallery-card__canvas-overlay">
          <div class="gallery-card__dots-grid"></div>
        </div>
        <div class="gallery-card__view-badge">LIVE 3D</div>
      </div>`;
  } else if (item.thumbnail_url) {
    thumbnailHtml = `<img src="${item.thumbnail_url}" alt="${title}" class="gallery-card__image" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'gallery-card__placeholder\\'>${placeholderSvg()}</div>'" />`;
  } else {
    thumbnailHtml = `<div class="gallery-card__placeholder">${placeholderSvg()}</div>`;
  }

  // Code action button
  const codeAction = hasCode
    ? `<button class="gallery-card__code-btn" data-code="${encodeAttr(item.scad_code)}" data-title="${encodeAttr(item.title || 'Untitled')}" aria-label="View SCAD code">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
        Code
       </button>`
    : '';

  return `
    <article class="gallery-card" id="${cardId}" data-scad-code="${hasCode ? 'true' : 'false'}">
      <div class="gallery-card__image-wrap">
        ${thumbnailHtml}
        <div class="gallery-card__hover-view">VIEW →</div>
      </div>
      <div class="gallery-card__content">
        <h2 class="gallery-card__title">${title}</h2>
        <div class="gallery-card__author">
          <div class="gallery-card__author-avatar"></div>
          <span>${author}</span>
        </div>
        <p class="gallery-card__description">${desc}</p>
        <div class="gallery-card__footer">
          <span class="gallery-card__date">${dateStr}</span>
          <div class="gallery-card__actions">
            ${codeAction}
            <a href="render.html?gallery_id=${item.id}" class="gallery-card__action">Open in Editor →</a>
          </div>
        </div>
      </div>
    </article>
  `;
}

function placeholderSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><line x1="12" y1="22" x2="12" y2="12"></line></svg>`;
}

// ── Lazy 3D Viewer Setup ─────────────────────────────
function setupLazyViewers() {
  const canvasWraps = document.querySelectorAll('.gallery-card__canvas-wrap');
  if (canvasWraps.length === 0) return;

  intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const wrap = entry.target;
      const canvasId = wrap.querySelector('canvas')?.id;
      if (!canvasId) return;

      if (entry.isIntersecting) {
        if (!activeViewers.has(canvasId)) {
          initCardViewer(canvasId);
        } else {
          // Resume animation
          const viewer = activeViewers.get(canvasId);
          if (viewer && !viewer.animId) {
            startAnimation(viewer);
          }
        }
      } else {
        // Pause animation when off-screen
        const viewer = activeViewers.get(canvasId);
        if (viewer && viewer.animId) {
          cancelAnimationFrame(viewer.animId);
          viewer.animId = null;
        }
      }
    });
  }, {
    rootMargin: '100px',
    threshold: 0.05
  });

  canvasWraps.forEach(wrap => intersectionObserver.observe(wrap));
}

// ── Single Card 3D Viewer ────────────────────────────
function initCardViewer(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const wrap = canvas.parentElement;
  const cardEl = canvas.closest('.gallery-card');
  if (!wrap || !cardEl) return;

  // Extract the SCAD code from the code button's data attribute
  const codeBtn = cardEl.querySelector('.gallery-card__code-btn');
  const scadCode = codeBtn ? decodeAttr(codeBtn.dataset.code) : '';
  if (!scadCode) return;

  // Setup renderer — lightweight, no post-processing
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h);

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);

  // Camera
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 500);

  // Light rig (simplified — no bloom)
  const hemiLight = new THREE.HemisphereLight(0xb0c0e0, 0x202030, 0.7);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff0e6, 1.3);
  keyLight.position.set(6, 10, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(512, 512);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 40;
  keyLight.shadow.camera.left = -10;
  keyLight.shadow.camera.right = 10;
  keyLight.shadow.camera.top = 10;
  keyLight.shadow.camera.bottom = -10;
  keyLight.shadow.bias = -0.001;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x6688cc, 0.4);
  fillLight.position.set(-4, 2, -4);
  scene.add(fillLight);

  const rimLight = new THREE.PointLight(0x00f0ff, 0.5, 25);
  rimLight.position.set(-3, 5, -2);
  scene.add(rimLight);

  // Ground plane for shadow
  const groundGeo = new THREE.PlaneGeometry(60, 60);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.25, depthWrite: false });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // Model pivot
  const pivot = new THREE.Group();
  scene.add(pivot);

  // Spherical camera control (auto-rotate, no interaction for gallery cards)
  const spherical = { theta: 0, phi: Math.PI / 4, radius: 8 };
  const target = new THREE.Vector3(0, 0, 0);

  // Compile SCAD code client-side
  try {
    const { group } = parseSCAD(scadCode);

    if (group.children.length > 0) {
      pivot.add(group);

      // Auto-frame: compute bounding box, center, and set camera distance
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      // Center model on X/Z, ground it on Y=0
      group.position.set(-center.x, -box.min.y, -center.z);
      target.set(0, size.y / 2, 0);
      spherical.radius = Math.max(size.length() * 1.6, 3);
    }
  } catch (err) {
    console.warn(`Gallery card SCAD compile failed for ${canvasId}:`, err);
  }

  // Build viewer state
  const viewer = {
    renderer,
    scene,
    camera,
    spherical,
    target,
    rimLight,
    animId: null,
    canvas,
    wrap,
  };

  activeViewers.set(canvasId, viewer);
  startAnimation(viewer);

  // ResizeObserver for this card
  const ro = new ResizeObserver(() => {
    const nw = wrap.clientWidth;
    const nh = wrap.clientHeight;
    if (nw === 0 || nh === 0) return;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  });
  ro.observe(wrap);
  viewer.resizeObserver = ro;
}

function startAnimation(viewer) {
  const { renderer, scene, camera, spherical, target, rimLight } = viewer;
  let elapsed = 0;

  function tick() {
    viewer.animId = requestAnimationFrame(tick);
    elapsed += 0.016; // ~60fps timestep

    // Auto-rotate camera
    spherical.theta += 0.003;

    // Compute camera position from spherical coordinates
    const sinPhi = Math.sin(spherical.phi);
    const cosPhi = Math.cos(spherical.phi);
    const sinTheta = Math.sin(spherical.theta);
    const cosTheta = Math.cos(spherical.theta);

    camera.position.set(
      target.x + spherical.radius * sinPhi * cosTheta,
      target.y + spherical.radius * cosPhi,
      target.z + spherical.radius * sinPhi * sinTheta
    );
    camera.lookAt(target);

    // Subtle rim light orbit
    rimLight.position.x = Math.sin(elapsed * 0.3) * 5;
    rimLight.position.z = Math.cos(elapsed * 0.3) * 5;

    renderer.render(scene, camera);
  }

  tick();
}

// ── Code Modal ───────────────────────────────────────
function setupCodeModal() {
  if (!codeModal) return;

  // Event delegation for code buttons
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.gallery-card__code-btn');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const code = decodeAttr(btn.dataset.code);
      const title = decodeAttr(btn.dataset.title);
      openCodeModal(code, title);
    }
  });

  // Close modal
  if (codeModalClose) {
    codeModalClose.addEventListener('click', closeCodeModal);
  }

  // Close on backdrop click
  codeModal.addEventListener('click', (e) => {
    if (e.target === codeModal) closeCodeModal();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && codeModal.classList.contains('open')) {
      closeCodeModal();
    }
  });

  // Copy button
  if (codeModalCopy) {
    codeModalCopy.addEventListener('click', () => {
      const code = codeModalPre?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        codeModalCopy.textContent = 'Copied!';
        codeModalCopy.classList.add('copied');
        setTimeout(() => {
          codeModalCopy.textContent = 'Copy';
          codeModalCopy.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        codeModalCopy.textContent = 'Copied!';
        codeModalCopy.classList.add('copied');
        setTimeout(() => {
          codeModalCopy.textContent = 'Copy';
          codeModalCopy.classList.remove('copied');
        }, 2000);
      });
    });
  }
}

function openCodeModal(code, title) {
  if (!codeModal || !codeModalPre) return;
  codeModalTitle.textContent = title;
  codeModalPre.textContent = code;
  highlightScadSyntax(codeModalPre);
  codeModal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCodeModal() {
  if (!codeModal) return;
  codeModal.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Simple SCAD Syntax Highlighting ──────────────────
function highlightScadSyntax(preEl) {
  const raw = preEl.textContent;
  let html = encodeHtml(raw);

  // Comments (single-line)
  html = html.replace(/(\/\/[^\n]*)/g, '<span class="scad-comment">$1</span>');
  // Comments (multi-line)
  html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="scad-comment">$1</span>');
  // Strings
  html = html.replace(/(&quot;[^&]*?&quot;)/g, '<span class="scad-string">$1</span>');
  // Numbers
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span class="scad-number">$1</span>');
  // Keywords
  const keywords = ['module', 'function', 'if', 'else', 'for', 'let', 'include', 'use', 'true', 'false'];
  keywords.forEach(kw => {
    html = html.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span class="scad-keyword">$1</span>');
  });
  // Builtins
  const builtins = ['cube', 'sphere', 'cylinder', 'circle', 'square', 'polygon', 'polyhedron', 'text',
    'translate', 'rotate', 'scale', 'mirror', 'color', 'union', 'difference', 'intersection',
    'hull', 'minkowski', 'linear_extrude', 'rotate_extrude', 'import', 'surface',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'abs', 'ceil', 'floor',
    'round', 'min', 'max', 'pow', 'sqrt', 'exp', 'log', 'ln', 'len', 'echo'];
  builtins.forEach(fn => {
    html = html.replace(new RegExp(`\\b(${fn})\\b`, 'g'), '<span class="scad-builtin">$1</span>');
  });
  // Variables ($ prefixed)
  html = html.replace(/(\$\w+)/g, '<span class="scad-variable">$1</span>');

  preEl.innerHTML = html;
}

// ── Utilities ────────────────────────────────────────
function encodeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function encodeAttr(str) {
  return btoa(unescape(encodeURIComponent(str || '')));
}

function decodeAttr(encoded) {
  try {
    return decodeURIComponent(escape(atob(encoded || '')));
  } catch {
    return '';
  }
}

function showError(msg) {
  if (loadingEl) loadingEl.style.display = 'none';
  if (gridEl) {
    gridEl.style.display = 'block';
    gridEl.innerHTML = `<div style="color:#f87171; text-align:center; padding:40px;">${msg}</div>`;
  }
}

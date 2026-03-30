/* ═══════════════════════════════════════════════════════
   SCAD Studio — Landing Page JS (v5: clean, no slop)
   ═══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import gsap from 'gsap';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

inject();
injectSpeedInsights();

// ── Particles ────────────────────────────────────────
async function initParticles() {
  try {
    const { tsParticles } = await import('@tsparticles/engine');
    const { loadSlim } = await import('@tsparticles/slim');
    await loadSlim(tsParticles);
    await tsParticles.load({
      id: 'tsparticles',
      options: {
        fullScreen: false,
        background: { color: 'transparent' },
        fpsLimit: 60,
        particles: {
          number: { value: 50, density: { enable: true, width: 1400, height: 900 } },
          color: { value: '#333' },
          shape: { type: 'circle' },
          opacity: { value: { min: 0.05, max: 0.15 } },
          size: { value: { min: 0.5, max: 1.5 } },
          links: { enable: true, distance: 120, color: '#222', opacity: 0.06, width: 0.6 },
          move: { enable: true, speed: 0.3, direction: 'none', random: true, outModes: { default: 'out' } },
        },
        interactivity: {
          detectsOn: 'window',
          events: { onHover: { enable: true, mode: 'grab' } },
          modes: { grab: { distance: 140, links: { opacity: 0.08 } } },
        },
      },
    });
  } catch (e) { /* particles optional */ }
}

// ── Hero 3D Scene ────────────────────────────────────
function initHeroScene() {
  const canvas = document.getElementById('hero-three-canvas');
  if (!canvas) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 0, 6);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Colored wireframe icosahedron
  const geo = new THREE.IcosahedronGeometry(2.2, 1);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.35 });
  const wireframe = new THREE.LineSegments(edges, mat);
  scene.add(wireframe);

  // Inner glow fill
  const innerMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.03, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geo, innerMat));

  // Orbiting particles (purple)
  const dotCount = 150;
  const positions = new Float32Array(dotCount * 3);
  for (let i = 0; i < dotCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 2.5 + Math.random() * 1.5;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dotMat = new THREE.PointsMaterial({ color: 0xa855f7, size: 0.02, transparent: true, opacity: 0.6 });
  const dots = new THREE.Points(dotGeo, dotMat);
  scene.add(dots);

  // Ring of cyan points
  const ringCount = 120;
  const ringPos = new Float32Array(ringCount * 3);
  for (let i = 0; i < ringCount; i++) {
    const angle = (i / ringCount) * Math.PI * 2;
    const r = 3.2 + Math.sin(angle * 5) * 0.3;
    ringPos[i * 3] = r * Math.cos(angle);
    ringPos[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
    ringPos[i * 3 + 2] = r * Math.sin(angle);
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
  const ring = new THREE.Points(ringGeo, new THREE.PointsMaterial({ color: 0x00f0ff, size: 0.015, transparent: true, opacity: 0.4 }));
  scene.add(ring);

  let mx = 0, my = 0;
  window.addEventListener('mousemove', (e) => {
    mx = (e.clientX / window.innerWidth - 0.5) * 2;
    my = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    wireframe.rotation.x = t * 0.12 + my * 0.08;
    wireframe.rotation.y = t * 0.18 + mx * 0.08;
    dots.rotation.y = t * 0.08;
    dots.rotation.x = Math.sin(t * 0.1) * 0.1;
    ring.rotation.y = -t * 0.1;
    const scale = 1 + Math.sin(t * 0.8) * 0.03;
    wireframe.scale.setScalar(scale);
    mat.opacity = 0.3 + Math.sin(t * 1.2) * 0.1;
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ── Feature 3D Scene (in the split-screen card) ──────
function initFeatureScene() {
  const canvas = document.getElementById('feature-scene-canvas');
  if (!canvas) return;

  const container = canvas.parentElement;
  const w = container.clientWidth || 500;
  const h = container.clientHeight || 380;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0d);

  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(4, 3, 5);
  camera.lookAt(0, 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  // Minimal lights
  scene.add(new THREE.AmbientLight(0x303040, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1);
  key.position.set(5, 8, 5);
  key.castShadow = true;
  scene.add(key);
  const accent = new THREE.PointLight(0x00f0ff, 0.3, 15);
  accent.position.set(-3, 4, -2);
  scene.add(accent);

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  // Simple architectural model — matches the drilled-block style
  const group = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.3, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x00f0ff, roughness: 0.2, metalness: 0.4, transparent: true, opacity: 0.5 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.3, 2.5), baseMat);
  base.castShadow = true;
  group.add(base);

  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 1.8, 6), baseMat);
  tower.position.y = 1.05;
  tower.castShadow = true;
  group.add(tower);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), accentMat);
  dome.position.y = 1.95;
  group.add(dome);

  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
  [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].forEach(([x, z]) => {
    const p = new THREE.Mesh(postGeo, accentMat);
    p.position.set(x, 0.55, z);
    p.castShadow = true;
    group.add(p);
  });

  // Edge hints
  group.traverse(c => {
    if (c.isMesh) {
      const e = new THREE.EdgesGeometry(c.geometry, 15);
      c.add(new THREE.LineSegments(e, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.04 })));
    }
  });

  scene.add(group);

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    group.rotation.y = clock.getElapsedTime() * 0.2;
    renderer.render(scene, camera);
  }
  animate();

  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth, nh = container.clientHeight;
    if (nw > 0 && nh > 0) { camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh); }
  });
  ro.observe(container);
}

// ── Showcase Scene ───────────────────────────────────
function initShowcaseScene() {
  const canvas = document.getElementById('showcase-canvas');
  if (!canvas) return;

  const container = canvas.parentElement;
  const w = container.clientWidth, h = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0d);

  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(3, 2.5, 4);
  camera.lookAt(0, 0.3, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  scene.add(new THREE.AmbientLight(0x303040, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 1);
  dl.position.set(5, 8, 5); dl.castShadow = true;
  scene.add(dl);

  const group = new THREE.Group();
  const mat1 = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.3, metalness: 0.6 });
  const mat2 = new THREE.MeshStandardMaterial({ color: 0x00f0ff, roughness: 0.2, metalness: 0.4, transparent: true, opacity: 0.5 });

  const b = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 1.5), mat1);
  b.castShadow = true; group.add(b);
  const c = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.9, 32), mat1);
  c.position.y = 0.6; c.castShadow = true; group.add(c);
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 32), mat2);
  s.position.y = 1.2; group.add(s);
  scene.add(group);

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    group.rotation.y = clock.getElapsedTime() * 0.25;
    renderer.render(scene, camera);
  }
  animate();

  const ro = new ResizeObserver(() => {
    const nw = container.clientWidth, nh = container.clientHeight;
    if (nw > 0 && nh > 0) { camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh); }
  });
  ro.observe(container);
}

// ── Code Typing ──────────────────────────────────────
function initTypingAnimation() {
  const codeEl = document.querySelector('#typing-code code');
  if (!codeEl) return;

  const lines = [
    '// Drilled block with corner posts',
    'difference() {',
    '  cube(size = 6, center = true);',
    '  cylinder(h = 8, r = 1.5, $fn = 32);',
    '}',
    '',
    'for (i = [0:90:270])',
    '  rotate([0, 0, i])',
    '    translate([2, 2, 0])',
    '      cylinder(h = 4, r = 0.3);',
  ];

  const fullCode = lines.join('\n');
  let idx = 0;
  let started = false;

  function typeChar() {
    if (idx <= fullCode.length) {
      const typed = fullCode.slice(0, idx);
      codeEl.innerHTML = colorize(typed) + '<span style="color:#555">|</span>';
      idx++;
      setTimeout(typeChar, fullCode[idx - 1] === '\n' ? 100 : (Math.random() * 30 + 15));
    } else {
      setTimeout(() => { idx = 0; typeChar(); }, 5000);
    }
  }

  const obs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !started) { started = true; typeChar(); }
  }, { threshold: 0.1 });
  const el = document.querySelector('.feature-hero');
  if (el) obs.observe(el);
}

function colorize(code) {
  // Escape HTML first
  let html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Apply syntax colors — order matters to avoid nested spans
  html = html.replace(/\/\/.*/g, m => `<span style="color:#555">${m}</span>`);
  html = html.replace(/\b(difference|cube|cylinder|rotate|translate|sphere|union|intersection|for|color)\b/g, '<span style="color:#6ee7b7">$&</span>');
  html = html.replace(/\b(true|false)\b/g, '<span style="color:#c084fc">$&</span>');
  // Only match numbers NOT inside a span tag
  html = html.replace(/(?<!color:#)\b(\d+\.?\d*)\b/g, '<span style="color:#fbbf24">$&</span>');
  return html;
}

// ── Counters ─────────────────────────────────────────
function initCounters() {
  document.querySelectorAll('.metric__value[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count);
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        gsap.to({ v: 0 }, {
          v: target, duration: 1.5, ease: 'power2.out',
          onUpdate() { el.textContent = Math.round(this.targets()[0].v); }
        });
        obs.disconnect();
      }
    }, { threshold: 0.1 });
    obs.observe(el);
  });
}

// ── Animations ───────────────────────────────────────
function initAnimations() {
  // Hero entrance
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.from('.hero__eyebrow', { opacity: 0, y: 15, duration: 0.8, delay: 0.2 })
    .from('.hero__title .line span', { y: '110%', duration: 1, stagger: 0.1 }, '-=0.5')
    .from('.hero__subtitle', { opacity: 0, y: 20, duration: 0.8 }, '-=0.5')
    .from('.hero__actions', { opacity: 0, y: 20, duration: 0.8 }, '-=0.5')
    .from('.hero__scroll-hint', { opacity: 0, duration: 0.8 }, '-=0.3');

  // Scroll reveals using IntersectionObserver (reliable)
  const fadeEls = document.querySelectorAll('.fade-in');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        gsap.to(entry.target, { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out' });
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05 });
  fadeEls.forEach(el => { gsap.set(el, { opacity: 0, y: 30 }); observer.observe(el); });
}

// ── Nav ──────────────────────────────────────────────
function initNavbar() {
  window.addEventListener('scroll', () => {
    document.getElementById('navbar')?.classList.toggle('scrolled', window.scrollY > 40);
  });

  const hamburger = document.getElementById('hamburger-btn');
  const mobile = document.getElementById('mobile-nav');
  if (hamburger && mobile) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('active');
      mobile.classList.toggle('visible');
      document.body.style.overflow = mobile.classList.contains('visible') ? 'hidden' : '';
    });
    mobile.querySelectorAll('.mobile-nav__link').forEach(l => {
      l.addEventListener('click', () => { hamburger.classList.remove('active'); mobile.classList.remove('visible'); document.body.style.overflow = ''; });
    });
  }
}

// ── Page Transition ──────────────────────────────────
function initPageTransitions() {
  document.querySelectorAll('.page-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const href = link.getAttribute('href');
      document.getElementById('page-transition')?.classList.add('active');
      setTimeout(() => { window.location.href = href; }, 400);
    });
  });
}

// ── Smooth Scroll ────────────────────────────────────
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const t = document.querySelector(a.getAttribute('href'));
      if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth' }); }
    });
  });
}

// ── Loading ──────────────────────────────────────────
function hideLoading() {
  setTimeout(() => document.getElementById('loading-screen')?.classList.add('hidden'), 300);
}

// ── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initHeroScene();
  initFeatureScene();
  initShowcaseScene();
  initAnimations();
  initNavbar();
  initSmoothScroll();
  initTypingAnimation();
  initCounters();
  initPageTransitions();
  hideLoading();
});

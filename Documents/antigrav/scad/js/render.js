/* ═══════════════════════════════════════════════════════
   SCAD Studio — Render Page JavaScript (v3 Overhaul)
   Editor + 3D preview + console + templates + save/load
   ═══════════════════════════════════════════════════════ */

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from '@codemirror/language';

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { createScene, createAxesHUD } from './three-scene.js';
import { DEFAULT_FILENAME, DEFAULT_SAMPLE_CODE } from './default-sample.js';
import { parseSCAD } from './scad-parser.js';
import { getSimpleFaceEditSpec, applySimpleFaceEdit } from './simple-face-edit.js';
import { TEMPLATES } from './templates.js';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import {
  isSupabaseConfigured, signUpWithEmail, signInWithEmail, signOut, getUser, getSession, onAuthChange,
  createProject, updateProject, deleteProject as deleteCloudProject,
  getMyProjects, getSharedProjects, shareProjectByEmail, uploadAvatar,
  publishToGallery, uploadGalleryThumbnail, getGalleryItem
} from './supabase.js';


inject();
injectSpeedInsights();

// ── Sample SCAD Code ────────────────────────────────
const SAMPLE_CODE = DEFAULT_SAMPLE_CODE;

// ── State ─────────────────────────────────────────────
let editor;
let scene3d;
let axesHUD;
let selectedFaceContext = null;
let selectedQuickEditSpec = null;
let currentUser = null;
let currentProjectId = null;  // cloud project id when signed in
const ANIMATION_DEFAULT_FPS = 24;
const ANIMATION_DEFAULT_STEPS = 120;
const ANIMATION_MIN_FPS = 1;
const ANIMATION_MAX_FPS = 60;
const ANIMATION_MIN_STEPS = 2;
const ANIMATION_MAX_STEPS = 360;
const animationState = {
  playing: false,
  hasAnimationVariable: false,
  frame: 0,
  t: 0,
  fps: ANIMATION_DEFAULT_FPS,
  steps: ANIMATION_DEFAULT_STEPS,
  rafId: 0,
  lastTickAt: 0,
};
let renderInFlight = false;
let queuedRenderOptions = null;
let suppressToastNotifications = false;
let suppressConsoleMessages = false;
const GALLERY_HANDOFF_PREFIX = 'scaid_gallery_open:';

const VIEW_PRESETS = {
  front: { buttonId: 'view-front', label: 'Front' },
  top: { buttonId: 'view-top', label: 'Top' },
  right: { buttonId: 'view-right', label: 'Right' },
  iso: { buttonId: 'view-iso', label: 'Isometric' },
};

function setViewportView(view) {
  if (!scene3d || !VIEW_PRESETS[view]) return;
  scene3d.setView(view);

  Object.entries(VIEW_PRESETS).forEach(([key, preset]) => {
    document.getElementById(preset.buttonId)?.classList.toggle('active', key === view);
  });

  const viewName = document.getElementById('viewport-view-name');
  if (viewName) viewName.textContent = VIEW_PRESETS[view].label;
}

// ── Console System ──────────────────────────────────
const consoleLogs = [];
function consoleLog(msg, level = 'info') {
  if (suppressConsoleMessages) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  consoleLogs.push({ msg, level, time: timeStr });
  updateConsoleUI();
}

function updateConsoleUI() {
  const output = document.getElementById('console-output');
  if (!output) return;
  output.innerHTML = consoleLogs.map(l =>
    `<div class="console-line console-line--${l.level}"><span class="console-line__time">${l.time}</span>${escapeHtml(l.msg)}</div>`
  ).join('');
  output.scrollTop = output.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getEditorContent() {
  return editor ? editor.state.doc.toString() : '';
}

function updateAIStatus(message) {
  const status = document.getElementById('ai-chat-status');
  if (status) status.textContent = message;
}

function updateFaceHint(message) {
  const hint = document.getElementById('ai-face-hint');
  if (hint) hint.textContent = message;
}

function setButtonBusy(buttonId, busy, busyLabel, idleLabel) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : idleLabel;
}

function formatNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return value.toFixed(2);
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function normalizeAnimationFps(value) {
  return Math.round(clampNumber(value, ANIMATION_MIN_FPS, ANIMATION_MAX_FPS, ANIMATION_DEFAULT_FPS));
}

function normalizeAnimationSteps(value) {
  return Math.round(clampNumber(value, ANIMATION_MIN_STEPS, ANIMATION_MAX_STEPS, ANIMATION_DEFAULT_STEPS));
}

function sourceSupportsAnimation(source) {
  return /\$t\b/.test(source || '');
}

function getAnimationFrameCount() {
  return normalizeAnimationSteps(animationState.steps);
}

function frameToAnimationT(frame, steps = getAnimationFrameCount()) {
  if (!Number.isFinite(frame) || steps <= 0) return 0;
  return Math.min(Math.max(frame, 0), steps - 1) / steps;
}

function formatAnimationT(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000';
}

function buildAnimationScope(t = animationState.t) {
  return { '$t': t };
}

function formatQuickEditValue(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function getQuickEditStep(value) {
  const magnitude = Math.abs(Number(value));
  if (!Number.isFinite(magnitude) || magnitude >= 10) return 1;
  if (magnitude >= 1) return 0.1;
  return 0.05;
}

function formatSelectionLabel(selection) {
  if (!selection) return 'Click a face to quickly change simple dimensions or use AI for bigger edits.';
  const primitive = selection.meta?.primitive || selection.meta?.operation || 'geometry';
  const line = selection.meta?.line ? `line ${selection.meta.line}` : 'source hint unavailable';
  return `Selected: ${primitive} (${line}).`;
}

function refreshQuickEditUI(selection) {
  const quickSection = document.getElementById('face-edit-quick');
  const label = document.getElementById('face-edit-quick-label');
  const hint = document.getElementById('face-edit-quick-hint');
  const input = document.getElementById('face-edit-value');
  const quickApply = document.getElementById('face-edit-quick-apply');
  const minus = document.getElementById('face-edit-quick-minus');
  const plus = document.getElementById('face-edit-quick-plus');
  if (!quickSection || !label || !hint || !input || !quickApply || !minus || !plus) return;

  selectedQuickEditSpec = selection ? getSimpleFaceEditSpec(getEditorContent(), selection) : null;

  if (!selectedQuickEditSpec) {
    quickSection.classList.add('face-edit-quick--unavailable');
    label.textContent = 'Quick Edit Unavailable';
    hint.textContent = 'This selection needs AI or a manual code edit. Quick edit currently supports cubes, cylinders, cones, and spheres.';
    input.value = '';
    input.disabled = true;
    quickApply.disabled = true;
    minus.disabled = true;
    plus.disabled = true;
    return;
  }

  const step = getQuickEditStep(selectedQuickEditSpec.currentValue);
  quickSection.classList.remove('face-edit-quick--unavailable');
  label.textContent = selectedQuickEditSpec.label;
  hint.textContent = `${selectedQuickEditSpec.hint}. This rewrites the SCAD source directly.`;
  input.disabled = false;
  quickApply.disabled = false;
  minus.disabled = false;
  plus.disabled = false;
  input.step = String(step);
  input.dataset.step = String(step);
  input.value = formatQuickEditValue(selectedQuickEditSpec.currentValue);
}

function nudgeQuickEditValue(direction) {
  const input = document.getElementById('face-edit-value');
  if (!input || input.disabled) return;

  const baseValue = input.value === ''
    ? Number(selectedQuickEditSpec?.currentValue)
    : Number(input.value);
  const step = Number(input.dataset.step || input.step || '0.1');
  if (!Number.isFinite(baseValue) || !Number.isFinite(step)) return;

  input.value = formatQuickEditValue(baseValue + (direction * step));
}

async function requestScadFromApi(url, payload) {
  const session = await getSession();
  const headers = { 'Content-Type': 'application/json' };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(payload),
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  if (!response.ok) {
    const msg = data?.error || `Request failed (${response.status})`;
    throw new Error(msg);
  }

  if (!data?.scadCode || typeof data.scadCode !== 'string') {
    throw new Error('No SCAD code returned from API.');
  }

  return data;
}

function applyGeneratedCode(scadCode, sourceLabel) {
  setEditorContent(scadCode);
  showToast(`✓ Updated by ${sourceLabel}`);
  consoleLog(`Code updated from ${sourceLabel}`, 'success');
  renderModel();
}

function hideFaceEditPopover() {
  const popover = document.getElementById('face-edit-popover');
  if (popover) popover.classList.remove('visible');
  selectedQuickEditSpec = null;
}

function positionFacePopover(selection) {
  const popover = document.getElementById('face-edit-popover');
  const previewPanel = document.getElementById('preview-panel');
  if (!popover || !previewPanel || !selection?.screenPoint) return;

  const panelRect = previewPanel.getBoundingClientRect();
  const popWidth = popover.offsetWidth || 340;
  const popHeight = popover.offsetHeight || 320;
  const margin = 12;
  let left = selection.screenPoint.x - panelRect.left + 10;
  let top = selection.screenPoint.y - panelRect.top + 10;

  if (left + popWidth > panelRect.width - margin) left = panelRect.width - popWidth - margin;
  if (top + popHeight > panelRect.height - margin) top = panelRect.height - popHeight - margin;
  left = Math.max(margin, left);
  top = Math.max(margin, top);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function showFaceEditPopover(selection) {
  const popover = document.getElementById('face-edit-popover');
  const meta = document.getElementById('face-edit-meta');
  const aiInput = document.getElementById('face-edit-input');
  const quickInput = document.getElementById('face-edit-value');
  if (!popover || !meta || !aiInput || !quickInput) return;

  const primitive = selection.meta?.primitive || selection.meta?.operation || 'geometry';
  const line = selection.meta?.line ? `line ${selection.meta.line}` : 'line unknown';
  const point = Array.isArray(selection.worldPoint)
    ? selection.worldPoint.map((v) => formatNumber(v)).join(', ')
    : 'n/a';
  const normal = Array.isArray(selection.worldNormal)
    ? selection.worldNormal.map((v) => formatNumber(v)).join(', ')
    : 'n/a';

  meta.textContent = `${primitive} • ${line} • p(${point}) • n(${normal})`;
  aiInput.value = '';
  refreshQuickEditUI(selection);
  popover.classList.add('visible');
  positionFacePopover(selection);

  if (selectedQuickEditSpec) quickInput.focus();
  else aiInput.focus();
}

// ── Initialize Editor ───────────────────────────────
function initEditor() {
  const container = document.getElementById('editor-container');

  const state = EditorState.create({
    doc: SAMPLE_CODE,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      bracketMatching(),
      javascript(),
      oneDark,
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        { key: 'Ctrl-Enter', run: () => { renderModel(); return true; } },
        { key: 'Cmd-Enter', run: () => { renderModel(); return true; } },
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        updateAnimationUI(update.state.doc.toString());
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '14px' },
        '.cm-content': {
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          padding: '12px 0',
        },
        '.cm-gutters': {
          background: '#111118',
          borderRight: '1px solid rgba(255,255,255,0.06)',
          color: '#555568',
        },
        '.cm-activeLineGutter': { background: 'rgba(241,155,169,0.05)' },
        '.cm-activeLine': { background: 'rgba(241,155,169,0.03)' },
        '.cm-cursor': { borderLeftColor: '#f19ba9' },
        '.cm-selectionBackground': { background: 'rgba(241,155,169,0.15) !important' },
        '&.cm-focused .cm-selectionBackground': { background: 'rgba(241,155,169,0.2) !important' },
      }),
    ],
  });

  editor = new EditorView({ state, parent: container });
}

// ── Initialize 3D Scene ─────────────────────────────
function initScene() {
  const canvas = document.getElementById('preview-canvas');
  scene3d = createScene(canvas);
  scene3d.onFaceSelected((selection) => {
    selectedFaceContext = selection;
    updateFaceHint(formatSelectionLabel(selection));
    showFaceEditPopover(selection);
    const primitive = selection.meta?.primitive || selection.meta?.operation || 'geometry';
    consoleLog(`Face selected on ${primitive}`, 'info');
  });

  const axesCanvas = document.getElementById('axes-canvas');
  if (axesCanvas) {
    axesHUD = createAxesHUD(axesCanvas);
    function updateHUD() {
      requestAnimationFrame(updateHUD);
      if (axesHUD) axesHUD.update(scene3d.camera, scene3d.controls.target);
      const fpsEl = document.getElementById('status-fps');
      if (fpsEl) fpsEl.textContent = `${scene3d.getFps()} FPS`;
    }
    updateHUD();
  }
}

// ── Render Model ────────────────────────────────────
function updateAnimationUI(source = getEditorContent()) {
  const panel = document.getElementById('animation-panel');
  const playBtn = document.getElementById('btn-animation-play');
  const resetBtn = document.getElementById('btn-animation-reset');
  const meta = document.getElementById('animation-meta');
  const scrubber = document.getElementById('animation-scrubber');
  const fpsInput = document.getElementById('animation-fps');
  const stepsInput = document.getElementById('animation-steps');
  const supportsAnimation = sourceSupportsAnimation(source);
  const steps = getAnimationFrameCount();

  animationState.hasAnimationVariable = supportsAnimation;
  animationState.fps = normalizeAnimationFps(animationState.fps);
  animationState.steps = steps;

  if (panel) panel.classList.toggle('is-inactive', !supportsAnimation);

  if (!supportsAnimation && animationState.playing) {
    cancelAnimationFrame(animationState.rafId);
    animationState.playing = false;
    animationState.rafId = 0;
    animationState.lastTickAt = 0;
  }

  if (animationState.frame >= steps) {
    animationState.frame = 0;
    animationState.t = frameToAnimationT(0, steps);
  }

  if (scrubber) {
    scrubber.max = String(Math.max(steps - 1, 0));
    scrubber.value = String(Math.min(animationState.frame, Math.max(steps - 1, 0)));
    scrubber.disabled = !supportsAnimation;
  }

  if (fpsInput) fpsInput.value = String(animationState.fps);
  if (stepsInput) stepsInput.value = String(steps);

  if (playBtn) {
    playBtn.disabled = !supportsAnimation;
    playBtn.textContent = animationState.playing ? '❚❚' : '▶';
    playBtn.title = animationState.playing ? 'Pause animation' : 'Play animation';
    playBtn.setAttribute('aria-label', animationState.playing ? 'Pause animation' : 'Play animation');
    playBtn.classList.toggle('is-playing', animationState.playing);
  }

  if (resetBtn) resetBtn.disabled = !supportsAnimation;

  if (meta) {
    meta.textContent = supportsAnimation
      ? `Frame ${animationState.frame + 1} / ${steps} · $t = ${formatAnimationT(animationState.t)}`
      : 'Add $t to your SCAD code to animate this preview.';
  }
}

function stopPreviewAnimation(options = {}) {
  const { keepFrame = true, render = false, source = getEditorContent() } = options;
  if (animationState.rafId) cancelAnimationFrame(animationState.rafId);
  animationState.rafId = 0;
  animationState.playing = false;
  animationState.lastTickAt = 0;

  if (!keepFrame) {
    animationState.frame = 0;
    animationState.t = 0;
  }

  updateAnimationUI(source);

  if (render) {
    renderModel({
      origin: 'animation',
      animationT: animationState.t,
      source,
      fitCamera: false,
      showToast: false,
      logToConsole: false,
    });
  }
}

function tickPreviewAnimation(now) {
  if (!animationState.playing) return;

  const source = getEditorContent();
  if (!sourceSupportsAnimation(source)) {
    stopPreviewAnimation({ source });
    return;
  }

  const fps = normalizeAnimationFps(animationState.fps);
  const interval = 1000 / fps;
  if (!animationState.lastTickAt) animationState.lastTickAt = now;

  const elapsed = now - animationState.lastTickAt;
  if (elapsed >= interval) {
    const steps = getAnimationFrameCount();
    const framesToAdvance = Math.max(1, Math.floor(elapsed / interval));
    animationState.frame = (animationState.frame + framesToAdvance) % steps;
    animationState.t = frameToAnimationT(animationState.frame, steps);
    animationState.lastTickAt = now - (elapsed % interval);
    updateAnimationUI(source);
    renderModel({
      origin: 'animation',
      animationT: animationState.t,
      source,
      fitCamera: false,
      showToast: false,
      logToConsole: false,
    });
  }

  animationState.rafId = requestAnimationFrame(tickPreviewAnimation);
}

function startPreviewAnimation() {
  const source = getEditorContent();
  if (!sourceSupportsAnimation(source)) {
    updateAnimationUI(source);
    showToast('Add $t to your SCAD code to animate the preview.');
    return;
  }

  if (animationState.playing) return;

  animationState.playing = true;
  animationState.lastTickAt = 0;
  updateAnimationUI(source);
  renderModel({
    origin: 'animation',
    animationT: animationState.t,
    source,
    fitCamera: false,
    showToast: false,
    logToConsole: false,
  });
  animationState.rafId = requestAnimationFrame(tickPreviewAnimation);
}

function initAnimationControls() {
  const playBtn = document.getElementById('btn-animation-play');
  const resetBtn = document.getElementById('btn-animation-reset');
  const scrubber = document.getElementById('animation-scrubber');
  const fpsInput = document.getElementById('animation-fps');
  const stepsInput = document.getElementById('animation-steps');

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (animationState.playing) stopPreviewAnimation();
      else startPreviewAnimation();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const source = getEditorContent();
      stopPreviewAnimation({ keepFrame: false, source });
      if (sourceSupportsAnimation(source)) {
        renderModel({
          origin: 'animation',
          animationT: animationState.t,
          source,
          fitCamera: false,
          showToast: false,
          logToConsole: false,
        });
      }
    });
  }

  if (scrubber) {
    scrubber.addEventListener('input', () => {
      const source = getEditorContent();
      stopPreviewAnimation({ source });
      animationState.frame = clampNumber(scrubber.value, 0, getAnimationFrameCount() - 1, 0);
      animationState.t = frameToAnimationT(animationState.frame);
      updateAnimationUI(source);
      if (sourceSupportsAnimation(source)) {
        renderModel({
          origin: 'animation',
          animationT: animationState.t,
          source,
          fitCamera: false,
          showToast: false,
          logToConsole: false,
        });
      }
    });
  }

  if (fpsInput) {
    fpsInput.addEventListener('change', () => {
      animationState.fps = normalizeAnimationFps(fpsInput.value);
      updateAnimationUI();
    });
  }

  if (stepsInput) {
    stepsInput.addEventListener('change', () => {
      const source = getEditorContent();
      const previousT = animationState.t;
      animationState.steps = normalizeAnimationSteps(stepsInput.value);
      animationState.frame = Math.round(previousT * getAnimationFrameCount());
      animationState.frame = clampNumber(animationState.frame, 0, getAnimationFrameCount() - 1, 0);
      animationState.t = frameToAnimationT(animationState.frame);
      updateAnimationUI(source);
      if (sourceSupportsAnimation(source)) {
        renderModel({
          origin: 'animation',
          animationT: animationState.t,
          source,
          fitCamera: false,
          showToast: false,
          logToConsole: false,
        });
      }
    });
  }

  updateAnimationUI(SAMPLE_CODE);
}

function renderModel(options = {}) {
  const source = options.source ?? getEditorContent();
  const origin = options.origin || 'manual';
  const animationT = typeof options.animationT === 'number' ? options.animationT : animationState.t;
  const fitCamera = typeof options.fitCamera === 'boolean' ? options.fitCamera : origin !== 'animation';
  const showRenderToast = typeof options.showToast === 'boolean' ? options.showToast : origin !== 'animation';
  const logRender = typeof options.logToConsole === 'boolean' ? options.logToConsole : origin !== 'animation';
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const infoStatus = document.getElementById('info-status');
  const emptyState = document.getElementById('preview-empty');
  const verticesEl = document.getElementById('status-vertices');
  const facesEl = document.getElementById('status-faces');
  const btnRender = document.getElementById('btn-render');

  if (renderInFlight) {
    queuedRenderOptions = {
      ...options,
      source,
      origin,
      animationT,
      fitCamera,
      showToast: showRenderToast,
      logToConsole: logRender,
    };
    return;
  }

  try {
    renderInFlight = true;
    btnRender.classList.add('rendering');
    statusText.textContent = origin === 'animation'
      ? `Animating $t = ${formatAnimationT(animationT)}...`
      : 'Rendering...';
    infoStatus.textContent = origin === 'animation'
      ? `Animating · $t = ${formatAnimationT(animationT)}`
      : 'Rendering...';
    statusDot.className = 'status-indicator__dot status-indicator__dot--warning';
    suppressToastNotifications = !showRenderToast;
    suppressConsoleMessages = !logRender;

    requestAnimationFrame(() => {
      try {
        const startTime = performance.now();
        const { group, vertexCount, faceCount } = parseSCAD(source, {
          initialScope: buildAnimationScope(animationT),
        });
        const elapsed = (performance.now() - startTime).toFixed(1);

        scene3d.setModel(group, { fitCamera });
        selectedFaceContext = null;
        selectedQuickEditSpec = null;
        hideFaceEditPopover();
        updateFaceHint('Click a face to quickly change simple dimensions or use AI for bigger edits.');

        if (origin === 'animation') {
          statusText.textContent = `Animating · $t = ${formatAnimationT(animationT)}`;
          infoStatus.textContent = `Animating · ${elapsed}ms · $t = ${formatAnimationT(animationT)}`;
        } else {
          statusText.textContent = `Rendered in ${elapsed}ms`;
          infoStatus.textContent = `Rendered · ${elapsed}ms`;
        }
        infoStatus.textContent = `Rendered · ${elapsed}ms`;
        if (origin === 'animation') {
          infoStatus.textContent = `Animating · ${elapsed}ms · $t = ${formatAnimationT(animationT)}`;
        }
        statusDot.className = 'status-indicator__dot';
        verticesEl.textContent = `Vertices: ${vertexCount.toLocaleString()}`;
        facesEl.textContent = `Faces: ${faceCount.toLocaleString()}`;
        btnRender.classList.remove('rendering');

        if (emptyState) emptyState.classList.add('hidden');
        updateAnimationUI(source);
        showToast(`✓ Rendered — ${vertexCount.toLocaleString()} verts, ${faceCount.toLocaleString()} faces · ${elapsed}ms`);
        consoleLog(`Rendered in ${elapsed}ms — ${vertexCount} vertices, ${faceCount} faces`, 'success');
      } catch (err) {
        console.error('SCAD Parse Error:', err);
        statusText.textContent = `Error: ${err.message}`;
        infoStatus.textContent = 'Error';
        statusDot.className = 'status-indicator__dot status-indicator__dot--error';
        btnRender.classList.remove('rendering');
        showToast(`✗ ${err.message}`);
        consoleLog(`Error: ${err.message}`, 'error');
      } finally {
        suppressToastNotifications = false;
        suppressConsoleMessages = false;
        renderInFlight = false;
        if (queuedRenderOptions) {
          const nextRender = queuedRenderOptions;
          queuedRenderOptions = null;
          renderModel(nextRender);
        }
      }
    });
  } catch (err) {
    suppressToastNotifications = false;
    suppressConsoleMessages = false;
    renderInFlight = false;
    console.error('Render Error:', err);
    btnRender.classList.remove('rendering');
    consoleLog(`Fatal Error: ${err.message}`, 'error');
  }
}

// ── Toast Notification ──────────────────────────────
let toastTimer;
function showToast(message) {
  if (suppressToastNotifications) return;
  const toast = document.getElementById('render-toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ── Resize Handle ───────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const editorPanel = document.getElementById('editor-panel');
  let isDragging = false;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const newWidth = Math.max(240, Math.min(e.clientX, window.innerWidth * 0.45));
    editorPanel.style.width = `${newWidth}px`;
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ── Save / Load (localStorage) ──────────────────────
function saveFile() {
  const filename = document.getElementById('filename').textContent.trim() || 'untitled.scad';
  const code = editor.state.doc.toString();
  const saves = JSON.parse(localStorage.getItem('scad_saves') || '{}');
  saves[filename] = { code, date: new Date().toISOString() };
  localStorage.setItem('scad_saves', JSON.stringify(saves));
  showToast(`✓ Saved "${filename}"`);
  consoleLog(`Saved file: ${filename}`, 'success');
}

function loadFile(filename) {
  const saves = JSON.parse(localStorage.getItem('scad_saves') || '{}');
  if (saves[filename]) {
    setEditorContent(saves[filename].code);
    document.getElementById('filename').textContent = filename;
    showToast(`✓ Loaded "${filename}"`);
    consoleLog(`Loaded file: ${filename}`, 'info');
    closeModal('load-modal');
  }
}

function deleteFile(filename) {
  const saves = JSON.parse(localStorage.getItem('scad_saves') || '{}');
  delete saves[filename];
  localStorage.setItem('scad_saves', JSON.stringify(saves));
  showSavedFiles();
  showToast(`Deleted "${filename}"`);
}

function showSavedFiles() {
  const saves = JSON.parse(localStorage.getItem('scad_saves') || '{}');
  const list = document.getElementById('saved-files-list');
  const empty = document.getElementById('load-modal-empty');
  const keys = Object.keys(saves);

  if (keys.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = keys.map(name => {
    const d = new Date(saves[name].date);
    const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="saved-file-item" data-name="${escapeHtml(name)}">
      <div>
        <div class="saved-file-item__name">${escapeHtml(name)}</div>
        <div class="saved-file-item__date">${dateStr}</div>
      </div>
      <button class="saved-file-item__delete" data-delete="${escapeHtml(name)}" title="Delete">🗑</button>
    </div>`;
  }).join('');

  // Bind clicks
  list.querySelectorAll('.saved-file-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.saved-file-item__delete')) return;
      loadFile(item.dataset.name);
    });
  });
  list.querySelectorAll('.saved-file-item__delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFile(btn.dataset.delete);
    });
  });
}

function setEditorContent(code) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: code },
  });
  updateAnimationUI(code);
}

function filenameFromGalleryTitle(title) {
  const base = String(title || 'gallery design')
    .replace(/\.scad$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'gallery_design';

  return `${base}.scad`;
}

function getPublishDisplayName(user) {
  const metadata = user?.user_metadata || {};
  const name = metadata.name || metadata.full_name || metadata.display_name || metadata.preferred_username;
  if (name && String(name).trim()) return String(name).trim();

  const emailName = user?.email?.split('@')[0];
  return emailName ? emailName.trim() : '';
}

async function loadGalleryModelFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const handoffItem = takeGalleryHandoff(params.get('gallery_open'));
  if (handoffItem) {
    try {
      applyGalleryItemToEditor(handoffItem);
      return true;
    } catch (err) {
      showToast('Gallery load failed: ' + err.message);
      consoleLog(`Gallery handoff failed: ${err.message}`, 'error');
      return false;
    }
  }

  const galleryId = params.get('gallery_id');
  if (!galleryId) return false;

  if (!isSupabaseConfigured()) {
    showToast('Database not configured. Cannot load gallery design.');
    consoleLog('Gallery load skipped: Supabase is not configured', 'error');
    return false;
  }

  try {
    showToast('Loading gallery design...');
    const item = await getGalleryItem(galleryId);
    if (!item) throw new Error('Gallery design not found.');

    applyGalleryItemToEditor(item);
    return true;
  } catch (err) {
    showToast('Gallery load failed: ' + err.message);
    consoleLog(`Gallery load failed: ${err.message}`, 'error');
    return false;
  }
}

function takeGalleryHandoff(token) {
  if (!token) return null;

  const key = `${GALLERY_HANDOFF_PREFIX}${token}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    localStorage.removeItem(key);
    const item = JSON.parse(raw);
    const ageMs = Date.now() - Number(item.handoff_at || 0);
    if (!Number.isFinite(ageMs) || ageMs > 30 * 60 * 1000) return null;
    return item;
  } catch (err) {
    localStorage.removeItem(key);
    consoleLog(`Gallery handoff failed: ${err.message}`, 'error');
    return null;
  }
}

function applyGalleryItemToEditor(item) {
  const code = String(item?.scad_code || '');
  if (!code.trim()) throw new Error('Gallery design has no SCAD code.');

  setEditorContent(code);
  document.getElementById('filename').textContent = filenameFromGalleryTitle(item.title);
  currentProjectId = null;
  showCodeEditorTab({ showWarning: false });
  editor?.focus();

  const title = item.title || 'Untitled Design';
  showToast(`Loaded "${title}"`);
  consoleLog(`Loaded gallery design: ${title}`, 'success');
}

// ── Screenshot Export ────────────────────────────────
function exportScreenshot() {
  if (!scene3d) return;
  try {
    scene3d.renderer.render(scene3d.scene, scene3d.camera);
    const dataURL = scene3d.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataURL;
    const baseName = (document.getElementById('filename').textContent || 'screenshot').replace(/\.scad$/i, '');
    a.download = `${baseName}.png`;
    a.click();
    showToast('✓ Screenshot saved');
    consoleLog('Screenshot exported as PNG', 'success');
  } catch (err) {
    showToast('✗ Screenshot failed');
    consoleLog(`Screenshot error: ${err.message}`, 'error');
  }
}

// ── STL Export ───────────────────────────────────────
function exportSTL() {
  if (!scene3d || !scene3d.modelGroup || scene3d.modelGroup.children.length === 0) {
    showToast('✗ Nothing to export');
    return;
  }
  try {
    showToast('Exporting STL...');
    const exporter = new STLExporter();
    const exportGroup = new THREE.Group();
    scene3d.modelGroup.traverse((child) => {
      if (child.isMesh && !child.userData.isWireframe) {
        exportGroup.add(child.clone());
      }
    });

    const stlString = exporter.parse(exportGroup);
    const blob = new Blob([stlString], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const baseName = (document.getElementById('filename').textContent || 'model.scad').replace(/\.scad$/i, '');
    a.download = `${baseName}.stl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✓ STL exported');
    consoleLog('STL exported successfully', 'success');
  } catch (err) {
    console.error('Export Error:', err);
    showToast('✗ Export error');
    consoleLog(`Export error: ${err.message}`, 'error');
  }
}

// ── OBJ Export ───────────────────────────────────────
function exportOBJ() {
  if (!scene3d || !scene3d.modelGroup || scene3d.modelGroup.children.length === 0) {
    showToast('✗ Nothing to export');
    return;
  }
  try {
    showToast('Exporting OBJ...');
    const exporter = new OBJExporter();
    const exportGroup = new THREE.Group();
    scene3d.modelGroup.traverse((child) => {
      if (child.isMesh && !child.userData.isWireframe) {
        exportGroup.add(child.clone());
      }
    });

    const objString = exporter.parse(exportGroup);
    const blob = new Blob([objString], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const baseName = (document.getElementById('filename').textContent || 'model.scad').replace(/\.scad$/i, '');
    a.download = `${baseName}.obj`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✓ OBJ exported');
    consoleLog('OBJ exported successfully', 'success');
  } catch (err) {
    console.error('OBJ Export Error:', err);
    showToast('✗ OBJ export error');
    consoleLog(`OBJ export error: ${err.message}`, 'error');
  }
}

// ── SCAD Download ────────────────────────────────────
function exportSCAD() {
  const code = getEditorContent();
  if (!code.trim()) {
    showToast('✗ No code to download');
    return;
  }
  try {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    const filename = (document.getElementById('filename').textContent || 'model.scad').trim();
    a.download = filename.endsWith('.scad') ? filename : `${filename}.scad`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✓ SCAD file downloaded');
    consoleLog('SCAD source file downloaded', 'success');
  } catch (err) {
    console.error('SCAD Download Error:', err);
    showToast('✗ Download error');
    consoleLog(`SCAD download error: ${err.message}`, 'error');
  }
}

// ── Modals ───────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('visible');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('visible');
}

// ── Templates ────────────────────────────────────────
function initTemplates() {
  const list = document.getElementById('templates-list');
  list.innerHTML = TEMPLATES.map((t, i) =>
    `<div class="template-card" data-idx="${i}">
      <div class="template-card__icon">${t.icon}</div>
      <div class="template-card__name">${t.name}</div>
      <div class="template-card__desc">${t.desc}</div>
    </div>`
  ).join('');

  list.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx);
      const t = TEMPLATES[idx];
      setEditorContent(t.code);
      document.getElementById('filename').textContent = t.name.toLowerCase().replace(/\s+/g, '_') + '.scad';
      document.getElementById('templates-sidebar').classList.remove('visible');
      showToast(`✓ Loaded template: ${t.name}`);
      consoleLog(`Template loaded: ${t.name}`, 'info');
      setTimeout(() => renderModel(), 100);
    });
  });
}

// ── Generation History (guest mode / localStorage) ───────
function addToHistory(prompt, model, code) {
  // If signed in, auto-save to cloud instead
  if (currentUser && currentProjectId) {
    updateProject(currentProjectId, { code, name: document.getElementById('filename').textContent.trim() }).catch(() => {});
  }

  const hist = JSON.parse(localStorage.getItem('scad_history') || '[]');
  hist.unshift({
    id: Date.now().toString() + Math.floor(Math.random() * 1000).toString(),
    prompt, model, code,
    date: new Date().toISOString()
  });
  if (hist.length > 50) hist.length = 50;
  localStorage.setItem('scad_history', JSON.stringify(hist));
  renderSidebarList();
}

function renderLocalHistoryList(list) {
  const hist = JSON.parse(localStorage.getItem('scad_history') || '[]');
  if (hist.length === 0) {
    list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem; line-height: 1.5;">No generations yet.<br/>Use the AI Chat to generate code.</div>';
    return;
  }
  list.innerHTML = hist.map(item => {
    const d = new Date(item.date);
    const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const shortPrompt = item.prompt.length > 40 ? item.prompt.substring(0, 40) + '...' : item.prompt;
    return `<div class="template-card history-card" data-id="${item.id}">
      <div class="template-card__icon">🤖</div>
      <div class="template-card__name">${escapeHtml(shortPrompt)}</div>
      <div class="template-card__desc">${escapeHtml(item.model)} • ${dateStr}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.history-card').forEach(card => {
    card.addEventListener('click', () => {
      const h = JSON.parse(localStorage.getItem('scad_history') || '[]');
      const item = h.find(i => i.id === card.dataset.id);
      if (item) {
        setEditorContent(item.code);
        document.getElementById('history-sidebar').classList.remove('visible');
        showToast('✓ Restored generation');
        consoleLog('Restored code from history', 'info');
        setTimeout(() => renderModel(), 100);
      }
    });
  });
}

// ── Cloud Projects (signed-in mode) ─────────────────
async function renderCloudProjectsList(list) {
  try {
    const [myProjects, sharedProjects] = await Promise.all([getMyProjects(), getSharedProjects()]);
    let html = '';

    if (myProjects.length === 0 && sharedProjects.length === 0) {
      html = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem; line-height: 1.5;">No projects yet.<br/>Click "+ New Project" to start.</div>';
      list.innerHTML = html;
      return;
    }

    if (myProjects.length > 0) {
      html += '<div style="padding: 6px 12px 4px; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); font-weight:700;">My Projects</div>';
      html += myProjects.map(p => {
        const d = new Date(p.updated_at);
        const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isActive = p.id === currentProjectId;
        return `<div class="template-card history-card ${isActive ? 'active-project' : ''}" data-project-id="${p.id}">
          <div class="template-card__icon">📄</div>
          <div class="template-card__name">${escapeHtml(p.name)}</div>
          <div class="template-card__desc">Updated ${dateStr}</div>
          <div class="project-card__actions">
            <button class="project-card__share" data-share-id="${p.id}" title="Share">🔗 Share</button>
            <button class="project-card__delete" data-del-id="${p.id}" title="Delete">🗑 Delete</button>
          </div>
        </div>`;
      }).join('');
    }

    if (sharedProjects.length > 0) {
      html += '<div style="padding: 12px 12px 4px; font-size:0.68rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-muted); font-weight:700;">Shared with me</div>';
      html += sharedProjects.map(p => {
        const d = new Date(p.updated_at);
        const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="template-card history-card" data-project-id="${p.id}">
          <div class="template-card__icon">📄</div>
          <div class="template-card__name">${escapeHtml(p.name)} <span class="project-card__shared-badge">👥 Shared</span></div>
          <div class="template-card__desc">Updated ${dateStr}</div>
        </div>`;
      }).join('');
    }

    list.innerHTML = html;

    // Bind click-to-load on project cards
    list.querySelectorAll('[data-project-id]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.project-card__share') || e.target.closest('.project-card__delete')) return;
        const pid = card.dataset.projectId;
        const allProjects = [...myProjects, ...sharedProjects];
        const proj = allProjects.find(p => p.id === pid);
        if (proj) {
          setEditorContent(proj.code || '');
          document.getElementById('filename').textContent = proj.name;
          currentProjectId = proj.id;
          document.getElementById('history-sidebar').classList.remove('visible');
          showToast(`✓ Opened "${proj.name}"`);
          consoleLog(`Opened project: ${proj.name}`, 'info');
          setTimeout(() => renderModel(), 100);
        }
      });
    });

    // Bind share buttons
    list.querySelectorAll('.project-card__share').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openShareModal(btn.dataset.shareId);
      });
    });

    // Bind delete buttons
    list.querySelectorAll('.project-card__delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pid = btn.dataset.delId;
        if (!confirm('Delete this project permanently?')) return;
        try {
          await deleteCloudProject(pid);
          if (currentProjectId === pid) currentProjectId = null;
          showToast('✓ Project deleted');
          renderSidebarList();
        } catch (err) {
          showToast(`✗ ${err.message}`);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="padding: 24px; text-align: center; color: #f87171; font-size: 0.8rem;">✗ ${escapeHtml(err.message)}</div>`;
  }
}

function renderSidebarList() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (currentUser) {
    renderCloudProjectsList(list);
  } else {
    renderLocalHistoryList(list);
  }
}

function initHistory() {
  renderSidebarList();
}

function switchWorkspaceTab(activeTabId, { showWarning = true } = {}) {
  const tabChat = document.getElementById('tab-chat');
  const tabCode = document.getElementById('tab-code');
  const tabConsole = document.getElementById('tab-console');

  const chatContainer = document.getElementById('chat-container');
  const editorContainer = document.getElementById('editor-container');
  const consoleContainer = document.getElementById('console-container');

  if (!tabChat || !tabCode || !tabConsole || !chatContainer || !editorContainer || !consoleContainer) return;

  tabChat.classList.toggle('active', activeTabId === 'tab-chat');
  tabCode.classList.toggle('active', activeTabId === 'tab-code');
  tabConsole.classList.toggle('active', activeTabId === 'tab-console');

  chatContainer.style.display = activeTabId === 'tab-chat' ? '' : 'none';
  editorContainer.style.display = activeTabId === 'tab-code' ? '' : 'none';
  consoleContainer.style.display = activeTabId === 'tab-console' ? '' : 'none';

  if (activeTabId === 'tab-console') {
    updateConsoleUI();
  }

  if (activeTabId === 'tab-code' && showWarning) {
    if (!localStorage.getItem('scaid_code_warning_seen')) {
      localStorage.setItem('scaid_code_warning_seen', 'true');
      openModal('code-warning-modal');
    }
  }
}

function showCodeEditorTab(options = {}) {
  switchWorkspaceTab('tab-code', options);
}

// ── Tab Switching ────────────────────────────────────
function initTabs() {
  const tabChat = document.getElementById('tab-chat');
  const tabCode = document.getElementById('tab-code');
  const tabConsole = document.getElementById('tab-console');
  
  const chatContainer = document.getElementById('chat-container');
  const editorContainer = document.getElementById('editor-container');
  const consoleContainer = document.getElementById('console-container');

  function switchTab(activeTabId) {
    tabChat.classList.toggle('active', activeTabId === 'tab-chat');
    tabCode.classList.toggle('active', activeTabId === 'tab-code');
    tabConsole.classList.toggle('active', activeTabId === 'tab-console');

    chatContainer.style.display = activeTabId === 'tab-chat' ? '' : 'none';
    editorContainer.style.display = activeTabId === 'tab-code' ? '' : 'none';
    consoleContainer.style.display = activeTabId === 'tab-console' ? '' : 'none';

    if (activeTabId === 'tab-console') {
      updateConsoleUI();
    }

    if (activeTabId === 'tab-code') {
      if (!localStorage.getItem('scaid_code_warning_seen')) {
        localStorage.setItem('scaid_code_warning_seen', 'true');
        openModal('code-warning-modal');
      }
    }
  }

  if (tabChat) tabChat.addEventListener('click', () => switchTab('tab-chat'));
  if (tabCode) tabCode.addEventListener('click', () => switchTab('tab-code'));
  if (tabConsole) tabConsole.addEventListener('click', () => switchTab('tab-console'));

  const warningClose = document.getElementById('code-warning-close');
  const warningOk = document.getElementById('code-warning-ok');
  if (warningClose) warningClose.addEventListener('click', () => closeModal('code-warning-modal'));
  if (warningOk) warningOk.addEventListener('click', () => closeModal('code-warning-modal'));
}

function initAIChat() {
  const chatInput = document.getElementById('ai-chat-input');
  const generateButton = document.getElementById('btn-ai-generate');
  const faceEditInput = document.getElementById('face-edit-input');
  const faceEditApply = document.getElementById('face-edit-apply');
  const quickEditInput = document.getElementById('face-edit-value');
  const quickEditApply = document.getElementById('face-edit-quick-apply');
  const quickEditMinus = document.getElementById('face-edit-quick-minus');
  const quickEditPlus = document.getElementById('face-edit-quick-plus');
  const faceEditClose = document.getElementById('face-edit-close');

  if (faceEditClose) faceEditClose.textContent = 'x';

  async function runGenerate() {
    if (!chatInput) return;
    const prompt = chatInput.value.trim();
    if (!prompt) {
      showToast('Enter a prompt first');
      return;
    }

    // Clear input immediately to fix the text lingering glitch
    chatInput.value = '';
    chatInput.style.height = 'auto';

    const chatHistory = document.getElementById('chat-history');
    
    const editorAiToast = document.getElementById('editor-ai-toast');
    if (editorAiToast) {
      editorAiToast.style.opacity = '1';
      editorAiToast.style.transform = 'translateX(-50%) translateY(0)';
      setTimeout(() => {
        editorAiToast.style.opacity = '0';
        editorAiToast.style.transform = 'translateX(-50%) translateY(20px)';
      }, 6000);
    }

    if (chatHistory) {
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-message chat-message--user';
      userBubble.textContent = prompt;
      chatHistory.appendChild(userBubble);
      
      const loadingBubble = document.createElement('div');
      loadingBubble.className = 'chat-message chat-message--assistant';
      loadingBubble.id = 'chat-loading-bubble';
      loadingBubble.innerHTML = '<span class="status-indicator__dot status-indicator__dot--warning" style="display:inline-block; margin-right:6px; vertical-align:middle;"></span><span style="vertical-align:middle;">Generating...</span>';
      chatHistory.appendChild(loadingBubble);
      
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    if (generateButton) {
      generateButton.disabled = true;
      generateButton.innerHTML = '...';
    }
    
    updateAIStatus('Asking AI... (this can take up to 4 minutes, do not be concerned)');
    consoleLog('Sending prompt to AI model', 'info');

    try {
      const result = await requestScadFromApi('/api/chat/generate', {
        prompt,
        currentCode: getEditorContent(),
      });
      applyGeneratedCode(result.scadCode, 'AI');
      addToHistory(prompt, 'AI', result.scadCode);
      updateAIStatus('Generated with AI.');
      
      const loadingBubble = document.getElementById('chat-loading-bubble');
      if (loadingBubble) {
        loadingBubble.id = '';
        loadingBubble.innerHTML = `✓ Generated successfully with AI.`;
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }
    } catch (err) {
      const msg = err?.message || 'AI request failed.';
      showToast(`✕ ${msg}`);
      updateAIStatus(msg);
      consoleLog(`AI error: ${msg}`, 'error');
      
      const loadingBubble = document.getElementById('chat-loading-bubble');
      if (loadingBubble) {
        loadingBubble.id = '';
        loadingBubble.innerHTML = `<span style="color:#f87171;">✕ ${msg}</span>`;
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }
    } finally {
      if (generateButton) {
        generateButton.disabled = false;
        generateButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
      }
    }
  }

  async function runFaceEdit() {
    if (!selectedFaceContext) {
      showToast('Select a face first');
      return;
    }
    if (!faceEditInput) return;

    const prompt = faceEditInput.value.trim();
    if (!prompt) {
      showToast('Describe the face edit first');
      return;
    }

    setButtonBusy('face-edit-apply', true, 'Applying...', 'Use AI');
    updateAIStatus('Asking AI to patch area... (this can take up to 4 minutes, do not be concerned)');
    consoleLog('Sending face-edit prompt to AI model', 'info');

    try {
      const result = await requestScadFromApi('/api/chat/face-edit', {
        prompt,
        selection: selectedFaceContext,
        currentCode: getEditorContent(),
      });
      applyGeneratedCode(result.scadCode, 'AI');
      addToHistory(prompt, 'AI', result.scadCode);
      updateAIStatus('Face edit applied with AI.');
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      selectedQuickEditSpec = null;
      updateFaceHint('Face edit applied. Click another face to keep tuning the model.');
    } catch (err) {
      const msg = err?.message || 'Face edit failed.';
      showToast(`✕ ${msg}`);
      updateAIStatus(msg);
      consoleLog(`Face edit error: ${msg}`, 'error');
    } finally {
      setButtonBusy('face-edit-apply', false, 'Applying...', 'Use AI');
    }
  }

  function runQuickFaceEdit() {
    if (!selectedFaceContext) {
      showToast('Select a face first');
      return;
    }
    if (!quickEditInput) return;

    const nextValue = quickEditInput.value.trim();
    if (!nextValue) {
      showToast('Enter a new value first');
      return;
    }

    setButtonBusy('face-edit-quick-apply', true, 'Applying...', 'Apply Quick Edit');
    updateAIStatus('Applying quick edit locally...');
    consoleLog('Applying local quick edit', 'info');

    try {
      const result = applySimpleFaceEdit(getEditorContent(), selectedFaceContext, nextValue);
      setEditorContent(result.updatedSource);
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      selectedQuickEditSpec = null;
      updateFaceHint('Quick edit applied. Click another face to keep tuning the model.');
      updateAIStatus('Quick edit applied locally.');
      showToast(`Updated ${result.spec.label} locally`);
      consoleLog(`Quick edit applied to ${result.spec.label}`, 'success');
      renderModel();
    } catch (err) {
      const msg = err?.message || 'Quick edit failed.';
      showToast(msg);
      updateAIStatus(msg);
      consoleLog(`Quick edit error: ${msg}`, 'error');
      refreshQuickEditUI(selectedFaceContext);
    } finally {
      setButtonBusy('face-edit-quick-apply', false, 'Applying...', 'Apply Quick Edit');
    }
  }

  if (generateButton) {
    generateButton.addEventListener('click', runGenerate);
  }

  if (chatInput) {
    // Enter sends, Shift+Enter adds newline
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runGenerate();
      }
    });

    // Auto-resize textarea as user types
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
    });
  }

  if (faceEditApply) {
    faceEditApply.addEventListener('click', runFaceEdit);
  }

  if (quickEditApply) {
    quickEditApply.addEventListener('click', runQuickFaceEdit);
  }

  if (faceEditInput) {
    faceEditInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runFaceEdit();
      }
    });
  }

  if (quickEditInput) {
    quickEditInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runQuickFaceEdit();
      }
    });
  }

  if (quickEditMinus) {
    quickEditMinus.addEventListener('click', () => nudgeQuickEditValue(-1));
  }

  if (quickEditPlus) {
    quickEditPlus.addEventListener('click', () => nudgeQuickEditValue(1));
  }

  if (faceEditClose) {
    faceEditClose.addEventListener('click', () => {
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      selectedQuickEditSpec = null;
      updateFaceHint('Click a face to quickly change simple dimensions or use AI for bigger edits.');
    });
  }
}

// ── Toolbar Buttons ─────────────────────────────────
function initToolbar() {
  document.getElementById('btn-render').addEventListener('click', renderModel);

  // Export dropdown toggle
  const exportDropdown = document.getElementById('export-dropdown');
  const exportBtn = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!exportDropdown.contains(e.target)) {
      exportDropdown.classList.remove('open');
    }
  });

  document.getElementById('export-stl').addEventListener('click', () => {
    exportDropdown.classList.remove('open');
    exportSTL();
  });

  document.getElementById('export-obj').addEventListener('click', () => {
    exportDropdown.classList.remove('open');
    exportOBJ();
  });

  document.getElementById('export-scad').addEventListener('click', () => {
    exportDropdown.classList.remove('open');
    exportSCAD();
  });

  document.getElementById('btn-screenshot').addEventListener('click', exportScreenshot);
  document.getElementById('btn-save').addEventListener('click', saveFile);
  
  // Hook up Gallery Publish button logic
  initGalleryPublish();

  document.getElementById('btn-load').addEventListener('click', () => {
    showSavedFiles();
    openModal('load-modal');
  });

  document.getElementById('btn-templates').addEventListener('click', () => {
    document.getElementById('templates-sidebar').classList.toggle('visible');
    document.getElementById('history-sidebar').classList.remove('visible');
  });

  document.getElementById('templates-close').addEventListener('click', () => {
    document.getElementById('templates-sidebar').classList.remove('visible');
  });

  document.getElementById('btn-history').addEventListener('click', () => {
    document.getElementById('history-sidebar').classList.toggle('visible');
    document.getElementById('templates-sidebar').classList.remove('visible');
  });

  document.getElementById('history-close').addEventListener('click', () => {
    document.getElementById('history-sidebar').classList.remove('visible');
  });

  document.getElementById('btn-shortcuts').addEventListener('click', () => {
    openModal('shortcut-modal');
  });

  // Modal close buttons
  document.getElementById('modal-close').addEventListener('click', () => closeModal('shortcut-modal'));
  document.getElementById('load-modal-close').addEventListener('click', () => closeModal('load-modal'));

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });
  });

  // Wireframe toggle
  document.getElementById('btn-wireframe').addEventListener('click', () => {
    const isWire = scene3d.toggleWireframe();
    document.getElementById('btn-wireframe').classList.toggle('active', isWire);
  });

  // Grid toggle
  document.getElementById('btn-grid').addEventListener('click', () => {
    const isVisible = scene3d.toggleGrid();
    document.getElementById('btn-grid').classList.toggle('active', isVisible);
  });

  // Reset camera
  document.getElementById('btn-reset-camera').addEventListener('click', () => setViewportView('iso'));

  // View presets
  Object.entries(VIEW_PRESETS).forEach(([view, preset]) => {
    document.getElementById(preset.buttonId).addEventListener('click', () => setViewportView(view));
  });

  // Mobile Code Toggle
  const btnMobileCode = document.getElementById('btn-mobile-code');
  if (btnMobileCode) {
    btnMobileCode.addEventListener('click', () => {
      document.body.classList.toggle('mobile-code-active');
      const isActive = document.body.classList.contains('mobile-code-active');
      btnMobileCode.classList.toggle('active', isActive);
    });
  }
}

// ── Keyboard Shortcuts ──────────────────────────────
function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const inCodeEditor = target.closest && target.closest('.cm-editor');
    const inTextInput = target instanceof HTMLElement
      && (inCodeEditor || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

    // Ctrl+Enter — render
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      renderModel();
      return;
    }

    // Ctrl+S — save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
      return;
    }

    // Ctrl+E — toggle export dropdown
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      const exportDropdown = document.getElementById('export-dropdown');
      if (exportDropdown) exportDropdown.classList.toggle('open');
      return;
    }

    // Ctrl+Shift+S — screenshot
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      exportScreenshot();
      return;
    }

    // Escape — close modals/sidebars
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.visible').forEach(m => m.classList.remove('visible'));
      document.getElementById('templates-sidebar').classList.remove('visible');
      document.getElementById('history-sidebar').classList.remove('visible');
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      selectedQuickEditSpec = null;
      updateFaceHint('Click a face to quickly change simple dimensions or use AI for bigger edits.');
      return;
    }

    // Don't trigger single-key shortcuts while typing in editor
    if (inTextInput) return;

    // ? — show shortcuts
    if (e.key === '?') {
      openModal('shortcut-modal');
      return;
    }

    // Single-key viewport shortcuts
    if (e.key === 'f' || e.key === 'F') { setViewportView('front'); return; }
    if (e.key === 't') { setViewportView('top'); return; }
    if (e.key === 'r') { setViewportView('right'); return; }
    if (e.key === 'i') { setViewportView('iso'); return; }
    if (e.key === 'w') {
      const isWire = scene3d.toggleWireframe();
      document.getElementById('btn-wireframe').classList.toggle('active', isWire);
      return;
    }
    if (e.key === 'g') {
      const isVisible = scene3d.toggleGrid();
      document.getElementById('btn-grid').classList.toggle('active', isVisible);
      return;
    }
  });
}

// ── Loading Screen ──────────────────────────────────
function hideLoadingScreen() {
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    setTimeout(() => loadingScreen.classList.add('hidden'), 200);
  }
}

// ── Auth Gate (replaces old welcome popup) ──────────
let shareTargetProjectId = null;

function openShareModal(projectId) {
  shareTargetProjectId = projectId;
  const emailInput = document.getElementById('share-email-input');
  const canEditCheck = document.getElementById('share-can-edit');
  const statusEl = document.getElementById('share-status');
  if (emailInput) emailInput.value = '';
  if (canEditCheck) canEditCheck.checked = false;
  if (statusEl) statusEl.textContent = '';
  openModal('share-modal');
}

function initShareModal() {
  const closeBtn = document.getElementById('share-modal-close');
  const cancelBtn = document.getElementById('share-cancel');
  const confirmBtn = document.getElementById('share-confirm');

  function close() { closeModal('share-modal'); shareTargetProjectId = null; }
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const email = document.getElementById('share-email-input')?.value.trim();
      const canEdit = document.getElementById('share-can-edit')?.checked || false;
      const statusEl = document.getElementById('share-status');
      if (!email) { if (statusEl) statusEl.textContent = 'Please enter an email address.'; return; }
      if (!shareTargetProjectId) return;

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Sharing...';
      try {
        await shareProjectByEmail(shareTargetProjectId, email, canEdit);
        if (statusEl) statusEl.textContent = `✓ Shared with ${email}`;
        showToast(`✓ Project shared with ${email}`);
        setTimeout(close, 1500);
      } catch (err) {
        if (statusEl) statusEl.textContent = `✗ ${err.message}`;
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Share';
      }
    });
  }
}

function updateToolbarAuth(user) {
  const authBtn = document.getElementById('btn-auth');
  const userEl = document.getElementById('toolbar-user');
  const avatarEl = document.getElementById('toolbar-avatar');
  const nameEl = document.getElementById('toolbar-user-name');
  const sidebarTitle = document.getElementById('sidebar-title');
  const projectsActions = document.getElementById('projects-actions');

  if (user) {
    if (authBtn) authBtn.style.display = 'none';
    if (userEl) userEl.style.display = 'flex';
    if (avatarEl) avatarEl.src = user.user_metadata?.avatar_url || '';
    if (nameEl) nameEl.textContent = user.user_metadata?.full_name || user.email || 'User';
    if (sidebarTitle) sidebarTitle.textContent = '📁 Projects';
    if (projectsActions) projectsActions.style.display = 'flex';
  } else {
    if (authBtn) authBtn.style.display = '';
    if (userEl) userEl.style.display = 'none';
    if (sidebarTitle) sidebarTitle.textContent = '🕒 History';
    if (projectsActions) projectsActions.style.display = 'none';
  }
}

function initAuthGate() {
  const GATE_KEY = 'scaid_auth_choice';

  // Wire up toolbar auth button
  const authBtn = document.getElementById('btn-auth');
  if (authBtn) {
    authBtn.addEventListener('click', () => {
      showSignInChoices();
      openModal('welcome-modal');
    });
  }

  // Wire up toolbar sign-out
  const signoutBtn = document.getElementById('btn-signout');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      try {
        await signOut();
        currentUser = null;
        currentProjectId = null;
        sessionStorage.removeItem(GATE_KEY);
        localStorage.removeItem(GATE_KEY);
        updateToolbarAuth(null);
        renderSidebarList();
        showToast('Signed out');
      } catch (err) {
        showToast(`✗ ${err.message}`);
      }
    });
  }

  // Wire up new project button
  const newProjectBtn = document.getElementById('btn-new-project');
  if (newProjectBtn) {
    newProjectBtn.addEventListener('click', async () => {
      if (!currentUser) return;
      try {
        const proj = await createProject('Untitled.scad', '');
        currentProjectId = proj.id;
        setEditorContent('');
        document.getElementById('filename').textContent = 'Untitled.scad';
        showToast('✓ New project created');
        renderSidebarList();
      } catch (err) {
        showToast(`✗ ${err.message}`);
      }
    });
  }

  // Wire up save project button
  const saveProjectBtn = document.getElementById('btn-save-project');
  if (saveProjectBtn) {
    saveProjectBtn.addEventListener('click', async () => {
      if (!currentUser) return;
      const code = getEditorContent();
      const name = document.getElementById('filename').textContent.trim() || 'Untitled.scad';
      try {
        if (currentProjectId) {
          await updateProject(currentProjectId, { code, name });
          showToast(`✓ Saved "${name}"`);
        } else {
          const proj = await createProject(name, code);
          currentProjectId = proj.id;
          showToast(`✓ Saved "${name}" to cloud`);
        }
        renderSidebarList();
      } catch (err) {
        showToast(`✗ ${err.message}`);
      }
    });
  }

  // Listen for auth state changes (handles OAuth redirect)
  onAuthChange(async (session) => {
    if (session?.user) {
      currentUser = session.user;
      localStorage.setItem(GATE_KEY, 'account');
      updateToolbarAuth(currentUser);
      renderSidebarList();
      closeModal('welcome-modal');
      highlightAIPanel();
    }
  });

  // Check if already authenticated or has made a choice
  (async () => {
    const session = await getSession();
    if (session?.user) {
      currentUser = session.user;
      updateToolbarAuth(currentUser);
      renderSidebarList();
      return; // already signed in, skip gate
    }

    const choice = localStorage.getItem(GATE_KEY) || sessionStorage.getItem(GATE_KEY);
    if (choice === 'guest' || choice === 'account') return; // already chose

    // Show auth gate modal after brief delay
    setTimeout(() => openModal('welcome-modal'), 800);
  })();

  // Wire up auth gate buttons
  const guestBtn = document.getElementById('auth-guest');
  const signinBtn = document.getElementById('auth-signin');
  const backBtn = document.getElementById('auth-back');
  const closeBtn = document.getElementById('welcome-modal-close');
  const choices = document.querySelector('.auth-gate__choices');
  const signinView = document.getElementById('auth-signin-view');
  
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const btnEmailSignIn = document.getElementById('btn-email-signin');
  const btnEmailSignUp = document.getElementById('btn-email-signup');
  const authStatus = document.getElementById('auth-status');

  // Wire up Avatar Upload
  const avatarWrapper = document.getElementById('btn-avatar-upload');
  const avatarInput = document.getElementById('avatar-input');
  
  if (avatarWrapper && avatarInput) {
    avatarWrapper.addEventListener('click', () => {
      avatarInput.click();
    });

    avatarInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const overlaySpan = avatarWrapper.querySelector('.toolbar__avatar-overlay span');
      if (overlaySpan) overlaySpan.textContent = '...';
      avatarWrapper.classList.add('uploading');

      try {
        const publicUrl = await uploadAvatar(file);
        const avatarImage = document.getElementById('toolbar-avatar');
        if (avatarImage) avatarImage.src = publicUrl;
        
        // Update current user state with new URL
        if (currentUser) {
          currentUser.user_metadata = currentUser.user_metadata || {};
          currentUser.user_metadata.avatar_url = publicUrl;
        }

        showToast('✓ Avatar updated successfully');
      } catch (err) {
        showToast(`✗ Failed to upload avatar: ${err.message}`);
      } finally {
        avatarWrapper.classList.remove('uploading');
        if (overlaySpan) overlaySpan.textContent = '+';
        avatarInput.value = ''; // Custom Reset
      }
    });
  }

  function showSignInChoices() {
    if (choices) choices.style.display = 'flex';
    if (signinView) signinView.style.display = 'none';
    if (authStatus) {
      authStatus.textContent = '';
      authStatus.className = 'auth-gate__status';
    }
    if (emailInput) emailInput.value = '';
    if (passwordInput) passwordInput.value = '';
  }

  function dismissAsGuest() {
    sessionStorage.setItem(GATE_KEY, 'guest');
    closeModal('welcome-modal');
    highlightAIPanel();
  }

  if (guestBtn) guestBtn.addEventListener('click', dismissAsGuest);
  if (closeBtn) closeBtn.addEventListener('click', dismissAsGuest);

  if (signinBtn) {
    signinBtn.addEventListener('click', () => {
      if (choices) choices.style.display = 'none';
      if (signinView) signinView.style.display = 'flex';
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', showSignInChoices);
  }

  async function handleAuth(action, btn) {
    const email = emailInput?.value.trim();
    const password = passwordInput?.value.trim();
    if (!email || !password) {
      authStatus.textContent = 'Please enter email and password';
      authStatus.className = 'auth-gate__status error';
      return;
    }
    
    authStatus.textContent = 'Authenticating...';
    authStatus.className = 'auth-gate__status';
    btn.disabled = true;

    try {
      if (action === 'signin') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password);
      }
      
      authStatus.textContent = 'Success!';
      authStatus.className = 'auth-gate__status success';
      
      // onAuthChange listener will handle the modal close and state update
    } catch (err) {
      authStatus.textContent = err.message;
      authStatus.className = 'auth-gate__status error';
    } finally {
      btn.disabled = false;
    }
  }

  if (btnEmailSignIn) {
    btnEmailSignIn.addEventListener('click', () => handleAuth('signin', btnEmailSignIn));
  }
  if (btnEmailSignUp) {
    btnEmailSignUp.addEventListener('click', () => handleAuth('signup', btnEmailSignUp));
  }

  // Overlay click dismisses as guest
  const overlay = document.getElementById('welcome-modal');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismissAsGuest();
    });
  }
}

function highlightAIPanel() {
  const chatTab = document.getElementById('tab-chat');
  const chatContainer = document.getElementById('chat-container');
  if (chatTab && chatContainer) {
    chatTab.click(); // Ensure chat tab is active
    chatContainer.classList.add('highlight-pulse');
    setTimeout(() => chatContainer.classList.remove('highlight-pulse'), 3000);
  }
}

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  consoleLog('SCAD Studio v3.0 initialized', 'info');
  consoleLog('Type SCAD code and press Ctrl+Enter to render', 'info');
  const filenameEl = document.getElementById('filename');
  if (filenameEl) filenameEl.textContent = DEFAULT_FILENAME;

  initEditor();
  initScene();
  initResizeHandle();
  initAnimationControls();
  initToolbar();
  initShortcuts();
  initTabs();
  initAIChat();
  initTemplates();
  initHistory();

  const loadedFromGallery = await loadGalleryModelFromUrl();

  // Hide loading screen
  hideLoadingScreen();

  // Auto-render whichever source is currently in the editor.
  setTimeout(() => renderModel(), loadedFromGallery ? 100 : 400);

  // Init auth system (replaces old welcome popup)
  initAuthGate();
  initShareModal();
});

// ── Gallery Publish ─────────────────────────────────
function initGalleryPublish() {
  const publishDropdown = document.getElementById('publish-dropdown');
  const publishBtn = document.getElementById('btn-publish');
  const publishMenu = document.getElementById('publish-menu');
  const publishSubmit = document.getElementById('btn-publish-submit');
  const nicknameInput = document.getElementById('publish-nickname');
  const titleInput = document.getElementById('publish-title');
  const descInput = document.getElementById('publish-desc');

  if (!publishBtn || !publishMenu) return;

  publishBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    
    // Toggle dropdown
    const isOpen = publishDropdown.classList.contains('open');
    if (isOpen) {
      publishDropdown.classList.remove('open');
      return;
    }

    // 1. Check auth before opening
    if (!isSupabaseConfigured()) {
      showToast('Database not configured. Run Supabase scripts first.');
      return;
    }
    const user = await getUser();
    if (!user) {
      showToast('Please sign in to publish to the gallery.');
      if (typeof initAuthGate === 'function') {
        openModal('welcome-modal');
      }
      return;
    }
    currentUser = user;

    // 2. Automatically infer best default title
    let inferredTitle = document.getElementById('filename').textContent || 'Untitled Design';
    inferredTitle = inferredTitle.replace(/\.scad$/i, '').replace(/_/g, ' ');
    inferredTitle = inferredTitle.replace(/\b\w/g, c => c.toUpperCase());
    
    titleInput.value = inferredTitle;
    descInput.value = '';
    
    // Auto-fill nickname if they have a profile name, else leave blank
    nicknameInput.value = getPublishDisplayName(user);
    
    // 3. Keep other dropdowns closed, open this one
    document.querySelectorAll('.export-dropdown.open').forEach(el => el.classList.remove('open'));
    publishDropdown.classList.add('open');
  });

  // Stop clicks inside the menu from closing the dropdown
  publishMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Close when clicking outside (handled alongside export logic)
  document.addEventListener('click', (e) => {
    if (!publishDropdown.contains(e.target)) {
      publishDropdown.classList.remove('open');
    }
  });

  publishSubmit.addEventListener('click', async () => {
    const nickname = nicknameInput.value.trim() || getPublishDisplayName(currentUser) || 'Anonymous';
    const title = titleInput.value.trim();
    const desc = descInput.value.trim();
    if (!title) {
      showToast('Title is required.');
      return;
    }

    try {
      publishSubmit.disabled = true;
      publishSubmit.textContent = 'Publishing...';

      const code = getEditorContent();
      if (!code.trim()) {
        showToast('Cannot publish an empty model.');
        return;
      }
      
      let thumbnailUrl = null;
      if (scene3d && typeof scene3d.captureScreenshot === 'function') {
        const dataUrl = scene3d.captureScreenshot();
        if (dataUrl) {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          const file = new File([blob], "thumbnail.png", { type: "image/png" });
          
          showToast('Uploading thumbnail...');
          thumbnailUrl = await uploadGalleryThumbnail(file);
        }
      }

      showToast('Publishing design...');
      await publishToGallery(title, desc, code, thumbnailUrl, nickname);

      showToast('✓ Published to Gallery!');
      publishDropdown.classList.remove('open');
      
    } catch (err) {
      console.error(err);
      showToast('✗ Publish failed: ' + err.message);
    } finally {
      publishSubmit.disabled = false;
      publishSubmit.textContent = 'Submit';
    }
  });
}

// -- Mobile Warning Check ----------------------------
window.addEventListener('DOMContentLoaded', () => {
  if (window.innerWidth <= 768) {
    const warned = localStorage.getItem('scaid_mobile_warning_seen');
    if (!warned) {
      localStorage.setItem('scaid_mobile_warning_seen', 'true');
      const mobileModal = document.getElementById('mobile-warning-modal');
      if (mobileModal) {
        mobileModal.classList.add('visible');
      }
    }
  }

  const mobileCloseBtn = document.getElementById('mobile-warning-close');
  const mobileOkBtn = document.getElementById('mobile-warning-ok');
  
  if (mobileCloseBtn) {
    mobileCloseBtn.addEventListener('click', () => {
        const m = document.getElementById('mobile-warning-modal');
        if (m) m.classList.remove('visible');
    });
  }
  if (mobileOkBtn) {
    mobileOkBtn.addEventListener('click', () => {
        const m = document.getElementById('mobile-warning-modal');
        if (m) m.classList.remove('visible');
    });
  }
});

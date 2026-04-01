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
import { createScene, createAxesHUD } from './three-scene.js';
import { DEFAULT_FILENAME, DEFAULT_SAMPLE_CODE } from './default-sample.js';
import { parseSCAD } from './scad-parser.js';
import { TEMPLATES } from './templates.js';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

inject();
injectSpeedInsights();

// ── Sample SCAD Code ────────────────────────────────
const SAMPLE_CODE = DEFAULT_SAMPLE_CODE;

// ── State ───────────────────────────────────────────
let editor;
let scene3d;
let axesHUD;
let selectedFaceContext = null;

// ── Console System ──────────────────────────────────
const consoleLogs = [];
function consoleLog(msg, level = 'info') {
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

function formatSelectionLabel(selection) {
  if (!selection) return 'Click a face in the model to open a targeted AI edit.';
  const primitive = selection.meta?.primitive || selection.meta?.operation || 'geometry';
  const line = selection.meta?.line ? `line ${selection.meta.line}` : 'source hint unavailable';
  return `Selected: ${primitive} (${line}).`;
}

async function requestScadFromApi(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
}

function positionFacePopover(selection) {
  const popover = document.getElementById('face-edit-popover');
  const previewPanel = document.getElementById('preview-panel');
  if (!popover || !previewPanel || !selection?.screenPoint) return;

  const panelRect = previewPanel.getBoundingClientRect();
  const popWidth = 320;
  const popHeight = 220;
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
  const input = document.getElementById('face-edit-input');
  if (!popover || !meta || !input) return;

  const primitive = selection.meta?.primitive || selection.meta?.operation || 'geometry';
  const line = selection.meta?.line ? `line ${selection.meta.line}` : 'line unknown';
  const point = Array.isArray(selection.worldPoint)
    ? selection.worldPoint.map((v) => formatNumber(v)).join(', ')
    : 'n/a';
  const normal = Array.isArray(selection.worldNormal)
    ? selection.worldNormal.map((v) => formatNumber(v)).join(', ')
    : 'n/a';

  meta.textContent = `${primitive} • ${line} • p(${point}) • n(${normal})`;
  input.value = '';
  positionFacePopover(selection);
  popover.classList.add('visible');
  input.focus();
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
        '.cm-activeLineGutter': { background: 'rgba(0,240,255,0.05)' },
        '.cm-activeLine': { background: 'rgba(0,240,255,0.03)' },
        '.cm-cursor': { borderLeftColor: '#00f0ff' },
        '.cm-selectionBackground': { background: 'rgba(0,240,255,0.15) !important' },
        '&.cm-focused .cm-selectionBackground': { background: 'rgba(0,240,255,0.2) !important' },
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
function renderModel() {
  const source = editor.state.doc.toString();
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const infoStatus = document.getElementById('info-status');
  const emptyState = document.getElementById('preview-empty');
  const verticesEl = document.getElementById('status-vertices');
  const facesEl = document.getElementById('status-faces');
  const btnRender = document.getElementById('btn-render');

  try {
    btnRender.classList.add('rendering');
    statusText.textContent = 'Rendering...';
    infoStatus.textContent = 'Rendering...';
    statusDot.className = 'status-indicator__dot status-indicator__dot--warning';

    requestAnimationFrame(() => {
      try {
        const startTime = performance.now();
        const { group, vertexCount, faceCount } = parseSCAD(source);
        const elapsed = (performance.now() - startTime).toFixed(1);

        scene3d.setModel(group);
        selectedFaceContext = null;
        hideFaceEditPopover();
        updateFaceHint('Click a face in the model to open a targeted AI edit.');

        statusText.textContent = `Rendered in ${elapsed}ms`;
        infoStatus.textContent = `Rendered · ${elapsed}ms`;
        statusDot.className = 'status-indicator__dot';
        verticesEl.textContent = `Vertices: ${vertexCount.toLocaleString()}`;
        facesEl.textContent = `Faces: ${faceCount.toLocaleString()}`;
        btnRender.classList.remove('rendering');

        if (emptyState) emptyState.classList.add('hidden');
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
      }
    });
  } catch (err) {
    console.error('Render Error:', err);
    btnRender.classList.remove('rendering');
    consoleLog(`Fatal Error: ${err.message}`, 'error');
  }
}

// ── Toast Notification ──────────────────────────────
let toastTimer;
function showToast(message) {
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

// ── Generation History ───────────────────────────────
function addToHistory(prompt, model, code) {
  const history = JSON.parse(localStorage.getItem('scad_history') || '[]');
  history.unshift({
    id: Date.now().toString() + Math.floor(Math.random() * 1000).toString(),
    prompt: prompt,
    model: model,
    code: code,
    date: new Date().toISOString()
  });
  if (history.length > 50) history.length = 50;
  localStorage.setItem('scad_history', JSON.stringify(history));
  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  if (!list) return;
  const history = JSON.parse(localStorage.getItem('scad_history') || '[]');
  
  if (history.length === 0) {
    list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem; line-height: 1.5;">No generations yet.<br/>Use the AI Chat to generate code.</div>';
    return;
  }

  list.innerHTML = history.map(item => {
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
      const hist = JSON.parse(localStorage.getItem('scad_history') || '[]');
      const item = hist.find(h => h.id === card.dataset.id);
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

function initHistory() {
  renderHistoryList();
}

// ── Tab Switching ────────────────────────────────────
function initTabs() {
  const tabCode = document.getElementById('tab-code');
  const tabConsole = document.getElementById('tab-console');
  const editorContainer = document.getElementById('editor-container');
  const consoleContainer = document.getElementById('console-container');

  tabCode.addEventListener('click', () => {
    tabCode.classList.add('active');
    tabConsole.classList.remove('active');
    editorContainer.style.display = '';
    consoleContainer.style.display = 'none';
  });

  tabConsole.addEventListener('click', () => {
    tabConsole.classList.add('active');
    tabCode.classList.remove('active');
    editorContainer.style.display = 'none';
    consoleContainer.style.display = '';
    updateConsoleUI();
  });
}

function initAIChat() {
  const chatInput = document.getElementById('ai-chat-input');
  const generateButton = document.getElementById('btn-ai-generate');
  const faceEditInput = document.getElementById('face-edit-input');
  const faceEditApply = document.getElementById('face-edit-apply');
  const faceEditClose = document.getElementById('face-edit-close');

  async function runGenerate() {
    if (!chatInput) return;
    const prompt = chatInput.value.trim();
    if (!prompt) {
      showToast('Enter a prompt first');
      return;
    }

    setButtonBusy('btn-ai-generate', true, 'Generating...', 'Generate');
    updateAIStatus('Asking AI... (this can take up to 4 minutes, do not be concerned)');
    consoleLog('Sending prompt to AI model', 'info');

    try {
      const result = await requestScadFromApi('/api/chat/generate', {
        prompt,
        currentCode: getEditorContent(),
      });
      applyGeneratedCode(result.scadCode, result.model || 'AI');
      addToHistory(prompt, result.model || 'AI', result.scadCode);
      updateAIStatus('Generated with AI.');
      chatInput.value = '';
    } catch (err) {
      const msg = err?.message || 'AI request failed.';
      showToast(`✕ ${msg}`);
      updateAIStatus(msg);
      consoleLog(`AI error: ${msg}`, 'error');
    } finally {
      setButtonBusy('btn-ai-generate', false, 'Generating...', 'Generate');
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

    setButtonBusy('face-edit-apply', true, 'Applying...', 'Apply Edit');
    updateAIStatus('Asking AI to patch area... (this can take up to 4 minutes, do not be concerned)');
    consoleLog('Sending face-edit prompt to AI model', 'info');

    try {
      const result = await requestScadFromApi('/api/chat/face-edit', {
        prompt,
        selection: selectedFaceContext,
        currentCode: getEditorContent(),
      });
      applyGeneratedCode(result.scadCode, result.model || 'AI');
      addToHistory(prompt, result.model || 'AI', result.scadCode);
      updateAIStatus('Face edit applied with AI.');
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      updateFaceHint('Face edit applied. Click another face for more targeted edits.');
    } catch (err) {
      const msg = err?.message || 'Face edit failed.';
      showToast(`✕ ${msg}`);
      updateAIStatus(msg);
      consoleLog(`Face edit error: ${msg}`, 'error');
    } finally {
      setButtonBusy('face-edit-apply', false, 'Applying...', 'Apply Edit');
    }
  }

  if (generateButton) {
    generateButton.addEventListener('click', runGenerate);
  }

  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runGenerate();
      }
    });
  }

  if (faceEditApply) {
    faceEditApply.addEventListener('click', runFaceEdit);
  }

  if (faceEditInput) {
    faceEditInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runFaceEdit();
      }
    });
  }

  if (faceEditClose) {
    faceEditClose.addEventListener('click', () => {
      hideFaceEditPopover();
      if (scene3d) scene3d.clearFaceSelection();
      selectedFaceContext = null;
      updateFaceHint('Click a face in the model to open a targeted AI edit.');
    });
  }
}

// ── Toolbar Buttons ─────────────────────────────────
function initToolbar() {
  document.getElementById('btn-render').addEventListener('click', renderModel);
  document.getElementById('btn-export').addEventListener('click', exportSTL);
  document.getElementById('btn-screenshot').addEventListener('click', exportScreenshot);
  document.getElementById('btn-save').addEventListener('click', saveFile);

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
  document.getElementById('btn-reset-camera').addEventListener('click', () => scene3d.resetCamera());

  // View presets
  document.getElementById('view-front').addEventListener('click', () => scene3d.setView('front'));
  document.getElementById('view-top').addEventListener('click', () => scene3d.setView('top'));
  document.getElementById('view-right').addEventListener('click', () => scene3d.setView('right'));
  document.getElementById('view-iso').addEventListener('click', () => scene3d.setView('iso'));

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

    // Ctrl+E — export STL
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      exportSTL();
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
      updateFaceHint('Click a face in the model to open a targeted AI edit.');
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
    if (e.key === 'f' || e.key === 'F') { scene3d.setView('front'); return; }
    if (e.key === 't') { scene3d.setView('top'); return; }
    if (e.key === 'r') { scene3d.setView('right'); return; }
    if (e.key === 'i') { scene3d.setView('iso'); return; }
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

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  consoleLog('SCAD Studio v3.0 initialized', 'info');
  consoleLog('Type SCAD code and press Ctrl+Enter to render', 'info');
  const filenameEl = document.getElementById('filename');
  if (filenameEl) filenameEl.textContent = DEFAULT_FILENAME;

  initEditor();
  initScene();
  initResizeHandle();
  initToolbar();
  initShortcuts();
  initTabs();
  initAIChat();
  initTemplates();
  initHistory();
  updateAIStatus('Prompt AI to generate or revise full SCAD code.');
  updateFaceHint('Click a face in the model to open a targeted AI edit.');

  // Hide loading screen
  hideLoadingScreen();

  // Auto-render sample on load
  setTimeout(() => renderModel(), 400);
});

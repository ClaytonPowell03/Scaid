/* ═══════════════════════════════════════════════════════
   SCAD Parser — Converts SCAD code to Three.js geometry
   v3 — for loops, expressions, linear_extrude, rotate_extrude
   ═══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CSG } from 'three-csg-ts';

/**
 * Tokenize SCAD source code.
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    // Single-line comments
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Multi-line comments
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Strings
    if (src[i] === '"') {
      let str = '';
      i++;
      while (i < src.length && src[i] !== '"') { str += src[i++]; }
      i++;
      tokens.push({ type: 'string', value: str });
      continue;
    }
    // Numbers
    if (/[\d.]/.test(src[i]) || (src[i] === '-' && i + 1 < src.length && /[\d.]/.test(src[i + 1]) && (tokens.length === 0 || ['char', 'op'].includes(tokens[tokens.length - 1].type)))) {
      let num = '';
      if (src[i] === '-') { num += '-'; i++; }
      while (i < src.length && /[\d.eE]/.test(src[i])) { num += src[i++]; }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }
    // Operators
    if ('+-*/%'.includes(src[i]) && !(/[\d.]/.test(src[i + 1] || '') && src[i] === '-' && (tokens.length === 0 || ['char', 'op'].includes(tokens[tokens.length - 1]?.type)))) {
      tokens.push({ type: 'op', value: src[i] });
      i++;
      continue;
    }
    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(src[i])) {
      let id = '';
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) { id += src[i++]; }
      tokens.push({ type: 'ident', value: id });
      continue;
    }
    // Single chars
    tokens.push({ type: 'char', value: src[i] });
    i++;
  }
  return tokens;
}

/**
 * Parse token stream into an AST.
 */
function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function advance() { return tokens[pos++]; }
  function expect(type, value) {
    const t = advance();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${type}:${value}, got ${t ? `${t.type}:${t.value}` : 'EOF'}`);
    }
    return t;
  }

  function parseExpression() {
    let left = parseUnary();
    while (peek() && peek().type === 'op' && '+-*/%'.includes(peek().value)) {
      const op = advance().value;
      const right = parseUnary();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && peek().value === '-') {
      advance();
      const val = parsePrimary();
      return { type: 'unary', op: '-', operand: val };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    if (!peek()) return 0;

    if (peek().type === 'number') {
      return advance().value;
    }
    if (peek().type === 'string') {
      return advance().value;
    }
    if (peek().value === '[') {
      return parseArray();
    }
    if (peek().type === 'ident') {
      const v = advance().value;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v; // Variable ref or identifier
    }
    if (peek().value === '(') {
      advance(); // (
      const expr = parseExpression();
      if (peek() && peek().value === ')') advance(); // )
      return expr;
    }
    advance();
    return 0;
  }

  function parseArgs() {
    const args = {};
    expect('char', '(');
    while (peek() && !(peek().type === 'char' && peek().value === ')')) {
      if (peek().type === 'ident' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
        const name = advance().value;
        advance(); // skip =
        args[name] = parseExpression();
      } else {
        const idx = Object.keys(args).length;
        args[idx] = parseExpression();
      }
      if (peek() && peek().value === ',') advance();
    }
    expect('char', ')');
    return args;
  }

  function parseArray() {
    expect('char', '[');
    const arr = [];
    while (peek() && !(peek().type === 'char' && peek().value === ']')) {
      arr.push(parseExpression());
      if (peek() && peek().value === ',') advance();
      // Range syntax [start:step:end] or [start:end]
      if (peek() && peek().value === ':') {
        advance(); // :
        const second = parseExpression();
        if (peek() && peek().value === ':') {
          advance(); // :
          const third = parseExpression();
          if (peek() && peek().value === ']') {
            advance();
            return { type: 'range', start: arr[0], step: second, end: third };
          }
        } else {
          if (peek() && peek().value === ']') {
            advance();
            return { type: 'range', start: arr[0], step: 1, end: second };
          }
        }
      }
    }
    expect('char', ']');
    return arr;
  }

  function parseStatement() {
    if (!peek()) return null;
    if (peek().value === ';') { advance(); return null; }

    // Variable Assignment: name = expr;
    if (peek().type === 'ident' && tokens[pos + 1] && tokens[pos + 1].value === '=') {
      const varName = advance().value;
      advance(); // skip =
      const varValue = parseExpression();
      if (peek() && peek().value === ';') advance();
      return { type: 'assign', name: varName, value: varValue };
    }

    const name = advance().value;

    // for loop: for (var = [range]) { ... }
    if (name === 'for') {
      expect('char', '(');
      const varName = advance().value;
      expect('char', '=');
      const range = parseExpression();
      expect('char', ')');
      const children = parseBlock();
      return { type: 'for', varName, range, children };
    }

    // if statement: if (expr) { ... }
    if (name === 'if') {
      expect('char', '(');
      const condition = parseExpression();
      expect('char', ')');
      const children = parseBlock();
      return { type: 'if', condition, children };
    }

    // Transforms & CSG
    const transforms = ['translate', 'rotate', 'scale', 'color', 'union', 'difference', 'intersection', 'hull', 'minkowski', 'linear_extrude', 'rotate_extrude'];
    const primitives = ['cube', 'sphere', 'cylinder', 'cone', 'circle', 'square'];

    if (transforms.includes(name)) {
      let args = {};
      if (peek() && peek().value === '(') args = parseArgs();
      const children = parseBlock();
      return { type: 'transform', name, args, children };
    }

    if (primitives.includes(name)) {
      let args = {};
      if (peek() && peek().value === '(') args = parseArgs();
      if (peek() && peek().value === ';') advance();
      return { type: 'primitive', name, args };
    }

    // Skip known unsupported keywords gracefully
    const unsupported = ['module', 'function', 'include', 'use', 'import', 'text', 'polyhedron', 'offset', 'projection', 'echo', 'assert', 'let', 'render', 'surface', 'polygon', 'resize', 'mirror', 'multmatrix'];
    if (unsupported.includes(name)) {
      // Skip until we find a matching end or semicolon
      let braceDepth = 0;
      while (peek()) {
        if (peek().value === '{') { braceDepth++; advance(); }
        else if (peek().value === '}') {
          if (braceDepth <= 0) break;
          braceDepth--; advance();
        }
        else if (peek().value === ';' && braceDepth === 0) { advance(); break; }
        else { advance(); }
      }
      return null;
    }

    while (peek() && peek().value !== ';' && peek().value !== '{' && peek().value !== '}') advance();
    if (peek() && peek().value === ';') advance();
    return null;
  }

  function parseBlock() {
    const children = [];
    if (peek() && peek().value === '{') {
      advance();
      while (peek() && peek().value !== '}') {
        const stmt = parseStatement();
        if (stmt) children.push(stmt);
      }
      if (peek()) advance();
    } else {
      const stmt = parseStatement();
      if (stmt) children.push(stmt);
    }
    return children;
  }

  const ast = [];
  while (pos < tokens.length) {
    const stmt = parseStatement();
    if (stmt) ast.push(stmt);
  }
  return ast;
}

/**
 * Evaluate an expression AST node in a given scope.
 */
function evalExpr(expr, scope) {
  if (expr === null || expr === undefined) return 0;
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'boolean') return expr;
  if (typeof expr === 'string') {
    if (scope.hasOwnProperty(expr)) return scope[expr];
    return expr; // named color or unknown ident
  }
  if (Array.isArray(expr)) {
    return expr.map(v => evalExpr(v, scope));
  }
  if (typeof expr === 'object') {
    if (expr.type === 'binop') {
      const l = evalExpr(expr.left, scope);
      const r = evalExpr(expr.right, scope);
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r !== 0 ? l / r : 0;
        case '%': return r !== 0 ? l % r : 0;
      }
    }
    if (expr.type === 'unary' && expr.op === '-') {
      return -evalExpr(expr.operand, scope);
    }
    if (expr.type === 'range') {
      const start = evalExpr(expr.start, scope);
      const step = evalExpr(expr.step, scope);
      const end = evalExpr(expr.end, scope);
      const result = [];
      if (step > 0) {
        for (let v = start; v <= end; v += step) result.push(v);
      } else if (step < 0) {
        for (let v = start; v >= end; v += step) result.push(v);
      }
      return result;
    }
  }
  return expr;
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineForIndex(index, lineStarts) {
  if (!lineStarts.length) return 1;
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function buildSourceHintIndex(source) {
  const tracked = new Set([
    'cube',
    'sphere',
    'cylinder',
    'cone',
    'circle',
    'square',
    'translate',
    'rotate',
    'scale',
    'color',
    'union',
    'difference',
    'intersection',
    'linear_extrude',
    'rotate_extrude',
  ]);
  const map = {};
  tracked.forEach((name) => { map[name] = []; });

  if (!source) return map;

  const lineStarts = buildLineStarts(source);
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match = regex.exec(source);
  while (match) {
    const name = match[1];
    if (tracked.has(name)) {
      const index = match.index;
      const lineStart = source.lastIndexOf('\n', index) + 1;
      const lineEndRaw = source.indexOf('\n', index);
      const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
      const snippet = source.slice(lineStart, lineEnd).trim();
      map[name].push({
        index,
        line: lineForIndex(index, lineStarts),
        snippet,
      });
    }
    match = regex.exec(source);
  }

  return map;
}

function summarizeArgs(args) {
  try {
    const json = JSON.stringify(args);
    if (json.length <= 240) return json;
    return `${json.slice(0, 237)}...`;
  } catch {
    return '';
  }
}

function attachSourceMetadata(target, metadata = {}) {
  if (!target || !target.userData) return;
  const sourceHint = metadata.sourceHint || null;
  const contextPath = Array.isArray(metadata.contextPath)
    ? metadata.contextPath.join(' > ')
    : '';

  target.userData.scadMeta = {
    primitive: metadata.primitive || null,
    operation: metadata.operation || null,
    contextPath,
    args: metadata.args || {},
    argsSummary: summarizeArgs(metadata.args || {}),
    line: sourceHint?.line || null,
    sourceIndex: typeof sourceHint?.index === 'number' ? sourceHint.index : null,
    snippet: sourceHint?.snippet || '',
  };
}

/**
 * Convert AST to Three.js object hierarchy.
 */
function astToThree(ast, defaultColor = 0x00f0ff, initialScope = {}, source = '') {
  const group = new THREE.Group();
  let vertexCount = 0;
  let faceCount = 0;
  const sourceHints = buildSourceHintIndex(source);
  const sourceCursor = {};

  function claimSourceHint(name) {
    const list = sourceHints[name] || [];
    const cursor = sourceCursor[name] || 0;
    sourceCursor[name] = cursor + 1;
    return list[cursor] || null;
  }

  function processNode(node, parentColor, currentScope, contextPath = []) {
    let currentColor = parentColor || defaultColor;

    if (node.type === 'assign') {
      currentScope[node.name] = evalExpr(node.value, currentScope);
      return null;
    }

    // for loop
    if (node.type === 'for') {
      const range = evalExpr(node.range, currentScope);
      if (Array.isArray(range)) {
        const g = new THREE.Group();
        for (const val of range) {
          const loopScope = { ...currentScope, [node.varName]: val };
          for (const child of node.children) {
            const obj = processNode(child, currentColor, loopScope, contextPath);
            if (obj) g.add(obj);
          }
        }
        return g;
      }
      return null;
    }

    if (node.type === 'primitive') {
    try {
      const resolvedArgs = {};
      for (const [k, v] of Object.entries(node.args)) {
        resolvedArgs[k] = evalExpr(v, currentScope);
      }
      const { mesh, verts, faces } = createPrimitive(node.name, resolvedArgs, currentColor, {
        primitive: node.name,
        contextPath,
        sourceHint: claimSourceHint(node.name),
        args: resolvedArgs,
      });
      if (mesh) {
        vertexCount += verts || 0;
        faceCount += faces || 0;
        return mesh;
      }
      return null;
    } catch (primErr) {
      console.warn(`Primitive ${node.name} failed:`, primErr);
      return null;
    }
    }

    if (node.type === 'transform') {
      const { name, args, children } = node;

      const resolvedArgs = {};
      for (const [k, v] of Object.entries(args)) {
        resolvedArgs[k] = evalExpr(v, currentScope);
      }

      if (name === 'color') {
        const c = resolvedArgs[0] || resolvedArgs['c'];
        if (Array.isArray(c) && c.length >= 3) {
          currentColor = new THREE.Color(c[0], c[1], c[2]);
        } else if (typeof c === 'string') {
          currentColor = new THREE.Color(c);
        }
      }

      const childObjects = [];
      const childGroup = new THREE.Group();
      const blockScope = { ...currentScope };
      const nextContextPath = [...contextPath, name];

      for (const child of children) {
        const obj = processNode(child, currentColor, blockScope, nextContextPath);
        if (obj) {
          childObjects.push(obj);
          childGroup.add(obj);
        }
      }

      // CSG Operations
      if (['difference', 'intersection', 'union'].includes(name) && childObjects.length > 0) {
        try {
          const meshes = [];
          childGroup.updateMatrixWorld(true);
          childGroup.traverse((c) => {
            if (c.isMesh && !c.userData.isWireframe) {
              const clone = c.clone();
              clone.geometry = c.geometry.clone();
              clone.material = c.material.clone();
              clone.applyMatrix4(c.matrixWorld);
              meshes.push(clone);
            }
          });

          if (meshes.length > 0) {
            let resultMesh = meshes[0];
            let csgFailed = false;
            for (let i = 1; i < meshes.length; i++) {
              try {
                if (name === 'difference') resultMesh = CSG.subtract(resultMesh, meshes[i]);
                else if (name === 'intersection') resultMesh = CSG.intersect(resultMesh, meshes[i]);
                else if (name === 'union') resultMesh = CSG.union(resultMesh, meshes[i]);
              } catch (e) {
                console.warn(`CSG ${name} failed on operand ${i}:`, e);
                csgFailed = true;
                break;
              }
            }

            if (csgFailed) {
              // Fall back to showing children as-is instead of black screen
              return childGroup;
            }

            if (resultMesh) {
              const material = new THREE.MeshStandardMaterial({
                color: currentColor instanceof THREE.Color ? currentColor : new THREE.Color(currentColor),
                roughness: 0.25, metalness: 0.6, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
              });
              resultMesh.material = material;
              resultMesh.castShadow = true;
              resultMesh.receiveShadow = true;
              const edges = new THREE.EdgesGeometry(resultMesh.geometry, 15);
              const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 });
              const wireframe = new THREE.LineSegments(edges, edgeMat);
              wireframe.userData.isWireframe = true;
              resultMesh.add(wireframe);
              attachSourceMetadata(resultMesh, {
                operation: name,
                contextPath: nextContextPath,
                sourceHint: claimSourceHint(name),
                args: resolvedArgs,
              });
              return resultMesh;
            }
          }
        } catch (csgErr) {
          console.warn(`CSG ${name} operation error, falling back to child display:`, csgErr);
          return childGroup;
        }
      }

      // Linear extrude: extrude the child 2D primitives into 3D
      if (name === 'linear_extrude') {
        const height = resolvedArgs['height'] || resolvedArgs[0] || 1;
        // Look for circle/square children and extrude them
        childGroup.traverse((c) => {
          if (c.isMesh && c.userData.is2D && c.userData.extrudeShape) {
            const shape = c.userData.extrudeShape;
            const extrudeGeo = new THREE.ExtrudeGeometry(shape, {
              depth: height,
              bevelEnabled: false,
            });
            c.geometry.dispose();
            c.geometry = extrudeGeo;
            c.userData.is2D = false;
          }
        });
      }

      // Standard transforms
      switch (name) {
        case 'translate': {
          const v = resolvedArgs[0] || resolvedArgs['v'] || [0, 0, 0];
          if (Array.isArray(v)) childGroup.position.set(v[0] || 0, v[2] || 0, v[1] || 0);
          break;
        }
        case 'rotate': {
          const a = resolvedArgs[0] || resolvedArgs['a'] || [0, 0, 0];
          if (Array.isArray(a)) {
            const deg = Math.PI / 180;
            childGroup.rotation.set((a[0] || 0) * deg, (a[2] || 0) * deg, (a[1] || 0) * deg);
          }
          break;
        }
        case 'scale': {
          const s = resolvedArgs[0] || resolvedArgs['v'] || [1, 1, 1];
          if (Array.isArray(s)) childGroup.scale.set(s[0] || 1, s[2] || 1, s[1] || 1);
          else if (typeof s === 'number') childGroup.scale.setScalar(s);
          break;
        }
      }

      childGroup.updateMatrixWorld(true);
      return childGroup;
    }
    return null;
  }

  const globalScope = { ...initialScope };
  for (const node of ast) {
    try {
      const obj = processNode(node, defaultColor, globalScope);
      if (obj) group.add(obj);
    } catch (nodeErr) {
      console.warn('Skipping node due to error:', nodeErr);
    }
  }

  // Recount
  vertexCount = 0;
  faceCount = 0;
  group.traverse((c) => {
    if (c.isMesh && !c.userData.isWireframe && c.geometry) {
      const g = c.geometry;
      const v = g.attributes.position ? g.attributes.position.count : 0;
      const f = g.index ? g.index.count / 3 : v / 3;
      vertexCount += v;
      faceCount += f;
    }
  });

  return { group, vertexCount: Math.floor(vertexCount), faceCount: Math.floor(faceCount) };
}

/**
 * Create a Three.js mesh for a SCAD primitive.
 */
function createPrimitive(name, args, color, metadata = null) {
  let geometry, mesh;
  let verts = 0, faces = 0;

  const mat = new THREE.MeshStandardMaterial({
    color: color instanceof THREE.Color ? color : new THREE.Color(color),
    roughness: 0.25, metalness: 0.6, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
  });

  const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 });

  switch (name) {
    case 'cube': {
      let size = args['size'] || args[0] || [1, 1, 1];
      const center = args['center'] !== undefined ? args['center'] : false;
      if (typeof size === 'number') size = [size, size, size];
      geometry = new THREE.BoxGeometry(size[0], size[2] || size[0], size[1] || size[0]);
      if (!center) {
        geometry.translate(size[0] / 2, (size[2] || size[0]) / 2, (size[1] || size[0]) / 2);
      }
      mesh = new THREE.Mesh(geometry, mat);
      break;
    }
    case 'sphere': {
      const r = args['r'] || args[0] || 1;
      const d = args['d'];
      const radius = d ? d / 2 : r;
      const fn = args['$fn'] || 32;
      geometry = new THREE.SphereGeometry(radius, fn, Math.floor(fn / 2));
      mesh = new THREE.Mesh(geometry, mat);
      break;
    }
    case 'cylinder': {
      const h = args['h'] || args[0] || 1;
      const r1 = args['r1'] !== undefined ? args['r1'] : (args['r'] || args['d'] ? (args['d'] || 0) / 2 : 1);
      const r2 = args['r2'] !== undefined ? args['r2'] : r1;
      const r = args['r'];
      const d = args['d'];
      const fn = args['$fn'] || 32;
      const center = args['center'] !== undefined ? args['center'] : false;
      let topR = r2, botR = r1;
      if (r !== undefined) { topR = r; botR = r; }
      if (d !== undefined) { topR = d / 2; botR = d / 2; }
      geometry = new THREE.CylinderGeometry(topR, botR, h, fn);
      if (!center) {
        geometry.translate(0, h / 2, 0);
      }
      mesh = new THREE.Mesh(geometry, mat);
      break;
    }
    case 'circle': {
      const r = args['r'] || args[0] || 1;
      const fn = args['$fn'] || 32;
      const shape = new THREE.Shape();
      for (let i = 0; i <= fn; i++) {
        const angle = (i / fn) * Math.PI * 2;
        if (i === 0) shape.moveTo(r * Math.cos(angle), r * Math.sin(angle));
        else shape.lineTo(r * Math.cos(angle), r * Math.sin(angle));
      }
      geometry = new THREE.ShapeGeometry(shape);
      mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.is2D = true;
      mesh.userData.extrudeShape = shape;
      break;
    }
    case 'square': {
      let size = args['size'] || args[0] || [1, 1];
      const center = args['center'] !== undefined ? args['center'] : false;
      if (typeof size === 'number') size = [size, size];
      const shape = new THREE.Shape();
      if (center) {
        shape.moveTo(-size[0] / 2, -size[1] / 2);
        shape.lineTo(size[0] / 2, -size[1] / 2);
        shape.lineTo(size[0] / 2, size[1] / 2);
        shape.lineTo(-size[0] / 2, size[1] / 2);
        shape.closePath();
      } else {
        shape.moveTo(0, 0);
        shape.lineTo(size[0], 0);
        shape.lineTo(size[0], size[1]);
        shape.lineTo(0, size[1]);
        shape.closePath();
      }
      geometry = new THREE.ShapeGeometry(shape);
      mesh = new THREE.Mesh(geometry, mat);
      mesh.userData.is2D = true;
      mesh.userData.extrudeShape = shape;
      break;
    }
    case 'cone': {
      const h = args['h'] || args[0] || 1;
      const r1 = args['r1'] !== undefined ? args['r1'] : (args['r'] || 1);
      const r2 = args['r2'] !== undefined ? args['r2'] : 0;
      const fn = args['$fn'] || 32;
      const center = args['center'] !== undefined ? args['center'] : false;
      geometry = new THREE.CylinderGeometry(r2, r1, h, fn);
      if (!center) {
        geometry.translate(0, h / 2, 0);
      }
      mesh = new THREE.Mesh(geometry, mat);
      break;
    }
    default:
      return { mesh: null, verts: 0, faces: 0 };
  }

  if (geometry) {
    verts = geometry.attributes.position.count;
    faces = geometry.index ? geometry.index.count / 3 : verts / 3;
    const edges = new THREE.EdgesGeometry(geometry, 15);
    const wireframe = new THREE.LineSegments(edges, edgeMat);
    wireframe.userData.isWireframe = true;
    mesh.add(wireframe);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (metadata) attachSourceMetadata(mesh, metadata);
  }

  return { mesh, verts: Math.floor(verts), faces: Math.floor(faces) };
}

/**
 * Main entry point: parse SCAD string and return Three.js group.
 */
export function parseSCAD(source) {
  try {
    const tokens = tokenize(source);
    const ast = parse(tokens);
    return astToThree(ast, 0x00f0ff, {}, source);
  } catch (err) {
    console.error('SCAD Parse Error:', err);
    // Return empty group instead of crashing — prevents black screen
    const group = new THREE.Group();
    return { group, vertexCount: 0, faceCount: 0 };
  }
}

export default parseSCAD;

/* ═══════════════════════════════════════════════════════
   scAId — Gemini 3.1 Pro API Backend
   ═══════════════════════════════════════════════════════ */

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_REQUEST_BYTES = 1_000_000;
const GUEST_RATE_LIMIT_COOKIE = 'scaid_guest_ai_rl';
const GUEST_RATE_LIMIT_MAX_REQUESTS = 2;
const GUEST_RATE_LIMIT_WINDOW_MS = 3 * 60 * 60 * 1000;

// ── System Prompt: Generation ────────────────────────
// This prompt is a precise technical reference card for the
// model. It mirrors exactly what scad-parser.js can tokenize,
// parse, evaluate, and render via Three.js + CSG.
const SYSTEM_PROMPT_GENERATE = `
You are scAId, an expert 3D‑modeling assistant.
Your job is to write OpenSCAD code that a LIMITED browser‑based renderer can parse and display.
Think carefully about every object the user describes — break it into its visually recognizable parts and compose them from the primitives listed below.

─── RENDERER REFERENCE ────────────────────────────────

PRIMITIVES (each must end with a semicolon):
  cube(size = [x,y,z], center = true|false)
  sphere(r = N, $fn = N)
  cylinder(h = N, r = N, r1 = N, r2 = N, d = N, center = true|false, $fn = N)
  cone(h = N, r1 = N, r2 = N, $fn = N, center = true|false)
  circle(r = N, $fn = N)            — 2D, use inside linear_extrude
  square(size = [x,y], center = true|false)  — 2D, use inside linear_extrude

TRANSFORMS (wrap children in braces):
  translate([x, y, z]) { … }
  rotate([x, y, z]) { … }        — degrees
  scale([x, y, z]) { … }
  color([r, g, b]) { … }          — floats 0‑1

BOOLEAN / CSG:
  union() { … }
  difference() { … }              — first child is base, rest are subtracted
  intersection() { … }

EXTRUSION:
  linear_extrude(height = N) { … } — extrudes 2D child (circle / square) into 3D

LANGUAGE:
  Variables:       height = 10;
  For‑loops:       for (i = [0:1:5]) { … }     — range [start:step:end]
  If‑blocks:       if (condition) { … }
  Expressions:     + - * / %    parentheses OK
  Comments:        // single   /* multi */
  $fn:             controls curve smoothness (use 40+ for nice results)

─── HARD CONSTRAINTS ──────────────────────────────────

The renderer will CRASH on any of the following — never emit them:
  module / function declarations, include, use, import,
  text(), polyhedron(), polygon(), offset(), projection(),
  minkowski(), hull(), resize(), mirror(), multmatrix(),
  render(), surface(),
  let(), assert(), echo(), each,
  list comprehensions, ternary (? :),
  logical operators (&&  ||  !),
  comparison operators (==  !=  <  >  <=  >=),
  string functions (str(), concat()), $fa, $fs.

─── OUTPUT RULES ──────────────────────────────────────

1. Return ONLY raw OpenSCAD code. No markdown fences, no prose, no explanations.
2. Every primitive call ends with a semicolon.
3. Every transform / boolean block uses matched braces { }.
4. Parametrize key dimensions at the top with named variables.
5. Use $fn = 40 on every cylinder and sphere.
6. For difference(), oversize cutouts by 0.1 and offset by −0.05 to prevent z‑fighting.
7. Use color() liberally — colorful models look much better in the preview.
`.trim();

// ── System Prompt: Face Edit ─────────────────────────
const SYSTEM_PROMPT_FACE_EDIT = `
You are scAId, an OpenSCAD editor for a limited browser‑based renderer.
You receive the user's EXISTING code plus metadata about a face they clicked in the 3D viewport.
Your task: apply the user's requested change with MINIMAL edits.

Rules:
1. Preserve all unrelated geometry exactly as‑is.
2. Keep the same variable names, indentation style, and comments.
3. Return the FULL updated script — raw code only, no markdown, no explanations.
4. Stay within the renderer's supported dialect (same constraints as the generation prompt).
`.trim();

// ── Utilities ────────────────────────────────────────
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function getSupabaseConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  return { url, anonKey };
}

function getRateLimitSecret(env) {
  return env.RATE_LIMIT_SECRET || env.GEMINI_API_KEY || '';
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[key] = value;
  }

  return cookies;
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase();
  if (forwardedProto.includes('https')) return true;
  return Boolean(req.socket?.encrypted);
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signValue(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function encodeGuestRateLimitState(state, secret) {
  const payload = base64UrlEncode(JSON.stringify(state));
  const signature = signValue(payload, secret);
  return `${payload}.${signature}`;
}

function decodeGuestRateLimitState(rawValue, secret) {
  if (!rawValue || !secret) return null;

  const separatorIndex = rawValue.lastIndexOf('.');
  if (separatorIndex === -1) return null;

  const payload = rawValue.slice(0, separatorIndex);
  const signature = rawValue.slice(separatorIndex + 1);
  const expectedSignature = signValue(payload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) return null;

  try {
    return JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, value]);
    return;
  }

  res.setHeader('Set-Cookie', [existing, value]);
}

function writeGuestRateLimitCookie(res, req, timestamps, env) {
  const secret = getRateLimitSecret(env);
  if (!secret) return;

  const state = {
    timestamps,
  };
  const value = encodeGuestRateLimitState(state, secret);
  const attributes = [
    `${GUEST_RATE_LIMIT_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.ceil(GUEST_RATE_LIMIT_WINDOW_MS / 1000)}`,
  ];

  if (isSecureRequest(req)) attributes.push('Secure');
  appendSetCookie(res, attributes.join('; '));
}

function getGuestRateLimitTimestamps(req, env, now = Date.now()) {
  const secret = getRateLimitSecret(env);
  if (!secret) return [];

  const cookies = parseCookieHeader(req.headers?.cookie || '');
  const state = decodeGuestRateLimitState(cookies[GUEST_RATE_LIMIT_COOKIE], secret);
  const timestamps = Array.isArray(state?.timestamps) ? state.timestamps : [];

  return timestamps
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && now - value < GUEST_RATE_LIMIT_WINDOW_MS)
    .sort((a, b) => a - b);
}

function formatRetryDelay(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function enforceGuestRateLimit(req, res, env) {
  const now = Date.now();
  const recentTimestamps = getGuestRateLimitTimestamps(req, env, now);

  if (recentTimestamps.length >= GUEST_RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = GUEST_RATE_LIMIT_WINDOW_MS - (now - recentTimestamps[0]);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    writeGuestRateLimitCookie(res, req, recentTimestamps, env);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return {
      allowed: false,
      retryAfterSeconds,
      message: `Guest AI access is limited to ${GUEST_RATE_LIMIT_MAX_REQUESTS} requests every 3 hours. Create a free account to keep generating right away, or try again in ${formatRetryDelay(retryAfterMs)}.`,
    };
  }

  writeGuestRateLimitCookie(res, req, [...recentTimestamps, now], env);
  return { allowed: true };
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
}

async function getAuthenticatedUser(req, env) {
  const token = getBearerToken(req);
  if (!token) return null;

  const { url, anonKey } = getSupabaseConfig(env);
  if (!url || !anonKey) return null;

  try {
    const response = await fetch(`${url}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) return null;
    const user = await response.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function toLineNumber(index, lineStarts) {
  let low = 0, high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function buildSelectionSummary(selection, currentCode) {
  if (!selection || typeof selection !== 'object') return 'No face selection context provided.';
  const meta = selection.meta || {};
  const fmt = (v) => Number(v).toFixed(3);
  const point = Array.isArray(selection.worldPoint) ? selection.worldPoint.map(fmt).join(', ') : 'n/a';
  const normal = Array.isArray(selection.worldNormal) ? selection.worldNormal.map(fmt).join(', ') : 'n/a';
  const faceIndex = Number.isInteger(selection.faceIndex) ? selection.faceIndex : 'n/a';

  let inferredLine = 'n/a';
  if (typeof meta.sourceIndex === 'number' && currentCode) {
    inferredLine = toLineNumber(meta.sourceIndex, buildLineStarts(currentCode));
  } else if (typeof meta.line === 'number') {
    inferredLine = meta.line;
  }

  return [
    `Primitive/op: ${meta.primitive || meta.operation || 'unknown'}`,
    `Context: ${meta.contextPath || 'none'}`,
    `Face index: ${faceIndex}`,
    `World point: [${point}]`,
    `World normal: [${normal}]`,
    `Source line: ${inferredLine}`,
    `Snippet: ${meta.snippet || 'n/a'}`,
  ].join('\n');
}

// ── Response extraction ──────────────────────────────
function extractTextFromGemini(responseJson) {
  const candidate = responseJson?.candidates?.[0];
  if (!candidate?.content?.parts) return '';
  return candidate.content.parts
    .filter(p => typeof p.text === 'string')
    .map(p => p.text)
    .join('\n')
    .trim();
}

function extractScad(text) {
  if (!text) return '';
  const fenced = text.match(/```(?:scad|openscad)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  let normalized = text.trim();
  const openFence = normalized.match(/^```(?:scad|openscad)?\s*/i);
  if (openFence) normalized = normalized.slice(openFence[0].length);
  normalized = normalized.replace(/\s*```$/, '');
  return normalized.trim();
}

function getGeminiFinishReason(responseJson) {
  return String(responseJson?.candidates?.[0]?.finishReason || '').trim().toUpperCase();
}

function analyzeScadCompleteness(source) {
  const stack = [];
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']' || char === ')') {
      const expected = char === '}' ? '{' : (char === ']' ? '[' : '(');
      if (stack[stack.length - 1] === expected) stack.pop();
    }
  }

  const reasons = [];
  if (stack.length > 0) reasons.push(`unclosed delimiters: ${stack.join('')}`);
  if (inString) reasons.push('unterminated string literal');
  if (inBlockComment) reasons.push('unterminated block comment');

  return {
    complete: reasons.length === 0,
    reasons,
  };
}

function shouldContinueScad(scadCode, finishReason) {
  const completion = analyzeScadCompleteness(scadCode || '');
  if (!completion.complete) return true;
  if (!finishReason) return false;
  return finishReason.includes('MAX') || finishReason.includes('TOKEN') || finishReason.includes('LENGTH');
}

function mergeScadContinuation(existingCode, continuationCode) {
  const base = String(existingCode || '');
  const addition = String(continuationCode || '').trim();

  if (!addition) return base;
  if (!base) return addition;
  if (base.includes(addition)) return base;
  if (addition.includes(base)) return addition;

  const maxChars = Math.min(base.length, addition.length, 4000);
  for (let len = maxChars; len >= 24; len -= 1) {
    if (base.slice(-len) === addition.slice(0, len)) {
      return base + addition.slice(len);
    }
  }

  const baseLines = base.split(/\r?\n/);
  const addLines = addition.split(/\r?\n/);
  const maxLines = Math.min(baseLines.length, addLines.length, 24);
  for (let len = maxLines; len >= 1; len -= 1) {
    if (baseLines.slice(-len).join('\n') === addLines.slice(0, len).join('\n')) {
      return `${base}\n${addLines.slice(len).join('\n')}`.trim();
    }
  }

  return `${base}\n${addition}`.trim();
}

function buildContinuationPrompt(originalPrompt, partialCode, completion) {
  const tail = partialCode.slice(-2400);
  const reasons = completion.reasons.length > 0
    ? completion.reasons.join(', ')
    : 'model stopped before clearly finishing the script';

  return [
    'The previous OpenSCAD response was cut off before the script was complete.',
    'Continue the SAME script from the exact point it stopped.',
    'Return ONLY the missing continuation text.',
    'Do not restart from the top.',
    'Do not repeat large sections that are already present.',
    'Do not explain anything.',
    '',
    `Original task:\n${originalPrompt}`,
    '',
    `Existing partial script tail:\n\`\`\`\n${tail}\n\`\`\``,
    '',
    `Why continuation is needed: ${reasons}`,
    '',
    'Continue immediately after the final character of the partial script above.',
  ].join('\n');
}

async function generateCompleteScad({
  apiKey,
  model,
  system,
  userPrompt,
  maxOutputTokens,
  maxContinuations = 3,
}) {
  let response = await callGemini({
    apiKey,
    model,
    system,
    userPrompt,
    maxOutputTokens,
  });

  let scadCode = extractScad(extractTextFromGemini(response));
  let finishReason = getGeminiFinishReason(response);
  let continuationCount = 0;

  while (shouldContinueScad(scadCode, finishReason) && continuationCount < maxContinuations) {
    const completion = analyzeScadCompleteness(scadCode);
    const continuationPrompt = buildContinuationPrompt(userPrompt, scadCode, completion);
    const nextResponse = await callGemini({
      apiKey,
      model,
      system,
      userPrompt: continuationPrompt,
      maxOutputTokens,
    });

    const nextChunk = extractScad(extractTextFromGemini(nextResponse));
    if (!nextChunk) break;

    const merged = mergeScadContinuation(scadCode, nextChunk);
    if (merged === scadCode) break;

    scadCode = merged;
    finishReason = getGeminiFinishReason(nextResponse);
    continuationCount += 1;
  }

  const completion = analyzeScadCompleteness(scadCode);
  if (!scadCode) {
    throw new Error('Model returned an empty response.');
  }
  if (!completion.complete) {
    throw new Error(`Model returned incomplete SCAD after ${continuationCount + 1} attempt(s): ${completion.reasons.join(', ')}`);
  }

  return {
    scadCode,
    finishReason,
    continuationCount,
  };
}

// ── Gemini API call ──────────────────────────────────
async function callGemini({ apiKey, model, system, userPrompt, maxOutputTokens = 16384 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens,
      thinkingConfig: {
        thinkingLevel: 'HIGH',
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let payload = null;
  try { payload = rawText ? JSON.parse(rawText) : {}; }
  catch { payload = null; }

  if (!response.ok) {
    const msg = payload?.error?.message || rawText || `Gemini request failed (${response.status}).`;
    const err = new Error(msg);
    err.statusCode = response.status;
    throw err;
  }

  return payload;
}

// ── Route: /api/chat/generate ────────────────────────
async function handleGenerate(req, res, env) {
  const body = await readJsonBody(req);
  const prompt = (body?.prompt || '').trim();
  const currentCode = typeof body?.currentCode === 'string' ? body.currentCode : '';

  if (!prompt) return sendJson(res, 400, { error: 'Missing prompt.' });

  const userPrompt = currentCode
    ? `The user already has this code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nUser request: ${prompt}`
    : `Generate OpenSCAD code from scratch.\n\nUser request: ${prompt}`;

  const model = env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
  const result = await generateCompleteScad({
    apiKey: env.GEMINI_API_KEY,
    model,
    maxOutputTokens: 16384,
    system: SYSTEM_PROMPT_GENERATE,
    userPrompt,
  });

  sendJson(res, 200, {
    scadCode: result.scadCode,
    model,
    finishReason: result.finishReason,
    continuationCount: result.continuationCount,
  });
}

// ── Route: /api/chat/face-edit ───────────────────────
async function handleFaceEdit(req, res, env) {
  const body = await readJsonBody(req);
  const prompt = (body?.prompt || '').trim();
  const currentCode = typeof body?.currentCode === 'string' ? body.currentCode : '';
  const selection = body?.selection;

  if (!prompt) return sendJson(res, 400, { error: 'Missing face-edit prompt.' });
  if (!currentCode.trim()) return sendJson(res, 400, { error: 'Missing current SCAD code.' });

  const userPrompt = [
    `Selected face context:\n${buildSelectionSummary(selection, currentCode)}`,
    '',
    `Requested edit: ${prompt}`,
    '',
    `Current code:\n\`\`\`\n${currentCode}\n\`\`\``,
  ].join('\n');

  const model = env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
  const result = await generateCompleteScad({
    apiKey: env.GEMINI_API_KEY,
    model,
    maxOutputTokens: 16384,
    system: SYSTEM_PROMPT_FACE_EDIT,
    userPrompt,
  });

  sendJson(res, 200, {
    scadCode: result.scadCode,
    model,
    finishReason: result.finishReason,
    continuationCount: result.continuationCount,
  });
}

// ── Middleware export ────────────────────────────────
export function createGeminiApiMiddleware(env) {
  return async (req, res, next) => {
    const method = req.method || 'GET';
    const pathname = (req.url || '').split('?')[0];

    if (pathname !== '/api/chat/generate' && pathname !== '/api/chat/face-edit') {
      return next();
    }
    if (!env.GEMINI_API_KEY) {
      return sendJson(res, 500, { error: 'Missing GEMINI_API_KEY on server.' });
    }
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }

    try {
      const authenticatedUser = await getAuthenticatedUser(req, env);
      if (!authenticatedUser) {
        const rateLimit = enforceGuestRateLimit(req, res, env);
        if (!rateLimit.allowed) {
          return sendJson(res, 429, {
            error: rateLimit.message,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          });
        }
      }

      if (pathname === '/api/chat/generate') {
        await handleGenerate(req, res, env);
      } else {
        await handleFaceEdit(req, res, env);
      }
    } catch (err) {
      const statusCode = err?.statusCode || 500;
      sendJson(res, statusCode, { error: err?.message || 'Unhandled server error.' });
    }
  };
}

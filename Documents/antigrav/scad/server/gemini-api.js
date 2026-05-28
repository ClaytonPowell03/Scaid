/* ═══════════════════════════════════════════════════════
   scAId — API Backend (OpenRouter + Anthropic Pro)
   ═══════════════════════════════════════════════════════ */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPostHogClient } from './posthog.js';

const MAX_REQUEST_BYTES = 1_000_000;
const GUEST_RATE_LIMIT_COOKIE = 'scaid_guest_ai_rl';
const GUEST_RATE_LIMIT_MAX_REQUESTS = 2;
const GUEST_RATE_LIMIT_WINDOW_MS = 3 * 60 * 60 * 1000;

// ── Provider constants ───────────────────────────────
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'xiaomi/mimo-v2.5-pro';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-4-7-20250515';
const ANTHROPIC_API_VERSION = '2023-06-01';

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
  color([r, g, b]) or color("#HEX") { … } — floats 0‑1 or hex string

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
  Math functions:  sin cos tan asin acos atan atan2 abs sign sqrt pow exp ln log floor ceil round min max clamp
  Comments:        // single   /* multi */
  $fn:             controls curve smoothness (use 40+ for nice results)

ANIMATION:
  $t is supported by the previewer as normalized animation time from 0 up to just under 1.
  If the user asks for animation, articulated motion, opening/closing parts, or looping movement, drive it with named variables derived from $t.
  Good patterns:
    angle = 45 * sin(360 * $t);
    swing = 20 + 10 * sin(360 * $t + 90);
    gap = 8 + 3 * sin(720 * $t);
  Prefer separate transformed solids for articulated parts instead of wrapping everything in union().
  Use nested translate()/rotate() blocks to build joint chains.

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
7. Use color() liberally. Favor our modern theme colors: pink/rose ("#d25a8a", "#f19ba9") and purple/plum ("#b466b0", "#291a36", "#2d1b3d"). Use hex strings like color("#d25a8a").
8. If animation is requested, keep moving values in named variables near the top and derive them from $t.
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
5. The renderer supports $t-based animation. Preserve existing animation variables when present unless the user asks to remove or replace them.
6. If the user asks for motion, articulation, opening/closing parts, or a looping preview, express it with named variables derived from $t.
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
  return env.RATE_LIMIT_SECRET || env.OPENROUTER_API_KEY || '';
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

function isProUser(user) {
  if (!user) return false;
  // Check user_metadata (set by Stripe webhook)
  if (user.user_metadata?.is_pro === true) return true;
  // Fallback: check app_metadata
  if (user.app_metadata?.subscription_tier === 'pro') return true;
  return false;
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

// Extract text from OpenRouter (OpenAI-compatible) response
function extractTextFromOpenRouter(responseJson) {
  const choice = responseJson?.choices?.[0];
  if (!choice) return '';
  // The content is in message.content
  return (choice.message?.content || '').trim();
}

// Extract text from Anthropic response
function extractTextFromAnthropic(responseJson) {
  const contentBlocks = responseJson?.content;
  if (!Array.isArray(contentBlocks)) return '';
  // Filter for text blocks (skip thinking blocks)
  return contentBlocks
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n')
    .trim();
}

function extractText(responseJson, provider) {
  if (provider === 'anthropic') return extractTextFromAnthropic(responseJson);
  return extractTextFromOpenRouter(responseJson);
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

function getFinishReason(responseJson, provider) {
  if (provider === 'anthropic') {
    return String(responseJson?.stop_reason || '').trim().toUpperCase();
  }
  // OpenRouter / OpenAI format
  return String(responseJson?.choices?.[0]?.finish_reason || '').trim().toUpperCase();
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
  provider,
  apiKey,
  model,
  system,
  userPrompt,
  maxOutputTokens,
  maxContinuations = 3,
}) {
  const callFn = provider === 'anthropic' ? callAnthropic : callOpenRouter;

  let response = await callFn({
    apiKey,
    model,
    system,
    userPrompt,
    maxOutputTokens,
  });

  let scadCode = extractScad(extractText(response, provider));
  let finishReason = getFinishReason(response, provider);
  let continuationCount = 0;

  while (shouldContinueScad(scadCode, finishReason) && continuationCount < maxContinuations) {
    const completion = analyzeScadCompleteness(scadCode);
    const continuationPrompt = buildContinuationPrompt(userPrompt, scadCode, completion);
    const nextResponse = await callFn({
      apiKey,
      model,
      system,
      userPrompt: continuationPrompt,
      maxOutputTokens,
    });

    const nextChunk = extractScad(extractText(nextResponse, provider));
    if (!nextChunk) break;

    const merged = mergeScadContinuation(scadCode, nextChunk);
    if (merged === scadCode) break;

    scadCode = merged;
    finishReason = getFinishReason(nextResponse, provider);
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

// ── OpenRouter API call ──────────────────────────────
async function callOpenRouter({ apiKey, model, system, userPrompt, maxOutputTokens = 16384 }) {
  const messages = [];

  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model: model,
    messages,
    max_tokens: maxOutputTokens,
    temperature: 0.3,
    // Enable reasoning for kimi-k2.6
    provider: {
      require_parameters: true,
    },
    reasoning: {
      effort: 'medium',
    },
  };

  try {
    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://scaid.tech',
        'X-Title': 'scAId',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const msg = errorData?.error?.message || `OpenRouter request failed (${response.status})`;
      const err = new Error(msg);
      err.statusCode = response.status;
      throw err;
    }

    return await response.json();
  } catch (error) {
    if (error.statusCode) throw error;
    const msg = error?.message || 'OpenRouter request failed.';
    const err = new Error(msg);
    err.statusCode = 500;
    throw err;
  }
}

// ── Anthropic API call ───────────────────────────────
async function callAnthropic({ apiKey, model, system, userPrompt, maxOutputTokens = 16384 }) {
  const messages = [
    { role: 'user', content: userPrompt },
  ];

  // Anthropic uses extended thinking for Opus 4.7
  // budget_tokens controls how much the model can think
  const thinkingBudget = Math.min(maxOutputTokens * 2, 32768);

  const body = {
    model: model,
    max_tokens: maxOutputTokens + thinkingBudget,
    messages,
    system: system || undefined,
    temperature: 1, // Required to be 1 when thinking is enabled
    thinking: {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    },
  };

  try {
    const response = await fetch(ANTHROPIC_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const msg = errorData?.error?.message || `Anthropic request failed (${response.status})`;
      const err = new Error(msg);
      err.statusCode = response.status;
      throw err;
    }

    return await response.json();
  } catch (error) {
    if (error.statusCode) throw error;
    const msg = error?.message || 'Anthropic request failed.';
    const err = new Error(msg);
    err.statusCode = 500;
    throw err;
  }
}

// ── Route: /api/chat/generate ────────────────────────
async function handleGenerate(req, res, env, authenticatedUser) {
  const body = await readJsonBody(req);
  const prompt = (body?.prompt || '').trim();
  const currentCode = typeof body?.currentCode === 'string' ? body.currentCode : '';

  if (!prompt) return sendJson(res, 400, { error: 'Missing prompt.' });

  const userPrompt = currentCode
    ? `The user already has this code:\n\`\`\`\n${currentCode}\n\`\`\`\n\nUser request: ${prompt}`
    : `Generate OpenSCAD code from scratch.\n\nUser request: ${prompt}`;

  const pro = isProUser(authenticatedUser);
  const provider = pro ? 'anthropic' : 'openrouter';
  const apiKey = pro ? env.ANTHROPIC_API_KEY : env.OPENROUTER_API_KEY;
  const model = pro ? ANTHROPIC_MODEL : OPENROUTER_MODEL;

  if (!apiKey) {
    return sendJson(res, 500, { error: 'AI service is not configured.' });
  }

  const result = await generateCompleteScad({
    provider,
    apiKey,
    model,
    maxOutputTokens: 16384,
    system: SYSTEM_PROMPT_GENERATE,
    userPrompt,
  });

  // Never expose the model name — use generic labels
  sendJson(res, 200, {
    scadCode: result.scadCode,
    model: pro ? 'AI Pro' : 'AI',
    finishReason: result.finishReason,
    continuationCount: result.continuationCount,
  });
}

// ── Route: /api/chat/face-edit ───────────────────────
async function handleFaceEdit(req, res, env, authenticatedUser) {
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

  const pro = isProUser(authenticatedUser);
  const provider = pro ? 'anthropic' : 'openrouter';
  const apiKey = pro ? env.ANTHROPIC_API_KEY : env.OPENROUTER_API_KEY;
  const model = pro ? ANTHROPIC_MODEL : OPENROUTER_MODEL;

  if (!apiKey) {
    return sendJson(res, 500, { error: 'AI service is not configured.' });
  }

  const result = await generateCompleteScad({
    provider,
    apiKey,
    model,
    maxOutputTokens: 16384,
    system: SYSTEM_PROMPT_FACE_EDIT,
    userPrompt,
  });

  // Never expose the model name — use generic labels
  sendJson(res, 200, {
    scadCode: result.scadCode,
    model: pro ? 'AI Pro' : 'AI',
    finishReason: result.finishReason,
    continuationCount: result.continuationCount,
  });
}

// ── Middleware export ────────────────────────────────
export function createApiMiddleware(env) {
  return async (req, res, next) => {
    const method = req.method || 'GET';
    const pathname = (req.url || '').split('?')[0];

    if (pathname !== '/api/chat/generate' && pathname !== '/api/chat/face-edit') {
      return next();
    }
    if (!env.OPENROUTER_API_KEY) {
      return sendJson(res, 500, { error: 'AI service is not configured on the server.' });
    }
    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }

    try {
      const authenticatedUser = await getAuthenticatedUser(req, env);
      const distinctId = authenticatedUser?.id || 'guest';
      const posthog = getPostHogClient();

      if (!authenticatedUser) {
        const rateLimit = enforceGuestRateLimit(req, res, env);
        if (!rateLimit.allowed) {
          posthog?.capture({
            distinctId,
            event: 'ai_request_rate_limited',
            properties: {
              endpoint: pathname,
              retry_after_seconds: rateLimit.retryAfterSeconds,
            },
          });
          return sendJson(res, 429, {
            error: rateLimit.message,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          });
        }
      }

      const eventName = pathname === '/api/chat/generate' ? 'ai_generate' : 'ai_face_edit';
      const startTime = Date.now();

      try {
        if (pathname === '/api/chat/generate') {
          await handleGenerate(req, res, env, authenticatedUser);
        } else {
          await handleFaceEdit(req, res, env, authenticatedUser);
        }
        posthog?.capture({
          distinctId,
          event: eventName,
          properties: {
            outcome: 'success',
            is_authenticated: Boolean(authenticatedUser),
            is_pro: isProUser(authenticatedUser),
            duration_ms: Date.now() - startTime,
          },
        });
      } catch (err) {
        posthog?.capture({
          distinctId,
          event: eventName,
          properties: {
            outcome: 'error',
            is_authenticated: Boolean(authenticatedUser),
            is_pro: isProUser(authenticatedUser),
            duration_ms: Date.now() - startTime,
            error_message: err?.message,
            status_code: err?.statusCode || 500,
          },
        });
        throw err;
      }
    } catch (err) {
      const statusCode = err?.statusCode || 500;
      sendJson(res, statusCode, { error: err?.message || 'Unhandled server error.' });
    }
  };
}

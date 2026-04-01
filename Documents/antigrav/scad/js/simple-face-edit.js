const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEIGHT_FACE_THRESHOLD = 0.82;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDominantAxis(vector) {
  if (!Array.isArray(vector) || vector.length < 3) return null;

  const [x = 0, y = 0, z = 0] = vector.map((value) => Number(value) || 0);
  const axes = [
    { axis: 'x', value: x, magnitude: Math.abs(x) },
    { axis: 'y', value: y, magnitude: Math.abs(y) },
    { axis: 'z', value: z, magnitude: Math.abs(z) },
  ].sort((a, b) => b.magnitude - a.magnitude);

  return {
    axis: axes[0].axis,
    sign: axes[0].value >= 0 ? 1 : -1,
    magnitude: axes[0].magnitude,
  };
}

function trimRange(sourceText, absoluteStart) {
  const leading = sourceText.match(/^\s*/)?.[0].length || 0;
  const trailing = sourceText.match(/\s*$/)?.[0].length || 0;
  const start = absoluteStart + leading;
  const end = absoluteStart + sourceText.length - trailing;
  return {
    text: sourceText.slice(leading, sourceText.length - trailing),
    from: start,
    to: end,
  };
}

function findMatchingParen(source, openParenIndex) {
  if (openParenIndex < 0 || source[openParenIndex] !== '(') return -1;

  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openParenIndex; i < source.length; i += 1) {
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
      if (char === inString) inString = null;
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

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function splitTopLevelSegments(sourceText, absoluteStart) {
  const segments = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;

  function pushSegment(endIndex) {
    const raw = sourceText.slice(start, endIndex);
    const trimmed = trimRange(raw, absoluteStart + start);
    if (!trimmed.text) {
      start = endIndex + 1;
      return;
    }
    segments.push(trimmed);
    start = endIndex + 1;
  }

  for (let i = 0; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    const next = sourceText[i + 1];

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
      if (char === inString) inString = null;
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

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen -= 1;
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket -= 1;
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace -= 1;
    else if (char === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      pushSegment(i);
    }
  }

  pushSegment(sourceText.length);
  return segments;
}

function findTopLevelEquals(sourceText) {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString = null;

  for (let i = 0; i < sourceText.length; i += 1) {
    const char = sourceText[i];

    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen -= 1;
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket -= 1;
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace -= 1;
    else if (char === '=' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      return i;
    }
  }

  return -1;
}

function parseCallArguments(source, sourceIndex) {
  const openParenIndex = source.indexOf('(', sourceIndex);
  if (openParenIndex < 0) return null;

  const closeParenIndex = findMatchingParen(source, openParenIndex);
  if (closeParenIndex < 0) return null;

  const argsText = source.slice(openParenIndex + 1, closeParenIndex);
  const rawSegments = splitTopLevelSegments(argsText, openParenIndex + 1);
  let positionalIndex = 0;

  const args = rawSegments.map((segment) => {
    const equalsIndex = findTopLevelEquals(segment.text);
    if (equalsIndex < 0) {
      const positionalArg = {
        text: segment.text,
        from: segment.from,
        to: segment.to,
        name: null,
        expressionText: segment.text,
        expressionFrom: segment.from,
        expressionTo: segment.to,
        position: positionalIndex,
      };
      positionalIndex += 1;
      return positionalArg;
    }

    const name = segment.text.slice(0, equalsIndex).trim();
    const expression = trimRange(
      segment.text.slice(equalsIndex + 1),
      segment.from + equalsIndex + 1
    );

    return {
      text: segment.text,
      from: segment.from,
      to: segment.to,
      name,
      expressionText: expression.text,
      expressionFrom: expression.from,
      expressionTo: expression.to,
      position: null,
    };
  });

  return {
    openParenIndex,
    closeParenIndex,
    args,
  };
}

function findArg(call, name, position) {
  if (!call?.args?.length) return null;
  if (name) {
    const named = call.args.find((arg) => arg.name === name);
    if (named) return named;
  }
  if (Number.isInteger(position)) {
    return call.args.find((arg) => arg.position === position) || null;
  }
  return null;
}

function parseArrayElements(expressionText, expressionFrom) {
  const trimmed = expressionText.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];

  const leadingWhitespace = expressionText.match(/^\s*/)?.[0].length || 0;
  const openBracketOffset = expressionText.indexOf('[', leadingWhitespace);
  const closeBracketOffset = expressionText.lastIndexOf(']');
  if (openBracketOffset < 0 || closeBracketOffset < 0 || closeBracketOffset <= openBracketOffset) {
    return [];
  }

  const innerText = expressionText.slice(openBracketOffset + 1, closeBracketOffset);
  return splitTopLevelSegments(innerText, expressionFrom + openBracketOffset + 1);
}

function findExpressionToSemicolon(source, fromIndex) {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let start = fromIndex;

  while (start < source.length && /\s/.test(source[start])) start += 1;

  for (let i = start; i < source.length; i += 1) {
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
      if (char === inString) inString = null;
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

    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }

    if (char === '(') depthParen += 1;
    else if (char === ')') depthParen -= 1;
    else if (char === '[') depthBracket += 1;
    else if (char === ']') depthBracket -= 1;
    else if (char === '{') depthBrace += 1;
    else if (char === '}') depthBrace -= 1;
    else if (char === ';' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      let end = i;
      while (end > start && /\s/.test(source[end - 1])) end -= 1;
      return {
        from: start,
        to: end,
        text: source.slice(start, end),
      };
    }
  }

  return null;
}

function findNearestAssignment(source, variableName, beforeIndex) {
  const assignmentRegex = new RegExp(`(^|\\n)\\s*${escapeRegex(variableName)}\\s*=`, 'g');
  let match = assignmentRegex.exec(source);
  let best = null;

  while (match) {
    const assignmentStart = match.index + match[0].lastIndexOf(variableName);
    if (assignmentStart >= beforeIndex) break;

    const equalsIndex = source.indexOf('=', assignmentStart + variableName.length);
    if (equalsIndex >= 0) {
      const expression = findExpressionToSemicolon(source, equalsIndex + 1);
      if (expression && expression.from < beforeIndex) {
        best = {
          variableName,
          expressionFrom: expression.from,
          expressionTo: expression.to,
          expressionText: expression.text,
        };
      }
    }

    match = assignmentRegex.exec(source);
  }

  return best;
}

function resolvePatchTarget(source, expression, beforeIndex) {
  if (!expression?.expressionText) return null;

  const rawExpression = expression.expressionText.trim();
  if (IDENTIFIER_RE.test(rawExpression)) {
    const assignment = findNearestAssignment(source, rawExpression, beforeIndex);
    if (assignment) {
      return {
        kind: 'variable',
        replaceFrom: assignment.expressionFrom,
        replaceTo: assignment.expressionTo,
        targetName: rawExpression,
        sourceText: assignment.expressionText,
        hint: `Updating ${rawExpression}`,
      };
    }
  }

  return {
    kind: 'inline',
    replaceFrom: expression.expressionFrom,
    replaceTo: expression.expressionTo,
    targetName: null,
    sourceText: expression.expressionText,
    hint: 'Updating selected primitive',
  };
}

function getResolvedArg(metaArgs, name, position) {
  if (!metaArgs || typeof metaArgs !== 'object') return undefined;
  if (name && metaArgs[name] !== undefined) return metaArgs[name];
  if (Number.isInteger(position) && metaArgs[position] !== undefined) return metaArgs[position];
  return undefined;
}

function getCubeEdit(source, selection, call) {
  const axisInfo = getDominantAxis(selection.localNormal || selection.worldNormal);
  if (!axisInfo) return null;

  const dimensionMap = {
    x: { index: 0, label: 'Width (X)' },
    y: { index: 2, label: 'Height (Z)' },
    z: { index: 1, label: 'Depth (Y)' },
  };
  const targetInfo = dimensionMap[axisInfo.axis];
  if (!targetInfo) return null;

  const sizeArg = findArg(call, 'size', 0);
  if (!sizeArg) return null;

  const sizeValue = getResolvedArg(selection.meta?.args, 'size', 0);
  if (sizeValue === undefined || sizeValue === null) return null;

  let expression = sizeArg;
  let currentValue = Number(sizeValue);
  let label = 'Uniform Size';

  if (Array.isArray(sizeValue)) {
    const elements = parseArrayElements(sizeArg.expressionText, sizeArg.expressionFrom);
    expression = elements[targetInfo.index] || null;
    currentValue = Number(sizeValue[targetInfo.index]);
    label = targetInfo.label;
  }

  if (!expression || !Number.isFinite(currentValue)) return null;

  const patchTarget = resolvePatchTarget(source, {
    expressionText: expression.text || expression.expressionText,
    expressionFrom: expression.from ?? expression.expressionFrom,
    expressionTo: expression.to ?? expression.expressionTo,
  }, selection.meta.sourceIndex);

  if (!patchTarget) return null;

  return {
    kind: 'simple',
    primitive: 'cube',
    label,
    currentValue,
    replaceFrom: patchTarget.replaceFrom,
    replaceTo: patchTarget.replaceTo,
    patchMode: patchTarget.kind,
    hint: patchTarget.hint,
  };
}

function pickFrustumEnd(selection, height, centered) {
  const localPointY = Number(selection.localPoint?.[1]);
  if (!Number.isFinite(localPointY)) return 'bottom';

  const midpoint = centered ? 0 : height / 2;
  return localPointY >= midpoint ? 'top' : 'bottom';
}

function getHeightEdit(selection, call) {
  const heightArg = findArg(call, 'h', 0);
  const currentValue = Number(getResolvedArg(selection.meta?.args, 'h', 0));

  if (!heightArg || !Number.isFinite(currentValue)) return null;

  return {
    label: 'Height',
    currentValue,
    expressionText: heightArg.expressionText,
    expressionFrom: heightArg.expressionFrom,
    expressionTo: heightArg.expressionTo,
  };
}

function getRadiusEdit(selection, call) {
  const metaArgs = selection.meta?.args || {};
  const centered = Boolean(metaArgs.center);
  const height = Number(metaArgs.h ?? metaArgs[0] ?? 0);
  const preferredEnd = pickFrustumEnd(selection, height, centered);

  const diameterArg = findArg(call, 'd');
  if (diameterArg) {
    const diameter = Number(getResolvedArg(metaArgs, 'd'));
    if (Number.isFinite(diameter)) {
      return {
        label: 'Diameter',
        currentValue: diameter,
        expressionText: diameterArg.expressionText,
        expressionFrom: diameterArg.expressionFrom,
        expressionTo: diameterArg.expressionTo,
      };
    }
  }

  const radiusArg = findArg(call, 'r');
  if (radiusArg) {
    const radius = Number(getResolvedArg(metaArgs, 'r'));
    if (Number.isFinite(radius)) {
      return {
        label: 'Radius',
        currentValue: radius,
        expressionText: radiusArg.expressionText,
        expressionFrom: radiusArg.expressionFrom,
        expressionTo: radiusArg.expressionTo,
      };
    }
  }

  const radiusArgs = {
    top: findArg(call, 'r2'),
    bottom: findArg(call, 'r1'),
  };
  const radiusValues = {
    top: Number(getResolvedArg(metaArgs, 'r2')),
    bottom: Number(getResolvedArg(metaArgs, 'r1')),
  };

  if (radiusArgs[preferredEnd] && Number.isFinite(radiusValues[preferredEnd])) {
    return {
      label: preferredEnd === 'top' ? 'Top Radius' : 'Bottom Radius',
      currentValue: radiusValues[preferredEnd],
      expressionText: radiusArgs[preferredEnd].expressionText,
      expressionFrom: radiusArgs[preferredEnd].expressionFrom,
      expressionTo: radiusArgs[preferredEnd].expressionTo,
    };
  }

  const fallbackEnd = preferredEnd === 'top' ? 'bottom' : 'top';
  if (radiusArgs[fallbackEnd] && Number.isFinite(radiusValues[fallbackEnd])) {
    return {
      label: fallbackEnd === 'top' ? 'Top Radius' : 'Bottom Radius',
      currentValue: radiusValues[fallbackEnd],
      expressionText: radiusArgs[fallbackEnd].expressionText,
      expressionFrom: radiusArgs[fallbackEnd].expressionFrom,
      expressionTo: radiusArgs[fallbackEnd].expressionTo,
    };
  }

  return null;
}

function getRoundPrimitiveEdit(source, selection, call) {
  const axisInfo = getDominantAxis(selection.localNormal || selection.worldNormal);
  if (!axisInfo) return null;

  const heightLikeSelection = axisInfo.axis === 'y' && axisInfo.magnitude >= HEIGHT_FACE_THRESHOLD;
  const edit = heightLikeSelection
    ? getHeightEdit(selection, call)
    : getRadiusEdit(selection, call);

  if (!edit) return null;

  const patchTarget = resolvePatchTarget(source, edit, selection.meta.sourceIndex);
  if (!patchTarget) return null;

  return {
    kind: 'simple',
    primitive: selection.meta?.primitive || 'round',
    label: edit.label,
    currentValue: edit.currentValue,
    replaceFrom: patchTarget.replaceFrom,
    replaceTo: patchTarget.replaceTo,
    patchMode: patchTarget.kind,
    hint: patchTarget.hint,
  };
}

function getSphereEdit(source, selection, call) {
  const metaArgs = selection.meta?.args || {};
  const diameterArg = findArg(call, 'd');
  const radiusArg = findArg(call, 'r', 0);
  const chosenArg = diameterArg || radiusArg;

  if (!chosenArg) return null;

  const label = diameterArg ? 'Diameter' : 'Radius';
  const currentValue = Number(diameterArg ? metaArgs.d : (metaArgs.r ?? metaArgs[0]));
  if (!Number.isFinite(currentValue)) return null;

  const patchTarget = resolvePatchTarget(source, {
    expressionText: chosenArg.expressionText,
    expressionFrom: chosenArg.expressionFrom,
    expressionTo: chosenArg.expressionTo,
  }, selection.meta.sourceIndex);

  if (!patchTarget) return null;

  return {
    kind: 'simple',
    primitive: 'sphere',
    label,
    currentValue,
    replaceFrom: patchTarget.replaceFrom,
    replaceTo: patchTarget.replaceTo,
    patchMode: patchTarget.kind,
    hint: patchTarget.hint,
  };
}

function getPrimitiveEdit(source, selection, call) {
  const primitive = selection.meta?.primitive;
  if (!primitive) return null;

  if (primitive === 'cube') return getCubeEdit(source, selection, call);
  if (primitive === 'cylinder' || primitive === 'cone') return getRoundPrimitiveEdit(source, selection, call);
  if (primitive === 'sphere') return getSphereEdit(source, selection, call);

  return null;
}

function getCallSourceIndex(selection) {
  const sourceIndex = selection?.meta?.sourceIndex;
  return typeof sourceIndex === 'number' && sourceIndex >= 0 ? sourceIndex : null;
}

function normalizeEditedValue(nextValue) {
  const value = typeof nextValue === 'number' ? nextValue : Number(nextValue);
  if (!Number.isFinite(value)) return null;

  const rounded = Math.round(value * 1000) / 1000;
  if (Object.is(rounded, -0)) return '0';
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function getSimpleFaceEditSpec(source, selection) {
  if (!source || !selection?.meta?.primitive) return null;

  const sourceIndex = getCallSourceIndex(selection);
  if (sourceIndex === null) return null;

  const call = parseCallArguments(source, sourceIndex);
  if (!call) return null;

  return getPrimitiveEdit(source, selection, call);
}

export function applySimpleFaceEdit(source, selection, nextValue) {
  const spec = getSimpleFaceEditSpec(source, selection);
  if (!spec) {
    throw new Error('This face does not support quick local edits yet.');
  }

  const normalizedValue = normalizeEditedValue(nextValue);
  if (normalizedValue === null) {
    throw new Error('Enter a valid number for the quick edit.');
  }

  if (Number(normalizedValue) <= 0) {
    throw new Error('Quick edit values must be greater than 0.');
  }

  const updatedSource = `${source.slice(0, spec.replaceFrom)}${normalizedValue}${source.slice(spec.replaceTo)}`;

  return {
    updatedSource,
    spec,
    appliedValue: Number(normalizedValue),
  };
}

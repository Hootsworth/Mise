/**
 * Incrementally extracts partial recipe fields from streaming JSON tokens
 * so Mise can typeset title, metadata, ingredients, and steps live.
 */
function stripFences(raw) {
  let s = String(raw || "").trimStart();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "");
    const endIdx = s.lastIndexOf("```");
    if (endIdx !== -1 && endIdx > 0) {
      const after = s.slice(endIdx + 3).trim();
      if (!after) s = s.slice(0, endIdx);
    }
  }
  const objStart = s.indexOf("{");
  return objStart === -1 ? s : s.slice(objStart);
}

function unescapeJsonFragment(frag) {
  let out = "";
  for (let i = 0; i < frag.length; i++) {
    const ch = frag[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (i + 1 >= frag.length) break;
    const next = frag[++i];
    if (next === '"') out += '"';
    else if (next === "\\") out += "\\";
    else if (next === "/") out += "/";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "u" && i + 4 < frag.length) {
      const hex = frag.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    }
  }
  return out;
}

function readJsonString(src, quoteIdx) {
  let i = quoteIdx + 1;
  let closed = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      closed = true;
      break;
    }
    i++;
  }
  const value = unescapeJsonFragment(src.slice(quoteIdx + 1, Math.min(i, src.length)));
  return { value, closed, nextIndex: closed ? i + 1 : src.length };
}

function readTopLevelValue(src, valStart) {
  if (valStart >= src.length) return { value: undefined, closed: false };
  const ch = src[valStart];
  if (ch === '"') return readJsonString(src, valStart);
  if (ch === "{") {
    const end = findBalancedEnd(src, valStart, "{", "}");
    if (end !== -1) {
      try {
        return { value: JSON.parse(src.slice(valStart, end + 1)), closed: true };
      } catch {
        return { value: undefined, closed: false };
      }
    }
    return { value: undefined, closed: false };
  }
  if (ch === "[") {
    const end = findBalancedEnd(src, valStart, "[", "]");
    if (end !== -1) {
      try {
        return { value: JSON.parse(src.slice(valStart, end + 1)), closed: true };
      } catch {
        return { value: undefined, closed: false };
      }
    }
    return { value: src.slice(valStart), closed: false, partialArray: true };
  }
  // Primitive (number, boolean, null)
  const m = /^([^,}\]\s]+)/.exec(src.slice(valStart));
  if (!m) return { value: undefined, closed: false };
  const token = m[1];
  const rest = src.slice(valStart + token.length);
  // Ensure the token isn't still mid-stream if nothing follows it
  if (!rest.length) return { value: undefined, closed: false };
  if (token === "true") return { value: true, closed: true };
  if (token === "false") return { value: false, closed: true };
  if (token === "null") return { value: null, closed: true };
  const num = Number(token);
  if (!Number.isNaN(num)) return { value: num, closed: true };
  return { value: undefined, closed: false };
}

function findBalancedEnd(src, startIdx, openCh, closeCh) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTopLevelKey(src, keyName) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 1) {
        const keyRes = readJsonString(src, i);
        if (keyRes.closed && keyRes.value === keyName) {
          let j = keyRes.nextIndex;
          while (j < src.length && /\s/.test(src[j])) j++;
          if (src[j] === ":") {
            j++;
            while (j < src.length && /\s/.test(src[j])) j++;
            return j;
          }
        }
        i = keyRes.nextIndex - 1;
        continue;
      }
      inStr = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
  return -1;
}

function extractPartialObjectArray(src, arrStartIdx) {
  if (arrStartIdx === -1 || src[arrStartIdx] !== "[") return { items: [], closed: false };
  const items = [];
  let i = arrStartIdx + 1;
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === "]") return { items, closed: true };
    if (src[i] === "{") {
      const end = findBalancedEnd(src, i, "{", "}");
      if (end !== -1) {
        try {
          items.push(JSON.parse(src.slice(i, end + 1)));
        } catch {
          // Ignore malformed element
        }
        i = end + 1;
        continue;
      }
      // Partial object at tail: extract fields we already have!
      const partialSrc = src.slice(i);
      const partialObj = {};
      for (const k of ["item", "unit", "note", "title", "text"]) {
        const kIdx = findTopLevelKey(partialSrc, k);
        if (kIdx !== -1 && partialSrc[kIdx] === '"') {
          partialObj[k] = readJsonString(partialSrc, kIdx).value;
        }
      }
      for (const k of ["amount", "minutes"]) {
        const kIdx = findTopLevelKey(partialSrc, k);
        if (kIdx !== -1) {
          const val = readTopLevelValue(partialSrc, kIdx);
          if (val.closed) partialObj[k] = val.value;
        }
      }
      if (Object.keys(partialObj).length > 0) {
        partialObj.__streaming = true;
        items.push(partialObj);
      }
      break;
    }
    i++;
  }
  return { items, closed: false };
}

function extractPartialStringArray(src, arrStartIdx) {
  if (arrStartIdx === -1 || src[arrStartIdx] !== "[") return { items: [], closed: false };
  const items = [];
  let i = arrStartIdx + 1;
  while (i < src.length) {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === "]") return { items, closed: true };
    if (src[i] === '"') {
      const str = readJsonString(src, i);
      if (str.value) items.push(str.value);
      if (!str.closed) break;
      i = str.nextIndex;
      continue;
    }
    i++;
  }
  return { items, closed: false };
}

/**
 * Parses a streaming JSON recipe payload into a partial recipe object and progress phase.
 */
export function extractPartialRecipe(rawText) {
  const cleaned = stripFences(rawText);
  if (!cleaned.startsWith("{")) {
    return { recipe: null, isComplete: false, phase: "title" };
  }

  try {
    const full = JSON.parse(cleaned);
    if (full && typeof full === "object" && !Array.isArray(full)) {
      return { recipe: full, isComplete: true, phase: "done" };
    }
  } catch {
    // Continue to partial scan
  }

  const recipe = {};
  for (const key of ["title", "tagline", "difficulty", "cuisine", "error", "change_summary"]) {
    const idx = findTopLevelKey(cleaned, key);
    if (idx !== -1 && cleaned[idx] === '"') {
      recipe[key] = readJsonString(cleaned, idx).value;
    }
  }
  for (const key of ["prep_minutes", "cook_minutes", "time_minutes", "servings"]) {
    const idx = findTopLevelKey(cleaned, key);
    if (idx !== -1) {
      const val = readTopLevelValue(cleaned, idx);
      if (val.closed && typeof val.value === "number") recipe[key] = val.value;
    }
  }

  const ingIdx = findTopLevelKey(cleaned, "ingredients");
  const ingRes = extractPartialObjectArray(cleaned, ingIdx);
  if (ingRes.items.length) recipe.ingredients = ingRes.items;

  const stepIdx = findTopLevelKey(cleaned, "steps");
  const stepRes = extractPartialObjectArray(cleaned, stepIdx);
  if (stepRes.items.length) recipe.steps = stepRes.items;

  const tipsIdx = findTopLevelKey(cleaned, "tips");
  const tipsRes = extractPartialStringArray(cleaned, tipsIdx);
  if (tipsRes.items.length) recipe.tips = tipsRes.items;

  let phase = "title";
  if (tipsRes.items.length) phase = "tips";
  else if (stepRes.items.length) phase = "steps";
  else if (ingRes.items.length) phase = "ingredients";

  return {
    recipe: Object.keys(recipe).length ? recipe : null,
    isComplete: false,
    phase
  };
}

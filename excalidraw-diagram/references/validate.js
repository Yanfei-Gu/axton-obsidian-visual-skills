#!/usr/bin/env node
/**
 * Validate Excalidraw JSON structure before output.
 *
 * Catches common errors: overlap, text overflow, missing fields,
 * orphan bindings, duplicate IDs, canvas bounds.
 *
 * Works in BOTH multimodal and text-only model environments —
 * no visual inspection required.
 *
 * Usage:
 *   node references/validate.js <path-to-file.excalidraw>
 *
 * Exit codes: 0 = valid (or warnings only), 1 = errors found, 2 = file/parse error
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_BASE = [
  'id', 'type', 'x', 'y', 'width', 'height',
  'angle', 'strokeColor', 'backgroundColor', 'fillStyle',
  'strokeWidth', 'strokeStyle', 'roughness', 'opacity',
  'groupIds', 'roundness', 'seed', 'version',
  'isDeleted', 'boundElements', 'updated', 'link', 'locked',
];

const REQUIRED_TEXT = [
  'text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign',
  'containerId', 'originalText', 'autoResize', 'lineHeight',
];

const FORBIDDEN_FIELDS = new Set(['frameId', 'index', 'versionNonce', 'rawText']);

const WARN_MIN_FONT = 14;
const CJK_FACTOR = 1.0;
const LATIN_FACTOR = 0.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function charWidth(ch, fontSize) {
  return ch.codePointAt(0) > 0x2E7F ? fontSize * CJK_FACTOR : fontSize * LATIN_FACTOR;
}

function estimateTextWidth(text, fontSize) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return w;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkDuplicateIds(elements) {
  const errors = [];
  const seen = new Map();
  for (const el of elements) {
    if (el.id == null) continue;
    seen.set(el.id, (seen.get(el.id) || 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) errors.push(`Duplicate id '${id}' appears ${count} times`);
  }
  return errors;
}

function checkRequiredFields(elements) {
  const errors = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const eid = el.id || '?';
    const etype = el.type || '?';
    for (const f of REQUIRED_BASE) {
      if (!(f in el)) errors.push(`[${eid}] Missing required field: ${f}`);
    }
    if (etype === 'text') {
      for (const f of REQUIRED_TEXT) {
        if (!(f in el)) errors.push(`[${eid}] Text element missing: ${f}`);
      }
    }
    for (const f of FORBIDDEN_FIELDS) {
      if (f in el) errors.push(`[${eid}] Forbidden field: ${f}`);
    }
    if (Array.isArray(el.boundElements) && el.boundElements.length === 0) {
      errors.push(`[${eid}] boundElements should be null, not []`);
    }
    if (el.updated !== 1) {
      errors.push(`[${eid}] updated should be 1, got ${el.updated}`);
    }
  }
  return errors;
}

function checkOrphanBindings(elements) {
  const errors = [];
  const allIds = new Set(
    elements.filter(e => !e.isDeleted && e.id != null).map(e => e.id)
  );

  for (const el of elements) {
    if (el.isDeleted) continue;
    const eid = el.id || '?';

    if (el.containerId != null && !allIds.has(el.containerId)) {
      errors.push(`[${eid}] containerId refs non-existent: ${el.containerId}`);
    }

    if (Array.isArray(el.boundElements)) {
      for (const b of el.boundElements) {
        if (b.id != null && !allIds.has(b.id)) {
          errors.push(`[${eid}] boundElements refs non-existent: ${b.id}`);
        }
      }
    }

    if (el.type === 'arrow' || el.type === 'line') {
      for (const key of ['startBinding', 'endBinding']) {
        const binding = el[key];
        if (binding && typeof binding === 'object' && binding.elementId != null) {
          if (!allIds.has(binding.elementId)) {
            errors.push(`[${eid}] ${key} refs non-existent: ${binding.elementId}`);
          }
        }
      }
    }
  }
  return errors;
}

function checkOverlaps(elements) {
  const warnings = [];
  const shapes = elements.filter(
    e => !e.isDeleted && !['text', 'arrow', 'line'].includes(e.type)
  );

  for (let i = 0; i < shapes.length; i++) {
    const a = shapes[i];
    if ((a.opacity ?? 100) < 50) continue; // skip background zones

    for (let j = i + 1; j < shapes.length; j++) {
      const b = shapes[j];
      if ((b.opacity ?? 100) < 50) continue;

      const ax = a.x, ay = a.y;
      const aw = Math.abs(a.width || 0), ah = Math.abs(a.height || 0);
      const bx = b.x, by = b.y;
      const bw = Math.abs(b.width || 0), bh = Math.abs(b.height || 0);

      if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by) {
        const ox = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
        const oy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
        const area = ox * oy;
        const smaller = Math.min(aw * ah, bw * bh);
        if (smaller > 0 && area / smaller > 0.1) {
          warnings.push(
            `[${a.id}] & [${b.id}] overlap ${Math.round(ox)}x${Math.round(oy)}px (${Math.round(area / smaller * 100)}% of smaller)`
          );
        }
      }
    }
  }
  return warnings;
}

function checkTextOverflow(elements) {
  const warnings = [];
  const byId = new Map(
    elements.filter(e => !e.isDeleted).map(e => [e.id, e])
  );

  for (const el of elements) {
    if (el.isDeleted || el.type !== 'text') continue;
    if (el.containerId == null || !byId.has(el.containerId)) continue;

    const container = byId.get(el.containerId);
    const text = el.text || '';
    const fontSize = el.fontSize || 16;
    const cw = Math.abs(container.width || 0);
    const padding = 10;
    const available = cw - padding * 2;

    for (const line of text.split('\n')) {
      const est = estimateTextWidth(line, fontSize);
      if (est > available) {
        warnings.push(
          `[${el.id}] Text may overflow container [${el.containerId}]: est ${Math.round(est)}px > available ${Math.round(available)}px`
        );
        break;
      }
    }
  }
  return warnings;
}

function checkFontSizes(elements) {
  const warnings = [];
  for (const el of elements) {
    if (el.isDeleted || el.type !== 'text') continue;
    const fs = el.fontSize || 16;
    if (fs < WARN_MIN_FONT) {
      warnings.push(`[${el.id || '?'}] fontSize ${fs}px < ${WARN_MIN_FONT}px minimum`);
    }
  }
  return warnings;
}

function checkCanvasBounds(elements) {
  const warnings = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const x = el.x || 0, y = el.y || 0;
    if (x < -200 || y < -200 || x > 2000 || y > 1500) {
      warnings.push(
        `[${el.id || '?'}] Position (${Math.round(x)}, ${Math.round(y)}) far outside recommended canvas (0-1200 x 0-800)`
      );
    }
  }
  return warnings;
}

function computeBoundingBox(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const x = el.x || 0, y = el.y || 0;
    if ((el.type === 'arrow' || el.type === 'line') && Array.isArray(el.points)) {
      for (const [px, py] of el.points) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        maxX = Math.max(maxX, x + px);
        maxY = Math.max(maxY, y + py);
      }
    } else {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + Math.abs(el.width || 0));
      maxY = Math.max(maxY, y + Math.abs(el.height || 0));
    }
  }
  if (minX === Infinity) return [0, 0, 800, 600];
  return [minX, minY, maxX, maxY];
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

function validate(data) {
  const errors = [];
  const warnings = [];

  // Structural
  if (data.type !== 'excalidraw') {
    errors.push(`Expected type 'excalidraw', got '${data.type}'`);
  }
  if (!('elements' in data)) {
    errors.push("Missing 'elements' array");
    return { errors, warnings };
  }
  if (!Array.isArray(data.elements)) {
    errors.push("'elements' must be an array");
    return { errors, warnings };
  }
  if (data.elements.length === 0) {
    errors.push("'elements' array is empty");
    return { errors, warnings };
  }
  if (!('appState' in data)) warnings.push("Missing 'appState'");
  if (!('files' in data)) warnings.push("Missing 'files' field");

  const elements = data.elements;

  // Element-level
  errors.push(...checkDuplicateIds(elements));
  errors.push(...checkRequiredFields(elements));
  errors.push(...checkOrphanBindings(elements));

  const overlaps = checkOverlaps(elements);
  if (overlaps.length > 0) {
    warnings.push(`Potential overlaps (${overlaps.length}):`);
    warnings.push(...overlaps.slice(0, 10).map(o => `  - ${o}`));
  }

  const overflow = checkTextOverflow(elements);
  if (overflow.length > 0) {
    warnings.push(`Text overflow warnings (${overflow.length}):`);
    warnings.push(...overflow.map(o => `  - ${o}`));
  }

  const fontIssues = checkFontSizes(elements);
  if (fontIssues.length > 0) {
    warnings.push(`Font size warnings (${fontIssues.length}):`);
    warnings.push(...fontIssues.map(f => `  - ${f}`));
  }

  const boundsIssues = checkCanvasBounds(elements);
  if (boundsIssues.length > 0) {
    warnings.push(`Canvas bounds warnings (${boundsIssues.length}):`);
    warnings.push(...boundsIssues.map(b => `  - ${b}`));
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate.js <path-to-file.excalidraw>');
    process.exit(2);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`ERROR: File not found: ${absPath}`);
    process.exit(2);
  }

  let data;
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`ERROR: Invalid JSON: ${e.message}`);
    process.exit(2);
  }

  const { errors, warnings } = validate(data);

  // Report
  if (errors.length > 0) {
    console.log(`❌ ERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  - ${e}`);
  }

  if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):`);
    for (const w of warnings) console.log(`  ${w}`);
  }

  // Summary
  const live = (data.elements || []).filter(e => !e.isDeleted);
  const bbox = computeBoundingBox(live);
  console.log(`\n📊 Stats: ${live.length} elements, canvas ${Math.round(bbox[2] - bbox[0])}x${Math.round(bbox[3] - bbox[1])}px`);

  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All checks passed!');
    process.exit(0);
  } else if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} error(s) must be fixed before saving.`);
    process.exit(1);
  } else {
    console.log(`\n⚠️  ${warnings.length} warning(s) — review recommended.`);
    process.exit(0);
  }
}

main();

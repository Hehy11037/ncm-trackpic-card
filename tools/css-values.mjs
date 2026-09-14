// Reading numbers out of the stylesheet without a browser.
//
//   import { makeCssReader } from './css-values.mjs'
//
// No browser is available in this environment, so the checks recompute where each element
// lands by resolving the stylesheet's custom properties and summing boxes, margins and
// padding. This module is that evaluator, shared by check-layout.mjs and
// check-interaction.mjs so the two cannot disagree about what the CSS says.
//
// Three parsing traps are handled explicitly, each of which caused a silent hang or crash
// while this was being written:
//   1. `calc(var(--u) * 2.6)` has nested parentheses - a regex cannot strip `calc()`.
//   2. A declaration must not run past `{` into the next rule.
//   3. A shorthand's components contain spaces inside parentheses, so splitting on
//      whitespace alone is wrong.

import { readFileSync } from 'node:fs';

// Remove CSS comments, so a comment can never be mistaken for a selector.
export function stripComments(cssText) {
  return String(cssText).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** All `--custom: value` declarations in a stylesheet, last one winning. */
export function readCustomProperties(cssText) {
  const props = new Map();
  for (const m of cssText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) props.set(m[1], m[2].trim());
  return props;
}

export function readStyle(relativePath) {
  return readFileSync(relativePath, 'utf8');
}

/**
 * Build a reader for a stylesheet pair.
 *
 * @param {{tokens: string, rules: string}} sources `tokens` supplies custom properties,
 *   `rules` is where selectors are looked up.
 */
export function makeCssReader({ tokens, rules }) {
  // Comments are stripped up front: a comment sitting above a rule would otherwise be swept
  // into that rule's selector by a `([^{}]+)\{...\}` scan, which silently broke a check that
  // looked for `button` among the `no-drag` selectors.
  const props = readCustomProperties(stripComments(tokens));
  const sheet = stripComments(rules);
  const cache = new Map();

  /** Replace `calc(...)` with a plain parenthesised expression, counting depth. */
  function stripCalc(text) {
    let result = text;
    for (let guard = 0; guard < 50; guard++) {
      const start = result.indexOf('calc(');
      if (start < 0) return result;
      let depth = 0;
      let end = -1;
      for (let i = start + 4; i < result.length; i++) {
        if (result[i] === '(') depth++;
        else if (result[i] === ')') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) return result;
      result = `${result.slice(0, start)}(${result.slice(start + 5, end)})${result.slice(end + 1)}`;
    }
    return result;
  }

  function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of String(text)) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      const isSeparator = (/\s/.test(ch) || ch === ',') && depth === 0;
      if (isSeparator) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /**
   * Evaluate a declaration to a number.
   *
   * `var(--u)` resolves to 1, so every result is in units (1u = 1% of the card width) unless
   * the expression is absolute. `max(a, b)` keeps its first argument, because the floors in
   * the font sizes exist for legibility and the reference comparison wants the measured value.
   */
  function evaluate(expression, depth = 0) {
    if (expression === null || expression === undefined) return 0;
    if (depth > 10) return 0;
    let text = String(expression).trim();
    if (!text) return 0;

    text = text.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/gi, (_m, name, fallback) => {
      if (name === '--u' || name === '--u-pure') return '1';
      if (cache.has(name)) return String(cache.get(name));
      if (props.has(name)) {
        const resolved = evaluate(props.get(name), depth + 1);
        cache.set(name, resolved);
        return String(resolved);
      }
      return fallback !== undefined ? String(evaluate(fallback, depth + 1)) : '0';
    });

    while (/max\(/.test(text)) {
      const start = text.indexOf('max(');
      let depthCount = 0;
      let end = -1;
      for (let i = start + 3; i < text.length; i++) {
        if (text[i] === '(') depthCount++;
        else if (text[i] === ')') {
          depthCount--;
          if (depthCount === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) break;
      const args = text.slice(start + 4, end);
      // `max()` separates its arguments with commas, unlike a CSS shorthand's spaces.
      const parts = splitTopLevel(args);
      text = `${text.slice(0, start)}(${parts[0] ?? '0'})${text.slice(end + 1)}`;
    }

    text = stripCalc(text);
    const numeric = text.replace(/px|deg|em|%/g, '').trim();
    if (!/^[\d\s+\-*/().]+$/.test(numeric)) return 0;
    try {
      const out = Function(`"use strict"; return (${numeric});`)();
      return Number.isFinite(out) ? out : 0;
    } catch {
      return 0;
    }
  }

  /** Raw declaration text for a property in a rule, or null. */
  function declaration(selector, property) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
    if (!block) return null;
    // `[^;{}]`: a value must not run past the end of the rule into the next one.
    const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;{}]+)`).exec(block[1]);
    return found ? found[1].trim() : null;
  }

  /** Every declaration block whose selector matches, in source order. */
  function blocks(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...sheet.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  }

  const value = (selector, property) => evaluate(declaration(selector, property));

  const unit = (name) => evaluate(props.get(name));

  /** One component of a shorthand, ignoring spaces inside parentheses. */
  function shorthand(selector, property, index) {
    const raw = declaration(selector, property);
    if (!raw) return 0;
    const parts = splitTopLevel(raw).filter((part) => part !== ',');
    return evaluate(parts[Math.min(index, parts.length - 1)]);
  }

  return { props, rules: sheet, tokens: stripComments(tokens), evaluate, declaration, blocks, value, unit, shorthand, splitTopLevel };
}

/**
 * Split on top-level commas only, ignoring commas inside parentheses.
 *
 * This is what a comma-separated *list* needs - `box-shadow` layers, font stacks. Note that
 * `splitTopLevel` also splits on whitespace, which is right for `max(a, b)` arguments and
 * wrong here: it would chop every shadow layer into its individual lengths.
 */
export function splitCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Split on whitespace, ignoring spaces inside parentheses.
 *
 * `calc(var(--u) * 2.6)` is one component, not four.
 */
export function splitWhitespace(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Sides of a `padding` / `margin` shorthand, as `[top, right, bottom, left]`.
 *
 * Handles the 1, 2, 3 and 4 value forms; anything else falls back to the first value on all
 * four sides, which is what a browser does with an invalid shorthand.
 */
export function shorthandSides(text) {
  const parts = splitWhitespace(text);

  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  if (parts.length >= 4) return [parts[0], parts[1], parts[2], parts[3]];
  return ['0', '0', '0', '0'];
}

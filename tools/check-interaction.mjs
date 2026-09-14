// Verify the things that make the card *operable* - the class of bug a screenshot cannot show.
//
//   node tools/check-interaction.mjs
//
// This exists because the colour band shipped looking correct and could not be clicked: the
// swatches were 4px tall, and their `no-drag` carve-out was barely larger, so a click either
// missed or was swallowed as a window drag. Nothing in the layout check noticed. So this one
// asserts, from the stylesheet and the module sources alone:
//
//   - the band's clickable box is a real target, and its padding still cancels out of the layout
//   - every interactive element opts out of the window's drag region
//   - every control has a handler bound somewhere
//   - the floating shadow fits inside the transparent margin the window leaves for it
//   - the roll-up actually has two mutually exclusive states with the right contents

import { readFileSync } from 'node:fs';

import { makeCssReader, readStyle, shorthandSides, splitCommas, splitWhitespace } from './css-values.mjs';

const tokensText = readStyle('ui/styles/tokens.css');
const css = makeCssReader({ tokens: tokensText, rules: readStyle('ui/styles/card.css') });
const html = readStyle('ui/index.html');
const mainJs = readStyle('ui/src/main.js');
const cardJs = readStyle('ui/src/card.js');
const layoutJs = readStyle('ui/src/layout.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

/** The card width the checks assume, matching DEFAULT_WIDTH in the shell. */
const CARD_WIDTH = 400;
const UNIT_PX = CARD_WIDTH / 100;

/* ------------------------------------------------------------ hit targets */

console.log('--- 命中区域 ---');
{
  const height = css.value('.band', 'height');
  const padding = shorthandSides(css.declaration('.band', 'padding')).map((v) => css.evaluate(v));
  const margin = shorthandSides(css.declaration('.band', 'margin')).map((v) => css.evaluate(v));

  // `content-box` is load-bearing: with the global `border-box` the padding would eat the
  // measured height (1.7u is smaller than 2 x 2.4u) and the visible band would grow.
  check('色带用 content-box', css.declaration('.band', 'box-sizing') === 'content-box');

  const hitUnits = height + padding[0] + padding[2];
  const hitPx = hitUnits * UNIT_PX;
  check(
    `色带可点击高度 >= 24px`,
    hitPx >= 24,
    `${hitUnits.toFixed(2)}u = ${hitPx.toFixed(1)}px @ ${CARD_WIDTH}px 卡片`,
  );

  // The negative margin must cancel the padding exactly, or the band moves and every measured
  // position below it (hex labels, credit) shifts with it.
  const cancels = Math.abs(margin[0] + padding[0]) < 0.001 && Math.abs(margin[2] + padding[2]) < 0.001;
  check('内边距被负外边距抵消（视觉位置不变）', cancels, `padding ${padding[0]}, margin ${margin[0]}`);

  // Each swatch is one fifth of the card width, so the target is wide as well as tall.
  const swatchPx = (100 / 5) * UNIT_PX;
  check('每个色块宽度 >= 40px', swatchPx >= 40, `${swatchPx.toFixed(0)}px`);

  const ctrlPx = css.value('.ctrl', 'width') * UNIT_PX;
  check('播放控制 >= 16px', ctrlPx >= 16, `${ctrlPx.toFixed(1)}px`);
}

/* --------------------------------------------------------------- no-drag */

console.log('\n--- 窗口拖拽区域 ---');
{
  // `-webkit-app-region: drag` on the body is what makes the whole window a drag handle; the
  // interactive elements must carve themselves out of it or their clicks become window drags.
  check('body 声明了 drag（整个窗口可拖动）', /-webkit-app-region:\s*drag/.test(tokensText));

  const noDragSelectors = new Set();
  for (const m of css.rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/-webkit-app-region:\s*no-drag/.test(m[2])) continue;
    for (const selector of m[1].split(',')) noDragSelectors.add(selector.trim());
  }

  const required = ['button', '.band', '.band-segment', '.ctrl', '.icon-btn', '.mini-action'];
  for (const selector of required) {
    check(`${selector} 声明 no-drag`, noDragSelectors.has(selector));
  }
}

/* -------------------------------------------------------------- handlers */

console.log('\n--- 事件绑定 ---');
{
  // The band is delegated on the container and falls back to the pointer's x position, so a
  // click anywhere in the padded hit box selects a colour - including the padding, which is
  // where a click that "does nothing" would otherwise land.
  check('色带用容器事件委托', /bindBand\(\)/.test(cardJs) && /addEventListener\('click'/.test(cardJs));
  check('色带按位置兜底取色', /closest\('\.band-segment'\)/.test(cardJs) && /getBoundingClientRect/.test(cardJs));
  check('色块带索引以便委托取值', /dataset\.index/.test(cardJs));

  for (const id of ['flip', 'close', 'lock', 'mini-expand']) {
    check(`#${id} 绑定了 click`, new RegExp(`on\\('${id}'`).test(mainJs));
    check(`#${id} 存在于 index.html`, html.includes(`id="${id}"`));
  }
  check('播放控制绑定了 click', /\.ctrl\[data-action\]/.test(mainJs));
  check('键盘 L 切换锁定', /event\.key === 'l'/.test(mainJs));

  // Clicking a swatch must actually repaint: setBackground has to be reachable from the click.
  check('点击色块会换背景', /setBackground\(/.test(cardJs) && /--bg/.test(cardJs));
}

/* ---------------------------------------------------------------- shadow */

console.log('\n--- 悬浮阴影 ---');
{
  const shadowPad = css.unit('--shadow-pad');
  check('存在 --shadow-pad', shadowPad > 0, `${shadowPad}px`);
  check('卡片使用 --shadow-float', (css.declaration('.card', 'box-shadow') ?? '').includes('var(--shadow-float)'));
  check('mini 条也有阴影', (css.declaration('.mini', 'box-shadow') ?? '').includes('var(--shadow-float)'));

  // Parse the shadow's layers and work out how far the largest one reaches, then compare with
  // the transparent margin the shell leaves around the card. A shadow larger than the margin
  // is clipped flat at the window edge, which reads as a rendering bug rather than a shadow.
  const raw = css.props.get('--shadow-float') ?? '';
  const layers = splitCommas(raw);
  let maxExtent = 0;
  let hasRim = false;
  for (const layer of layers) {
    const parts = splitWhitespace(layer);
    if (parts.length < 3) continue;
    const isRim = css.evaluate(parts[2]) === 0 && css.evaluate(parts[0]) === 0 && css.evaluate(parts[1]) === 0;
    if (isRim) hasRim = true;
    const offsetY = css.evaluate(parts[1]);
    const blur = css.evaluate(parts[2]);
    const spread = parts.length >= 4 && !/^rgba?\(/.test(parts[3]) ? css.evaluate(parts[3]) : 0;
    maxExtent = Math.max(maxExtent, Math.abs(offsetY) + blur / 2 + spread);
  }
  check('阴影有 3 层（含描边）', layers.length >= 3, `${layers.length} 层`);
  check('有一圈轮廓描边', hasRim);
  const extentPx = maxExtent * UNIT_PX;
  check('阴影不超出窗口留白', extentPx <= shadowPad + 0.5, `${extentPx.toFixed(1)}px <= ${shadowPad}px`);
}

/* --------------------------------------------------------------- top bar */

console.log('\n--- 顶栏按钮 ---');
{
  check('顶栏左右分布', css.declaration('.top-bar', 'justify-content') === 'space-between');
  const size = css.value('.icon-btn', 'width');
  check('图标按钮比旧版放大（> 5u）', size > 5, `${size}u = ${(size * UNIT_PX).toFixed(1)}px`);
  check('图标按钮命中 >= 24px', size * UNIT_PX >= 24, `${(size * UNIT_PX).toFixed(1)}px`);

  const flipAt = html.indexOf('id="flip"');
  const lockAt = html.indexOf('id="lock"');
  const closeAt = html.indexOf('id="close"');
  check('翻面键在左、锁定与关闭在右', flipAt > 0 && flipAt < lockAt && lockAt < closeAt);
  check('右侧按钮成组', html.includes('top-bar__right') && readStyle('ui/styles/card.css').includes('.top-bar__right'));

  // The bar spans the card, so it must not swallow the drag region between the buttons, and the
  // buttons must not be invisible hit targets when the card is not hovered.
  check('顶栏空白处不拦截鼠标', css.declaration('.top-bar', 'pointer-events') === 'none');
  check('未悬停时按钮不拦截鼠标', css.declaration('.icon-btn', 'pointer-events') === 'none');
  const hoverRule = /\.card:hover \.icon-btn[^{]*\{([^}]*)\}/.exec(css.rules);
  check('悬停后按钮可点击', !!hoverRule && /pointer-events:\s*auto/.test(hoverRule[1]));
}

/* -------------------------------------------------------------- roll-up */

console.log('\n--- 收起 / 展开 ---');
{
  const rules = readStyle('ui/styles/card.css');
  check('mini 与卡片互斥（卡片隐藏）', css.declaration(".stage[data-mode='mini'] .card", 'display') === 'none');
  check('mini 在收起时显示', css.declaration(".stage[data-mode='mini'] .mini", 'display') === 'flex');

  const miniParts = ['mini-cover', 'mini-title', 'mini-artist', 'mini-fill'];
  for (const id of miniParts) {
    check(`mini 含 #${id}`, html.includes(`id="${id}"`));
  }
  check('mini 内容由 card.js 更新', /miniTitle|miniFill/.test(cardJs));

  // The mode must come from the window's real height, not from a message, or the drawing and
  // the window can disagree about which state is on screen.
  check('模式由窗口高度推导', /window\.innerHeight/.test(layoutJs) && /syncStageMode/.test(layoutJs));
  check('--mini-ratio 已定义', css.unit('--mini-ratio') > 0, String(css.unit('--mini-ratio')));

  // Lock is what stops the roll-up, so it has to be persisted and pushed to the shell.
  check('锁定状态持久化', /LOCK_KEY/.test(mainJs) && /localStorage/.test(mainJs));
  check('锁定状态推送给壳', /setLocked\?\.\(/.test(mainJs));
  check('壳体提供桥接接口', readStyle('apps/overlay/preload.cjs').includes('overlayShell'));
  // A stuck strip would be unrecoverable from the card itself, so there is a second way out.
  check('指针移到条上也能展开', /addEventListener\('mousemove'/.test(mainJs) && /view\.mode === 'mini'/.test(mainJs));
}

/* ---------------------------------------------------------------- structure */

console.log('\n--- DOM 嵌套 ---');
{
  /*
   * A misplaced closing tag is invisible from here: the page still loads, and the stylesheet
   * still parses, but the card ends up inside the wrong parent and nothing lines up. So the
   * markup is parsed into a tree and the chains that matter are asserted directly.
   */
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>');

  const root = { tag: '#root', attrs: '', children: [], parent: null, id: null };
  const stack = [root];
  const mismatches = [];
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (stack.length < 2 || stack[stack.length - 1].tag !== tag) {
        mismatches.push(`</${tag}> 与 <${stack[stack.length - 1]?.tag}> 不匹配`);
      }
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = {
      tag,
      attrs,
      id: /id="([^"]+)"/.exec(attrs)?.[1] ?? null,
      classes: (/class="([^"]+)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean),
      children: [],
      parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }

  check('标签全部闭合且配对', mismatches.length === 0 && stack.length === 1, mismatches.join('; ') || `${stack.length - 1} 个未闭合`);

  const byId = new Map();
  const walk = (node) => {
    if (node.id) byId.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  walk(root);

  /** Ancestor chain from the root down to a node, as `tag` or `tag.class`. */
  const chain = (id) => {
    const out = [];
    for (let node = byId.get(id); node && node.tag !== '#root'; node = node.parent) {
      out.unshift(node.classes.length ? `${node.tag}.${node.classes.join('.')}` : node.tag);
    }
    return out;
  };

  const hasAncestor = (id, tag, className) => chain(id).some((part) => part.startsWith(tag) && (!className || part.includes(`.${className}`)));

  for (const id of ['palette', 'palette-labels', 'flip', 'lock', 'close', 'title', 'progress-fill', 'lyrics']) {
    check(`#${id} 在卡片内`, hasAncestor(id, 'main', 'card'), chain(id).join(' > '));
  }
  check('#palette 在底部的 .foot 里', hasAncestor('palette', 'div', 'foot'));
  for (const id of ['flip', 'lock', 'close']) {
    check(`#${id} 在 .top-bar 里`, hasAncestor(id, 'div', 'top-bar'));
  }
  check('#lock 与 #close 同在 .top-bar__right', hasAncestor('lock', 'div', 'top-bar__right') && hasAncestor('close', 'div', 'top-bar__right'));

  // The mini bar is the *alternative* to the card, so it must be a sibling of it, not inside.
  const miniChain = chain('mini').join(' > ');
  check('#mini 与 #card 同级', miniChain.endsWith('div.stage > div.mini'), miniChain);
  check('#card 也在 .stage 里', chain('card').join(' > ').endsWith('div.stage > main.card'));
  check('#mini 不在卡片里', !hasAncestor('mini', 'main', 'card'));
  for (const id of ['mini-cover', 'mini-title', 'mini-artist', 'mini-fill', 'mini-expand']) {
    check(`#${id} 在 .mini 里`, hasAncestor(id, 'div', 'mini'));
  }
}

console.log(`\n${failures ? `❌ ${failures} 项问题` : '✅ 交互检查通过'}`);
process.exit(failures ? 1 : 0);

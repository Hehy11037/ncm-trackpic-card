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

import { makeCssReader, readStyle, shorthandSides, splitCommas, splitWhitespace, stripComments } from './css-values.mjs';

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
  /*
   * The scheme is deliberately inverted: nothing is draggable unless it opts in. Making the
   * whole window a title bar and carving the controls out did not hold on a transparent
   * Windows window - the colour band was swallowed even with a 26px carve-out, while an
   * identical button in the top bar worked.
   */
  check('body 不再声明 drag', !/-webkit-app-region:\s*drag/.test(css.tokens.split('.stage')[0]));
  check('拖拽手柄显式列出', /\.cover-wrap,[\s\S]{0,200}-webkit-app-region:\s*drag/.test(css.rules));

  const dragSelectors = new Set();
  for (const m of css.rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/-webkit-app-region:\s*drag/.test(m[2])) continue;
    for (const selector of m[1].split(',')) dragSelectors.add(selector.trim());
  }
  // A control inside a drag handle would be swallowed again, so the two lists must not overlap.
  const controls = ['.band', '.band-segment', '.ctrl', '.icon-btn', '.mini-action', '.foot'];
  for (const selector of controls) {
    check(`${selector} 不是拖拽手柄`, !dragSelectors.has(selector));
  }
  check('封面可用于拖动窗口', dragSelectors.has('.cover-wrap'));

  const noDragSelectors = new Set();
  for (const m of css.rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/-webkit-app-region:\s*no-drag/.test(m[2])) continue;
    for (const selector of m[1].split(',')) noDragSelectors.add(selector.trim());
  }

  const required = ['button', '.band', '.band-segment', '.foot', '.ctrl', '.icon-btn', '.mini-action'];
  for (const selector of required) {
    check(`${selector} 声明 no-drag`, noDragSelectors.has(selector));
  }
}

/* ------------------------------------------------------------ stale assets */

console.log('\n--- 静态资源不被缓存 ---');
{
  /*
   * The UI server sent `{ cache: 'no-store' }`, which writes a header named `cache` - not a
   * real HTTP header, so no cache directive went out at all. Chromium's HTTP cache lives in the
   * Electron profile and survives restarts, so a fixed stylesheet could keep being served from
   * cache and the fix would look like it had never been applied.
   */
  // Comments are stripped first: the fix is documented in prose right above it, and the prose
  // quotes the broken header verbatim.
  const server = stripComments(readStyle('packages/host/src/ui-server.ts'));
  check('界面服务发送 cache-control', /'cache-control':\s*'no-store/.test(server));
  // The lookahead matters: plain `cache:` also matches inside `cache-control:`.
  check('没有拼错的 cache 头', !/\bcache(?!-)\s*:\s*'no-store'/.test(server));
  check('index.html 与 config.json 都带该头', (server.match(/NO_CACHE/g) ?? []).length >= 3);
}

/* -------------------------------------------------------------- handlers */

console.log('\n--- 事件绑定 ---');
{
  // The band is delegated on the container and falls back to the pointer's x position, so a
  // press anywhere in the padded hit box selects a colour - including the padding, which is
  // where a press that "does nothing" would otherwise land.
  //
  // `pointerdown`, not `click`: a click needs press and release on the same element, and the
  // band is rebuilt from inside this very handler.
  check('色带用容器事件委托', /bindBand\(\)/.test(cardJs) && /addEventListener\('pointerdown'/.test(cardJs));
  check('色带不再依赖 click', !/band\.addEventListener\('click'/.test(cardJs));
  check('色带按位置兜底取色', /closest\('\.band-segment'\)/.test(cardJs) && /getBoundingClientRect/.test(cardJs));
  check('色块带索引以便委托取值', /dataset\.index/.test(cardJs));
  check('取色后打印结果到终端', /背景色 ->/.test(cardJs));
  check('启动时做命中自检', /reportHitTargets/.test(cardJs) && /view\.reportHitTargets\(\)/.test(mainJs));

  for (const id of ['flip', 'close', 'lock', 'mini-expand']) {
    check(`#${id} 绑定了 click`, new RegExp(`on\\('${id}'`).test(mainJs));
    check(`#${id} 存在于 index.html`, html.includes(`id="${id}"`));
  }
  check('播放控制绑定了 click', /\.ctrl\[data-action\]/.test(mainJs));
  check('键盘 L 切换锁定', /event\.key === 'l'/.test(mainJs));

  // Clicking a swatch must actually repaint: setBackground has to be reachable from the press.
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
  // Whole pixels, matching the shell's Math.round, so no face lands on a sub-pixel boundary.
  check('舞台高度取整', /Math\.round\(width \* STAGE_ASPECT\)/.test(layoutJs) && /Math\.round\(width \* MINI_RATIO\)/.test(layoutJs));

  /*
   * The roll-up must not depend on the renderer at all: gating it on an IPC message made
   * "the preload is broken" and "the card never rolls up" the same symptom, which is how this
   * shipped broken. It is gated on the webContents lifecycle instead.
   */
  const shellJs = readStyle('apps/overlay/main.mjs');
  const shellUtils = readStyle('apps/overlay/shell-utils.mjs');
  check('收起不依赖渲染层握手', /webContents\.once\('dom-ready'/.test(shellJs));
  check('渲染层不再发送 ready', !/overlay:ready/.test(shellJs) && !/ready: \(\)/.test(readStyle('apps/overlay/preload.cjs')));

  // Lock: owned and persisted by the shell, offered both on the card and in the tray, and
  // defaulting to ON so an overlay never rolls itself up by surprise on first run.
  check('锁定状态由壳持有', /let locked = true/.test(shellJs) && /overlay:toggle-lock/.test(shellJs));
  check('锁定状态写入存档', /locked,/.test(shellJs) && /locked: state\.locked === true/.test(shellUtils));
  check('锁定默认开启', /typeof raw\.locked === 'boolean' \? raw\.locked : true/.test(shellUtils));
  check('托盘也能锁定', /锁定（鼠标离开不收起）/.test(shellJs) && /type: 'checkbox'/.test(shellJs));
  check('渲染层订阅壳的锁定状态', /watchState/.test(mainJs) && /watchState/.test(readStyle('apps/overlay/preload.cjs')));
  check('渲染层不再自己存锁定', !/LOCK_KEY/.test(mainJs) && !/ncm-card:locked/.test(mainJs));
  check('锁定状态推送给渲染层', /send\('overlay:state'/.test(shellJs));
  // The three controls must hide together regardless of the lock, which is what the state
  // attribute used to override.
  check('三个按键在锁定时也照常隐藏', !/data-locked/.test(cardJs) && !/\[data-locked=/.test(css.rules));

  /*
   * Dropping the 3D transform once a flip finishes: a face left at rotateY(0deg) keeps its own
   * composited layer, which Chromium re-rasterises when the transition ends - the faint jitter
   * on the last frame of a flip.
   */
  check('翻面结束后清除 3D 变换', /data-settled/.test(cardJs) && /\[data-settled='true'\]/.test(css.rules));
  const flipDuration = /--flip-duration:\s*(\d+)ms/.exec(css.tokens)?.[1];
  const settleMs = /FLIP_SETTLE_MS = (\d+)/.exec(cardJs)?.[1];
  check(
    '结算延迟晚于翻转时长',
    Number(settleMs) > Number(flipDuration),
    `${settleMs}ms > ${flipDuration}ms`,
  );

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

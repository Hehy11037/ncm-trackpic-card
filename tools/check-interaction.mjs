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
import {
  extractIcons,
  iconStyle,
  parsePath,
  pathBounds,
  rasterizeAlpha,
  styledSubpaths,
  visibleAt,
} from './svg-path.mjs';
import { transportRowLayout } from './transport-layout.mjs';

const tokensText = readStyle('ui/styles/tokens.css');
const cardText = readStyle('ui/styles/card.css');
/*
 * Both stylesheets, concatenated in link order.
 *
 * A reader given only one of them answers "no such selector" for anything in the other - which is
 * how `.stage`, which lives in tokens.css, first looked like it had no `top` at all. The order
 * matters too: the cascade takes the last declaration, and index.html links card.css after
 * tokens.css, so appending card.css is what a browser would do.
 */
const css = makeCssReader({ tokens: tokensText, rules: `${tokensText}\n${cardText}` });
const html = readStyle('ui/index.html');
const mainJs = readStyle('ui/src/main.js');
const cardJs = readStyle('ui/src/card.js');
const dragJs = readStyle('ui/src/drag.js');
const scrubJs = readStyle('ui/src/scrub.js');
const layoutJs = readStyle('ui/src/layout.js');
const shellJs = readStyle('apps/overlay/main.mjs');
const shellUtils = readStyle('apps/overlay/shell-utils.mjs');
const preloadJs = readStyle('apps/overlay/preload.cjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

/** The card width the checks assume, matching DEFAULT_WIDTH in the shell. */
const CARD_WIDTH = 400;
const UNIT_PX = CARD_WIDTH / 100;

/* --------------------------------------------------------------- tool sanity */

console.log('--- 样式读取工具 ---');
{
  /*
   * Two traps that both produced confident but wrong answers, so they are pinned here.
   *
   * A selector can appear in several rules (`.card` gets a drag region near the top and its real
   * box later), and for one selector the specificity is equal - so the last declaration must
   * win. And a comma-separated selector group only ends with `{` after its *last* member, so a
   * first-match `\.credit\s*\{` scan returns that group and hides the real rule.
   */
  const shadow = css.declaration('.card', 'box-shadow') ?? '';
  check('能找到卡片的阴影', shadow.includes('var(--shadow-float)'), shadow.slice(0, 40));
  // `.lyric-line` has two rules: the main one sets `color` and `line-height`, the later one
  // overrides only `color`. The cascade says the later colour wins and the earlier line-height
  // survives, which is exactly the pair of behaviours a naive lookup gets wrong.
  check(
    '同一选择器的后一条规则生效',
    (css.declaration('.lyric-line', 'color') ?? '').includes('--lyric-color'),
    css.declaration('.lyric-line', 'color'),
  );
  check('未声明的属性不会丢', css.value('.lyric-line', 'line-height') === 1.45, String(css.value('.lyric-line', 'line-height')));
  check(
    '逗号选择器组不会遮蔽真实规则',
    css.value('.credit', 'margin-top') > 0,
    `.credit margin-top = ${css.value('.credit', 'margin-top')}u`,
  );
  for (const selector of ['.cover-wrap', '.title', '.artist', '.progress', '.credit']) {
    check(`${selector} 仍能读到布局属性`, css.declaration(selector, 'margin-top') !== null || css.declaration(selector, 'margin') !== null || css.declaration(selector, 'padding-top') !== null || css.declaration(selector, 'width') !== null);
  }
}

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

console.log('\n--- 窗口拖动 ---');
{
  /*
   * Dragging is a pointer gesture, not a `-webkit-app-region` region. Three rounds established
   * that the CSS mechanism and this card's controls cannot coexist: a window-wide region made
   * the colour band unclickable however its carve-out was sized, and every partial arrangement
   * either broke a control or left the window impossible to move.
   *
   * The invariant that matters, and the one no browser is needed to check, is that no element
   * declares a drag region at all - so there is nothing left that can swallow a press.
   */
  check('没有任何元素声明拖拽区', !/-webkit-app-region:\s*drag/.test(css.rules));
  check('tokens.css 也没有', !/-webkit-app-region:\s*drag/.test(css.tokens));

  check('拖动由指针手势实现', /installDragToMove/.test(dragJs) && /pointerdown/.test(dragJs));
  check('拖动已安装到界面', /installDragToMove\(\{ shell \}\)/.test(mainJs));
  check('按下控件不会拖动', /CONTROL_SELECTOR/.test(dragJs) && /closest\(CONTROL_SELECTOR\)/.test(dragJs));
  /*
   * The exclusion list, element by element.
   *
   * Pinning the whole selector string made this check fail the moment a new draggable control was
   * added - which is the opposite of useful: the list is *supposed* to grow. What matters is that
   * each interactive thing is on it, so a press there cannot also drag the window.
   */
  const controlSelector = /const CONTROL_SELECTOR = '([^']+)'/.exec(dragJs)?.[1] ?? '';
  for (const selector of ['button', '.band', '.band-segment', '.progress-track', '.volume-bar']) {
    check(`拖动排除 ${selector}`, controlSelector.includes(selector));
  }
  // Capture keeps a fast flick from releasing outside the window and leaving the drag running.
  check('使用指针捕获', /setPointerCapture/.test(dragJs));
  check('有兜底结束（取消 / 失焦）', /pointercancel/.test(dragJs) && /lostpointercapture/.test(dragJs));
  /*
   * A cancel or a lost capture used to strand the drag: the button was still held but the window
   * had stopped following it. Re-arming on the next move while the button is down recovers from
   * that, so a spurious cancel costs nothing.
   */
  check('取消后按住仍可续拖', /event\.buttons & 1/.test(dragJs));
  // A press sends `drag-start`, so the gesture must be closed even when nothing moved - otherwise
  // a drag stays open forever and the shell skips every auto-collapse tick while it is open.
  check(
    '未移动的按压也会结束手势',
    /bridge\(\)\?\.dragEnd\?\.\(\);/.test(dragJs) && !/if \(dragging\) bridge/.test(dragJs),
  );
  check('壳端有放弃僵死拖动的兜底', /DRAG_STALE_MS/.test(shellJs) && /endDrag\(/.test(shellJs));

  /*
   * The window's position is computed in the shell from absolute screen coordinates.
   *
   * The *coordinates*, though, come from the renderer's `pointermove` and not from polling the
   * cursor on a timer: a `setInterval` fires near a frame rather than on it, so the window is
   * sometimes moved twice within one frame and sometimes not at all, which the eye reads as stutter.
   */
  check('壳按坐标移动窗口', /overlay:drag-move/.test(shellJs) && /dragTarget\(/.test(shellJs));
  check('不再用定时器轮询光标', !/startDragFollow/.test(shellJs) && !/getCursorScreenPoint\(\)[\s\S]{0,200}dragGrab/.test(shellJs));
  check('渲染层每帧上报一次坐标', /requestAnimationFrame/.test(dragJs) && /dragMove\?\.\(pending\.x/.test(dragJs));
  check('上报的是绝对坐标不是位移', /dragMove: \(x, y\)/.test(preloadJs));
  check('按下即开始，没有死区', !/DRAG_THRESHOLD_PX/.test(dragJs) && /bridge\(\)\.dragStart\(event\.screenX, event\.screenY\)/.test(dragJs));
  check('拖动期间不自动收起', /if \(dragGrab\)/.test(shellJs));

  for (const verb of ['dragStart', 'dragMove', 'dragEnd']) {
    check(`桥接暴露 ${verb}`, new RegExp(`${verb}:`).test(preloadJs));
  }
  // The shell owns the arithmetic now, and it lives with the other window geometry.
  check('拖动算法在壳里', /export function dragTarget/.test(shellUtils));
  check('壳不再引用渲染层的 drag.js', !/ui\/src\/drag\.js/.test(shellJs));
}

console.log('\n--- 拖动时的窗口尺寸 ---');
{
  /*
   * Feeding `getBounds().width` into the next `setBounds` compounds a DIP rounding drift on a
   * display whose scale factor is not whole. The user saw the card slowly grow while it was being
   * dragged, then snap back. The size is captured at the press and never read back.
   */
  check('拖动开始时捕获尺寸', /dragSize = \{ width: bounds\.width, height: bounds\.height \}/.test(shellJs));
  const dragHandlers = shellJs.slice(shellJs.indexOf("ipcMain.on('overlay:drag-start'"), shellJs.indexOf('function endDrag'));
  check('移动时用捕获的尺寸', /\.\.\.dragSize/.test(dragHandlers));
  // The mismatch warning deliberately *reads* bounds to compare; what must never happen is the
  // read-back size being written straight back out, which is what the growth was.
  check('移动时不把读回的尺寸写回去', !/setBounds\(\{ \.\.\.bounds/.test(dragHandlers));
  check('结束时校验尺寸没变', /拖动期间窗口尺寸被改动/.test(shellJs));

  /*
   * A drag that starts in the middle of a resize tween.
   *
   * `animateGeometryTo` writes the target width immediately and interpolates the height towards it.
   * Capturing the size at that instant therefore records a pair that belongs to no window the user
   * ever saw - the log had `请求 432x740`, and 432 of width implies 744 of height, so the drag held a
   * card with the wrong proportions for as long as it lasted. Landing the tween first is the fix,
   * and the order is the whole point: the target must be applied *before* the size is read.
   */
  const startHandler = shellJs.slice(
    shellJs.indexOf("ipcMain.on('overlay:drag-start'"),
    shellJs.indexOf("ipcMain.on('overlay:drag-move'"),
  );
  check('拖动前先落定尺寸动画', startHandler.indexOf('resizeAnim.target') < startHandler.indexOf('dragSize = {'));
  check('落定时使用目标尺寸', /setBounds\(target, false\)/.test(startHandler));
  check('落定后停掉动画时钟', /stopResizeTween\(\)/.test(startHandler));
}

console.log('\n--- 播放控制的发送路径 ---');
{
  /*
   * How a transport command leaves the overlay, and how many times.
   *
   * The media key is the primary route: it is the client's own global hotkey, so it cannot break
   * when the client's internals are rebuilt. The bridge stays for the commands with no media-key
   * equivalent. The dangerous shape is a *fallback* - press the key, decide it did not work, then
   * also dispatch through the bridge - because the key may well have worked and the confirmation
   * simply arrived late, which skips two tracks per press. So `controlViaBridge` must be reachable
   * exactly once, from the `!key` branch, and a media key must be pressed exactly once.
   */
  const sessionTs = readStyle('packages/host/src/session.ts');

  const mapStart = sessionTs.indexOf('const MEDIA_KEY_FOR');
  const mapBody = sessionTs.slice(mapStart, sessionTs.indexOf('};', mapStart));
  for (const [type, key] of [
    ['playPause', 'playpause'],
    ['play', 'playpause'],
    ['pause', 'playpause'],
    ['next', 'next'],
    ['previous', 'prev'],
  ]) {
    check(`${type} → ${key}`, new RegExp(`${type}:\\s*'${key}'`).test(mapBody));
  }

  check(
    '没有媒体键才走桥接',
    /const key = MEDIA_KEY_FOR\[command\.type\];\s*\n\s*if \(!key\) return this\.controlViaBridge\(session, command\)/.test(
      sessionTs,
    ),
  );
  const bridgeCalls = [...sessionTs.matchAll(/this\.controlViaBridge\(/g)].length;
  check('桥接只从这一个分支进入（失败后不重试）', bridgeCalls === 1, `${bridgeCalls} 处调用`);
  const keyPresses = [...sessionTs.matchAll(/pressMediaKey\(/g)].length;
  check('每次指令只按一次媒体键', keyPresses === 1, `${keyPresses} 处`);

  const controlBody = sessionTs.slice(
    sessionTs.indexOf('async control(command'),
    sessionTs.indexOf('private async controlViaBridge'),
  );
  check('媒体键路径不再发桥接指令', !/sendControl\(/.test(controlBody));
  check('结果标注发送方式', /via: 'media-key'/.test(controlBody));
  check('客户端没变化时不算成功', /confirmed: false/.test(controlBody) && /ok: false/.test(controlBody));
  // A skip in repeat-one changes neither the state nor the song, so the playhead is a signal too.
  check('跳过以换歌或播放头回退确认', /currentSongId\(\) !== beforeSongId/.test(sessionTs) && /position < beforePositionMs - 1000/.test(sessionTs));
}

console.log('\n--- 传输控制条的排布 ---');
{
  /*
   * Play mode on the left, previous/play/next together in the middle, volume on the right.
   *
   * The order in the markup is what the finger sees, and the two side slots have to be the *same*
   * width or the play button is merely spaced between two edges instead of centred on the card -
   * which is what the reference has, and what the previous absolute-positioning trick achieved (at
   * the cost of repeating the transform in every hover/active rule).
   */
  const order = ['mode', 'previous', 'playPause', 'next', 'mute'].map((action) =>
    html.indexOf(`data-action="${action}"`),
  );
  check('五个控件都在', order.every((at) => at >= 0));
  check(
    '顺序是 模式 / 上一首 / 播放 / 下一首 / 音量',
    order.every((at, i) => i === 0 || (order[i - 1] >= 0 && at > order[i - 1])),
    order.join(','),
  );
  check('左右两侧同宽', css.declaration('.controls__side', 'width') !== null);
  check(
    '播放按钮不再绝对定位',
    css.declaration('.ctrl--primary', 'position') === null &&
      /flex:\s*none/.test(css.blocks('.ctrl--primary').join('\n')),
  );
  // The equal-width sides only centre the group if the group itself is not stretched.
  check('中间一组不拉伸', /\.controls__center\s*\{[^}]*display:\s*flex/.test(cardText));

  // Four mode glyphs, one per mode, selected by the card's own attribute.
  for (const mode of ['playOrder', 'playCycle', 'playOneCycle', 'playRandom']) {
    check(`模式图标 ${mode}`, new RegExp(`data-mode='${mode}'`).test(cardText));
  }
  const icons = [...html.matchAll(/class="mode-icon mode-icon--(\w+)"/g)].map((m) => m[1]);
  check('图标数量与模式数量一致', new Set(icons).size === 4, icons.join(','));

  /*
   * The mode list must be the client's own, in the client's own order.
   *
   * `ui/` cannot import the shared contract (it is served as plain modules with no build step), so
   * the list is declared twice on purpose - and checked here, the same way the card's aspect ratio
   * is declared in three languages and compared.
   */
  const uiModes = [...(/export const MODE_CYCLE = \[([^\]]+)\]/.exec(readStyle('ui/src/card.js'))?.[1] ?? '')
    .matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const sharedModes = [...(/export const PLAY_MODES = \[([^\]]+)\]/.exec(readStyle('packages/shared/src/types.ts'))?.[1] ?? '')
    .matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  check('界面与契约的模式列表一致', uiModes.join(',') === sharedModes.join(','), `${uiModes} vs ${sharedModes}`);
  check('模式循环里有四个', uiModes.length === 4);
  check('按钮有四种状态', new RegExp(`data-mode="playOrder"`).test(html));
}

console.log('\n--- 控制条几何（从样式表算出来） ---');
{
  /*
   * Where the five controls actually land.
   *
   * The row is flexbox: `space-between`, two equal-width side slots, and a centre group whose three
   * buttons are held together by a gap. That is enough to compute every position exactly, and it is
   * the only way this layout can be measured before the owner looks at it - there is no browser in
   * the tooling shell. `npm run icons` draws the same numbers as a picture.
   *
   * The claim being checked is the one the arrangement exists for: **the play button is on the
   * card's centre line**, which used to be arranged with absolute positioning (and a transform
   * repeated in every hover and active rule) and is now a consequence of the two sides being equal.
   */
  const layout = transportRowLayout(css);
  const at = (name) => layout.controls[name].centre;
  const pretty = Object.entries(layout.controls)
    .map(([name, box]) => `${name} ${box.centre.toFixed(2)}u`)
    .join(', ');

  check('播放键在卡片中线', Math.abs(at('playPause') - 50) < 0.05, `${at('playPause').toFixed(2)}u`);
  check(
    '上一首/下一首关于中线对称',
    Math.abs(50 - at('previous') - (at('next') - 50)) < 0.05,
    `${at('previous').toFixed(2)} / ${at('next').toFixed(2)}`,
  );
  check(
    '模式与音量对称贴边',
    Math.abs(at('mode') - (100 - at('volume'))) < 0.05,
    `${at('mode').toFixed(2)} / ${at('volume').toFixed(2)}`,
  );
  // Equality of the two side slots is what makes the middle centred; the padding being symmetric is
  // what makes the middle the card's middle.
  check('两侧槽位等宽', layout.sidesEqual, `${layout.side}u / ${layout.rightSide}u`);
  check(
    '左右内边距相等',
    Math.abs(layout.padding.left - layout.padding.right) < 0.01,
    `${layout.padding.left.toFixed(2)} / ${layout.padding.right.toFixed(2)}`,
  );
  check(
    '五个控件都在卡片内',
    Object.values(layout.controls).every((box) => box.centre - box.size / 2 >= -0.01 && box.centre + box.size / 2 <= 100.01),
    pretty,
  );
  check('三组之间留得下空隙', layout.between > 1, `${layout.between.toFixed(2)}u`);
  check('上一首/播放/下一首不贴在一起', layout.gap >= 1, `${layout.gap}u`);
  // The row has to fit: two slots, the centre group, and the two gaps.
  check('一行放得下', layout.between * 2 + layout.centre + layout.side * 2 <= layout.rowWidth + 0.01);
  check('音量条不伸出卡片', layout.popover.left > 0, `左边缘 ${layout.popover.left.toFixed(2)}u`);
  check(
    '音量条不压到播放键',
    layout.popover.left > at('playPause') + layout.play / 2,
    `播放键右缘 ${(at('playPause') + layout.play / 2).toFixed(2)}u`,
  );

  /*
   * The row's height is declared, not derived from its contents.
   *
   * The play button used to be `position: absolute`, so it contributed nothing to the row's height;
   * it is now an ordinary flex child and contributes all 15.74u of itself. If the height were left
   * to the contents, the row would grow and push the reference's colour band down - and the
   * reference comparison measures offsets *above* the row, so it would not notice.
   */
  const declaredHeight = css.value('.controls', 'height');
  check('控制条高度是声明出来的', css.declaration('.controls', 'height') !== null, `${declaredHeight}u`);
  check('最高的控件放得进这一行', layout.play <= declaredHeight + 0.01, `${layout.play}u ≤ ${declaredHeight}u`);

  /*
   * The four mode names and labels, against the measurement they came from.
   *
   * `docs/contracts.md` records what the client's own button said as it cycled, so it is the
   * authority; the card declares its own copy because `ui/` imports nothing from the host's modules.
   * Two declarations and a check that compares them - the same arrangement as the card's aspect
   * ratio, which is written in three languages.
   */
  const contracts = readStyle('docs/contracts.md');
  const sharedModes = [
    ...(/export const PLAY_MODES = \[([^\]]+)\]/.exec(readStyle('packages/shared/src/types.ts'))?.[1] ?? '').matchAll(
      /'([a-zA-Z]+)'/g,
    ),
  ].map((match) => match[1]);
  // Scoped to the four mode names: the same file is full of field tables, and a loose pattern
  // matched `playingState` and friends as if they were modes.
  const contractModes = sharedModes.map((mode) => {
    const row = new RegExp('\\|\\s*`?' + mode + '`?\\s*\\|\\s*([^|]+?)\\s*\\|').exec(contracts);
    return [mode, row?.[1]?.trim() ?? null];
  });
  check(
    '契约里记下了四种模式',
    contractModes.length === 4 && contractModes.every(([, label]) => label),
    contractModes.map(([mode, label]) => `${mode}=${label ?? '?'}`).join(' '),
  );
  const uiLabels = Object.fromEntries(
    [...readStyle('ui/src/card.js').matchAll(/(play[A-Za-z]+):\s*'([^']+)'/g)].map((match) => [match[1], match[2]]),
  );
  for (const [mode, label] of contractModes) {
    check(`界面标签与实测一致 ${mode}`, uiLabels[mode] === label, `界面 ${uiLabels[mode] ?? '(缺)'} / 契约 ${label}`);
  }
}


{
  /*
   * Both bars are the same gesture, so both must be installed through the same helper - and the
   * helper is where the two bugs that always show up here are handled: pointer capture (a drag that
   * leaves the element must keep reporting) and `pointercancel` (which is *not* a release; treating
   * it as one seeks wherever the pointer happened to be when Chromium gave up).
   */
  check('两条都装了拖动', (mainJs.match(/installScrub\(/g) ?? []).length === 2);
  check('拖动条是横向的', /axis: 'x'/.test(mainJs));
  check('使用指针捕获', /setPointerCapture/.test(scrubJs));
  /*
   * Only a release commits. A `pointercancel` or a lost capture - which Chromium fires when the
   * window moves under the pointer - must end the gesture *without* sending a command, or the seek
   * would go to wherever the pointer happened to be when the browser gave up.
   */
  check('取消走不提交的出口', /const onPointerCancel = \(\) => finish\(false\)/.test(scrubJs));
  check(
    '取消与丢失捕获都接上这个出口',
    /addEventListener\('pointercancel', onPointerCancel\)/.test(scrubJs) &&
      /addEventListener\('lostpointercapture', onPointerCancel\)/.test(scrubJs),
  );
  check('只有松手才提交', (scrubJs.match(/finish\(true\)/g) ?? []).length === 1);
  check('按下时不选中文字', /preventDefault\(\)/.test(scrubJs));
  // Ratio is measured from the strip, never from the event target: the fill is a child of the bar,
  // so a press on the fill arrives with the fill as target.
  check('比例取自拖动条自身', /element\.getBoundingClientRect\(\)/.test(scrubJs));
  check('键盘也能调', /ArrowRight|ArrowLeft/.test(scrubJs));
  // The arrows are also the card's skip keys, so the bar must swallow the press it handles.
  check('键盘处理后不再冒泡', /stopPropagation\(\)/.test(scrubJs));

  /*
   * The two hit areas, which are the reason the band was ever unclickable: a 1.48u bar is about
   * 6px tall on a 440px card, and a 6px target is not a target. Both use a `::before` overlay, so
   * the geometry below them does not move (a padded box with a cancelling margin works too, but it
   * shifts every measurement after it - the band's approach, and the band is the only thing after
   * which nothing is measured).
   */
  check('进度条有加高的命中区', /\.progress-track::before\s*\{[^}]*top:\s*calc\(var\(--u\) \* -/.test(cardText));
  check('音量条有加高的命中区', /\.volume-bar::before\s*\{[^}]*top:\s*calc\(var\(--u\) \* -/.test(cardText));
  check('进度条可显示滑块', /\.progress:hover \.progress-thumb/.test(cardText));
  check('拖动时滑块常显', /data-scrubbing='true'\] \.progress-thumb/.test(cardText));
  check('进度条有滑块元素', /id="progress-thumb"/.test(html));
  check('拖动时时间变亮', /data-scrubbing='true'\] \.progress-times/.test(cardText));

  // While the pointer is down the preview *is* the position; the clock may not overwrite it.
  check('拖动时时钟不夺回进度条', /scrubFraction != null/.test(readStyle('ui/src/card.js')));
  check('快照到来前不放掉预览', /Math\.abs\(playheadMs - scrub\.ms\) < 1500/.test(mainJs));
  check('预览有超时兜底', /PLAY_PAUSE_OPTIMISM_MS \* 2/.test(mainJs));
  // A paused client may publish nothing, so the seek reply's own position places the bar.
  check('跳转回执用来定位', /typeof result\.positionMs === 'number'\) snapTo\(result\.positionMs\)/.test(mainJs));
  // A single command per gesture: one per preview frame would be dozens of seeks per drag.
  const seekHandler = mainJs.slice(mainJs.indexOf('function installSeekBar'), mainJs.indexOf('function installVolumeBar'));
  check('拖动过程中不发指令', !/control\(/.test(seekHandler.slice(0, seekHandler.indexOf('onCommit'))));
  check('松手才发跳转指令', /onCommit[\s\S]{0,400}control\(\{ type: 'seek', positionMs/.test(seekHandler));
  // No duration yet (nothing playing) means there is nowhere to seek to.
  check('没有时长就不跳转', /if \(!\(duration > 0\)\)/.test(seekHandler));

  check('音量条拖动即预览', /onPreview[\s\S]{0,200}setVolumePreview\(fraction\)/.test(mainJs));
  // The drag guard in `setVolume` must not swallow the preview itself, or the bar would not follow
  // the pointer: the preview is what the drag is producing, not a snapshot arriving mid-drag.
  check('预览越过拖动保护', /setVolumePreview\(volume\)\s*\{/.test(readStyle('ui/src/card.js')));
  check('松手才发音量指令', /onCommit[\s\S]{0,300}control\(\{ type: 'setVolume', volume \}\)/.test(mainJs));
  // Held until the client's own value arrives, or the bar jumps back under the pointer.
  check('音量预览也会被保持', /volumePreview != null[\s\S]{0,400}setVolumePreview\(volumePreview\)/.test(mainJs));
  check('点击喇叭键静音', /action === 'mute'\) link\.control\(\{ type: 'toggleMute' \}\)/.test(mainJs));
  // The panel overlaps the card's controls while hidden, so it must not take clicks then.
  check('音量条默认不吃点击', /\.volume-pop\s*\{[^}]*pointer-events:\s*none/.test(cardText));
  check('悬停才显示音量条', /\.controls__volume:hover \.volume-pop/.test(cardText));
  check('拖动时音量条不收起', /data-open='true'/.test(cardText) && /setAttribute\('data-open', 'true'\)/.test(mainJs));
  check('音量条向上弹出', /\.volume-pop\s*\{[^}]*bottom:\s*calc\(100%/.test(cardText));

  /*
   * A drag may not move the layout.
   *
   * The scrubbing state used to thicken the progress track with `height: 2.1u`, and the track is an
   * ordinary block in the column - so pressing the bar pushed the times, the transport row, the
   * colour band and the credit down by 0.62u, and released them again on pointer-up. The control
   * moved out from under the pointer that was using it.
   *
   * Asserted generically rather than by naming `height`: any in-flow property set by a drag state is
   * the same bug, and `box-shadow` / `opacity` / `transform` are the ones that are not.
   */
  const IN_FLOW = [
    'height', 'min-height', 'max-height', 'width', 'min-width', 'max-width',
    'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding', 'padding-top', 'padding-bottom',
    'border-width', 'border-top-width', 'border-bottom-width',
    'font-size', 'line-height', 'top', 'bottom',
  ];
  for (const selector of [".progress[data-scrubbing='true'] .progress-track", ".volume-bar[data-scrubbing='true']"]) {
    const moved = IN_FLOW.filter((property) => css.declaration(selector, property) !== null);
    check(`拖动状态不改变布局 ${selector}`, moved.length === 0, moved.join(', '));
  }
  // ... and it still has to *show* something, or "no layout change" would be satisfied by nothing.
  check(
    '拖动时进度条仍被强调',
    css.declaration(".progress[data-scrubbing='true'] .progress-track", 'box-shadow') !== null,
  );  /*
   * Right-aligned, not centred on the button. The volume button is the rightmost element on the
   * card, so a ~20u panel centred on it hangs off the card and over the transparent margin the
   * floating shadow renders in - where it is either clipped or drawn over the shadow.
   */
  const sessionSource = readStyle('packages/host/src/session.ts');
  check(
    '静音就是音量为零',
    /muted: volume == null \? null : volume <= 0\.001/.test(sessionSource) &&
      !/muted: raw\.muteVolume/.test(sessionSource),
  );
  check('音量条贴右边不出界', /\.volume-pop\s*\{[^}]*right:\s*0/.test(cardText) && css.declaration('.volume-pop', 'left') === null);
}

console.log('\n--- 图标 ---');
{
  /*
   * The icons are the one part of the card nothing else looks at.
   *
   * They are not laid out, so the layout check ignores them; they are not elements with ids, so the
   * DOM check ignores them; and there is no browser in the tooling shell to look at them with. So
   * they were written blind, and two of them were wrong: the sound waves rendered as nothing (they
   * are strokes) and the mute cross rendered as four diamonds (two filled bars crossing cancel under
   * the nonzero winding rule). `tools/render-icons.mjs` is how they were finally seen; this is the
   * part of that which can run in `npm run check`.
   */
  const icons = extractIcons(html);
  check('找得到图标', icons.length >= 8, `${icons.length} 个`);

  let paths = 0;
  for (const icon of icons) {
    const label = `${icon.owner || '(无宿主)'}${icon.cls ? `.${icon.cls}` : ''}`;
    for (const path of icon.paths) {
      paths++;
      const name = `${label} ${path.cls || '(无类名)'}`;
      let subpaths;
      try {
        subpaths = parsePath(path.d);
      } catch (err) {
        check(`${name} 路径可解析`, false, String(err.message));
        continue;
      }
      const bounds = pathBounds(subpaths);
      check(
        `${name} 在 viewBox 内`,
        !!bounds && bounds.minX >= -0.01 && bounds.minY >= -0.01 && bounds.maxX <= 24.01 && bounds.maxY <= 24.01,
        bounds ? `${bounds.minX.toFixed(1)},${bounds.minY.toFixed(1)} → ${bounds.maxX.toFixed(1)},${bounds.maxY.toFixed(1)}` : '没有点',
      );
      // Painted the way the card paints it - filled *or* stroked. A stroke-only path drawn as a
      // fill is invisible, which is exactly what the sound waves were.
      const style = iconStyle(css, icon.owner, path.cls);
      const alpha = rasterizeAlpha(styledSubpaths(subpaths, style), 48);
      const coverage = [...alpha].reduce((sum, value) => sum + value, 0) / (48 * 48);
      check(`${name} 画得出东西`, coverage > 0.002, `覆盖 ${(coverage * 100).toFixed(2)}%`);
    }
  }
  check('图标一共这么多条路径', paths >= 10, `${paths} 条`);

  // The four mode glyphs must differ, or two modes look identical on the card.
  const modeIcons = icons.filter((icon) => icon.cls.includes('mode-icon'));
  check('四个模式图标各不相同', new Set(modeIcons.map((i) => i.paths.map((p) => p.d).join('|'))).size === modeIcons.length);

  /*
   * Fill versus stroke, per glyph, from the stylesheet.
   *
   * The volume icon's svg is `fill: none; stroke: currentColor`, so anything inside it that is not
   * explicitly filled is a *line*. The speaker body must be filled (it is a solid shape), and the
   * waves and the cross must be strokes - a cross drawn as two filled bars cancels at the
   * intersection and renders as four separate diamonds.
   */
  const volume = icons.find((icon) => /ctrl--volume/.test(icon.owner));
  check('找得到音量图标', !!volume);
  if (volume) {
    const styleOf = (cls) => iconStyle(css, volume.owner, cls);
    check('喇叭主体是填充的', styleOf('speaker').fill === true);
    check('声波是描边而不是填充', styleOf('wave wave--1').fill === false && styleOf('wave wave--1').strokeWidth > 0);
    check('静音叉是描边（两条线）', styleOf('cross').fill === false && styleOf('cross').strokeWidth > 0);
    // Two crossing *filled* bars is the shape that cancels; the cross must not be one path quad pair.
    const cross = volume.paths.find((path) => path.cls === 'cross');
    check('静音叉不是交叉的闭合四边形', !!cross && !/z/i.test(cross.d), cross?.d ?? '');
    check('三个状态各自可见', ['high', 'low', 'mute'].every((state) => !!visibleAt(css, 'speaker', state)));
    check(
      '静音时藏起声波',
      visibleAt(css, 'wave wave--1', 'mute') === false && visibleAt(css, 'wave wave--1', 'high') === true,
    );
    check('静音时显示叉', visibleAt(css, 'cross', 'mute') === true && visibleAt(css, 'cross', 'high') === false);
    check('低音量只留一道声波', visibleAt(css, 'wave wave--2', 'low') === false);
  }
}
console.log('\n--- 播放/暂停的即时反馈 ---');
{
  /*
   * The button used to flicker and feel slow.
   *
   * The command was immediate; the *drawing* was not. A media key takes the client a moment to act
   * on, and the client keeps publishing snapshots until it does - so drawing every snapshot
   * verbatim flipped the button, flipped it back, and flipped it again. The optimistic value is now
   * held until the client agrees, the host reports a failure, or it times out.
   */
  check('乐观状态会被保持', /function displayedStatus\(/.test(mainJs));
  check('保持有超时', /PLAY_PAUSE_OPTIMISM_MS = \d+/.test(mainJs));
  check('客户端确认后交还', /clientStatus === pending\.expect[\s\S]{0,80}pendingPlayPause = null/.test(mainJs));
  check('快照画的是处理过的状态', /view\.setSnapshot\(effective\)/.test(mainJs));
  check('按钮立刻反映翻转', /view\.setStatus\(pendingPlayPause\.expect\)/.test(mainJs));
  check('失败时回退', /view\.setStatus\(lastSnapshot\?\.playback\?\.status/.test(mainJs));
  // `setStatus` must be its own operation, or the revert would have to rebuild a whole snapshot.
  check('状态可以单独绘制', /setStatus\(status\)\s*\{/.test(readStyle('ui/src/card.js')));
}

console.log('\n--- 托盘菜单 ---');
{
  /*
   * The owner of the app asked for the tray menu to be cut back to size and quit. It had become a
   * control panel, and every item removed has to still be reachable somewhere - which is what the
   * rest of this block asserts, because "the tray no longer offers it" is only acceptable while
   * "the card does" stays true.
   */
  const start = shellJs.indexOf('function trayTemplate()');
  const end = shellJs.indexOf('function createTray()');
  const menu = shellJs.slice(start, end);
  check(
    '托盘菜单只有尺寸与退出',
    menu.includes('CARD_WIDTH_PRESETS') &&
      menu.includes('preset.label') &&
      menu.includes("label: '退出'"),
  );
  // Everything else that used to be in there.
  for (const gone of ['显示 / 隐藏', '展开卡片', '居中显示', '立即收起', "type: 'checkbox'"]) {
    check(`托盘不再有「${gone}」`, !menu.includes(gone));
  }
  // ... and the recovery the tray used to provide is now the icon's own click.
  check('单击托盘图标可显示/隐藏', /tray\.on\('click', \(\) => toggleWindow\(\)\)/.test(shellJs));
  check(
    '从托盘显示必定展开',
    /function showWindow\(\)[\s\S]{0,600}setCollapsed\(false\)/.test(shellJs),
  );
  check('菜单只构建一次', !/refreshTrayMenu/.test(shellJs));
}

console.log('\n--- 舞台锚点与模式阈值 ---');
{
  /*
   * The stage is anchored to the window's TOP, not centred.
   *
   * The window's height is tweened during the roll-up and the top edge is what stays put, so the
   * card is eaten from below by the window's bottom edge - which is the whole look. A centred stage
   * would shrink the card towards its middle from both ends instead; a transform on an ancestor of
   * the card is also a compositing hazard the flip work has already been bitten by once.
   */
  check('舞台贴窗口顶部', css.declaration('.stage', 'top') === 'var(--shadow-pad)');
  check('舞台水平居中不用 transform', css.declaration('.stage', 'margin') === '0 auto');
  check('舞台没有 transform', css.declaration('.stage', 'transform') === null);

  /*
   * The mode threshold must sit at the *collapsed* height, not between the two: the window passes
   * through every height in between while it animates, and the card has to stay the card until the
   * window is essentially the strip, or the roll-up pops instead of rolling.
   */
  const layoutJsText = readStyle('ui/src/layout.js');
  check('模式阈值基于收起高度', /stageModeFor\(window\.innerHeight, collapsedWindowHeight\)/.test(layoutJsText));
  check('阈值用收起高度计算', /collapsedWindowHeight = Math\.round\(width \* MINI_RATIO\)/.test(layoutJsText));
  check('阈值有单元测试', /stageModeFor/.test(readStyle('ui/test/layout.test.mjs')));
}

console.log('\n--- 收起/展开动画 ---');
{
  /*
   * The roll-up used to be a single jump, and it read as slow however short the delay got -
   * because nothing moved, so there was nothing to judge the speed by except the pause.
   */
  check('收起/展开走补间', /function animateGeometryTo/.test(shellJs));
  const resizeMs = Number(/const RESIZE_MS = (\d+)/.exec(shellJs)?.[1] ?? NaN);
  check('补间时长很短（<= 250ms）', Number.isFinite(resizeMs) && resizeMs <= 250, `${resizeMs}ms`);
  check('用缓出曲线', /easeOutCubic/.test(shellJs) && /export function easeOutCubic/.test(shellUtils));
  // The tween must step from values captured once - see the drag-size check above for why.
  check('补间起点只读一次', /const from = \{ x: current\.x/.test(shellJs));
  check('退出时清掉补间定时器', /will-quit[\s\S]{0,240}stopResizeTween\(\)/.test(shellJs));
  // A drag owns the bounds; a tween underneath it would fight for the same window.
  check('拖动时不启动补间', /if \(dragGrab\) \{[\s\S]{0,80}applyGeometry\(\)/.test(shellJs));
  // The reaction time the user feels is the delay plus one poll, so both are asserted to stay low.
  const collapseMs = Number(/const COLLAPSE_DELAY_MS = (\d+)/.exec(shellJs)?.[1] ?? NaN);
  const pollMs = Number(/const HOVER_POLL_MS = (\d+)/.exec(shellJs)?.[1] ?? NaN);
  check(
    '收起反应时间（延迟 + 一次轮询）<= 200ms',
    collapseMs + pollMs <= 200,
    `${collapseMs} + ${pollMs} = ${collapseMs + pollMs}ms`,
  );
  check('展开比收起更快', Number(/const EXPAND_DELAY_MS = (\d+)/.exec(shellJs)?.[1] ?? NaN) <= collapseMs);

  /*
   * The tween is stepped by the renderer's animation frames, not by a timer in the shell.
   *
   * A `setInterval` fires near a frame rather than on it, so the window is sometimes resized twice
   * inside one frame and sometimes not at all - which is read as 一顿一顿的 however smooth the
   * curve is. This is the same lesson the drag learned; the renderer is the only side with a frame
   * clock.
   */
  check('补间由渲染层的帧驱动', /overlay:animate-resize/.test(shellJs) && /overlay:resize-tick/.test(shellJs));
  check('没有用 setInterval 步进补间', !/resizeTimer = setInterval/.test(shellJs));
  check('有兜底定时器收尾', /finishResizeTween/.test(shellJs));
  check('过期 tick 会被忽略', /token !== resizeToken/.test(shellJs));
  check('渲染层实现了帧时钟', /installResizeClock/.test(mainJs) && /requestAnimationFrame/.test(readStyle('ui/src/resize-clock.js')));
}

console.log('\n--- 收起不会卡住 ---');
{
  /*
   * "偶尔鼠标移开却一直没有收缩" has three possible stalls, each of which used to last a long
   * time or forever. All three are now short or self-reporting.
   */
  const dragStale = Number(/const DRAG_STALE_MS = ([\d_]+)/.exec(shellJs)?.[1].replace(/_/g, '') ?? NaN);
  // While a drag is open the watcher skips every tick, so a leaked drag means "never collapses".
  // A short guard is safe because the renderer re-arms on the next move with the button held.
  check('僵死拖动的兜底很短（<= 5s）', dragStale <= 5000, `${dragStale}ms`);
  check('拖动后的抑制也很短', Number(/const DRAG_SETTLE_MS = (\d+)/.exec(shellJs)?.[1] ?? NaN) <= 500);
  check('渲染层会在按住时续拖', /event\.buttons & 1/.test(dragJs));
  // Resetting the machine on a bad tick restarts the "pointer has been away" timer, so an error
  // every other tick could stop the collapse ever reaching its delay.
  const catchBlock = shellJs.slice(shellJs.indexOf('指针监听出错'), shellJs.indexOf('}, HOVER_POLL_MS)'));
  check('采样出错不会重置状态机', !/hoverState\.reset\(\)/.test(catchBlock));
  check('卡住时会自己报告', /仍未收起/.test(shellJs));
}

console.log('\n--- 歌词颜色 ---');
{
  /*
   * One colour for every entry. There used to be four, handed out by depth, which made the page
   * read as a hue gradient rather than as lyrics; the owner of the design asked for that to go and
   * depth is already carried by size, blur and opacity.
   */
  const lyricsJs = readStyle('ui/src/lyrics.js');
  check('只设置一个歌词颜色', /--lyric-color/.test(lyricsJs) && !/--lyric-\$\{i\}/.test(lyricsJs));
  check('不再有按深度分色的规则', !/data-depth=/.test(css.rules) && !/--lyric-[0-9]/.test(css.rules));
  check('所有歌词行用同一个颜色', /\.lyric-line \{\s*color: var\(--lyric-color/.test(css.rules));
  // The colour is still chosen for contrast: a mid-tone background can leave no swatch readable,
  // and the white/near-black fallback has to survive.
  check('仍然按对比度选色', /contrastRatio/.test(lyricsJs) && />= 3/.test(lyricsJs));
}

console.log('\n--- 调色板提取 ---');
{
  /*
   * The fabrication this guards against: `chosen.map(boostSaturation)` passes the array *index* as
   * the optional `factor`, so swatch 0 was multiplied by 0 - collapsing every channel onto the
   * colour's midpoint and producing a pure grey - swatch 1 was left alone, and 2..4 were blown out
   * to saturated primaries. ui/test/palette.test.mjs asserts on the results; this asserts that the
   * call cannot be written that way again.
   */
  // Comments are stripped: the fix is documented by quoting the broken call verbatim.
  const paletteJs = stripComments(readStyle('ui/src/palette.js'));
  check('boostSaturation 不直接传给 map', !/\.map\(boostSaturation\)/.test(paletteJs));
  check('boostSaturation 的 factor 是显式的', /map\(\(color\) => boostSaturation\(color\)\)/.test(paletteJs));
  check('调色板有单元测试', /assertPaletteMatches/.test(readStyle('ui/test/palette.test.mjs')));
  // Choosing a colour and judging contrast are different jobs with different measures.
  check('过滤用 luma255 而不是 WCAG', /const luma = luma255\(/.test(paletteJs));
  check('极端色阈值与过滤阈值同源', /luma <= DARK_LUMA/.test(paletteJs) && /luma >= LIGHT_LUMA/.test(paletteJs));
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
  check('收起不依赖渲染层握手', /webContents\.once\('dom-ready'/.test(shellJs));
  check('渲染层不再发送 ready', !/overlay:ready/.test(shellJs) && !/ready: \(\)/.test(preloadJs));

  // Lock: owned and persisted by the shell, controlled from the card and `L`, and defaulting to ON
  // so an overlay never rolls itself up by surprise on first run.
  check('锁定状态由壳持有', /let locked = true/.test(shellJs) && /overlay:toggle-lock/.test(shellJs));
  check('锁定状态写入存档', /locked,/.test(shellJs) && /locked: state\.locked === true/.test(shellUtils));
  check('锁定默认开启', /typeof raw\.locked === 'boolean' \? raw\.locked : true/.test(shellUtils));
  check('卡片上有锁定键', html.includes('id="lock"') && /on\('lock'/.test(mainJs) && /event\.key === 'l'/.test(mainJs));
  check('渲染层订阅壳的锁定状态', /watchState/.test(mainJs) && /watchState/.test(preloadJs));
  check('渲染层不再自己存锁定', !/LOCK_KEY/.test(mainJs) && !/ncm-card:locked/.test(mainJs));
  check('锁定状态推送给渲染层', /send\('overlay:state'/.test(shellJs));
  // The three controls must hide together regardless of the lock, which is what the state
  // attribute used to override.
  check('三个按键在锁定时也照常隐藏', !/data-locked/.test(cardJs) && !/\[data-locked=/.test(css.rules));

  /*
   * The flip, and the faint shift of the cover reported after one.
   *
   * A flip promotes each face to a compositor layer and Chromium drops it again when the
   * transition ends; a layer's raster can differ from the main frame's by a sub-pixel, which is
   * exactly what a slight shift of detailed artwork looks like. `will-change` keeps both faces
   * promoted for the card's whole life, so there is no promotion or demotion to notice.
   *
   * A previous attempt instead *removed* the transform after the flip finished. It did not help -
   * and a style change 470ms after the animation is itself something to see - so it is gone.
   */
  // `declaration()` returns the value, not the whole declaration.
  check('两面常驻独立合成层', /^transform,\s*opacity$/.test(css.declaration('.face', 'will-change') ?? ''));
  check('不再延迟改动翻面样式', !/data-settled/.test(cardJs) && !/data-settled/.test(css.rules));

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

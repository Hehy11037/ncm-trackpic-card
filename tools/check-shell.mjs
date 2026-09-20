// Verify the Electron shell's pure helpers without launching Electron.
//
//   node tools/check-shell.mjs
//
// Three things are easy to get silently wrong and invisible in a screenshot:
//   - the PNG encoder for the tray icon (a bad CRC or header yields an empty tray icon)
//   - the window geometry maths (wrong aspect leaves transparent bars around the card; a
//     shadow margin that does not match the stylesheet clips the shadow flat)
//   - when the window rolls up (a hover that collapses too eagerly is unusable, and one that
//     oscillates is worse)
//
// So this writes the generated icon to disk for visual inspection, checks the geometry
// against the card's real numbers taken from the stylesheet and the renderer rather than
// duplicated here, and exercises the hover state machine through its awkward cases.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { decodePng } from './lib/png.mjs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
  CARD_ASPECT,
  CARD_WIDTH_DEFAULT,
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  CARD_WIDTH_PRESETS,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MINI_RATIO,
  MIN_WIDTH,
  KEEP_VISIBLE,
  SHADOW_PAD,
  cardWidthForWindow,
  clampToWorkArea,
  createHoverState,
  dragTarget,
  easeOutCubic,
  fitWindow,
  loadWindowState,
  makeIconPng,
  saveWindowState,
  stateFilePath,
} from '../apps/overlay/shell-utils.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const readStyle = (relativePath) => readFileSync(relativePath, 'utf8');

const number = (source, pattern) => {
  const m = pattern.exec(source);
  return m ? Number(m[1]) : null;
};

/* ------------------------------------------------------- cross-file constants */

console.log('--- 三处常量是否一致 ---');
{
  /*
   * These numbers are declared in three languages - CSS, the renderer, and the shell - because
   * each needs them at a different time. Nothing but this check keeps them in step, and an
   * unmirrored edit does not fail loudly: the window simply stops matching the card.
   */
  const tokens = readFileSync('ui/styles/tokens.css', 'utf8');
  const layout = readFileSync('ui/src/layout.js', 'utf8');

  const cssAspect = number(tokens, /--card-aspect:\s*([\d.]+)/);
  const cssMini = number(tokens, /--mini-ratio:\s*([\d.]+)/);
  const cssPad = number(tokens, /--shadow-pad:\s*([\d.]+)px/);
  const cssMinCard = number(tokens, /max\((\d+)px,\s*calc\(100vw/);

  const jsAspect = number(layout, /STAGE_ASPECT\s*=\s*([\d.]+)/);
  const jsMini = number(layout, /MINI_RATIO\s*=\s*([\d.]+)/);
  const jsMinCard = number(layout, /MIN_STAGE_WIDTH\s*=\s*(\d+)/);

  console.log(
    `    卡片比例   css ${cssAspect}   renderer ${jsAspect}   shell ${CARD_ASPECT}`,
  );
  check('卡片比例三处一致', cssAspect === CARD_ASPECT && jsAspect === CARD_ASPECT);

  console.log(`    收起高度比 css ${cssMini}   renderer ${jsMini}   shell ${MINI_RATIO}`);
  check('收起高度比三处一致', cssMini === MINI_RATIO && jsMini === MINI_RATIO);

  console.log(`    阴影留白   css ${cssPad}   shell ${SHADOW_PAD}`);
  check('阴影留白两处一致', cssPad === SHADOW_PAD);

  console.log(`    最小卡宽   css ${cssMinCard}   renderer ${jsMinCard}   shell ${CARD_WIDTH_MIN}`);
  check('最小卡宽三处一致', cssMinCard === CARD_WIDTH_MIN && jsMinCard === CARD_WIDTH_MIN);

  check('窗口最小宽度 = 卡片 + 两侧留白', MIN_WIDTH === CARD_WIDTH_MIN + SHADOW_PAD * 2, String(MIN_WIDTH));
  check('窗口最大宽度 = 卡片 + 两侧留白', MAX_WIDTH === CARD_WIDTH_MAX + SHADOW_PAD * 2, String(MAX_WIDTH));
  check('默认宽度与默认卡片宽一致', DEFAULT_WIDTH === CARD_WIDTH_DEFAULT + SHADOW_PAD * 2);
  check('托盘预设都在允许范围内', CARD_WIDTH_PRESETS.every((p) => p.width >= CARD_WIDTH_MIN && p.width <= CARD_WIDTH_MAX));
}

/* --------------------------------------------------------------- geometry */

console.log('\n--- 窗口几何 ---');
{
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  for (const card of [CARD_WIDTH_MIN, CARD_WIDTH_DEFAULT, 440, CARD_WIDTH_MAX]) {
    const fit = fitWindow(card, workArea);
    const ratio = fit.height / fit.width;
    const cardRatio = (fit.height - SHADOW_PAD * 2) / (fit.width - SHADOW_PAD * 2);
    check(
      `卡片宽 ${card} -> 窗口 ${fit.width}x${fit.height}`,
      Math.abs(cardRatio - CARD_ASPECT) < 0.005,
      `卡片比例 1 : ${cardRatio.toFixed(3)}`,
    );
    check(
      `  收起高度 ${fit.collapsedHeight} 小于展开高度`,
      fit.collapsedHeight < fit.height,
      `${fit.collapsedHeight} < ${fit.height}`,
    );
    check(`  窗口比卡片宽 2 x ${SHADOW_PAD}`, fit.width - fit.cardWidth === SHADOW_PAD * 2);
    void ratio;
  }

  // A screen that cannot hold the requested card must shrink the *card*, not clip the height:
  // clamping the height alone silently breaks the aspect ratio and cuts the bottom off.
  const short = fitWindow(CARD_WIDTH_MAX, { x: 0, y: 0, width: 1920, height: 900 });
  check('矮屏幕上卡片被缩小', short.cardWidth < CARD_WIDTH_MAX, `${CARD_WIDTH_MAX} -> ${short.cardWidth}`);
  check('矮屏幕上高度仍然放得下', short.height <= 900 * 0.96 + 1, `高 ${short.height}`);
  check(
    '矮屏幕上比例仍然正确',
    Math.abs((short.height - SHADOW_PAD * 2) / (short.width - SHADOW_PAD * 2) - CARD_ASPECT) < 0.005,
  );

  // A screen too short even for the minimum card: the floor wins, because an unreadable card is
  // worse than one that overflows - the same call the stylesheet makes with `max(380px, ...)`.
  const tiny = fitWindow(CARD_WIDTH_MAX, { x: 0, y: 0, width: 1920, height: 500 });
  check('极矮屏幕下不小于最小卡宽', tiny.cardWidth === CARD_WIDTH_MIN, String(tiny.cardWidth));
  check(
    '极矮屏幕下比例依然正确（窗口可以溢出，卡片不失真）',
    Math.abs((tiny.height - SHADOW_PAD * 2) / (tiny.width - SHADOW_PAD * 2) - CARD_ASPECT) < 0.005,
  );

  // Rubbish in, sane defaults out. The tall work area keeps the screen clamp out of the way so
  // this checks the input handling rather than the display fit.
  const roomy = { x: 0, y: 0, width: 1920, height: 2160 };
  check('非法卡宽回落到默认值', fitWindow(NaN, roomy).cardWidth === CARD_WIDTH_DEFAULT);
  check('过大卡宽被限制到上限', fitWindow(9999, roomy).cardWidth === CARD_WIDTH_MAX);
  check('过小卡宽被限制到下限', fitWindow(10, roomy).cardWidth === CARD_WIDTH_MIN);
  check('无工作区时也能算', fitWindow(400, null).height === Math.round(400 * CARD_ASPECT) + SHADOW_PAD * 2);

  check('反推卡宽', cardWidthForWindow(DEFAULT_WIDTH) === CARD_WIDTH_DEFAULT);
  check('反推卡宽受下限约束', cardWidthForWindow(100) === CARD_WIDTH_MIN);
}

/* ------------------------------------------------------------ drag position */

console.log('\n--- 拖动时的窗口位置 ---');
{
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 448, height: 773 };
  const cardWidth = size.width - SHADOW_PAD * 2;
  const cardHeight = size.height - SHADOW_PAD * 2;

  /** How much of the card would be inside the work area, in each axis. */
  const visible = (position) => {
    const left = position.x + SHADOW_PAD;
    const top = position.y + SHADOW_PAD;
    return {
      width: Math.min(left + cardWidth, workArea.x + workArea.width) - Math.max(left, workArea.x),
      height: Math.min(top + cardHeight, workArea.y + workArea.height) - Math.max(top, workArea.y),
    };
  };

  // The window follows the cursor, holding the pressed point at a fixed offset inside it.
  const target = dragTarget({ x: 900, y: 500 }, { x: 200, y: 300 }, size, workArea);
  check('按住内部的点拖动会跟随', target.x === 700 && target.y === 200, JSON.stringify(target));

  /*
   * A floating card is allowed to hang off an edge - that is how every other client behaves, and with
   * the shadow margin the old rule would not even let it touch the edge. What must not happen is a card
   * pushed so far that no pointer can reach it again, so the invariant is `KEEP_VISIBLE`, not "inside".
   */
  const farTopLeft = dragTarget({ x: -100000, y: -100000 }, { x: 200, y: 300 }, size, workArea);
  const topLeftVisible = visible(farTopLeft);
  check(
    '可以拖出屏幕，但会留下可抓取的一块（左上）',
    topLeftVisible.width === KEEP_VISIBLE && topLeftVisible.height === KEEP_VISIBLE,
    `${JSON.stringify(farTopLeft)} → 可见 ${topLeftVisible.width}x${topLeftVisible.height}`,
  );

  const farBottomRight = dragTarget({ x: 100000, y: 100000 }, { x: 10, y: 10 }, size, workArea);
  const bottomRightVisible = visible(farBottomRight);
  check(
    '可以拖出屏幕，但会留下可抓取的一块（右下）',
    bottomRightVisible.width === KEEP_VISIBLE && bottomRightVisible.height === KEEP_VISIBLE,
    `${JSON.stringify(farBottomRight)} → 可见 ${bottomRightVisible.width}x${bottomRightVisible.height}`,
  );

  // Somewhere in the middle of the screen nothing is clamped at all.
  const middle = dragTarget({ x: 900, y: 500 }, { x: 200, y: 300 }, size, workArea);
  check('屏幕中间不做任何夹取', middle.x === 700 && middle.y === 200);

  // A secondary display to the left has negative coordinates; the clamp must use them.
  const leftDisplay = { x: -1920, y: 0, width: 1920, height: 1040 };
  const negative = dragTarget({ x: -100000, y: 400 }, { x: 200, y: 100 }, size, leftDisplay);
  check(
    '副屏（负坐标）也能正确夹取',
    negative.x === leftDisplay.x + KEEP_VISIBLE - SHADOW_PAD - cardWidth,
    JSON.stringify(negative),
  );

  // A card bigger than the display still keeps its grabbable part on screen.
  const oversized = clampToWorkArea({ x: 500, y: 500 }, { width: 3000, height: 2000 }, workArea);
  check(
    '卡片比屏幕还大时仍然可抓',
    oversized.x + SHADOW_PAD <= workArea.width - KEEP_VISIBLE && oversized.y + SHADOW_PAD <= workArea.height - KEEP_VISIBLE,
    JSON.stringify(oversized),
  );

  // The rolled-up strip is shorter than KEEP_VISIBLE, so it is never asked to keep more than it has.
  const strip = clampToWorkArea({ x: 10, y: -100000 }, { width: 448, height: 40 + SHADOW_PAD * 2 }, workArea);
  const stripTop = strip.y + SHADOW_PAD;
  check(
    '收起条比 KEEP_VISIBLE 矮时整条留在屏内',
    stripTop >= 0,
    `条顶 ${stripTop}（窗口 y=${strip.y}）`,
  );

  // Sub-pixel positions make a scaled display blurry, so the result is always whole pixels.
  const rounded = clampToWorkArea({ x: 10.4, y: 10.6 }, size, workArea);
  check('位置取整', rounded.x === 10 && rounded.y === 11, JSON.stringify(rounded));
}

/* ------------------------------------------------------------------ easing */

console.log('\n--- 收起动画的缓动 ---');
{
  check('起点为 0', easeOutCubic(0) === 0);
  check('终点为 1', easeOutCubic(1) === 1);
  // Monotonic and clamped: a late timer tick must not overshoot the target height.
  const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(easeOutCubic);
  check(
    '单调递增',
    samples.every((value, i) => i === 0 || value > samples[i - 1]),
    samples.map((v) => v.toFixed(3)).join(' '),
  );
  check('越界被夹住', easeOutCubic(-1) === 0 && easeOutCubic(2) === 1);
  // Ease-OUT, not ease-in: most of the distance is covered in the first half, which is what makes
  // a short tween read as fast rather than as a slow slide.
  check('前一半走完大部分距离', easeOutCubic(0.5) > 0.8, easeOutCubic(0.5).toFixed(3));
}

/* ------------------------------------------------------- hover -> collapse */

console.log('\n--- 鼠标离开 -> 收起 ---');
{
  const opts = { collapseDelayMs: 600, expandDelayMs: 80 };

  // Staying inside must never collapse, however long the pointer rests there.
  const stay = createHoverState(opts);
  check('首次采样在内部不收起', stay.update(0, true, false) === false && !stay.collapsed);
  check('长时间停留仍不收起', stay.update(60_000, true, false) === false && !stay.collapsed);

  // Leaving collapses only after the delay - brushing past the edge must not roll it up.
  const leave = createHoverState(opts);
  leave.update(0, true, false);
  check('刚离开不收', leave.update(1000, false, false) === false && !leave.collapsed);
  check('离开未满延迟不收', leave.update(1599, false, false) === false && !leave.collapsed);
  check('离开满延迟后收起', leave.update(1600, false, false) === true && leave.collapsed);

  // Coming back inside the delay cancels it.
  const brush = createHoverState(opts);
  brush.update(0, true, false);
  brush.update(1000, false, false);
  check('回到窗口内取消收起', brush.update(1100, true, false) === false && !brush.collapsed);
  check('取消后继续停留不收起', brush.update(9000, true, false) === false && !brush.collapsed);

  // Expanding takes a short confirmation so a flicker at the edge does not pop the card open.
  const back = createHoverState(opts);
  back.update(0, false, false);
  back.update(600, false, false);
  check('已在收起状态', back.collapsed);
  check('刚移入不立刻展开', back.update(2000, true, false) === false && back.collapsed);
  check('移入满延迟后展开', back.update(2080, true, false) === true && !back.collapsed);

  // A pointer that never enters the collapsed window cannot expand it - which is guaranteed
  // geometrically, because the bar is the top of the expanded window, not a new area.
  const away = createHoverState(opts);
  away.update(0, false, false);
  away.update(600, false, false);
  check('指针仍在外面时不展开', away.update(60_000, false, false) === false && away.collapsed);

  // Lock wins, in both directions.
  const locked = createHoverState(opts);
  locked.update(0, false, false);
  check('锁定时不收起', locked.update(60_000, false, true) === false && !locked.collapsed);
  const unlockLater = createHoverState(opts);
  unlockLater.update(0, false, false);
  unlockLater.update(600, false, false);
  check('已收起后加锁会展开', unlockLater.update(700, false, true) === true && !unlockLater.collapsed);
  // The pointer never came back, so releasing the lock lets the next sample roll it up again.
  check('解锁后（指针仍在外）立即重新收起', unlockLater.update(800, false, false) === true && unlockLater.collapsed);
  check('重新收起后不再反复触发', unlockLater.update(2000, false, false) === false && unlockLater.collapsed);

  // While hidden the state is reset, so showing the window does not act on a stale sample.
  const hidden = createHoverState(opts);
  hidden.update(0, true, false);
  hidden.reset();
  check('reset 后重新采样', hidden.update(5000, false, false) === false && !hidden.collapsed);
  check('reset 后延迟从新采样算起', hidden.update(5600, false, false) === true && hidden.collapsed);

  // A constant stream of samples must produce at most one transition per state change.
  const settled = createHoverState(opts);
  let transitions = 0;
  for (let t = 0; t <= 5000; t += 120) if (settled.update(t, false, false)) transitions++;
  check('持续在外部只发生一次收起', transitions === 1, `${transitions} 次`);
}

/* ---------------------------------------------------------- state file */

console.log('\n--- 窗口位置持久化 ---');
{
  const dir = join(process.cwd(), '.scratch', 'shell-state');
  mkdirSync(dir, { recursive: true });
  const file = stateFilePath(dir);
  const bounds = [{ x: 0, y: 0, width: 1920, height: 1080 }];

  saveWindowState(file, { cardWidth: 400, x: 120, y: 240, locked: true });
  const restored = loadWindowState(file, bounds);
  check(
    '保存后可读回（含锁定状态）',
    restored.cardWidth === 400 && restored.x === 120 && restored.y === 240 && restored.locked === true,
    JSON.stringify(restored),
  );

  saveWindowState(file, { cardWidth: 400, x: 120, y: 240, locked: false });
  check('锁定状态可以关闭并存回', loadWindowState(file, bounds).locked === false);

  // A position from an unplugged monitor must be dropped, not restored off screen.
  saveWindowState(file, { cardWidth: 400, x: 9000, y: 9000, locked: true });
  const offscreen = loadWindowState(file, bounds);
  check('屏幕外的位置被丢弃', offscreen.x === undefined && offscreen.y === undefined, JSON.stringify(offscreen));

  // Card width must be clamped into the allowed range.
  saveWindowState(file, { cardWidth: 5000, x: 10, y: 10, locked: true });
  check('过大的卡宽被限制', loadWindowState(file, bounds).cardWidth === CARD_WIDTH_MAX);

  // A file written by the previous version stored the *window* width; it must be converted,
  // not read as a card width (which would silently grow the card by the shadow margin).
  writeFileSync(file, JSON.stringify({ width: DEFAULT_WIDTH, x: 5, y: 6 }), 'utf8');
  check('兼容旧的窗口宽度字段', loadWindowState(file, bounds).cardWidth === CARD_WIDTH_DEFAULT);

  /*
   * Locking defaults to ON. An overlay that rolls itself up the first time the pointer wanders
   * off is a surprise on first run; not rolling up is merely inert.
   */
  check('旧存档没有锁定时默认锁定', loadWindowState(file, bounds).locked === true);

  /*
   * The custom cover's on/off flag lives in the same file, and only the flag does: the image itself is
   * a file beside it, because a data URL in the state JSON would make it megabytes. A default of ON
   * means "if there is a picture, show it" - with no picture the flag changes nothing.
   */
  saveWindowState(file, { cardWidth: 400, x: 120, y: 240, locked: true, coverEnabled: false });
  check('自选封面的开关能存回（关）', loadWindowState(file, bounds).coverEnabled === false);
  saveWindowState(file, { cardWidth: 400, x: 120, y: 240, locked: true, coverEnabled: true });
  check('自选封面的开关能存回（开）', loadWindowState(file, bounds).coverEnabled === true);
  writeFileSync(file, JSON.stringify({ cardWidth: 400, x: 1, y: 2, locked: true }), 'utf8');
  check('旧存档没有这个字段时默认开', loadWindowState(file, bounds).coverEnabled === true);
  const stateText = readFileSync(file, 'utf8');
  check('状态文件里不存图片本身', stateText.length < 400 && !stateText.includes('base64'), `${stateText.length} 字节`);

  // A missing or corrupt file must fall back to a default rather than throwing.
  const missing = loadWindowState(join(dir, 'nope.json'), bounds);
  check('文件缺失时用默认值', missing.cardWidth === CARD_WIDTH_DEFAULT && missing.locked === true, JSON.stringify(missing));
  writeFileSync(file, '{ not json', 'utf8');
  check('文件损坏时不抛异常', loadWindowState(file, bounds).cardWidth === CARD_WIDTH_DEFAULT);

  // The lock must not be read from anything but an actual boolean.
  writeFileSync(file, JSON.stringify({ cardWidth: 400, locked: 'yes' }), 'utf8');
  check('非布尔的锁定值被忽略', loadWindowState(file, bounds).locked === true);
}

/* ---------------------------------------------------------------- icon PNG */

console.log('\n--- 托盘图标 PNG ---');
{
  const png = makeIconPng({ r: 0x98, g: 0xb6, b: 0xbe }, 32);
  check('产出非空字节', png.length > 100, `${png.length} 字节`);
  check('PNG 签名正确', png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  const ihdr = png.indexOf('IHDR');
  check('IHDR 存在且在签名之后', ihdr === 12, `offset ${ihdr}`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  check('尺寸写入为 32x32', width === 32 && height === 32, `${width}x${height}`);
  check('颜色类型为 RGBA', png[25] === 6, `type ${png[25]}`);
  check('包含 IDAT 与 IEND', png.includes('IDAT') && png.includes('IEND'));

  // Every chunk's CRC must verify, or decoders reject the image.
  let offset = 8;
  let chunks = 0;
  let crcOk = true;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const stored = png.readUInt32BE(offset + 8 + length);
    const body = png.subarray(offset + 4, offset + 8 + length);
    let c = 0xffffffff;
    for (const byte of body) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    if ((c ^ 0xffffffff) >>> 0 !== stored >>> 0) crcOk = false;
    chunks++;
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  check('所有 chunk 的 CRC 正确', crcOk, `共 ${chunks} 个 chunk`);

  const out = join(process.cwd(), '.scratch', 'tray-icon.png');
  writeFileSync(out, png);
  console.log(`    已写出用于人工查看: ${out}`);

  /*
   * Decode the pixels, not just the container.
   *
   * CRC checks say the PNG is well-formed; they do not say the image data is usable. Electron
   * will not take a raw buffer at all (`Tray` wants a NativeImage or a path), so the shell wraps
   * it in `nativeImage.createFromBuffer` - and that quietly returns an *empty* image rather than
   * throwing if the stream cannot be decoded. Inflating the IDAT and probing two pixels is the
   * cheap way to know the encoder produced a real picture.
   */
  let offset2 = 8;
  const idat = [];
  while (offset2 + 12 <= png.length) {
    const length = png.readUInt32BE(offset2);
    const type = png.subarray(offset2 + 4, offset2 + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(offset2 + 8, offset2 + 8 + length));
    offset2 += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  check('图像数据可解压且长度正确', raw.length === height * stride, `${raw.length} vs ${height * stride}`);
  let filterOk = true;
  for (let y = 0; y < height; y++) if (raw[y * stride] !== 0) filterOk = false;
  check('每行过滤字节均为 0', filterOk);

  const pixel = (x, y) => {
    const at = y * stride + 1 + x * 4;
    return [raw[at], raw[at + 1], raw[at + 2], raw[at + 3]];
  };
  check('圆角外为透明', pixel(0, 0)[3] === 0, `alpha=${pixel(0, 0)[3]}`);
  const centre = pixel(Math.floor(width / 2), Math.floor(height / 2));
  check('中心为不透明白色（播放三角）', centre.join(',') === '255,255,255,255', centre.join(','));
}

console.log('\n--- 应用图标（assets/icon.ico）---');
{
  /*
   * The shipped icon is generated by `tools/make-icon.mjs`, committed, and read by the tray, the
   * taskbar and (later) the installer. Nothing else in the project looks at it: a truncated or
   * single-size .ico would only be discovered when someone packaged the app or noticed a blurry
   * tray. So it is parsed here - directory, PNG signature, IEND, and the pixel size inside each
   * frame *against* the size the directory claims.
   */
  const icoPath = 'assets/icon.ico';
  check('图标文件存在', existsSync(icoPath), icoPath);
  if (existsSync(icoPath)) {
    const ico = readFileSync(icoPath);
    check('ICO 头正确', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, `type=${ico.readUInt16LE(2)}`);
    const count = ico.readUInt16LE(4);
    check('至少 5 个尺寸', count >= 5, `${count} 个`);

    let bad = 0;
    const sizes = [];
    let end = 0;
    let frame256 = null;
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const size = ico[entry] === 0 ? 256 : ico[entry];
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const signature = ico.subarray(offset, offset + 8).toString('hex') === '89504e470d0a1a0a';
      const iend = ico.subarray(offset + length - 8, offset + length - 4).toString('ascii') === 'IEND';
      const pixelWidth = ico.readUInt32BE(offset + 16);
      const pixelHeight = ico.readUInt32BE(offset + 20);
      if (!signature || !iend || pixelWidth !== size || pixelHeight !== size) bad++;
      if (size === 256) frame256 = ico.subarray(offset, offset + length);
      sizes.push(size);
      end = Math.max(end, offset + length);
    }
    check('每一帧都是完整的 PNG 且尺寸与目录一致', bad === 0, bad ? `${bad} 帧有问题` : sizes.join(' '));
    check('帧不越出文件', end === ico.length, `结束 ${end} / 文件 ${ico.length}`);
    check('包含 16px（托盘）与 256px（安装包）', sizes.includes(16) && sizes.includes(256));

    /*
     * The frames at 48px and up are cut out of the owner's export, whose "transparent" background is
     * a grey/white **checkerboard baked into the pixels**. A cut that assumes a perfect circle leaves a
     * strip of that checkerboard below the disc - which is exactly what shipped once, and the owner
     * caught it by eye before any check did. So the disc is checked for residue: nothing opaque
     * outside its radius, and empty corners.
     */
    if (frame256) {
      const image = decodePng(frame256);
      const centre = (image.width - 1) / 2;
      let outside = 0;
      let corners = 0;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (image.pixels[(y * image.width + x) * 4 + 3] < 8) continue;
          const distance = Math.hypot(x - centre, y - centre);
          if (distance > image.width / 2 + 2) outside++;
        }
      }
      for (const [x, y] of [[1, 1], [image.width - 2, 1], [1, image.height - 2], [image.width - 2, image.height - 2]]) {
        if (image.pixels[(y * image.width + x) * 4 + 3] > 8) corners++;
      }
      check('256 帧盘外没有残留（导出图的棋盘格不能漏进来）', outside === 0, outside ? `${outside} 个不透明像素在盘外` : '');
      check('256 帧四角透明', corners === 0, corners ? `${corners} 个角不透明` : '');
      /*
       * And the disc has to *fill* the frame: a cut that comes out too small leaves the icon looking
       * shrunken beside its neighbours in the taskbar. Counting the opaque pixels well inside the
       * radius and comparing with that circle's area catches a uniform shrinkage, which the
       * "reaches the bottom edge" test below would not.
       */
      let inner = 0;
      const innerRadius = (image.width / 2) * 0.95;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (Math.hypot(x - centre, y - centre) > innerRadius) continue;
          if (image.pixels[(y * image.width + x) * 4 + 3] > 8) inner++;
        }
      }
      const expected = Math.PI * innerRadius * innerRadius;
      check('256 帧没有缩小（该实的地方是实的）', inner > expected * 0.98, `${inner} / 期望约 ${Math.round(expected)}`);
      // And the disc must still reach the frame's edge, or the icon looks shrunken next to others.
      let lowest = -1;
      for (let y = 0; y < image.height; y++) {
        if (image.pixels[(y * image.width + Math.floor(image.width / 2)) * 4 + 3] > 8) lowest = y;
      }
      check('256 帧是满幅的（圆盘贴到边缘）', lowest >= image.height - 4, `中线最低不透明像素 y=${lowest}`);

      /*
       * The owner asked for the client's own red, so the shipped frames have to *carry* it - both the
       * large ones taken from the export and the small vector ones. The code comes from measuring the
       * client's icon (`resources\format.ico`), not from a palette: `#fd364e` is the mean of that
       * mark's gradient (`#fc3c49` is its most common stop, `#fe245b` its other end).
       */
      const modalRed = (png, label) => {
        const frame = decodePng(png);
        const counts = new Map();
        for (let i = 0; i < frame.width * frame.height; i++) {
          const r = frame.pixels[i * 4];
          const g = frame.pixels[i * 4 + 1];
          const b = frame.pixels[i * 4 + 2];
          if (frame.pixels[i * 4 + 3] < 250) continue;
          if (!(r > 120 && r - Math.max(g, b) > 40)) continue;
          const key = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let best = null;
        for (const [key, value] of counts) if (!best || value > best[1]) best = [key, value];
        void label;
        return best ? best[0] : null;
      };
      const fromArt = frame256 ? modalRed(frame256) : null;
      check('256 帧的红是网易云客户端的红', fromArt === '#fd364e', `${fromArt}`);
      const ico16 = (() => {
        for (let i = 0; i < count; i++) {
          const entry = 6 + i * 16;
          if ((ico[entry] === 0 ? 256 : ico[entry]) !== 16) continue;
          const length = ico.readUInt32LE(entry + 8);
          const offset = ico.readUInt32LE(entry + 12);
          return ico.subarray(offset, offset + length);
        }
        return null;
      })();
      const fromVector = ico16 ? modalRed(ico16) : null;
      check('16 帧的红也是同一个色号（每一帧都从导出图来）', fromVector === '#fd364e', `${fromVector}`);
      check(
        '矢量定义里写的就是这个色号',
        /const RED = \[0xfd, 0x36, 0x4e\]/.test(readStyle('tools/make-icon.mjs')),
      );
    }
  }
  // The shell must actually use it, with the in-memory drawing left as the fallback.
  const shellJs = readStyle('apps/overlay/main.mjs');
  check('托盘用上了这个图标', /join\(ROOT, 'assets', 'icon\.ico'\)/.test(shellJs));
  check('读不到时退回内存绘制', /makeIconPng\(ICON_COLOR/.test(shellJs));
  check('矢量源也在仓库里', existsSync('assets/icon.svg'));
}

/* ------------------------------------------------------------------ custom cover */

console.log('\n--- 自选封面（外壳这一侧）---');
{
  /*
   * The user's own cover: chosen through a file dialog, kept as a file beside the state, and fetched
   * by the renderer as a data URL - it cannot read a local file from an http page, and re-sending the
   * image on every state broadcast would be wasteful. All three verbs live on the preload bridge; the
   * UI must survive their absence, which is what the `?.` calls are for.
   */
  const shellJs = readStyle('apps/overlay/main.mjs');
  const preload = readStyle('apps/overlay/preload.cjs');
  check('preload 暴露了选图', /pickCover: \(\) => ipcRenderer\.invoke\('overlay:pick-cover'\)/.test(preload));
  check('preload 暴露了开关', /toggleCover: \(\) => ipcRenderer\.send\('overlay:toggle-cover'\)/.test(preload));
  check('preload 暴露了清除', /clearCover: \(\) => ipcRenderer\.send\('overlay:clear-cover'\)/.test(preload));
  check('preload 暴露了取图（数据 URL）', /coverUrl: \(\) => ipcRenderer\.invoke\('overlay:cover-url'\)/.test(preload));

  check('外壳注册了这三个动词', /ipcMain\.handle\('overlay:pick-cover'/.test(shellJs) && /ipcMain\.on\('overlay:toggle-cover'/.test(shellJs) && /ipcMain\.on\('overlay:clear-cover'/.test(shellJs));
  check('选图只收图片类型', /extensions: \['png', 'jpg'/.test(shellJs));
  check('选图会先解码，避免把坏文件存下来', /nativeImage\.createFromPath\(result\.filePaths\[0\]\)/.test(shellJs) && /isEmpty\(\)/.test(shellJs));
  check('大图会先缩小再保存', /resize\(\{ width: COVER_MAX_WIDTH/.test(shellJs) && /COVER_MAX_WIDTH = \d+/.test(shellJs));
  check('图片存成独立文件', /join\(app\.getPath\('userData'\), 'custom-cover\.png'\)/.test(shellJs));
  check('状态广播带上封面的有无、开关与版本号', /cover: \{ has: cover\.url !== null, enabled: cover\.enabled, rev: cover\.rev \}/.test(shellJs));
  // Only a revision can distinguish a second picture from the same one, so it has to be bumped.
  check('选图与清除都会推进版本号', (shellJs.match(/cover\.rev \+= 1;/g) ?? []).length >= 2);
  check('清除时删掉文件', /rmSync\(coverFilePath\(\), \{ force: true \}\)/.test(shellJs));
  check('开关与清除都会持久化', (shellJs.match(/persistWindowState\(\)/g) ?? []).length >= 4);
  // The tray menu is fixed at 小/中/大 + 退出; the cover belongs to the card, not the tray.
  check('没有往托盘菜单里加东西', !/自选封面/.test(readStyle('apps/overlay/main.mjs').slice(readStyle('apps/overlay/main.mjs').indexOf('trayTemplate'))));
}

/* --------------------------------------------------------------- packaging */

console.log('\n--- 打包配置（electron-builder.yml）---');
{
  /*
   * The config decides whether an installed app can find its own parts, and getting it wrong is
   * invisible until someone installs it: the app starts and cannot load `ui/`, or opens with no icon,
   * or ships the whole checkout. So the four things the shell reads at runtime are checked against the
   * `files` list, and the icon against the file on disk.
   */
  const configPath = 'electron-builder.yml';
  check('存在打包配置', existsSync(configPath), configPath);
  const config = readStyle(configPath);
  const pkg = JSON.parse(readStyle('package.json'));

  check('入口指向外壳', pkg.main === 'apps/overlay/main.mjs', `${pkg.main}`);
  check(
    '有 pack / dist 脚本',
    /"pack": "electron-builder --dir"/.test(readStyle('package.json')) &&
      /"dist": "electron-builder"/.test(readStyle('package.json')),
  );
  check('electron-builder 是开发依赖', typeof pkg.devDependencies?.['electron-builder'] === 'string');

  /*
   * Everything the shell touches at runtime: the host entry, the host's sources (Node strips the types
   * at run time), the UI the host serves, and the icon the tray loads.
   */
  for (const [what, pattern, present] of [
    ['宿主入口', /tools\/host-run\.mjs/, existsSync('tools/host-run.mjs')],
    ['宿主源码', /packages\/host\/src\/\*\*\/\*/, existsSync('packages/host/src/index.ts')],
    ['界面', /ui\/\*\*\/\*/, existsSync('ui/index.html')],
    ['外壳', /apps\/overlay\/\*\*\/\*/, existsSync('apps/overlay/main.mjs')],
    ['图标', /assets\/icon\.ico/, existsSync('assets/icon.ico')],
  ]) {
    check(`files 里包含${what}`, pattern.test(config) && present);
  }
  check('图标目录指向 assets（不是被忽略的 build/）', /buildResources: assets/.test(config));
  check('win.icon 指向存在的图标', /icon: assets\/icon\.ico/.test(config) && existsSync('assets/icon.ico'));
  check('输出到 dist/', /output: dist/.test(config));

  // No native modules, so the rebuild pass has nothing to do; see the comment in the config.
  check('关掉无用的 native 重建', /npmRebuild: false/.test(config));

  // The installer is per-user and lets the user choose where it goes: an overlay writes only to its own
  // user data, so an administrator prompt would be asking for a privilege it never uses.
  check('按用户安装、可选目录', /perMachine: false/.test(config) && /allowToChangeInstallationDirectory: true/.test(config));
  check('同时产出安装包与免安装版', /target: nsis/.test(config) && /target: portable/.test(config));
  check(
    '安装后给出开始菜单与桌面快捷方式',
    /createStartMenuShortcut: true/.test(config) && /createDesktopShortcut: true/.test(config),
  );

  /*
   * Auto-start is a latch the shell applies once, packaged only - and it must never be applied in
   * development, where a checkout would register itself to run at login.
   */
  const shellJs2 = readStyle('apps/overlay/main.mjs');
  check('开机自启只在打包后生效', /if \(!app\.isPackaged \|\| autoStartApplied\) return;/.test(shellJs2));
  check(
    '开机自启只做一次（记在状态文件里）',
    /autoStartApplied: raw\.autoStartApplied === true/.test(readStyle('apps/overlay/shell-utils.mjs')),
  );
  check('单实例锁已就位', /requestSingleInstanceLock/.test(shellJs2) && /second-instance/.test(shellJs2));

  // The one thing the card can do about a missing debug channel: restart the client with it.
  check(
    '卡片能一键带通道重启客户端',
    /ipcMain\.handle\('overlay:restart-client'/.test(shellJs2) &&
      /restartClient: \(\) => ipcRenderer\.invoke\('overlay:restart-client'\)/.test(readStyle('apps/overlay/preload.cjs')),
  );
  check('重启用客户端自己的参数（只监听本机）', /clientDebugArgs\(CDP_PORT\)/.test(shellJs2));
}

/* ----------------------------------------------------------- startup wiring */

console.log('\n--- 启动顺序（一个坏掉的附加功能不能拖垮核心功能）---');
{
  const shellJs = readStyle('apps/overlay/main.mjs');

  /*
   * `new Tray(makeIconPng(...))` passed a raw PNG buffer, which Electron rejects with
   * "Argument must be a file path or a NativeImage". The throw happened inside `createTray()`,
   * in the middle of startup, so it silently skipped `startHoverWatch()` - and a broken tray
   * icon presented as "the card never rolls up". Two things prevent a repeat.
   */
  check('图标包装为 NativeImage', /nativeImage\.createFromBuffer/.test(shellJs));
  check('不再把裸 Buffer 交给 Tray', !/new Tray\(makeIconPng/.test(shellJs));
  check('图标解码失败会告警', /isEmpty\(\)/.test(shellJs));

  /*
   * The order within the startup block, not adjacency: a comment between two calls is fine, but
   * the pointer watcher must exist before anything that can throw, and the (possibly slow) wait
   * for the host must come after the window so the app is never invisible.
   */
  const startBlock = shellJs.slice(shellJs.indexOf('.whenReady()'));
  check('找到了启动块', startBlock.length > 0);
  const order = ['startHoverWatch();', 'createWindow();', 'createTray();', 'await loadUi();'].map((needle) =>
    startBlock.indexOf(needle),
  );
  check(
    '启动顺序：监听 -> 窗口 -> 托盘 -> 加载界面',
    order.every((at) => at > 0) && order.every((at, i) => i === 0 || order[i - 1] < at),
    order.join(' < '),
  );
  check('托盘创建被 try 包住', /try\s*\{\s*createTray\(\);/.test(startBlock));
  check('whenReady 链有 catch', /\.catch\(\(err\) => \{\s*console\.error\('\[shell\] 启动失败'/.test(shellJs));

  // The window shows a placeholder at once so Windows never reports a windowless process with its
  // "starting" cursor, and the real UI is loaded only once the host answers.
  check('窗口先显示启动页', /STARTUP_PAGE/.test(shellJs) && /loadURL\(STARTUP_PAGE\)/.test(shellJs));
  check('宿主就绪后才加载界面', /await waitForUi\(\)/.test(startBlock) && /loadUi\(\)/.test(shellJs));
  check('界面就绪以 dom-ready 为准', /once\('dom-ready'/.test(shellJs));

  // A drag may push the card off an edge, but never out of reach: clampToWorkArea keeps
  // KEEP_VISIBLE of it on screen, and the roll-up and the width presets go through the same call.
  check('拖动位置经过夹取', /clampToWorkArea/.test(shellJs) && /clampToWorkArea/.test(readStyle('apps/overlay/shell-utils.mjs')));
  check('收起/展开也用同一套限制', /clampToWorkArea\(\s*\{ x: bounds\.x/.test(shellJs));
  check('夹取以可抓取为准，不再要求整窗在屏内', !/workArea\.x \+ workArea\.width - size\.width/.test(readStyle('apps/overlay/shell-utils.mjs')));
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 桌面壳辅助逻辑通过'}`);
process.exit(failures ? 1 : 0);

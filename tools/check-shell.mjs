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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  // The window follows the cursor, holding the pressed point at a fixed offset inside it.
  const target = dragTarget({ x: 900, y: 500 }, { x: 200, y: 300 }, size, workArea);
  check('按住内部的点拖动会跟随', target.x === 700 && target.y === 200, JSON.stringify(target));

  /*
   * The clamp is what makes a rolled-up card recoverable. The strip sits along the window's TOP
   * edge, so a window left hanging above the top of the display would put the strip where no
   * pointer can reach it and the card could never be expanded again.
   */
  const topLeft = dragTarget({ x: 10, y: 10 }, { x: 200, y: 300 }, size, workArea);
  check('不能拖到屏幕左上角以外', topLeft.x === 0 && topLeft.y === 0, JSON.stringify(topLeft));

  const bottomRight = dragTarget({ x: 5000, y: 5000 }, { x: 10, y: 10 }, size, workArea);
  check(
    '不能拖出右下角',
    bottomRight.x === workArea.width - size.width && bottomRight.y === workArea.height - size.height,
    JSON.stringify(bottomRight),
  );

  // A secondary display to the left has negative coordinates; the clamp must use them.
  const leftDisplay = { x: -1920, y: 0, width: 1920, height: 1040 };
  const negative = dragTarget({ x: -1000, y: 400 }, { x: 200, y: 100 }, size, leftDisplay);
  check(
    '副屏（负坐标）也能正确夹取',
    negative.x === -1200 && negative.y === leftDisplay.height - size.height,
    JSON.stringify(negative),
  );

  // A window larger than the display anchors to the top-left instead of a negative coordinate.
  const oversized = clampToWorkArea({ x: 500, y: 500 }, { width: 3000, height: 2000 }, workArea);
  check('窗口大于屏幕时贴左上角', oversized.x === 0 && oversized.y === 0, JSON.stringify(oversized));

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

  // A drag must never be able to move the window somewhere the pointer cannot reach it again.
  check('拖动位置被限制在工作区', /clampToWorkArea/.test(shellJs) && /clampToWorkArea/.test(readStyle('apps/overlay/shell-utils.mjs')));
  check('收起/展开也用同一套限制', /clampToWorkArea\(\s*\{ x: bounds\.x/.test(shellJs));
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 桌面壳辅助逻辑通过'}`);
process.exit(failures ? 1 : 0);

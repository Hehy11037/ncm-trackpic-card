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
  createHoverState,
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
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 桌面壳辅助逻辑通过'}`);
process.exit(failures ? 1 : 0);

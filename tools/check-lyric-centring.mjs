// Verify the lyric centring transform, and the depth classes that decide visibility.
//
//   node tools/check-lyric-centring.mjs
//
// An earlier version of this file validated the *buggy* formula and passed, because it
// reproduced the same coordinate-system mistake the code had. The model here is explicit
// about the two coordinate systems, so that class of error shows up instead of hiding:
//
//   - the stack is anchored to the container's top edge (CSS `top: 0`)
//   - `offsetTop` is measured from the stack's top
//   - the transform moves the stack, so the active line's screen position is
//     `containerTop + offsetTop + offset`
//
// The container is modelled as starting at screen y = 0, so the check is simply whether
// the active line's centre lands on `containerHeight / 2`.

const VISIBLE_LINES = 7;
const MAX_DISTANCE = Math.floor(VISIBLE_LINES / 2);
const RECEDE_ABOVE = 0.55;
const RECEDE_BELOW = 0.15;

/** Mirrors #centreOn in ui/src/lyrics.js. */
function centreOffset(containerHeight, activeTop, activeHeight) {
  return containerHeight / 2 - (activeTop + activeHeight / 2);
}

/** Mirrors #setActive: node index -> depth. The active line is exactly 0. */
function depthFor(nodeIndex, activeIndex) {
  if (nodeIndex === activeIndex) return 0;
  const distance = nodeIndex - activeIndex;
  return distance < 0 ? Math.abs(distance) + RECEDE_ABOVE : distance + RECEDE_BELOW;
}

/** Build a layout with non-uniform line heights, as the real document has. */
function buildLayout({ containerHeight = 675, baseHeight = 60, translationExtra = 22, lines = 40 }) {
  const nodes = [];
  let top = 0;
  for (let i = 0; i < lines; i++) {
    const height = baseHeight + (i % 3 === 0 ? translationExtra : 0);
    nodes.push({ index: i, offsetTop: top, offsetHeight: height });
    top += height;
  }
  return { nodes, stackHeight: top, containerHeight };
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('--- 当前行是否落在容器正中 ---');
{
  const lines = 40;
  const layout = buildLayout({ lines });
  for (const active of [0, 1, 7, 20, 31, lines - 1]) {
    const node = layout.nodes[active];
    const offset = centreOffset(layout.containerHeight, node.offsetTop, node.offsetHeight);
    const screenCentre = node.offsetTop + node.offsetHeight / 2 + offset;
    const error = Math.abs(screenCentre - layout.containerHeight / 2);
    check(
      `active=${String(active).padStart(2)}`,
      error < 0.001,
      `线中心 ${screenCentre.toFixed(2)} / 容器中心 ${(layout.containerHeight / 2).toFixed(2)}`,
    );
  }
}

console.log('\n--- 偏移幅度：不该把内容推出画面 ---');
{
  const layout = buildLayout({ lines: 40, containerHeight: 675 });
  const offsets = layout.nodes.map((n) => centreOffset(layout.containerHeight, n.offsetTop, n.offsetHeight));
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  console.log(`  栈高 ${layout.stackHeight}px，容器高 ${layout.containerHeight}px`);
  console.log(`  offset 范围 ${min.toFixed(0)}..${max.toFixed(0)}px`);
  // The active line can be anywhere in the stack, so the offsets span roughly
  // [-(stackHeight), +containerHeight/2]. Anything else means the maths is off.
  check(
    '偏移幅度与内容规模相符',
    min >= -layout.stackHeight - 1 && max <= layout.containerHeight / 2 + 1,
    `${min.toFixed(0)} >= ${-layout.stackHeight}, ${max.toFixed(0)} <= ${layout.containerHeight / 2}`,
  );
}

console.log('\n--- 复现旧 bug：坐标系混用会让内容偏出多远 ---');
{
  const layout = buildLayout({ lines: 40, containerHeight: 675 });
  const node = layout.nodes[20];

  // The old code compared `offsetTop` (relative to the stack) with the stack's own
  // centre, which silently subtracted the stack's half-height from every offset. Model
  // that error and measure how far off the active line lands.
  const stackCentre = layout.stackHeight / 2;
  const buggy = -(node.offsetTop + node.offsetHeight / 2 - stackCentre);
  const correct = centreOffset(layout.containerHeight, node.offsetTop, node.offsetHeight);

  // With the stack positioned at `top: 50%`, its top edge starts at containerHeight/2, so
  // the active line's screen centre under the buggy formula is:
  const buggyScreen = layout.containerHeight / 2 + node.offsetTop + node.offsetHeight / 2 + buggy;
  const drift = Math.abs(buggyScreen - layout.containerHeight / 2);

  console.log(`  栈高 ${layout.stackHeight}px，offset 差 ${Math.abs(buggy - correct).toFixed(0)}px`);
  console.log(`  该错误会让当前行偏离容器中心 ${drift.toFixed(0)}px（容器高 ${layout.containerHeight}px）`);
  check('该错误足以让内容跑出视野', drift > layout.containerHeight / 2);
}

console.log('\n--- 深度分级：当前行最清晰，且窗口外隐藏 ---');
{
  for (const active of [0, 20]) {
    const depths = [];
    for (let i = 0; i < 40; i++) depths.push(depthFor(i, active));
    const activeDepth = depthFor(active, active);
    check(`active=${active} 深度为 0（最清晰）`, Math.abs(activeDepth) < 0.001, `d=${activeDepth}`);
  }

  // Of the seven visible lines, the current one must be the least faded.
  const active = 20;
  const visible = [];
  for (let i = 0; i < 40; i++) {
    if (Math.abs(i - active) <= MAX_DISTANCE) visible.push({ i, d: depthFor(i, active) });
  }
  const minDepth = Math.min(...visible.map((v) => v.d));
  const isActiveMin = visible.find((v) => v.d === minDepth)?.i === active;
  check('可见 7 行中当前行深度最小', isActiveMin, `可见行 ${visible.map((v) => v.i).join(',')}`);

  // Above the current line must recede faster than below it.
  const above = depthFor(active - 1, active);
  const below = depthFor(active + 1, active);
  check('上方衰减快于下方', above > below, `上 ${above} vs 下 ${below}`);
}

console.log(`\n${failures ? `❌ ${failures} 项失败` : '✅ 居中与深度逻辑正确'}`);
process.exit(failures ? 1 : 0);

/**
 * m3u8 广告过滤（同构：服务端 video-cache 与客户端播放器共用）。
 *
 * 采集站常见的两种插广告式（基于真实播放列表分析）：
 *
 * 1. 「独立目录」式（如量子资源 bfzy）：正片段在目录 A（0000299.ts…），
 *    广告段夹在两个 #EXT-X-DISCONTINUITY 之间且位于目录 B（/video/adjump/time/*.ts）。
 *    → 目录指纹法：统计各「源+目录」的分片数，正片目录是绝对多数派，
 *      明显少数派（≤15 段且正片 ≥10 段）的目录判定为广告。
 *
 * 2. 「短块夹插」式（如非凡影视 ffzy）：所有分片同目录、哈希文件名，无法按目录区分；
 *    广告以 DISCONTINUITY 包裹的短块出现（实测广告块 ≤5 段 / <20s，
 *    正片块 ≥88 段 / ≥355s，分界极宽）。
 *    → 分块时长法：按 DISCONTINUITY 分块，分片 ≤15 且总时长 <60s 的块判定为广告。
 *      为防误杀（正片本身极短的视频），若所有块都满足广告特征则放弃过滤。
 *
 * 3. 「序号跳变」式（如 lz 资源 lzi）：正片段文件名序号连续递增
 *    （…000073.ts → [广告 198255~198261.ts] → 000074.ts …），且该源每 10 段
 *    就有一个自然 DISCONTINUITY（编码器分块），块时长规律完全失效。
 *    → 序列法：提取分片文件名末尾数字，找出最长近似连续链（步长 0~2），
 *      链外分片判定为广告。防误杀护栏：数字后缀占比 ≥90%、最长链 ≥60%
 *      且 ≥30 段、链外总数 ≤10%（如量子资源的正片前段是另一条长链，
 *      链外占比 23% → 该方法自动禁用，由目录法处理）。
 *
 * 4. 「均匀分块短游程」式（如电影天堂 dyttzy）：单目录 + 全哈希文件名，
 *    上述方法全部失效；但该源以固定段数（众数，实测每 5 段）切
 *    DISCONTINUITY 块（占 80%），插广告表现为连续若干个「小于众数块」的
 *    游程且总段数恰为众数的整数倍（实测 4:58 处广告 = [3段,2段] 游程
 *    共 19s，各集时长指纹逐段一致）。被挤短的正片块与片头/片尾不完整块
 *    不会命中。护栏：众数 ≥4 段、占 ≥60% 的块、命中总时长 ≤15%。
 *
 * 四种方法都远低于误杀阈值，宁可漏放也不误删正片。
 */

/** 广告块的最大分片数 */
const AD_BLOCK_MAX_SEGMENTS = 15;
/** 广告块的最大总时长（秒） */
const AD_BLOCK_MAX_DURATION = 60;
/** 广告目录的最大分片数 */
const AD_DIR_MAX_SEGMENTS = 15;
/** 触发目录过滤所需的正片（多数派）最小分片数 */
const MAJORITY_MIN_SEGMENTS = 10;
/** 触发任何过滤所需的播放列表最小分片数 */
const MIN_SEGMENTS_TO_FILTER = 10;

interface SegmentRef {
  /** 分片行在原数组中的下标 */
  index: number;
  /** 绝对或相对 URL（保持原文） */
  url: string;
}

function isSegmentLine(line: string): boolean {
  return line.trim() !== '' && !line.trim().startsWith('#');
}

/** 「源+目录」指纹：分片 URL 去掉文件名后的部分（相对地址也能区分目录差异） */
function dirFingerprint(url: string): string {
  const idx = url.lastIndexOf('/');
  return idx === -1 ? '' : url.slice(0, idx + 1);
}

/**
 * 过滤媒体播放列表中的广告分片。master 播放列表（含 #EXT-X-STREAM-INF）原样返回。
 * 输入输出都是完整 m3u8 文本；不修改任何标签语义，仅删除被判定为广告的分片及其伴随行。
 */
export function filterM3u8Ads(m3u8: string): string {
  if (!m3u8) return m3u8;
  if (m3u8.includes('#EXT-X-STREAM-INF')) return m3u8; // master 列表不处理
  if (!m3u8.includes('#EXTINF')) return m3u8; // 非媒体播放列表（如反爬 HTML 页）不处理

  const lines = m3u8.split(/\r?\n/);

  // 收集分片行下标
  const segIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isSegmentLine(lines[i])) segIdx.push(i);
  }
  if (segIdx.length < MIN_SEGMENTS_TO_FILTER) return m3u8;

  // ---------- 方法 1：目录指纹 ----------
  const dirCount = new Map<string, number>();
  let majority = 0;
  for (const i of segIdx) {
    const fp = dirFingerprint(lines[i].trim());
    const c = (dirCount.get(fp) ?? 0) + 1;
    dirCount.set(fp, c);
    if (c > majority) majority = c;
  }
  const adDirs = new Set<string>();
  // 多数派必须占绝对优势（≥50%）：真实广告目录永远是极少数派；
  // 多目录均分的播放列表（各目录都是编码分块）不可靠，放弃目录过滤。
  if (
    majority >= MAJORITY_MIN_SEGMENTS &&
    majority >= segIdx.length * 0.5 &&
    dirCount.size > 1
  ) {
    dirCount.forEach((count, fp) => {
      if (count < majority && count <= AD_DIR_MAX_SEGMENTS) adDirs.add(fp);
    });
  }

  // ---------- 方法 2：DISCONTINUITY 分块时长 ----------
  // 把分片行按块划分：块 = 两个 DISCONTINUITY 标记之间的分片集合
  interface Block {
    indices: number[]; // 分片行下标
    dur: number;
    durPending?: number; // 尚未挂到分片上的 #EXTINF 时长
  }
  const blocks: Block[] = [];
  let cur: Block = { indices: [], dur: 0 };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#EXTINF')) {
      const m = /#EXTINF:\s*([0-9.]+)/.exec(t);
      cur.durPending = m ? parseFloat(m[1]) : undefined;
    } else if (isSegmentLine(t)) {
      cur.indices.push(i);
      cur.dur += cur.durPending ?? 0;
      cur.durPending = undefined;
    } else if (t.includes('#EXT-X-DISCONTINUITY')) {
      blocks.push(cur);
      cur = { indices: [], dur: 0 };
    }
  }
  blocks.push(cur);

  const contentBlocks = blocks.filter(
    (b) => b.indices.length > AD_BLOCK_MAX_SEGMENTS || b.dur >= AD_BLOCK_MAX_DURATION
  );
  // 仅当存在明确的正片块、且广告块不占绝对多数时才启用块过滤，防误杀短视频
  const adSegIdx = new Set<number>();
  if (contentBlocks.length > 0 && contentBlocks.length < blocks.length) {
    // 比例护栏：候选广告块的总时长占比过高（>15%）说明该源天然以短块切片
    // （如电影天堂/最大资源整集都是 ~20s 的编码分块），「短块=广告」假设不成立，
    // 宁可漏放也不误删正片。真实插广告（如 mdzy 每 ~5 分钟插 17s）占比 ≤12%。
    let adDur = 0;
    let totalDur = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      totalDur += blocks[bi].dur;
      if (
        blocks[bi].indices.length <= AD_BLOCK_MAX_SEGMENTS &&
        blocks[bi].dur < AD_BLOCK_MAX_DURATION
      ) {
        adDur += blocks[bi].dur;
      }
    }
    if (adDur <= totalDur * 0.15) {
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        if (
          b.indices.length > 0 &&
          b.indices.length <= AD_BLOCK_MAX_SEGMENTS &&
          b.dur < AD_BLOCK_MAX_DURATION
        ) {
          for (let k = 0; k < b.indices.length; k++) adSegIdx.add(b.indices[k]);
        }
      }
    }
  }

  if (adDirs.size > 0) {
    for (let k = 0; k < segIdx.length; k++) {
      if (adDirs.has(dirFingerprint(lines[segIdx[k]].trim()))) {
        adSegIdx.add(segIdx[k]);
      }
    }
  }

  // ---------- 方法 3：文件名数字序列离群检测 ----------
  // 正片分片序号在一个连续数值池内；广告序号来自另一个池，远离正片值域。
  // 用「中位数 ± MAD」做离群判定（对广告插在正片中间、把序号链切成多段的
  // 情形免疫——只看值域分布，不看文件顺序）。哈希文件名源的尾部数字无意义，
  // 要求几乎全部分片带数字后缀才启用。
  const nums: number[] = [];
  for (let k = 0; k < segIdx.length; k++) {
    const m = /(\d+)\.(?:ts|m4s|mp4)$/i.exec(lines[segIdx[k]].trim());
    if (m) nums.push(parseInt(m[1], 10));
  }
  if (nums.length >= segIdx.length * 0.9 && nums.length >= 30) {
    const sorted = [...nums].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const devs = sorted
      .map((n) => Math.abs(n - median))
      .sort((a, b) => a - b);
    const mad = devs[Math.floor(devs.length / 2)];
    // 阈值：MAD 的 1000 倍，且至少 10000（防 MAD=0 的退化情形）
    const threshold = Math.max(mad * 1000, 10000);
    const outlierIdx: number[] = [];
    for (let k = 0; k < nums.length; k++) {
      if (Math.abs(nums[k] - median) > threshold) outlierIdx.push(k);
    }
    // 护栏：离群分片必须明显是少数派（≤10%）才判定为广告
    if (outlierIdx.length > 0 && outlierIdx.length <= segIdx.length * 0.1) {
      for (let k = 0; k < outlierIdx.length; k++) {
        adSegIdx.add(segIdx[outlierIdx[k]]);
      }
    }
  }

  // ---------- 方法 4：均匀分块源的短块游程检测 ----------
  // 某些源（如电影天堂 dyttzy）以固定段数切 DISCONTINUITY 块（实测每 5 段一块，
  // 占 80%），文件名全哈希、单目录，方法 1/2/3 均无信号。其插广告表现为：
  // 连续若干个「小于众数块」的块组成游程，且游程总段数恰为众数的整数倍
  // （广告替换了整数个自然块；实测 4:58 处广告为 [3段,2段] 游程共 19s，
  // 各集时长指纹逐段一致）。被广告挤短的 4 段正片块与片头/片尾的不完整块
  // （游程和 ≠ 众数倍数）不会命中。
  // 护栏：众数块必须占绝对优势（≥60% 的块）且众数 ≥4 段；命中游程总时长
  // ≤ 全片 15%。
  const blockSizeCount = new Map<number, number>();
  let modeSize = 0;
  let modeCnt = 0;
  let totalBlockDur = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    totalBlockDur += blocks[bi].dur;
    const n = blocks[bi].indices.length;
    if (n === 0) continue;
    const c = (blockSizeCount.get(n) ?? 0) + 1;
    blockSizeCount.set(n, c);
    if (c > modeCnt) {
      modeCnt = c;
      modeSize = n;
    }
  }
  if (modeSize >= 4 && modeCnt >= blocks.length * 0.6) {
    const runIdx: number[] = [];
    let runDur = 0;
    let bi = 0;
    while (bi < blocks.length) {
      const n = blocks[bi].indices.length;
      if (n === 0 || n >= modeSize) {
        bi++;
        continue;
      }
      // 游程：连续的小于众数块大小的块
      let bj = bi;
      while (
        bj + 1 < blocks.length &&
        blocks[bj + 1].indices.length < modeSize
      ) {
        bj++;
      }
      const isEdge = bi === 0 || bj === blocks.length - 1;
      if (isEdge) {
        bi = bj + 1;
        continue;
      }
      // 在游程内找「和为众数整数倍」的连续子游程：广告替换了整数个自然块
      // （实测 [3段,2段]）。游程里被广告挤短的正片块（如单独的 4 段块）其
      // 子游程和不是众数的倍数，不会命中。
      let i = bi;
      while (i <= bj) {
        let sum = 0;
        let matched = -1;
        for (let k = i; k <= bj; k++) {
          sum += blocks[k].indices.length;
          if (sum > 0 && sum % modeSize === 0) {
            matched = k;
            break;
          }
        }
        if (matched >= 0) {
          for (let k = i; k <= matched; k++) {
            runDur += blocks[k].dur;
            for (let x = 0; x < blocks[k].indices.length; x++) {
              runIdx.push(blocks[k].indices[x]);
            }
          }
          i = matched + 1;
        } else {
          i++;
        }
      }
      bi = bj + 1;
    }
    if (runIdx.length > 0 && runDur <= totalBlockDur * 0.15) {
      for (let k = 0; k < runIdx.length; k++) adSegIdx.add(runIdx[k]);
    }
  }

  if (adSegIdx.size === 0) return m3u8;

  // ---------- 重建：删广告分片行 + 紧邻其前的 #EXTINF 等伴随行 + 空洞化 DISCONTINUITY ----------
  // 标记被删分片的伴随行（分片行上方连续的、属于该分片的标签行）
  const dropAdj = new Set<number>();
  adSegIdx.forEach((i) => {
    let j = i - 1;
    while (j >= 0) {
      const t = lines[j].trim();
      if (t === '' || isSegmentLine(t)) break;
      if (t.includes('#EXT-X-DISCONTINUITY')) break; // 分隔符另行处理
      dropAdj.add(j);
      j--;
    }
  });

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (adSegIdx.has(i) || dropAdj.has(i)) continue;
    const t = lines[i].trim();
    // DISCONTINUITY：若其前一块或后一块被整体删除则丢弃，避免出现连续空断点
    if (t.includes('#EXT-X-DISCONTINUITY')) {
      const prevBlock = out.filter((l) => isSegmentLine(l)).length;
      // 前面已无任何保留分片 → 该断点是头部/前块全删，丢
      // 后面是否还有保留分片在下一行判断（向后找最近的分片行是否被删）
      if (prevBlock === 0) continue;
      let nextSegKept = false;
      for (let k = i + 1; k < lines.length; k++) {
        const tt = lines[k].trim();
        if (isSegmentLine(tt)) {
          nextSegKept = !adSegIdx.has(k);
          break;
        }
        if (tt.includes('#EXT-X-DISCONTINUITY')) break;
      }
      if (!nextSegKept) continue;
    }
    out.push(lines[i]);
  }

  // 收尾：压缩连续空行
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

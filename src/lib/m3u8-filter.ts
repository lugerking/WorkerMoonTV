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
 * 两种方法都远低于误杀阈值，宁可漏放也不误删正片。
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
  if (majority >= MAJORITY_MIN_SEGMENTS && dirCount.size > 1) {
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

  if (adDirs.size > 0) {
    for (let k = 0; k < segIdx.length; k++) {
      if (adDirs.has(dirFingerprint(lines[segIdx[k]].trim()))) {
        adSegIdx.add(segIdx[k]);
      }
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

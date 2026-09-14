// === 沉寂期活动摘要（wake digest）===
//
// 目的：替换「从整条时间线捞全部特殊事件」的旧注入逻辑。
//
// 旧逻辑三个问题：
//   ① oldTimeline.filter(isSpecialEvent) 无时间窗、无条数上限 → 无限膨胀、稀释用户正文
//   ② 无时间戳的旧记录定位失败 → llmMessages.push() 堆到队尾（排在用户最新发言之后）
//      → 畸形对话（以 assistant 结尾），可能导致上游 500 错误
//   ③ contactUser 推送写的是 wake_session，不进时间线 → 推送记录永远不被注入（记忆断链）
//
// 新逻辑：注入源换成 current_wake_session.json。该文件天生只含「本轮沉寂期活动」，
// 用户一发新消息就清空，正是正确的时间窗，且所有活动都写它 → ③ 自动修好。
//
// 生命周期（重要设计决策）：
//   不是「只取最后 N 条活动」，而是「把本次沉寂期的全部活动总结成一块，
//   注入接下来 N 轮对话，之后停止注入」。
//   理由：那几轮会就沉寂期活动交流、写进记忆库，之后天然成为
//   上下文和外置记忆的一部分，可随时调用，不需要一直注入。
//
// 摘要用机械拼装，不调模型总结：
//   wake_session 里存的本来就是 AI 自己写的第一人称句子，重写会掉味道；
//   且机械拼装不可能虚构。
// 时间用相对时间（「12 分钟前」）而非绝对时间戳：避免时区混乱。

const fs = require("fs-extra");

const WAKE_SESSION_FILE = "current_wake_session.json";
const PENDING_DIGEST_FILE = "pending_wake_digest.json";

const MAX_BULLETS = 8;       // 最多列几条活动（更早的折成一句「还有 N 次」）
const MAX_BULLET_CHARS = 160; // 每条正文截断长度
const MAX_DIGEST_CHARS = 2000; // 整段摘要硬上限

// ---- 分类：wake_session 里实际存在的几种记录形态 ----
// 你可以根据自己的活动类型自定义这些标记
// 示例格式：
// 游戏  `[游戏记录]（2026/8/5 14:17:47 AI 自己去玩了会儿游戏）\n（玩了8步：…）\n正文`
// 论坛  `[论坛记录]（2026/8/5 14:28:24 AI 去逛了会儿论坛）\n（做了4步：…）\n正文`
// 推送  `（2026/8/5 16:23 刚刚给用户发了推送：标题｜正文）`
// 其他  `（… 自动唤醒：本次未操作）` / `（… 自动唤醒：正文）` / `（… 推送失败 …）`
function classify(content) {
  const c = String(content || "");
  if (c.includes("[游戏记录]")) return "game";
  if (c.includes("[论坛记录]")) return "forum";
  if (c.includes("推送失败")) return "pushFailed";
  if (c.includes("给用户发了推送") || c.includes("给用户发了 Bark")) return "push";
  if (c.includes("本次未操作")) return "noAction";
  return "other";
}

const LABELS = {
  game: "玩游戏",
  forum: "逛论坛",
  push: "给你发推送",
  pushFailed: "想给你发推送但失败了",
  noAction: "什么都没做",
  other: "自己待着",
};

// 安全截断：不把 emoji / 代理对劈成两半（劈开会渲染成 �）。
function safeSlice(s, n) {
  if (s.length <= n) return s;
  let cut = n;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;   // 末位是高位代理，往回退一格
  return s.slice(0, cut);
}

// 智能截断：优先切在句末标点处，避免把句子劈成半句。
function smartTruncate(s, max) {
  if (s.length <= max) return s;
  const head = safeSlice(s, max);
  // 在后 40% 区间里找最靠后的句末标点，找到就切在那儿
  const minKeep = Math.floor(max * 0.6);
  let best = -1;
  for (const p of ["。", "！", "？", "…", """, "」", "；", ".", "!", "?"]) {
    const i = head.lastIndexOf(p);
    if (i >= minKeep && i > best) best = i;
  }
  if (best !== -1) return head.slice(0, best + 1);
  // 没有句末标点就退一步找逗号顿号
  for (const p of ["，", "、", ","]) {
    const i = head.lastIndexOf(p);
    if (i >= minKeep && i > best) best = i;
  }
  if (best !== -1) return head.slice(0, best + 1) + "…";
  return head + "…";
}

// 剥掉机器抬头（时间戳行、步骤行、标记），只留 AI 自己写的正文。
function extractBody(content, kind) {
  let c = String(content || "").replace(/\r/g, "");

  if (kind === "game" || kind === "forum") {
    c = c.replace(/\[游戏记录\]|\[论坛记录\]/g, "");
    // 首行「（时间戳 AI 自己去玩了会儿游戏）」——不含内嵌换行，单行剥掉。
    c = c.replace(/^\s*（[^）\n]*）\s*\n?/, "");
    // 步骤块「（玩了N步：… ）」/「（做了N步：… ）」：
    // 命令里可能带多行内容，所以必须整块匹配到收尾的「）」
    c = c.replace(/^\s*（(?:玩了|做了)\d+步：[\s\S]*?）\s*\n?/, "");
  } else {
    // 外层包了一对全角括号，且开头是时间戳 + 事由；取冒号后的内容
    c = c.replace(/^\s*（/, "").replace(/）\s*$/, "");
    const m = c.match(/(?:推送|自动唤醒)[：:]\s*([\s\S]*)$/);
    if (m) c = m[1];
    else c = c.replace(/^\s*\S*\d{1,2}[:：]\d{2}(?::\d{2})?\s*/, "");
    c = c.replace(/｜/g, "：");
  }

  // 压平换行、压掉分隔线和多余空白
  c = c.replace(/^\s*-{2,}\s*$/gm, " ")
       .split("\n").map(s => s.trim()).filter(Boolean).join(" ")
       .replace(/\s{2,}/g, " ")
       .trim();

  return smartTruncate(c, MAX_BULLET_CHARS);
}

// 相对时间：「刚刚」/「12 分钟前」/「1 小时 12 分前」
function relTime(fromMs, nowMs) {
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) return "";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} 小时前` : `${h} 小时 ${m} 分前`;
}

// 时长：「1 小时 12 分」
function durText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "不到 1 分钟";
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/**
 * 把一段 wake_session 机械拼装成注入用的摘要文本。
 * @param {Array<{timestamp:string, content:string}>} session
 * @param {{now?:Date, prevUserAt?:string|null, aiName?:string, userName?:string}} opts
 * @returns {string|null} 摘要文本；session 为空则返回 null
 */
function buildWakeDigest(session, opts = {}) {
  if (!Array.isArray(session) || session.length === 0) return null;
  const nowMs = (opts.now instanceof Date ? opts.now : new Date()).getTime();
  const aiName = opts.aiName || "AI";
  const userName = opts.userName || "你";

  const items = session
    .map(e => {
      const kind = classify(e.content);
      const t = Date.parse(e.timestamp);
      return {
        kind,
        atMs: Number.isFinite(t) ? t : null,
        body: extractBody(e.content, kind),
      };
    })
    // 「什么都没做」不值得占一行，但要参与计数
    .filter(it => it.kind !== "noAction");

  const realCount = items.length;
  if (realCount === 0) {
    // 整个沉寂期只有「未操作」——不注入，省得占上下文
    return null;
  }

  // 头部：沉寂时长 + 活动次数（按类型分布）
  const parts = [];
  const prevMs = opts.prevUserAt ? Date.parse(opts.prevUserAt) : NaN;
  if (Number.isFinite(prevMs)) {
    const d = durText(nowMs - prevMs);
    if (d) parts.push(`距${userName}上次说话 ${d}`);
  }

  const tally = {};
  for (const it of items) tally[it.kind] = (tally[it.kind] || 0) + 1;
  // 固定顺序，不跟随事件发生顺序 —— 否则头部统计的排列会和倒序的正文对不上
  const TALLY_ORDER = ["game", "forum", "push", "pushFailed", "other"];
  const tallyText = TALLY_ORDER.filter(k => tally[k])
    .map(k => `${LABELS[k]} ${tally[k]} 次`)
    .join("、");
  // 只有 1 次活动时「活动了 1 次：玩游戏 1 次」啰嗦，正文自己会说明
  parts.push(realCount === 1 ? `这段时间${aiName}自己活动了 1 次` : `这段时间${aiName}自己活动了 ${realCount} 次：${tallyText}`);

  let head = `（后台记录：${parts.join("。")}。`;

  // 正文：最近的排前面，最多 MAX_BULLETS 条
  const recent = items.slice(-MAX_BULLETS).reverse();
  const omitted = realCount - recent.length;

  const bullets = recent.map(it => {
    const when = it.atMs ? relTime(it.atMs, nowMs) : "";
    const label = LABELS[it.kind] || it.kind;
    const prefix = when ? `· ${when} ${label}` : `· ${label}`;
    return it.body ? `${prefix}：${it.body}` : prefix;
  });
  if (omitted > 0) bullets.push(`· 更早还有 ${omitted} 次，不细说了`);

  let out = `${head}\n${bullets.join("\n")}\n以上是${aiName}自己做的事，本消息只在这一轮出现。如果觉得和当前对话相关、或者想和${userName}分享，需要在本回合就提及，因为下轮对话你就看不到这条了。可以自然地插入话题，不用打断${userName}正在说的事。如果${userName}正在说重要的事或情绪需要回应，优先回应${userName}；如果是日常闲聊或你觉得自己的活动值得分享，可以自然提一句。）`;
  if (out.length > MAX_DIGEST_CHARS) out = out.slice(0, MAX_DIGEST_CHARS - 2) + "…）";
  return out;
}

/**
 * 沉寂期结束时把 wake_session 快照成待注入摘要。
 * 在清空 wake_session 之前调用。
 * @param {Array|null} cwdSession - wake_session 数组，或 null（自动读文件）
 * @param {object} opts - 选项 { now, prevUserAt, aiName, userName }
 * @returns {boolean} 是否真的创建了摘要
 */
function captureDigest(cwdSession, opts = {}) {
  const turns = Number(process.env.WAKE_DIGEST_TURNS);
  const totalTurns = Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 5;

  let session = cwdSession;
  if (!Array.isArray(session)) {
    try { session = fs.readJsonSync(WAKE_SESSION_FILE); } catch { session = []; }
  }
  const digest = buildWakeDigest(session, opts);
  if (!digest) return false;

  try {
    fs.writeJsonSync(PENDING_DIGEST_FILE, {
      digest,
      remaining: totalTurns,
      total: totalTurns,
      createdAt: new Date().toISOString(),
      // 触发它的那条用户消息指纹；用于「同一轮重试不重复扣轮次」
      lastInjectedFp: null,
    }, { spaces: 2 });
    console.log(`[wake-digest] 已快照沉寂期摘要（${digest.length} 字，注入 ${totalTurns} 轮）`);
    return true;
  } catch (e) {
    console.error("[wake-digest] 写 pending digest 失败:", e.message);
    return false;
  }
}

/**
 * 取出本轮该注入的摘要，并推进生命周期。
 * 同一条用户消息重试（指纹不变）只返回摘要、不扣轮次，避免客户端的辅助请求
 * （标题生成等）白烧注入轮数。
 * @param {string|null} currentUserFp 本次请求最后一条真实用户消息的指纹
 * @returns {string|null} 要注入的摘要文本
 */
function consumeDigest(currentUserFp) {
  let rec = null;
  try {
    if (!fs.existsSync(PENDING_DIGEST_FILE)) return null;
    rec = fs.readJsonSync(PENDING_DIGEST_FILE);
  } catch { return null; }
  if (!rec || !rec.digest) return null;

  // 同一轮重试：原样返回，不扣
  if (currentUserFp && rec.lastInjectedFp === currentUserFp) {
    return rec.digest;
  }

  const remaining = Number(rec.remaining);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    try { fs.removeSync(PENDING_DIGEST_FILE); } catch {}
    console.log("[wake-digest] 注入轮次用尽，已停止注入并删除摘要");
    return null;
  }

  const left = remaining - 1;
  try {
    fs.writeJsonSync(PENDING_DIGEST_FILE, {
      ...rec, remaining: left, lastInjectedFp: currentUserFp || null,
    }, { spaces: 2 });
  } catch (e) {
    console.error("[wake-digest] 更新 pending digest 失败:", e.message);
  }
  console.log(`[wake-digest] 注入摘要（本轮后还剩 ${left} 轮）`);
  return rec.digest;
}

module.exports = {
  WAKE_SESSION_FILE, PENDING_DIGEST_FILE,
  buildWakeDigest, captureDigest, consumeDigest,
  _internal: { classify, extractBody, relTime, durText },
};

// ---- 自测入口：拿真实 wake_history 跑一遍，只打印，不写任何文件 ----
// 用法：node wake_digest.js --selftest [wake_history/wake_example.json]
if (require.main === module && process.argv.includes("--selftest")) {
  const file = process.argv.find(a => a.endsWith(".json")) || "wake_history/wake_example.json";
  const data = JSON.parse(require("fs").readFileSync(file, "utf8"));
  console.log(`[selftest] 数据源 ${file}，共 ${data.length} 条\n`);

  console.log("=== 分类结果 ===");
  for (const e of data) console.log(` ${classify(e.content).padEnd(11)} ${e.timestamp}`);

  // 用最后一条记录的时间当「现在」，模拟沉寂期刚结束
  const lastMs = Date.parse(data[data.length - 1].timestamp);
  const now = new Date(lastMs + 3 * 60000);
  const prevUserAt = new Date(Date.parse(data[0].timestamp) - 20 * 60000).toISOString();

  console.log("\n=== 全量（模拟一个超长沉寂期）===");
  console.log(buildWakeDigest(data, { now, prevUserAt }));

  console.log("\n=== 典型：最后 3 条 ===");
  console.log(buildWakeDigest(data.slice(-3), { now, prevUserAt: new Date(lastMs - 72 * 60000).toISOString() }));

  console.log("\n=== 边界：空 ===");
  console.log(buildWakeDigest([], { now }));
  console.log("=== 边界：只有未操作 ===");
  console.log(buildWakeDigest([{ timestamp: now.toISOString(), content: "（2026/8/5 17:00 自动唤醒：本次未操作）" }], { now }));
  console.log("=== 边界：无 prevUserAt ===");
  console.log(buildWakeDigest(data.slice(-2), { now }));
}

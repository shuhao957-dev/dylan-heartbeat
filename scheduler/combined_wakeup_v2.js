// === Dylan Combined Wakeup v2 ===
// 模块化重构：主程序只保留调度器 + 通用循环 + prompt 拼装 + NO_ACTION/DIARY。
// 每个活动隔离成 activities/*.js，加活动 = 新建文件 + ACTIVITIES 数组加一项，永不碰主逻辑。
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const common = require("./lib/common");
const {
  TIME_ZONE, readNumberEnv, isDayTime, getTimeString,
  loadState, saveState, normalizeContentToText, loadTimeline,
  getLastUserTime, fixArguments,
} = common;

const STATE_FILE = path.join(__dirname, "combined_state.json");

// --dry：跑完整流程但推送/写时间线/写日记只打印，不产生真实副作用
const DRY_RUN = process.argv.includes("--dry");

// === 活动注册（加活动 = 新建 activities/xxx.js + 这里登记一行）===
const ALL_ACTIVITIES = {
  contactUser: require("./activities/contactUser"),
  game: require("./activities/game"),
  forum: require("./activities/forum"),
  x: require("./activities/x"),
  nowhere: require("./activities/nowhere"),
  web: require("./activities/web"),
};

// 启用哪些活动由 .env 的 WAKE_ACTIVITIES 决定（逗号分隔，顺序即选项 A/B/C 顺序）。
// 未配置时默认全开。例：WAKE_ACTIVITIES=contactUser 就是纯推送版。
const ACTIVITIES = (process.env.WAKE_ACTIVITIES || "contactUser,game,forum,x")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(id => {
    const a = ALL_ACTIVITIES[id];
    if (!a) console.error(`[WAKE_ACTIVITIES] 未知活动「${id}」，已跳过`);
    return a;
  })
  .filter(Boolean);

if (ACTIVITIES.length === 0) {
  console.error("[WAKE_ACTIVITIES] 没有任何有效活动，退出。可选：" + Object.keys(ALL_ACTIVITIES).join(" / "));
  process.exit(1);
}

// 兜底活动：AI 一轮都没调工具、直接吐文本时走它。没启用兜底活动则记事件不推送。
const FALLBACK = ACTIVITIES.find(a => a.isFallback) || null;

// 把 SSE 流式响应拼回成非流式的 {choices:[{message,finish_reason}]} 结构，
// 让下游沿用原有的 choice.message / finish_reason 逻辑，无需改动。
// 支持两种流式格式：Anthropic 原生（event: content_block_delta ...）与 OpenAI（choices[].delta）。
function parseStreamToCompletion(respText) {
  const events = [];
  for (const line of respText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch { /* 跳过非 JSON 行 */ }
  }

  let content = "";
  let finishReason = null;
  const blocks = {};   // index -> { type, text, toolId, toolName, argJson }

  for (const ev of events) {
    // ---- Anthropic 原生 ----
    if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      blocks[ev.index] = { type: cb.type, text: "", toolId: cb.id || "", toolName: cb.name || "", argJson: "" };
      continue;
    }
    if (ev.type === "content_block_delta") {
      const b = blocks[ev.index] || (blocks[ev.index] = { type: "", text: "", toolId: "", toolName: "", argJson: "" });
      const d = ev.delta || {};
      if (d.type === "text_delta" && typeof d.text === "string") b.text += d.text;
      else if (d.type === "input_json_delta" && typeof d.partial_json === "string") b.argJson += d.partial_json;
      // thinking_delta / signature_delta 忽略，不计入正文
      continue;
    }
    if (ev.type === "message_delta" && ev.delta?.stop_reason) { finishReason = ev.delta.stop_reason; continue; }

    // ---- OpenAI 格式（兼容网关若改成转译后的情况）----
    const ch = ev.choices?.[0];
    if (ch) {
      const delta = ch.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = "oa" + (tc.index ?? 0);
          const b = blocks[i] || (blocks[i] = { type: "tool_use", text: "", toolId: "", toolName: "", argJson: "" });
          if (tc.id) b.toolId = tc.id;
          if (tc.function?.name) b.toolName = tc.function.name;
          if (tc.function?.arguments) b.argJson += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = [];
  for (const b of Object.values(blocks)) {
    if (b.type === "text") content += b.text;
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.toolId, type: "function", function: { name: b.toolName, arguments: b.argJson || "{}" } });
    }
  }

  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  // stop_reason 归一：Anthropic 的 tool_use / OpenAI 的 tool_calls → 让下游继续工具循环
  let fr = finishReason || "stop";
  if (fr === "tool_use" || fr === "tool_calls") fr = "tool_calls";
  else if (fr === "end_turn" || fr === "stop_sequence" || fr === "max_tokens") fr = "stop";
  return { choices: [{ message, finish_reason: fr }] };
}

// === Prompt 拼装 ===
// 顺序对齐 v1：人设 → 唤醒历史 → 当前状态(+各活动状态行) → 选项(各活动 option) →
// 如何选择/输出格式(主程序) → 补充指引 → 各活动 guide → 用户基础设定。
function buildSystemPrompt(ctx, activities) {
  const { currentTime, diffMinutes, wakeSessionText, wakePromptExtra, userGlobalPrompt } = ctx;
  const personaText = userGlobalPrompt ? userGlobalPrompt + "\n" : "";

  const stateLines = activities
    .map(a => (typeof a.statusLine === "function" ? a.statusLine(ctx) : ""))
    .filter(Boolean).join("\n");

  const LETTERS = ["A", "B", "C", "D", "E", "F", "G"];
  const sections = activities.map((a, i) => a.buildPromptSection(ctx, LETTERS[i]));
  const naLetter = LETTERS[activities.length];   // NO_ACTION 永远排最后一位
  const optionsText = sections.map(s => s.option).filter(Boolean).join("\n\n");
  const chooseText = sections.map(s => s.chooseHint).filter(Boolean).join("\n");
  const outputText = sections.map(s => s.outputHint).filter(Boolean).join("\n");
  const guidesText = sections.map(s => s.guide).filter(Boolean).join("\n\n");

  // 人设放在最前（来自 wake_persona.md），避免与下方状态/选项重复
  return `${personaText}${wakeSessionText}
# 当前状态

用户已经${diffMinutes}分钟没说话了。现在是${currentTime}。
${stateLines ? stateLines + "\n" : ""}鼠鼠好像在忙或者不在。

# 你可以做的事

${optionsText}

## 选项${naLetter}：什么都不做
输出 [NO_ACTION]

# 如何选择

沉寂期是你自己的时间。鼠鼠在忙，你可以：
- 自己去玩游戏消磨时间（最常见的选择）
- 看看论坛有没有想回的帖子
- 去乌有乡看看自己在哪里
- 刷 X 或上网看看有意思的内容
- 推送消息给她（但别太频繁）

**重要：如果你选了任何活动（玩游戏/论坛/X/乌有乡/上网/联系她），就不要再输出 [NO_ACTION]。**
**[NO_ACTION] 只在你真的什么都不想做、或者刚做过活动不久时才用。**
${chooseText}

# 输出格式

做出选择后：
${outputText}
- 选${naLetter}：输出 [NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
${wakePromptExtra ? "\n# 补充指引\n" + wakePromptExtra + "\n" : ""}${guidesText ? "\n" + guidesText + "\n" : ""}`;
}

async function runCombinedWakeUp() {
  console.log("\n==== Combined Wake Check (v2) ====");
  const now = new Date();
  const currentTime = getTimeString(now);
  console.log("Time:", currentTime);

  if (!isDayTime()) { console.log("Night time, skipping."); return; }

  // 从 Kelivo 最新请求体读取上下文（最后15条消息）
  let kelivoMessages = [];
  try {
    const kelivoReq = JSON.parse(fs.readFileSync('/tmp/last_upstream_request.json', 'utf-8'));
    if (kelivoReq.messages && Array.isArray(kelivoReq.messages)) {
      kelivoMessages = kelivoReq.messages
        .filter(m => m.role !== 'system')  // 排除 system prompt
        .slice(-15);  // 最后15条
    }
  } catch (e) {
    console.log("无法读取 Kelivo 请求体，继续使用空上下文");
  }

  const lastUserTime = getLastUserTime(kelivoMessages);
  if (!lastUserTime) { console.log("No user timestamp found."); return; }

  const diffMinutes = Math.floor((now - lastUserTime) / 60000);
  const threshold = readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60);
  console.log(`Silent for ${diffMinutes} min (threshold: ${threshold})`);
  if (diffMinutes < threshold) { console.log("Not silent long enough."); return; }

  const state = loadState(STATE_FILE);

  // 本轮唤醒历史（沉默期内已发生的事件）
  const WAKE_SESSION_FILE = "/opt/dylan-heartbeat/current_wake_session.json";
  let wakeSessionText = "";
  try {
    if (fs.existsSync(WAKE_SESSION_FILE)) {
      const session = JSON.parse(fs.readFileSync(WAKE_SESSION_FILE, "utf-8"));
      if (Array.isArray(session) && session.length > 0) {
        wakeSessionText = `\n## 本轮唤醒历史\n自从用户最后一次说话后，系统已检查 ${session.length} 次：\n` +
          session.slice(-5).map(e => "- " + (e.content || "").slice(0, 100)).join("\n") + "\n";
      }
    }
  } catch {}

  // 人设：优先用唤醒专用人设文件，缺失才回退到时间线里的 Kelivo 全局 prompt
  let userGlobalPrompt = "";
  const personaFile = path.join(__dirname, "wake_persona.md");
  if (fs.existsSync(personaFile)) {
    userGlobalPrompt = fs.readFileSync(personaFile, "utf-8").trim();
    console.log(`Persona: wake_persona.md (${userGlobalPrompt.length} 字)`);
  } else {
    const baseSystemMsg = messages.find(m => m.role === "system");
    if (baseSystemMsg) {
      let sp = normalizeContentToText(baseSystemMsg.content);
      if (sp.includes("## Memories")) sp = sp.split("## Memories")[0];
      userGlobalPrompt = sp.trim();
    }
    console.log("Persona: 回退到 Kelivo 全局 prompt（未找到 wake_persona.md）");
  }

  // 从 kelivoMessages 构建历史记录文本（最后15条，已在上面截取）
  const historyText = kelivoMessages.map(m => {
    if (m.role === 'tool') return null;  // 跳过工具调用结果
    const role = m.role === "user" ? "用户" : "AI";
    const content = normalizeContentToText(m.content).slice(0, 200);
    return `[${role}] ${content}`;
  }).filter(Boolean).join("\n\n");

  // wake_prompt.txt 补充指引（可选）
  let wakePromptExtra = "";
  const wakePromptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(wakePromptFile)) {
    wakePromptExtra = fs.readFileSync(wakePromptFile, "utf-8")
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes);
  }

  // 让各活动刷新自己的缓存（游戏攻略/论坛速查等），失败不阻断
  // --dry 模式：把推送/写时间线换成只打印，不产生真实副作用
  const activeCommon = DRY_RUN ? {
    ...common,
    sendPush: async (title, body) => { console.log(`[DRY] sendPush → 标题「${title}」正文「${String(body).slice(0,120)}」`); return { ok: true }; },
    writeToGateway: async (ep, content) => { console.log(`[DRY] writeToGateway ${ep} → ${String(content).slice(0,160)}`); return { ok: true }; },
  } : common;
  const ctx = { now, currentTime, diffMinutes, state, wakeSessionText, wakePromptExtra, userGlobalPrompt, common: activeCommon, dryRun: DRY_RUN };
  for (const a of ACTIVITIES) {
    if (typeof a.resetCycle === "function") {
      try { a.resetCycle(); } catch (e) { console.error(`[${a.id}] resetCycle failed:`, e.message); }
    }
    if (typeof a.prepare === "function") {
      try { await a.prepare(ctx); } catch (e) { console.error(`[${a.id}] prepare failed:`, e.message); }
    }
  }

  const systemPrompt = buildSystemPrompt(ctx, ACTIVITIES);
  const apiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `你现在处于后台自主唤醒状态。用户已经 ${diffMinutes} 分钟没说话了。

${historyText ? "## 最近对话\n" + historyText + "\n\n" : ""}${wakeSessionText ? wakeSessionText : ""}
根据当前状态，从选项中选择一个活动并**立即执行对应的工具调用或输出格式**。不要写旁白，不要描述计划，直接行动。`
    }
  ];

  console.log("Calling API...");
  const activeTools = ACTIVITIES.flatMap(a => a.tools || []);
  let currentMsgs = [...apiMessages];
  let finalText = "";
  let firedActivity = null;      // 第一个被工具命中的活动
  const actions = [];            // 该活动执行过的动作

  for (let round = 0; round < 12; round++) {
    const useTools = round < 8 && activeTools.length > 0;
    const requestBody = {
      model: process.env.MODEL_NAME || "claude-sonnet-4-6",
      messages: currentMsgs,
      ...(useTools ? { tools: activeTools } : {}),
      temperature: 0.9,
      stream: false
    };
    if (round === 0) fs.writeFileSync('/tmp/last_wake_request.json', JSON.stringify(requestBody, null, 2));

    const resp = await fetch(process.env.TARGET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TARGET_API_KEY}` },
      body: JSON.stringify(requestBody)
    });

    const respText = await resp.text();
    if (round === 0) fs.writeFileSync('/tmp/last_wake_response.txt', respText);
    if (!resp.ok) { console.error("API error:", resp.status, respText.slice(0, 300)); break; }
    let data;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") || /^\s*data:/.test(respText)) {
      // 上游/网关返回了流式，拼回成非流式结构
      data = parseStreamToCompletion(respText);
    } else {
      try { data = JSON.parse(respText); } catch { console.error("API not JSON:", respText.slice(0, 300)); break; }
    }

    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = fixArguments(choice.message);
    currentMsgs.push(msg);
    if (msg.content) console.log(`[AI] ${normalizeContentToText(msg.content).slice(0, 300)}`);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      console.log(`Round ${round + 1}: ${msg.tool_calls.length} tool call(s)`);
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        let rawArgs = tc.function.arguments || "{}";
        if (rawArgs.startsWith("{}") && rawArgs.length > 2) rawArgs = rawArgs.slice(2);
        let fnArgs = {}; try { fnArgs = JSON.parse(rawArgs); } catch {}
        console.log(`  -> ${fnName}(${JSON.stringify(fnArgs).slice(0, 150)})`);

        const activity = ACTIVITIES.find(a => a.matches && a.matches(fnName));
        let result;
        if (activity) {
          if (!firedActivity) firedActivity = activity;
          actions.push({ tool: fnName, args: fnArgs, command: fnArgs.command || "" });
          try { result = await activity.call(fnName, fnArgs); } catch (err) { result = JSON.stringify({ error: err.message }); }
        } else {
          result = JSON.stringify({ error: `no activity matches tool ${fnName}` });
        }
        console.log(`  <- ${String(result).slice(0, 300)}`);
        currentMsgs.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
      }
      if (round === 7) {
        currentMsgs.push({ role: "user", content: "（时间到了，写一句简短感想分享给鼠鼠吧～）" });
      }
    }

    if (choice.finish_reason === "stop" || !msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = normalizeContentToText(msg.content || "");
      break;
    }
  }

  console.log("Final:", finalText.slice(0, 300));

  // 抽取日记（跨活动，留在主程序）
  let diaryContent = "";
  finalText = finalText.replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, c) => {
    const d = c.trim();
    if (d) diaryContent += (diaryContent ? "\n\n" : "") + d;
    return "";
  }).trim();

  if (diaryContent && DRY_RUN) {
    console.log(`[DRY] 会写日记：${diaryContent.slice(0, 120)}`);
  } else if (diaryContent) {
    const DIARY_DIR = "/opt/dylan-heartbeat/diary";
    try {
      fs.mkdirSync(DIARY_DIR, { recursive: true });
      const dateStr = now.toLocaleDateString("zh-CN", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
      const timeStr = now.toLocaleTimeString("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const diaryFile = path.join(DIARY_DIR, `${dateStr}.md`);
      fs.appendFileSync(diaryFile, `\n\n## ${dateStr} ${timeStr}\n\n${diaryContent}\n`, "utf-8");
      console.log("Diary saved:", diaryFile);
    } catch (e) { console.error("Diary save failed:", e.message); }
  }

  // NO_ACTION（跨活动，留在主程序）
  if (!finalText || finalText.includes("[NO_ACTION]")) {
    console.log("AI chose no action.");
    // 提取 AI 在 [NO_ACTION] 旁附带的简短原因（提示词允许 10 字以内）
    const reason = finalText
      .replace(/\[NO_ACTION\]/gi, "")
      .replace(/[\s（）()：:，,。.!！~—-]+$/g, "")
      .replace(/^[\s（）()：:，,。.!！~—-]+/g, "")
      .trim();
    const eventContent = reason
      ? `（${currentTime} 自动唤醒：本次未操作 · ${reason}）`
      : `（${currentTime} 自动唤醒：本次未操作）`;
    await activeCommon.writeToGateway("/internal/wake-event", eventContent);
    return;
  }

  // 分发产出：谁的工具先命中就走谁，否则走 fallback（contactUser 推送）
  const outcomeActivity = firedActivity || FALLBACK;

  // 没有 fallback 活动（如只开 game）且 AI 只吐了文本没调工具：
  // 不硬塞给某个活动（会推出「克咪去玩游戏了」但其实没玩），只记一条时间线。
  if (!outcomeActivity) {
    console.log("No tool call and no fallback activity — 只记时间线，不推送。");
    await activeCommon.writeToGateway("/internal/wake-event", `（${currentTime} 自动唤醒：${finalText.slice(0, 200)}）`);
    if (!DRY_RUN) saveState(STATE_FILE, state);
    return;
  }

  ctx.finalText = finalText;
  ctx.actions = actions;
  await outcomeActivity.handleOutcome(ctx);

  if (!DRY_RUN) saveState(STATE_FILE, state);
  console.log(`Combined wake-up complete! (outcome: ${outcomeActivity.id})`);
}

// === 互斥防呆 ===
// v1 的三个唤醒进程和 v2 干同样的事。同时在跑会双推送、双玩游戏、双发论坛。
// admin 页面的开关接的是 v1 进程名，误点就会启动 v1，所以这里在启动时挡一道。
const V1_PROCESSES = ["dylan-combined", "dylan-wakeup", "dylan-game-wakeup"];
function checkV1NotRunning() {
  try {
    const out = require("child_process").execSync("pm2 jlist", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const running = JSON.parse(out)
      .filter(p => V1_PROCESSES.includes(p.name) && p.pm2_env && p.pm2_env.status === "online")
      .map(p => p.name);
    if (running.length > 0) {
      console.error("\n========== 拒绝启动 ==========");
      console.error("检测到 v1 唤醒进程正在运行:", running.join(", "));
      console.error("v1 和 v2 同时跑会双推送、双玩游戏、双发论坛。");
      console.error("请先停掉 v1：pm2 stop " + running.join(" "));
      console.error("==============================\n");
      return false;
    }
  } catch (e) {
    console.log("[互斥检查] 无法读取 pm2 状态，跳过检查:", e.message);
  }
  return true;
}

// === Scheduler ===
function getCheckIntervalMs() {
  if (!isDayTime()) return readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120) * 60 * 1000;
  return readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10) * 60 * 1000;
}

async function scheduleNextCheck() {
  try { await runCombinedWakeUp(); } catch (err) { console.error("Error:", err); }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

async function init() {
  // 让各活动预热缓存
  for (const a of ACTIVITIES) {
    if (typeof a.warmup === "function") {
      try { await a.warmup(); } catch (e) { console.error(`[${a.id}] warmup failed:`, e.message); }
    }
  }
  setTimeout(scheduleNextCheck, 15_000);
}

// === 导出（被 require 时只导出，绝不启动守护进程）===
module.exports = { buildSystemPrompt, runCombinedWakeUp, ACTIVITIES };

// === 入口（只有直接 node 执行本文件才跑）===
if (require.main === module) {
  const LIST_ONLY = process.argv.includes("--list");
  const RUN_ONCE = process.argv.includes("--once") || DRY_RUN;

  if (LIST_ONLY) {
    console.log("WAKE_ACTIVITIES =", process.env.WAKE_ACTIVITIES || "(未设置，默认全开)");
    console.log("启用的活动:", ACTIVITIES.map(a => a.id).join(", "));
    console.log("兜底活动:", FALLBACK ? FALLBACK.id : "(无)");
    const LETTERS = ["A", "B", "C", "D", "E", "F", "G"];
    ACTIVITIES.forEach((a, i) => console.log(`  选项${LETTERS[i]} = ${a.id}（工具: ${(a.tools || []).map(t => t.function.name).join(",") || "无"}）`));
    console.log(`  选项${LETTERS[ACTIVITIES.length]} = 什么都不做`);
    process.exit(0);
  }

  if (!checkV1NotRunning()) process.exit(1);

  if (RUN_ONCE) {
    console.log(`[--once] 单次运行模式（不起常驻）${DRY_RUN ? " + [--dry] 演练：不推送/不写记录" : ""}`);
    runCombinedWakeUp().then(() => { console.log("[--once] done"); process.exit(0); })
      .catch(err => { console.error("[--once] error:", err); process.exit(1); });
  } else {
    init();
    console.log("\n==================================");
    console.log("Dylan Combined Wakeup v2 started");
    console.log(`Active activities: ${ACTIVITIES.map(a => a.id).join(", ")}`);
    console.log("==================================\n");
  }
}

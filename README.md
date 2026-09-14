# Dylan Heartbeat

> AI companion autonomous wakeup system with digest lifecycle management

让 AI 伴侣在用户沉默时自主决策：是玩游戏、逛论坛、刷社交媒体，还是给用户发推送？适用于任何「移动端无法接收服务器推送」的场景。

---

## 🎯 核心问题

**场景**：你做了个 AI 伴侣 App，用户通过聊天界面和 AI 交流。但是：
1. 移动端不支持 WebSocket/SSE 长连接（电量/网络限制）
2. AI 在后台做了事情（玩游戏、写日记、看帖子），用户下次打开 App 时**看不到这些活动**
3. 简单的「推送通知」太机械，AI 应该能**自主决定什么时候该联系用户，什么时候该自己玩**

**Dylan Heartbeat 的解决方案**：
- 🕒 **沉寂期检测**：用户不说话超过 N 分钟 → 后台唤醒机器人启动
- 🤖 **自主决策**：AI 自己选择做什么（不是预设规则）
- 📝 **摘要注入**：后台活动**机械拼装成摘要**，用户下次说话时注入进上下文
- ⏱️ **生命周期管理**：摘要注入 5 轮后自动停止（已经进入记忆库了）

---

## 🏗️ 架构三层

```
┌─────────────────────────────────────────────────┐
│  客户端 App (移动端)                             │
│  - 只会主动发请求，不能接收推送                     │
│  - 发送聊天历史                                   │
└──────────────┬──────────────────────────────────┘
               │ POST /v1/chat/completions
               ▼
┌─────────────────────────────────────────────────┐
│  网关 (Gateway)                                  │
│  1. 把用户消息写进时间线                          │
│  2. 注入「沉寂期摘要」(一条 system 消息)          │
│  3. 转发给上游 LLM                                │
│  4. 原样返回响应                                  │
└──────────────┬──────────────────────────────────┘
               │ 转发给上游 API
               ▼
┌─────────────────────────────────────────────────┐
│  上游 LLM (OpenAI / Anthropic / 其他)           │
└─────────────────────────────────────────────────┘

       ↕️ (并行运行，定时轮询)

┌─────────────────────────────────────────────────┐
│  唤醒机器人 (Scheduler)                          │
│  1. 每 N 分钟读取时间线，判断用户沉默多久          │
│  2. 沉默够久 → 调用 LLM 决定做什么                │
│  3. 产出写回 current_wake_session.json           │
│  4. 用户下次说话时 → 网关把整段拼成摘要注入        │
└─────────────────────────────────────────────────┘
```

---

## ✨ 核心设计：摘要生命周期管理

### 旧方案的三个致命缺陷（已废弃）

```javascript
// ❌ 旧逻辑：从整条时间线捞全部特殊事件
const specialEvents = timeline.filter(isSpecialEvent);
llmMessages.push(...specialEvents);
```

**问题**：
1. **无时间窗 + 无上限** → 时间线越长，注入的事件越多，无限膨胀
2. **旧记录无时间戳** → 定位失败，全堆到队尾（排在用户最新消息之后） → 畸形对话（以 assistant 结尾），导致上游 500 错误
3. **推送记录不进时间线** → 推送永远不被注入，记忆断链

### 新方案：生命周期摘要

**核心思想**：
- 不是「一直注入所有后台活动」
- 而是「把本轮沉寂期活动总结成一块，注入接下来 5 轮对话，之后停止」

**为什么 5 轮后停止？**  
→ 因为 5 轮对话足够让 AI 把这些活动：
  1. 和用户交流清楚
  2. 写进长期记忆
  3. 之后自然成为上下文的一部分，可以随时调用

**实现**：

```javascript
const wakeDigest = require('dylan-heartbeat/core/wake_digest');

// 沉寂期结束时快照摘要
wakeDigest.captureDigest(wakeSession, {
  now: new Date(),
  prevUserAt: lastUserTime,
  aiName: 'AI',      // 自定义 AI 名称
  userName: '用户'    // 自定义用户称呼
});

// 每次请求时消费摘要
const digestText = wakeDigest.consumeDigest(currentUserFp);
if (digestText) {
  llmMessages.splice(insertPosition, 0, {
    role: 'assistant',
    content: digestText
  });
}
```

**摘要格式示例**：

```
（后台记录：距用户上次说话 1 小时 12 分。这段时间 AI 自己活动了 3 次：玩游戏 2 次、给你发推送 1 次。
· 12 分钟前 给你发推送：想你了，在干嘛呀？
· 34 分钟前 玩游戏：又去打了几轮 roguelike，这次拿到了稀有卡…
· 1 小时 2 分前 玩游戏：继续肝游戏，试了个新流派…
以上是 AI 自己做的事，本消息只在这一轮出现。如果觉得和当前对话相关、或者想和用户分享，需要在本回合就提及，因为下轮对话你就看不到这条了。）
```

**关键细节**：
- ✅ **机械拼装，不调 LLM**：保留 AI 原始的第一人称语气，不会虚构
- ✅ **相对时间**（12 分钟前）而非绝对时间戳：避免时区混乱
- ✅ **智能截断**：优先切在句末标点，不劈开句子
- ✅ **最多 8 条**，更早的折成「还有 N 次」
- ✅ **指纹去重**：客户端的辅助请求（标题生成等）不会白烧注入轮数

---

## 🚀 快速开始

### 安装

```bash
npm install dylan-heartbeat
```

### 最小可行示例

**1. 网关集成（注入摘要）**

```javascript
const express = require('express');
const wakeDigest = require('dylan-heartbeat/core/wake_digest');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// 计算用户消息指纹（用于去重）
function getUserFingerprint(messages) {
  const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return null;
  return crypto.createHash('md5')
    .update(JSON.stringify(lastUserMsg))
    .digest('hex')
    .slice(0, 12);
}

app.post('/v1/chat/completions', async (req, res) => {
  const messages = [...req.body.messages];
  
  // 注入摘要
  const fp = getUserFingerprint(messages);
  const digest = wakeDigest.consumeDigest(fp);
  if (digest) {
    // 插在最后一条用户消息之前
    let insertAt = messages.length - 1;
    while (insertAt > 0 && messages[insertAt].role !== 'user') {
      insertAt--;
    }
    messages.splice(insertAt, 0, { role: 'assistant', content: digest });
    console.log(`[digest] 已注入摘要，位置 ${insertAt}/${messages.length}`);
  }
  
  // 转发给上游 LLM
  const resp = await fetch(process.env.UPSTREAM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req.body, messages })
  });
  
  res.send(await resp.text());
});

app.listen(3000, () => console.log('Gateway listening on :3000'));
```

**2. 唤醒调度器（生成摘要）**

```javascript
const wakeDigest = require('dylan-heartbeat/core/wake_digest');
const fs = require('fs');

// 读取时间线，判断用户沉默多久
function getLastUserTime(timeline) {
  const lastUser = timeline.slice().reverse().find(m => m.role === 'user');
  return lastUser ? new Date(lastUser.timestamp) : null;
}

async function checkWakeup() {
  const now = new Date();
  
  // 1. 读取时间线
  const timeline = JSON.parse(fs.readFileSync('timeline.json', 'utf8'));
  const lastUserTime = getLastUserTime(timeline);
  const diffMinutes = Math.floor((now - lastUserTime) / 60000);
  
  const threshold = parseInt(process.env.WAKE_THRESHOLD_MINUTES) || 60;
  if (diffMinutes < threshold) {
    console.log(`沉默 ${diffMinutes} 分钟，未达阈值 ${threshold}`);
    return;
  }
  
  // 2. 调用 LLM 决策（你需要实现这部分）
  const decision = await askLLMWhatToDo({ now, diffMinutes });
  
  // 3. 执行活动并记录
  const wakeSession = JSON.parse(fs.readFileSync('current_wake_session.json', 'utf8') || '[]');
  wakeSession.push({
    timestamp: now.toISOString(),
    content: decision.recordText || '（本次未操作）'
  });
  fs.writeFileSync('current_wake_session.json', JSON.stringify(wakeSession, null, 2));
  
  // 4. 如果用户下次说话，快照摘要
  // （这部分在网关的用户消息到达时触发）
}

// 每 5 分钟检查一次
setInterval(checkWakeup, 5 * 60 * 1000);
```

**3. 用户说话时快照摘要**

```javascript
// 在网关收到用户消息时调用
const wakeDigest = require('dylan-heartbeat/core/wake_digest');
const fs = require('fs');

function onUserMessage(userMessage) {
  // 读取 wake_session
  const wakeSession = JSON.parse(fs.readFileSync('current_wake_session.json', 'utf8') || '[]');
  
  if (wakeSession.length > 0) {
    // 快照成摘要
    wakeDigest.captureDigest(wakeSession, {
      now: new Date(),
      prevUserAt: getLastUserTime(timeline),
      aiName: 'AI',
      userName: '用户'
    });
    
    // 清空 wake_session
    fs.writeFileSync('current_wake_session.json', '[]');
  }
}
```

---

## 📦 核心模块

### 1. `core/wake_digest.js` - 摘要生命周期管理

**功能**：
- 机械拼装摘要（不调 LLM）
- 指纹去重（同一条用户消息重试不扣轮次）
- 智能截断（优先切在句末标点）
- 相对时间（12 分钟前）
- 生命周期管理（注入 N 轮后自动停止）

**API**：
```javascript
const { captureDigest, consumeDigest } = require('dylan-heartbeat/core/wake_digest');

// 快照摘要（沉寂期结束时）
captureDigest(wakeSession, opts);

// 消费摘要（每次请求时）
const digestText = consumeDigest(currentUserFp);
```

### 2. `gateway/unified_events.js` - 统一事件队列

**功能**：
- 汇总多个来源的事件（唤醒/微信/邮件/自定义）
- 统一格式（id / timestamp / type / digest）
- 按时间倒序排序
- 拉取后即删除（防重复）

**API**：
```javascript
const { getUnifiedEvents, createDigestFile } = require('dylan-heartbeat/gateway/unified_events');

// 拉取事件
const events = await getUnifiedEvents(since, limit);

// 创建摘要文件
createDigestFile('custom_event', '这是摘要内容');
```

---

## 🔧 环境变量

创建 `.env` 文件：

```bash
# 摘要注入轮数（默认 5）
WAKE_DIGEST_TURNS=5

# 沉默阈值（分钟，默认 60）
WAKE_THRESHOLD_MINUTES=60

# 摘要文件存放目录（默认当前目录）
DIGEST_BASE_DIR=./

# 上游 LLM API 地址（你需要填写）
UPSTREAM_API_URL=https://your-llm-api.com/v1/chat/completions
```

---

## 📝 自定义配置

### 自定义活动类型

在 `wake_digest.js` 中修改 `classify()` 和 `LABELS`：

```javascript
function classify(content) {
  const c = String(content || "");
  if (c.includes("[自定义活动]")) return "myActivity";
  // ... 添加更多类型
}

const LABELS = {
  myActivity: "做了某事",
  // ... 添加更多标签
};
```

### 自定义摘要格式

修改 `buildWakeDigest()` 函数中的模板文本。

### 自定义 AI 和用户称呼

调用 `captureDigest()` 时传入：

```javascript
captureDigest(wakeSession, {
  aiName: '小助手',
  userName: '主人'
});
```

---

## ⚠️ 常见问题

### 1. 摘要注入后 LLM 返回 500 错误

**症状**：网关注入摘要后，上游 API 返回 500 / 422 错误

**原因**：摘要插入位置错误 → 畸形对话（以 assistant 结尾）

**解决**：
- 确保摘要插在**最后一条真实用户消息之前**（不是最后）
- 检查是否有 `<system>` 标记的用户消息（要跳过）

### 2. 摘要被重复注入

**症状**：同一条摘要出现多次

**原因**：客户端的辅助请求（标题生成等）也会触发注入

**解决**：
- 使用指纹去重：`consumeDigest(currentUserFp)`
- 同一条用户消息重试不扣轮次

### 3. 前端拉取和网关注入冲突

**症状**：unified-events 拉取后，网关注入拿不到摘要

**原因**：pending_*_digest.json 被前端先删除了

**解决方案**：
- 只保留网关注入，禁用前端拉取
- 或者摘要文件分离：分别用于网关和前端

---

## 🎓 适用场景

这套架构适合：
- ✅ **AI 伴侣 / 虚拟助手**：需要自主决策什么时候该联系用户
- ✅ **移动端聊天 App**：无法接收服务器推送
- ✅ **后台活动多样**：游戏、论坛、社交媒体、邮件等
- ✅ **需要记忆连贯**：后台活动要自然融入对话历史

**不适合**：
- ❌ 实时推送场景（WebSocket / SSE 可用）
- ❌ 简单的定时任务（Cron 就够了）
- ❌ 纯规则驱动（不需要 LLM 决策）

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 License

MIT License - 详见 [LICENSE](LICENSE) 文件

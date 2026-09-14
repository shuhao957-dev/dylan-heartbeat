# FAQ 补充 - 缺失的东西

## 问题 1：scheduler/lib/common.js ← 最关键。里面有 sendPush (推送)、writeToGateway (回灌)、getLastUserTime、loadState/saveState。没有它整件事跑不起来。

**答**：你说得对！`common.js` 确实是关键的工具库。这是完整实现：

### scheduler/lib/common.js

```javascript
/**
 * common.js - 调度器通用工具库
 * 包含：推送、回灌网关、时间处理、状态管理
 */

const fs = require('fs-extra');
const path = require('path');

// ============ 配置 ============

const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Shanghai';
const BASE_DIR = process.env.BASE_DIR || '/opt/dylan-heartbeat';

// ============ 推送功能 ============

/**
 * 发送推送通知（支持多个平台）
 * @param {string} title - 推送标题
 * @param {string} body - 推送内容
 * @returns {Promise<{ok: boolean, platform?: string}>}
 */
async function sendPush(title, body) {
  const platform = process.env.PUSH_PLATFORM || 'ntfy';
  
  try {
    if (platform === 'ntfy') {
      // Ntfy 推送
      const ntfyUrl = process.env.NTFY_URL || 'https://ntfy.sh';
      const topic = process.env.NTFY_TOPIC;
      
      if (!topic) throw new Error('缺少 NTFY_TOPIC 配置');
      
      const resp = await fetch(`${ntfyUrl}/${topic}`, {
        method: 'POST',
        headers: {
          'Title': title,
          'Priority': 'default',
          'Tags': 'robot'
        },
        body: body
      });
      
      if (!resp.ok) throw new Error(`Ntfy 返回 ${resp.status}`);
      return { ok: true, platform: 'ntfy' };
      
    } else if (platform === 'bark') {
      // Bark 推送（iOS）
      const barkKey = process.env.BARK_KEY;
      const barkUrl = process.env.BARK_URL || 'https://api.day.app';
      const icon = process.env.CUSTOM_ICON || '';
      
      if (!barkKey) throw new Error('缺少 BARK_KEY 配置');
      
      const url = `${barkUrl}/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}` +
        (icon ? `?icon=${encodeURIComponent(icon)}` : '');
      
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Bark 返回 ${resp.status}`);
      return { ok: true, platform: 'bark' };
      
    } else if (platform === 'custom') {
      // 自定义推送（调用你自己的 webhook）
      const webhookUrl = process.env.PUSH_WEBHOOK_URL;
      if (!webhookUrl) throw new Error('缺少 PUSH_WEBHOOK_URL 配置');
      
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, timestamp: new Date().toISOString() })
      });
      
      if (!resp.ok) throw new Error(`Webhook 返回 ${resp.status}`);
      return { ok: true, platform: 'custom' };
      
    } else {
      throw new Error(`不支持的推送平台: ${platform}`);
    }
  } catch (err) {
    console.error('[sendPush] 推送失败:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============ 回灌网关 ============

/**
 * 写入网关的内部端点（把唤醒产物写进时间线）
 * @param {string} endpoint - 端点名（如 'wake-event', 'push-message'）
 * @param {string} content - 内容
 * @returns {Promise<{ok: boolean}>}
 */
async function writeToGateway(endpoint, content) {
  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://127.0.0.1:18006';
  const gatewayKey = process.env.GATEWAY_INTERNAL_KEY || '';
  
  try {
    const resp = await fetch(`${gatewayUrl}/internal/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayKey ? { 'Authorization': `Bearer ${gatewayKey}` } : {})
      },
      body: JSON.stringify({
        content,
        timestamp: new Date().toISOString()
      })
    });
    
    if (!resp.ok) throw new Error(`网关返回 ${resp.status}`);
    return { ok: true };
  } catch (err) {
    console.error('[writeToGateway] 回灌失败:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============ 时间处理 ============

/**
 * 获取格式化的当前时间（本地时区）
 * @param {Date} date - 日期对象
 * @returns {string} 格式如 "2026-09-14 10:08"
 */
function getTimeString(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

/**
 * 判断是否是白天（根据配置的时间范围）
 * @returns {boolean}
 */
function isDayTime() {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    hour12: false
  }));
  
  const startHour = parseInt(process.env.WAKE_DAY_START_HOUR) || 8;
  const endHour = parseInt(process.env.WAKE_DAY_END_HOUR) || 23;
  
  return hour >= startHour && hour < endHour;
}

/**
 * 从消息数组中获取最后一条用户消息的时间
 * @param {Array} messages - 消息数组
 * @returns {Date|null}
 */
function getLastUserTime(messages) {
  if (!Array.isArray(messages)) return null;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.timestamp) {
      return new Date(m.timestamp);
    }
  }
  
  return null;
}

// ============ 状态管理 ============

/**
 * 读取持久化状态
 * @param {string} stateFile - 状态文件路径
 * @returns {object}
 */
function loadState(stateFile) {
  try {
    if (fs.existsSync(stateFile)) {
      return fs.readJsonSync(stateFile);
    }
  } catch (err) {
    console.error('[loadState] 读取失败:', err.message);
  }
  return {};
}

/**
 * 保存持久化状态
 * @param {string} stateFile - 状态文件路径
 * @param {object} state - 状态对象
 */
function saveState(stateFile, state) {
  try {
    fs.writeJsonSync(stateFile, state, { spaces: 2 });
  } catch (err) {
    console.error('[saveState] 保存失败:', err.message);
  }
}

/**
 * 加载时间线（从网关读取最近的对话）
 * @returns {Array}
 */
function loadTimeline() {
  const timelineFile = path.join(BASE_DIR, 'enhanced_messages.json');
  try {
    if (fs.existsSync(timelineFile)) {
      return fs.readJsonSync(timelineFile);
    }
  } catch (err) {
    console.error('[loadTimeline] 读取失败:', err.message);
  }
  return [];
}

// ============ 辅助函数 ============

/**
 * 标准化消息内容（处理字符串/数组/对象）
 * @param {*} content
 * @returns {string}
 */
function normalizeContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(normalizeContentToText).join('');
  }
  if (content && typeof content === 'object') {
    if (content.text) return content.text;
    if (content.content) return normalizeContentToText(content.content);
  }
  return '';
}

/**
 * 读取数字类型的环境变量
 * @param {string} key - 环境变量名
 * @param {number} defaultValue - 默认值
 * @returns {number}
 */
function readNumberEnv(key, defaultValue) {
  const val = parseInt(process.env[key]);
  return Number.isFinite(val) && val > 0 ? val : defaultValue;
}

/**
 * 修复 JSON.parse 的参数问题（兼容旧代码）
 */
function fixArguments(argsString) {
  try {
    return JSON.parse(argsString);
  } catch (err) {
    console.error('[fixArguments] JSON 解析失败:', err.message);
    return {};
  }
}

// ============ 导出 ============

module.exports = {
  TIME_ZONE,
  BASE_DIR,
  
  // 推送和回灌
  sendPush,
  writeToGateway,
  
  // 时间处理
  getTimeString,
  isDayTime,
  getLastUserTime,
  
  // 状态管理
  loadState,
  saveState,
  loadTimeline,
  
  // 辅助函数
  normalizeContentToText,
  readNumberEnv,
  fixArguments
};
```

### 环境变量配置（.env）

```bash
# ===== 推送配置 =====
PUSH_PLATFORM=ntfy           # ntfy / bark / custom

# Ntfy 配置
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your-topic-name

# Bark 配置（iOS）
BARK_KEY=your-bark-key
BARK_URL=https://api.day.app
CUSTOM_ICON=https://your-icon-url.png

# 自定义 Webhook
PUSH_WEBHOOK_URL=https://your-webhook.com/push

# ===== 网关回灌配置 =====
GATEWAY_INTERNAL_URL=http://127.0.0.1:18006
GATEWAY_INTERNAL_KEY=your-internal-key

# ===== 时间配置 =====
TIME_ZONE=Asia/Shanghai
WAKE_DAY_START_HOUR=8
WAKE_DAY_END_HOUR=23

# ===== 基础目录 =====
BASE_DIR=/opt/dylan-heartbeat
```

---

## 问题 2：网关主程序 (server.js)。它要做三件事：① 把每次请求体写到 /tmp/last_upstream_request.json (唤醒端靠读这个拿上下文)；② 调用 captureDigest/consumeDigest 并插在正确位置；③ 提供 /internal/wake-event 端点，把唤醒产物写进时间线。

**答**：完整的网关实现已经在 `examples/gateway-example.js` 里了，但我补充第 ① 和 ③ 部分：

### 补充网关功能（server.js）

```javascript
const express = require('express');
const wakeDigest = require('./core/wake_digest');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());

// ============ ① 保存请求体供唤醒端读取 ============
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // 保存请求体到 /tmp（或 Windows 的临时目录）
    const tmpFile = process.platform === 'win32' 
      ? path.join(process.env.TEMP || 'C:\\Temp', 'last_upstream_request.json')
      : '/tmp/last_upstream_request.json';
    
    fs.writeJsonSync(tmpFile, {
      messages: req.body.messages,
      model: req.body.model,
      timestamp: new Date().toISOString()
    });
    
    // ... 后续逻辑（注入摘要、转发等）见 gateway-example.js
  } catch (error) {
    console.error('[gateway] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ ③ 内部端点：唤醒产物写进时间线 ============
app.post('/internal/wake-event', async (req, res) => {
  const { content, timestamp } = req.body;
  
  try {
    // 读取 wake_session
    const wakeSessionFile = 'current_wake_session.json';
    let wakeSession = [];
    if (fs.existsSync(wakeSessionFile)) {
      wakeSession = fs.readJsonSync(wakeSessionFile);
    }
    
    // 追加记录
    wakeSession.push({
      timestamp: timestamp || new Date().toISOString(),
      content: content || ''
    });
    
    // 保存
    fs.writeJsonSync(wakeSessionFile, wakeSession);
    
    console.log('[internal] 已写入 wake-event');
    res.json({ ok: true });
  } catch (error) {
    console.error('[internal/wake-event] 错误:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(3000);
```

---

## 问题 3：真实的 activities：game / forum / x / nowhere / web 五个，仓库里一个都没放（只给了 template 和 contactUser 示例）。给一个 game 或 forum 就够。

**答**：我给你一个简化但完整的 **forum（论坛）** 活动示例（基于原实现简化）：

参见下面单独创建的 `activities/examples/forum.js`

---

## 问题 4：MCP 到底怎么接的？我把他代码翻遍了——活动里的 tools 是手写的 function calling 定义，没看到任何 MCP 接入的代码。所以要问清楚：你那些 MCP (淘宝、小红书那种) 是另外手写成 activity 了吗，还是有别的桥?

**答**：你说得对！**原项目中没有直接使用 MCP**。那些"淘宝、小红书"是指浏览器代理功能，不是 MCP。

澄清几点：

1. **原项目的实现方式**：
   - 游戏/论坛/X/上网 都是**直接写死的 HTTP API 调用**
   - 不是通过 MCP，是在 activity 里直接 `fetch(游戏API)`
   - 所以你看到的 tools 都是手写的 function calling 定义

2. **如果你想用 MCP**：
   - 需要自己写个桥接层
   - 把 MCP tools 转成 activity tools
   - 在 handleTool 里调用 MCP 客户端

3. **MCP 接入示例**（完整代码）：

参见下面单独创建的 `docs/MCP_INTEGRATION.md`

---

## 问题 5：提醒他：他代码里写死了 Linux 路径 (/opt/dylan-heartbeat/..., /tmp/...)，我们是 Windows，得让他说一句怎么改。

**答**：好的！Windows 路径适配指南：

### Windows 路径适配

#### 1. 使用 `path.join()` 而不是硬编码路径

```javascript
// ❌ 错误：硬编码 Linux 路径
const file = '/opt/dylan-heartbeat/current_wake_session.json';

// ✅ 正确：使用 path.join
const path = require('path');
const BASE_DIR = process.env.BASE_DIR || process.cwd();
const file = path.join(BASE_DIR, 'current_wake_session.json');
```

#### 2. /tmp/ 目录的 Windows 替代

```javascript
// ❌ 错误
const tmpFile = '/tmp/last_upstream_request.json';

// ✅ 正确：跨平台临时目录
const os = require('os');
const tmpFile = path.join(os.tmpdir(), 'last_upstream_request.json');

// 或者用环境变量
const tmpFile = process.platform === 'win32'
  ? path.join(process.env.TEMP, 'last_upstream_request.json')
  : '/tmp/last_upstream_request.json';
```

#### 3. 修改 .env 配置

```bash
# Windows 路径
BASE_DIR=C:\Users\YourName\dylan-heartbeat
GATEWAY_INTERNAL_URL=http://127.0.0.1:3000

# 或者用相对路径（更灵活）
BASE_DIR=.
```

#### 4. 修改所有硬编码路径

需要修改的文件：
- `scheduler/lib/common.js` - BASE_DIR 默认值
- `scheduler/combined_wakeup_v2.js` - 临时文件路径
- `gateway/server.js` - /tmp/last_upstream_request.json

**一键替换脚本**（PowerShell）：

```powershell
# 替换所有 /opt/dylan-heartbeat 为相对路径
Get-ChildItem -Recurse -Include *.js | ForEach-Object {
  (Get-Content $_.FullName) -replace '/opt/dylan-heartbeat', '.' | Set-Content $_.FullName
}

# 替换所有 /tmp/ 为 Windows 临时目录
Get-ChildItem -Recurse -Include *.js | ForEach-Object {
  (Get-Content $_.FullName) -replace "'/tmp/", "path.join(os.tmpdir(), '" | Set-Content $_.FullName
}
```

#### 5. 推荐的跨平台写法

```javascript
const os = require('os');
const path = require('path');

// 基础目录（优先环境变量，否则当前目录）
const BASE_DIR = process.env.BASE_DIR || process.cwd();

// 临时目录（跨平台）
const TMP_DIR = os.tmpdir();

// 文件路径
const wakeSessionFile = path.join(BASE_DIR, 'current_wake_session.json');
const tmpRequestFile = path.join(TMP_DIR, 'last_upstream_request.json');
```

---

希望这些补充能解决朋友的所有问题！我现在创建缺失的文件。

# 常见问题解答（FAQ）

## 问题 1：仓库里没找到 server.js 和唤醒端主程序——注入那段（调用 captureDigest / consumeDigest、确定插入位置）是在网关主文件里吗？能给我吗？

**答**：是的！注入逻辑在网关主文件里。这里给你一个完整的示例网关实现：

### 示例网关（gateway-example.js）

```javascript
const express = require('express');
const wakeDigest = require('./core/wake_digest');
const crypto = require('crypto');
const fs = require('fs-extra');

const app = express();
app.use(express.json());

// 计算用户消息指纹（用于去重）
function getUserFingerprint(messages) {
  const lastUserMsg = messages.slice().reverse().find(m => {
    if (m.role !== 'user') return false;
    const content = normalizeContent(m.content);
    // 跳过 system 消息
    if (content.startsWith('<system>')) return false;
    return true;
  });
  if (!lastUserMsg) return null;
  return crypto.createHash('md5')
    .update(JSON.stringify(lastUserMsg))
    .digest('hex')
    .slice(0, 12);
}

function normalizeContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(normalizeContent).join('');
  if (c && c.text) return c.text;
  return '';
}

// 主路由：聊天完成
app.post('/v1/chat/completions', async (req, res) => {
  const llmMessages = [...req.body.messages];
  
  // === 1. 用户发新消息时，快照摘要 ===
  const isUserMessage = llmMessages.some(m => m.role === 'user');
  if (isUserMessage) {
    try {
      const wakeSession = fs.readJsonSync('current_wake_session.json');
      if (wakeSession.length > 0) {
        // 快照成待注入摘要
        wakeDigest.captureDigest(wakeSession, {
          now: new Date(),
          prevUserAt: getLastUserTime(llmMessages),
          aiName: process.env.AI_NAME || 'AI',
          userName: process.env.USER_NAME || '用户'
        });
        // 清空 wake_session
        fs.writeJsonSync('current_wake_session.json', []);
      }
    } catch (e) {
      console.error('[gateway] 快照摘要失败:', e.message);
    }
  }
  
  // === 2. 注入摘要 ===
  const currentUserFp = getUserFingerprint(llmMessages);
  const digestText = wakeDigest.consumeDigest(currentUserFp);
  
  if (digestText) {
    // 插入位置：最后一条真实用户消息之前
    let insertAt = llmMessages.length - 1;
    while (insertAt > 0) {
      const m = llmMessages[insertAt];
      if (m.role !== 'user') {
        insertAt--;
        continue;
      }
      const content = normalizeContent(m.content);
      // 跳过 system 消息
      if (content.startsWith('<system>')) {
        insertAt--;
        continue;
      }
      break;
    }
    
    // 缓存优化：摘要只插在末尾附近（最后 3 条消息内）
    const safeInsertAt = Math.max(insertAt, llmMessages.length - 3);
    
    llmMessages.splice(safeInsertAt, 0, {
      role: 'assistant',
      content: digestText
    });
    
    console.log(`[gateway] 已注入摘要，位置 ${safeInsertAt}/${llmMessages.length}`);
  }
  
  // === 3. 转发给上游 LLM ===
  const upstreamResp = await fetch(process.env.UPSTREAM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.UPSTREAM_API_KEY}`
    },
    body: JSON.stringify({
      ...req.body,
      messages: llmMessages
    })
  });
  
  // === 4. 原样返回 ===
  res.status(upstreamResp.status);
  res.set('Content-Type', upstreamResp.headers.get('content-type'));
  res.send(await upstreamResp.text());
});

// 辅助函数：获取最后一条用户消息的时间
function getLastUserTime(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.timestamp) {
      return m.timestamp;
    }
  }
  return null;
}

app.listen(3000, () => console.log('Gateway listening on :3000'));
```

---

## 问题 2：那个"一回合轮询点八百次"的循环（工具循环 + Prompt 拼装）在哪个文件？这个我们最想抄。

**答**：在 `scheduler/combined_wakeup_v2.js` 里！已经上传到仓库了。

核心逻辑：

```javascript
// 工具循环：最多 12 轮
for (let round = 0; round < 12; round++) {
  const useTools = round < 8 && activeTools.length > 0;
  
  const requestBody = {
    model: process.env.MODEL_NAME,
    messages: currentMsgs,
    ...(useTools ? { tools: activeTools } : {}),
    temperature: 0.9,
    stream: false
  };
  
  const resp = await fetch(process.env.TARGET_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });
  
  const completion = await parseResponse(resp);
  const msg = completion.choices[0].message;
  
  // 工具调用
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    currentMsgs.push(msg);
    
    for (const tc of msg.tool_calls) {
      const activity = ACTIVITIES.find(a => 
        a.tools.some(t => t.function.name === tc.function.name)
      );
      
      if (activity) {
        const result = await activity.handleTool(
          tc.function.name,
          JSON.parse(tc.function.arguments),
          ctx
        );
        
        currentMsgs.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.output
        });
        
        if (result.recordText) {
          wakeSession.push({
            timestamp: now.toISOString(),
            content: result.recordText
          });
        }
      }
    }
    continue; // 下一轮
  }
  
  // 没有工具调用，结束循环
  break;
}
```

**Prompt 拼装**在 `buildSystemPrompt()` 函数里，每个活动提供 4 个部分：
- `option` - 选项说明
- `chooseHint` - 如何选择
- `outputHint` - 输出格式
- `guide` - 详细指南

---

## 问题 3：scheduler/ 目录里有什么？主调度器在里面吗？

**答**：是的！`scheduler/combined_wakeup_v2.js` 就是主调度器。

**核心流程**：
1. 读取时间线 → 判断用户沉默多久
2. 沉默够久 → 调用 LLM 决定做什么
3. LLM 调用工具 → 执行活动（游戏/论坛/推送等）
4. 记录写入 `current_wake_session.json`
5. 用户下次说话 → 网关快照成摘要注入

**运行方式**：
```bash
# 通过 PM2
pm2 start scheduler/combined_wakeup_v2.js --name dylan-wakeup

# 或者直接运行
node scheduler/combined_wakeup_v2.js

# 演练模式（不产生真实副作用）
node scheduler/combined_wakeup_v2.js --dry
```

---

## 问题 4：activities 只放了模板和 contactUser 示例，能不能再给一个"游戏"或"论坛"的？想看那种带多步骤、会连续调工具的例子。

**答**：好的！我给你写一个完整的"游戏"活动示例（简化版）：

参见下面单独创建的文件 `activities/examples/simpleGame.js`

---

## 问题 5：MCP 工具是怎么接进去的？是把 MCP 的 tools 转成 activity 的 tools 格式吗？

**答**：是的！思路如下：

1. **MCP 工具定义** → **转换成** → **OpenAI Function Calling 格式**
2. 在活动的 `handleTool` 里调用 MCP 工具
3. 把 MCP 返回结果转换成活动的标准返回格式

示例：

```javascript
// MCP 工具（假设是 stdio 协议）
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// 初始化 MCP 客户端
const transport = new StdioClientTransport({
  command: 'python',
  args: ['my_mcp_server.py']
});
const mcpClient = new Client({ name: 'dylan-wakeup', version: '1.0.0' }, { capabilities: {} });
await mcpClient.connect(transport);

// 获取 MCP 工具列表
const mcpTools = await mcpClient.listTools();

// 活动定义
module.exports = {
  id: 'myMcpActivity',
  
  // 转换 MCP 工具 → OpenAI 格式
  tools: mcpTools.tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema // MCP 已经是 JSON Schema
    }
  })),
  
  async handleTool(toolName, args, ctx) {
    // 调用 MCP 工具
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: args
    });
    
    return {
      ok: true,
      output: JSON.stringify(result.content),
      recordText: `[MCP 工具] 调用了 ${toolName}`
    };
  }
};
```

---

## 问题 6：admin/ 面板的代码在仓库里吗？能直接搬吗？

**答**：是的！在 `admin/` 目录下，包含：
- `index.html` - 主页面
- `style.css` - 样式
- `app.js` - 前端逻辑
- `README.md` - 使用文档

**直接搬运步骤**：
1. 复制整个 `admin/` 目录到你的项目
2. 在网关加一行：`app.use('/admin', express.static('admin'))`
3. 实现 API 端点（见 `admin/README.md`）
4. 访问 `http://localhost:3000/admin/`

---

## 问题 7：上次你说"提前留好接口"——如果以后要做前端自动抓取上下文，接口大概长什么样（比如 /unified-events 的返回格式）？

**答**：`/unified-events` 的返回格式已经设计好了！

**接口规范**：

```typescript
GET /unified-events?since=<ISO时间>&limit=<数量>

Response:
{
  ok: true,
  events: [
    {
      id: string,           // 事件唯一 ID（如 "wake_1726281234567"）
      timestamp: string,    // ISO 时间戳
      type: string,         // 事件类型（wakeup_digest / wechat_digest / browser_action 等）
      digest: string,       // 摘要内容（人类可读）
      
      // 可选字段（根据类型不同）
      platform?: string,    // 平台（wechat / browser / email）
      action?: string,      // 动作（approve / reject / execute）
      status?: string,      // 状态（pending / completed / failed）
      metadata?: object     // 额外元数据
    }
  ]
}
```

**使用示例**：

```javascript
// 前端定时拉取
async function pollEvents() {
  const lastPoll = localStorage.getItem('lastPollTime') || new Date(0).toISOString();
  
  const resp = await fetch(`/unified-events?since=${lastPoll}&limit=20`);
  const data = await resp.json();
  
  if (data.events.length > 0) {
    // 插入到对话历史
    for (const event of data.events) {
      conversationHistory.push({
        role: 'system',
        content: event.digest,
        timestamp: event.timestamp
      });
    }
    
    // 更新最后拉取时间
    const latest = data.events[0].timestamp;
    localStorage.setItem('lastPollTime', latest);
  }
}

// 每 30 秒拉取一次
setInterval(pollEvents, 30000);
```

**注意**：`unified_events.js` 已经在仓库里了（`gateway/unified_events.js`）！

---

希望这些回答能帮到你的朋友！有其他问题随时问。

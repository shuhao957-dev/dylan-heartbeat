# FastMCP 集成指南（HTTP 传输）

## FastMCP 是什么？

**FastMCP** 是基于 HTTP 的 MCP 实现，比 stdio 更适合：
- 本地 HTTP 服务（如 `http://localhost:8000`）
- 远程 MCP 服务器
- 需要跨进程/跨机器通信的场景

---

## 与 stdio 的区别

| 特性 | stdio MCP | FastMCP (HTTP) |
|------|-----------|----------------|
| 传输方式 | 标准输入/输出 | HTTP 请求 |
| 服务器启动 | 调度器启动子进程 | 独立运行（如 `python server.py`）|
| 适用场景 | 本地工具（文件系统） | 本地/远程服务 |
| 调试难度 | 较难（stdio 混在一起）| 容易（可以用 curl 测试）|

---

## Activity 集成示例（FastMCP）

### 1. FastMCP 服务器示例

假设你的 FastMCP 服务器运行在 `http://localhost:8000`，提供了这些工具：

```python
# fastmcp_server.py
from fastmcp import FastMCP

mcp = FastMCP("My Tools")

@mcp.tool()
def search_web(query: str) -> str:
    """搜索网页"""
    # 实际搜索逻辑
    return f"搜索结果：{query}"

@mcp.tool()
def get_weather(city: str) -> str:
    """获取天气"""
    return f"{city} 今天晴天"

if __name__ == "__main__":
    mcp.run(transport="sse")  # 运行在 http://localhost:8000
```

启动服务器：
```bash
python fastmcp_server.py
# 服务器运行在 http://localhost:8000
```

---

### 2. Activity 桥接代码（HTTP 传输）

```javascript
/**
 * FastMCP 桥接活动（HTTP 传输）
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

let mcpClient = null;
let mcpTools = [];

module.exports = {
  id: 'fastmcpBridge',

  async prepare(ctx) {
    if (mcpClient) return; // 已连接

    try {
      const mcpUrl = process.env.FASTMCP_URL || 'http://localhost:8000';

      // 👇 关键：使用 SSEClientTransport（HTTP）
      const transport = new SSEClientTransport(new URL(mcpUrl + '/sse'));

      mcpClient = new Client(
        {
          name: 'dylan-heartbeat',
          version: '1.0.0'
        },
        {
          capabilities: {}
        }
      );

      await mcpClient.connect(transport);
      console.log('[fastmcpBridge] 已连接到 FastMCP:', mcpUrl);

      // 获取工具列表
      const result = await mcpClient.listTools();
      mcpTools = result.tools || [];
      console.log(`[fastmcpBridge] 发现 ${mcpTools.length} 个工具:`, 
        mcpTools.map(t => t.name).join(', '));

    } catch (err) {
      console.error('[fastmcpBridge] 连接失败:', err.message);
      mcpClient = null;
    }
  },

  buildPromptSection(ctx, letter) {
    if (mcpTools.length === 0) {
      return {
        option: `## 选项${letter}：FastMCP 工具（未连接）`,
        chooseHint: '',
        outputHint: '',
        guide: ''
      };
    }

    const toolList = mcpTools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    return {
      option: `## 选项${letter}：使用 FastMCP 工具\n可用工具：\n${toolList}`,
      chooseHint: `- 需要搜索、查天气等时选${letter}`,
      outputHint: `- 选${letter}：调用对应的工具`,
      guide: `### ${letter} FastMCP 工具说明\n\n${toolList}`
    };
  },

  // 转换 MCP 工具 → OpenAI Function Calling 格式
  get tools() {
    return mcpTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || {
          type: 'object',
          properties: {}
        }
      }
    }));
  },

  async handleTool(toolName, args, ctx) {
    if (!mcpClient) {
      return {
        ok: false,
        output: 'FastMCP 客户端未连接'
      };
    }

    const { now, aiName = 'AI' } = ctx;

    try {
      console.log(`[fastmcpBridge] 调用工具: ${toolName}`, args);

      // 调用 FastMCP 工具
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: args
      });

      // 解析返回内容
      const output = result.content
        .map(c => {
          if (c.type === 'text') return c.text;
          if (c.type === 'image') return `[图片]`;
          if (c.type === 'resource') return `[资源: ${c.uri}]`;
          return JSON.stringify(c);
        })
        .join('\n');

      const recordText =
        `[FastMCP]（${now.toISOString()} ${aiName}使用了工具）\n` +
        `调用了 ${toolName}，结果：${output.slice(0, 100)}`;

      return {
        ok: true,
        output,
        recordText
      };

    } catch (err) {
      console.error(`[fastmcpBridge] 调用失败:`, err.message);
      return {
        ok: false,
        output: `工具调用失败：${err.message}`
      };
    }
  },

  async cleanup() {
    if (mcpClient) {
      try {
        await mcpClient.close();
        console.log('[fastmcpBridge] 已断开连接');
      } catch (err) {
        console.error('[fastmcpBridge] 断开失败:', err.message);
      }
      mcpClient = null;
    }
  }
};
```

---

### 3. 环境变量配置

```bash
# .env
FASTMCP_URL=http://localhost:8000

# 如果 FastMCP 在远程
# FASTMCP_URL=http://192.168.1.100:8000
```

---

### 4. 注册到调度器

```javascript
// scheduler/combined_wakeup_v2.js
const ALL_ACTIVITIES = {
  contactUser: require('./activities/contactUser'),
  fastmcpBridge: require('./activities/fastmcpBridge'),  // 👈 新增
  // ...
};

// .env 中启用
// WAKE_ACTIVITIES=contactUser,fastmcpBridge
```

---

## 完整的调用流程

```
┌─────────────────────────────────────────────────┐
│  FastMCP 服务器 (独立进程)                       │
│  http://localhost:8000                          │
│  - /sse (SSE 端点)                              │
│  - 提供工具：search_web, get_weather           │
└──────────────┬──────────────────────────────────┘
               │
               │ ① HTTP SSE 连接
               ▼
┌─────────────────────────────────────────────────┐
│  fastmcpBridge Activity                         │
│  - prepare(): 连接 FastMCP                      │
│  - listTools(): 获取工具列表                    │
│  - tools: 转换成 OpenAI 格式                    │
└──────────────┬──────────────────────────────────┘
               │
               │ ② 汇总到 allTools
               ▼
┌─────────────────────────────────────────────────┐
│  调度器                                          │
│  发送请求给 LLM（带 tools 数组）                 │
└──────────────┬──────────────────────────────────┘
               │
               │ ③ LLM 返回 tool_calls
               ▼
┌─────────────────────────────────────────────────┐
│  调度器                                          │
│  调用 fastmcpBridge.handleTool()                │
└──────────────┬──────────────────────────────────┘
               │
               │ ④ MCP 调用
               ▼
┌─────────────────────────────────────────────────┐
│  FastMCP 服务器                                  │
│  执行 search_web() → 返回结果                   │
└──────────────┬──────────────────────────────────┘
               │
               │ ⑤ 返回结果
               ▼
┌─────────────────────────────────────────────────┐
│  调度器                                          │
│  写入 wake_session → 用户下次看到               │
└─────────────────────────────────────────────────┘
```

---

## 测试 FastMCP 连接

### 手动测试（用 curl）

```bash
# 1. 测试 SSE 端点
curl http://localhost:8000/sse

# 2. 列出工具
curl http://localhost:8000/tools

# 3. 调用工具
curl -X POST http://localhost:8000/call \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "search_web",
    "arguments": {"query": "AI 伴侣"}
  }'
```

### Node.js 测试脚本

```javascript
// test_fastmcp.js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

async function test() {
  const transport = new SSEClientTransport(
    new URL('http://localhost:8000/sse')
  );

  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✅ 连接成功');

  // 列出工具
  const tools = await client.listTools();
  console.log('工具列表:', tools.tools.map(t => t.name));

  // 调用工具
  const result = await client.callTool({
    name: 'search_web',
    arguments: { query: 'test' }
  });
  console.log('调用结果:', result);

  await client.close();
}

test().catch(console.error);
```

运行测试：
```bash
node test_fastmcp.js
```

---

## 常见问题

### Q1: FastMCP 服务器没启动怎么办？

**A**: Activity 的 `prepare()` 会捕获错误，不会阻塞主流程。只是这个活动不可用。

```javascript
try {
  await mcpClient.connect(transport);
} catch (err) {
  console.error('FastMCP 连接失败:', err.message);
  mcpClient = null;  // 标记为未连接
}
```

### Q2: 如何支持多个 FastMCP 服务器？

**A**: 创建多个 activity：

```javascript
// activities/fastmcp_search.js
FASTMCP_URL=http://localhost:8000  // 搜索工具

// activities/fastmcp_weather.js
FASTMCP_URL=http://localhost:8001  // 天气工具
```

### Q3: FastMCP 返回的数据格式是什么？

**A**: 和 stdio MCP 一样，都是：

```json
{
  "content": [
    {
      "type": "text",
      "text": "搜索结果..."
    }
  ]
}
```

### Q4: Windows 下如何启动 FastMCP 服务器？

**A**:

```powershell
# PowerShell
python fastmcp_server.py

# 或者后台运行
Start-Process python -ArgumentList "fastmcp_server.py" -WindowStyle Hidden
```

### Q5: 如何调试 FastMCP 连接问题？

**A**: 启用详细日志：

```javascript
mcpClient.on('error', (err) => {
  console.error('[FastMCP Error]', err);
});

mcpClient.on('log', (msg) => {
  console.log('[FastMCP Log]', msg);
});
```

---

## 完整示例：搜索 + 天气

```javascript
// activities/myFastMCP.js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

let client = null;

module.exports = {
  id: 'myFastMCP',

  async prepare() {
    const transport = new SSEClientTransport(
      new URL('http://localhost:8000/sse')
    );
    client = new Client({ name: 'dylan', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    this._mcpTools = tools;
  },

  get tools() {
    return (this._mcpTools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));
  },

  async handleTool(toolName, args) {
    const result = await client.callTool({ name: toolName, arguments: args });
    return {
      ok: true,
      output: result.content.map(c => c.text).join('\n'),
      recordText: `[FastMCP] 调用了 ${toolName}`
    };
  }
};
```

---

## 总结

✅ **是的，FastMCP 用 SSEClientTransport（HTTP）**  
✅ 不是 StdioClientTransport（stdio）  
✅ 传输层是 HTTP SSE，不是标准输入/输出  
✅ 适合本地 HTTP 服务和远程 MCP 服务器  

**你的朋友理解得完全正确！** 👍

# MCP 集成指南

## 澄清：原项目没有使用 MCP

**重要说明**：原项目（Dylan Heartbeat）中的游戏、论坛、X、上网冲浪等功能**并不是通过 MCP 实现的**，而是直接在 activity 里调用 HTTP API。

所谓的"淘宝、小红书"指的是**浏览器代理功能**（browser agent），也不是 MCP。

---

## 如果你想接入 MCP

如果你确实想用 MCP 工具（比如 Claude Desktop 里的那些 MCP 服务器），下面是完整的接入方案：

### 方案 1：MCP 客户端 → Activity 桥接

#### 1. 安装 MCP SDK

```bash
npm install @modelcontextprotocol/sdk
```

#### 2. 创建 MCP 桥接 Activity

```javascript
/**
 * MCP 桥接活动
 * 把 MCP 工具转换成 activity 工具
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let mcpClient = null;
let mcpTools = [];

module.exports = {
  id: 'mcpBridge',

  // 预加载：连接 MCP 服务器
  async prepare(ctx) {
    if (mcpClient) return; // 已连接

    try {
      // 创建传输层（stdio 协议）
      const transport = new StdioClientTransport({
        command: process.env.MCP_COMMAND || 'python',  // 如 'python' / 'node' / 'uvx'
        args: (process.env.MCP_ARGS || '').split(',').filter(Boolean)  // 如 'my_mcp_server.py'
      });

      // 创建客户端
      mcpClient = new Client(
        {
          name: 'dylan-heartbeat',
          version: '1.0.0'
        },
        {
          capabilities: {}
        }
      );

      // 连接
      await mcpClient.connect(transport);
      console.log('[mcpBridge] MCP 客户端已连接');

      // 获取工具列表
      const result = await mcpClient.listTools();
      mcpTools = result.tools || [];
      console.log(`[mcpBridge] 发现 ${mcpTools.length} 个 MCP 工具`);

    } catch (err) {
      console.error('[mcpBridge] MCP 连接失败:', err.message);
      mcpClient = null;
    }
  },

  buildPromptSection(ctx, letter) {
    if (mcpTools.length === 0) {
      return {
        option: `## 选项${letter}：MCP 工具（未连接）`,
        chooseHint: '',
        outputHint: '',
        guide: ''
      };
    }

    const toolList = mcpTools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    return {
      option: `## 选项${letter}：使用 MCP 工具\n可用工具：\n${toolList}`,
      chooseHint: `- 需要使用外部工具时选${letter}`,
      outputHint: `- 选${letter}：调用对应的 MCP 工具`,
      guide: `### ${letter} MCP 工具说明\n\n${toolList}`
    };
  },

  // 转换 MCP 工具 → OpenAI Function Calling 格式
  get tools() {
    return mcpTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema  // MCP 的 inputSchema 已经是 JSON Schema
      }
    }));
  },

  async handleTool(toolName, args, ctx) {
    if (!mcpClient) {
      return {
        ok: false,
        output: 'MCP 客户端未连接'
      };
    }

    const { now, aiName = 'AI' } = ctx;

    try {
      // 调用 MCP 工具
      const result = await mcpClient.callTool({
        name: toolName,
        arguments: args
      });

      // MCP 返回格式：{ content: [...] }
      const output = result.content
        .map(c => {
          if (c.type === 'text') return c.text;
          if (c.type === 'image') return `[图片: ${c.data.slice(0, 50)}...]`;
          if (c.type === 'resource') return `[资源: ${c.uri}]`;
          return JSON.stringify(c);
        })
        .join('\n');

      // 记录到 wake_session
      const recordText =
        `[MCP 工具]（${now.toISOString()} ${aiName}使用了 MCP 工具）\n` +
        `调用了 ${toolName}，参数：${JSON.stringify(args).slice(0, 100)}`;

      return {
        ok: true,
        output,
        recordText
      };

    } catch (err) {
      console.error(`[mcpBridge] 调用 ${toolName} 失败:`, err.message);
      return {
        ok: false,
        output: `MCP 工具调用失败：${err.message}`
      };
    }
  },

  // 清理连接
  async cleanup() {
    if (mcpClient) {
      try {
        await mcpClient.close();
        console.log('[mcpBridge] MCP 客户端已断开');
      } catch (err) {
        console.error('[mcpBridge] 断开连接失败:', err.message);
      }
      mcpClient = null;
    }
  }
};
```

#### 3. 配置 .env

```bash
# MCP 服务器配置
MCP_COMMAND=python
MCP_ARGS=my_mcp_server.py

# 或者用 uvx（Python MCP）
MCP_COMMAND=uvx
MCP_ARGS=mcp-server-fetch

# 或者用 npx（Node.js MCP）
MCP_COMMAND=npx
MCP_ARGS=-y,@modelcontextprotocol/server-filesystem
```

#### 4. 在主调度器中启用

```javascript
// 在 combined_wakeup_v2.js 中注册
const ALL_ACTIVITIES = {
  contactUser: require('./activities/contactUser'),
  mcpBridge: require('./activities/mcpBridge'),
  // ...
};
```

---

### 方案 2：多个 MCP 服务器 → 独立 Activities

如果你有多个 MCP 服务器（如 Filesystem、Brave Search、Fetch），可以为每个创建独立的 activity：

#### activities/mcp_filesystem.js

```javascript
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let fsClient = null;

module.exports = {
  id: 'mcp_filesystem',

  async prepare() {
    if (fsClient) return;

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path']
    });

    fsClient = new Client({ name: 'dylan-fs', version: '1.0.0' }, { capabilities: {} });
    await fsClient.connect(transport);

    console.log('[mcp_filesystem] 已连接');
  },

  buildPromptSection(ctx, letter) {
    return {
      option: `## 选项${letter}：访问文件系统\n使用 read_file / write_file 等工具`,
      chooseHint: `- 需要读写文件时选${letter}`,
      outputHint: `- 选${letter}：调用 read_file / write_file`,
      guide: `支持的操作：读取文件、写入文件、列出目录`
    };
  },

  tools: [
    // 手动定义或从 listTools() 动态获取
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' }
          },
          required: ['path']
        }
      }
    }
  ],

  async handleTool(toolName, args, ctx) {
    const result = await fsClient.callTool({ name: toolName, arguments: args });
    return {
      ok: true,
      output: result.content.map(c => c.text || '').join('\n'),
      recordText: `[文件系统] 调用了 ${toolName}`
    };
  }
};
```

---

### 方案 3：SSE 传输（远程 MCP 服务器）

如果 MCP 服务器运行在远程（如 Claude Desktop 的 MCP），使用 SSE 传输：

```javascript
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const transport = new SSEClientTransport(
  new URL('http://localhost:3001/sse')
);

const client = new Client(
  { name: 'dylan', version: '1.0.0' },
  { capabilities: {} }
);

await client.connect(transport);
```

---

## 常见问题

### Q1: MCP 工具返回的是什么格式？

**A**: MCP 返回格式：

```json
{
  "content": [
    {
      "type": "text",
      "text": "工具执行结果"
    },
    {
      "type": "image",
      "data": "base64...",
      "mimeType": "image/png"
    }
  ]
}
```

需要手动转换成字符串给 LLM。

### Q2: MCP 和原项目的"游戏/论坛"有什么区别？

**A**:

| 特性 | 原项目 | MCP 方案 |
|------|--------|----------|
| 实现方式 | 直接 HTTP API 调用 | 通过 MCP 协议调用 |
| 工具定义 | 手写 JSON Schema | MCP 服务器提供 |
| 适用场景 | 简单的 REST API | 复杂的本地/远程工具 |
| 优势 | 轻量、直接 | 标准化、可复用 |

### Q3: 如何调试 MCP 连接？

**A**: 启用日志：

```javascript
await client.connect(transport);

// 监听日志
client.on('log', (message) => {
  console.log('[MCP Log]', message);
});

// 监听错误
client.on('error', (err) => {
  console.error('[MCP Error]', err);
});
```

### Q4: Windows 下如何运行 MCP 服务器？

**A**: 
- Python MCP: `python my_mcp_server.py`
- Node.js MCP: `npx -y @modelcontextprotocol/server-filesystem C:\allowed\path`
- 确保路径用反斜杠或 `path.normalize()`

---

## 总结

- ✅ **原项目不用 MCP**，直接调 HTTP API
- ✅ **如果想用 MCP**，按上面的桥接方案实现
- ✅ **推荐方案**：简单 API 用 HTTP，复杂工具用 MCP
- ✅ **关键代码**：`prepare()` 连接、`tools` 转换、`handleTool()` 调用

有问题随时问！

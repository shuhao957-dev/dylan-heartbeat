# Dylan Heartbeat - 活动系统

活动（Activity）是唤醒机器人可以执行的具体动作。每个活动是一个独立的模块，通过统一接口与主调度器交互。

## 📂 目录结构

```
activities/
├── template.js          # 活动模板（开发新活动时参考）
└── examples/            # 示例活动
    ├── contactUser.js   # 联系用户（发推送）
    └── simple.js        # 简单示例
```

## 🎯 活动接口

每个活动模块需要导出以下接口：

### 必需属性

1. **`id`** (string) - 活动唯一标识
2. **`tools`** (array) - 工具定义（OpenAI function calling 格式）
3. **`buildPromptSection(ctx, letter)`** - 构建 Prompt 的 4 个部分
4. **`handleTool(toolName, args, ctx)`** - 工具处理器

### 可选属性

- **`isFallback`** (boolean) - 是否是兜底活动（AI 没调工具时走它）
- **`statusLine(ctx)`** - 状态行（显示在 Prompt 的「当前状态」章节）
- **`prepare(ctx)`** - 预加载（每轮唤醒开始时调用）
- **`resetCycle()`** - 重置周期限制

## 📝 开发新活动

### 1. 复制模板

```bash
cp activities/template.js activities/myActivity.js
```

### 2. 修改 ID 和工具定义

```javascript
module.exports = {
  id: 'myActivity',  // 改成你的活动 ID
  
  tools: [
    {
      type: 'function',
      function: {
        name: 'my_tool',
        description: '做某事',
        parameters: {
          // JSON Schema
        }
      }
    }
  ],
  
  // ...
};
```

### 3. 实现 buildPromptSection

```javascript
buildPromptSection(ctx, letter) {
  return {
    option: `## 选项${letter}：做某事\n调用 my_tool 工具`,
    chooseHint: `- 想做某事时选${letter}`,
    outputHint: `- 选${letter}：调用 my_tool 工具`,
    guide: `### ${letter} 活动攻略\n\n详细指引...`
  };
}
```

### 4. 实现 handleTool

```javascript
async handleTool(toolName, args, ctx) {
  if (toolName !== 'my_tool') return null;
  
  // 执行业务逻辑
  const result = await doSomething(args);
  
  return {
    ok: true,
    output: '给 AI 的反馈',
    recordText: '[我的活动] ' + result
  };
}
```

### 5. 注册活动

在主调度器中注册（如果你用 v2 架构）：

```javascript
const ALL_ACTIVITIES = {
  myActivity: require('./activities/myActivity'),
  // ...
};
```

或在 `.env` 中启用：

```bash
WAKE_ACTIVITIES=myActivity,contactUser
```

## 🎨 Context 对象

所有钩子函数都会收到 `ctx` 上下文对象：

```javascript
{
  now: Date,           // 当前时间
  currentTime: string, // 格式化的时间字符串
  diffMinutes: number, // 用户沉默了多少分钟
  state: object,       // 持久化状态
  common: object,      // 通用工具函数
  aiName: string,      // AI 名称
  userName: string,    // 用户称呼
  dryRun: boolean      // 是否是演练模式
}
```

## 📋 最佳实践

### 1. 工具命名

使用清晰的动词+名词格式：
- ✅ `send_push` / `play_game` / `browse_forum`
- ❌ `do_it` / `action` / `execute`

### 2. recordText 格式

使用统一的格式标记：
```javascript
recordText: `[活动类型]（时间戳 AI做了什么）\n详细内容`
```

示例：
```javascript
recordText: `[游戏记录]（${timestamp} AI去玩了会儿游戏）\n打了 5 局，赢了 3 局`
```

### 3. 错误处理

```javascript
async handleTool(toolName, args, ctx) {
  try {
    // 业务逻辑
  } catch (err) {
    console.error(`[${this.id}] 错误:`, err.message);
    return {
      ok: false,
      output: '操作失败：' + err.message,
      recordText: `（${new Date().toISOString()} 尝试${toolName}但失败了）`
    };
  }
}
```

### 4. 限流保护

使用 `resetCycle()` 和状态管理：

```javascript
let executionCount = 0;

module.exports = {
  resetCycle() {
    executionCount = 0;
  },
  
  async handleTool(toolName, args, ctx) {
    if (executionCount >= 3) {
      return {
        ok: false,
        output: '本轮已执行 3 次，稍后再试'
      };
    }
    executionCount++;
    // ...
  }
};
```

## 🔍 调试

### 演练模式

使用 `--dry` 参数运行，不产生真实副作用：

```bash
node scheduler.js --dry
```

在 `ctx.dryRun === true` 时，你的活动应该只打印不执行：

```javascript
async handleTool(toolName, args, ctx) {
  if (ctx.dryRun) {
    console.log('[DRY] 将要执行:', args);
    return { ok: true, output: '[DRY] 已模拟执行' };
  }
  // 真实执行
}
```

### 日志输出

使用统一的日志前缀：

```javascript
console.log(`[${this.id}] 开始执行 ${toolName}`);
```

---

## 📚 示例活动

查看 `examples/` 目录下的完整示例：

- **contactUser.js** - 联系用户（推送通知）
- **simple.js** - 最简单的活动示例

---

有问题？查看主 [README](../README.md) 或提交 Issue！

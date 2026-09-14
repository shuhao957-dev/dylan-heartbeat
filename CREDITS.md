# 致谢与来源

## 原始项目

本项目基于 [@callie0313](https://github.com/callie0313) 的原始实现：
- **原仓库**：https://github.com/callie0313/dylan-heartbeat
- **原作者**：callie0313

**原项目包含**（2026-09 查证）：
- ✅ 自动唤醒系统（`wake_up.js`）
- ✅ Gateway 网关（`server.js`）
- ✅ Admin 管理面板（`/admin` 路由）
- ✅ 时间线管理（`enhanced_messages.json`）
- ✅ 推送功能（Bark/ntfy）
- ✅ 自动日记（`[DIARY]` 格式）
- ✅ 特殊事件处理（`special_events.js`）

---

## 本改编版的核心创新

由 [@shuhao957-dev](https://github.com/shuhao957-dev) 基于生产环境实践改编：

### 1️⃣ 摘要生命周期管理（原项目未包含）

**原项目问题**：
- 后台活动如何告知用户？原项目用 `special_events.js` 硬编码识别特殊格式
- 没有注入轮数控制，可能无限膨胀或遗漏

**本版本方案**（核心创新）：
- ✨ **`core/wake_digest.js`**（316 行新模块）
  - 机械拼装摘要（不调 LLM，保留原始语气）
  - 注入 N 轮后自动停止（默认 5 轮，已进入记忆）
  - 指纹去重（客户端重试不消耗轮次）
  - 智能截断（优先切在句末标点）
  - 相对时间（"12 分钟前"而非时间戳）
  
- 📝 **摘要格式示例**：
  ```
  （后台记录：距用户上次说话 1 小时 12 分。这段时间 AI 自己活动了 3 次：
  · 12 分钟前 给你发推送：想你了，在干嘛呀？
  · 34 分钟前 玩游戏：又去打了几轮 roguelike...
  以上是 AI 自己做的事，本消息只在这一轮出现...）
  ```

### 2️⃣ 模块化活动系统

**原项目**：活动逻辑硬编码在 `wake_up.js` 里

**本版本**：
- ✨ **`activities/` 目录架构**
  - 标准接口：`buildPromptSection()` / `handleTool()` / `tools`
  - 可插拔设计：环境变量控制启用哪些活动
  - 状态管理：每个活动独立管理自己的状态
  
- 📚 **完整示例**：
  - `activities/template.js` - 活动接口规范
  - `activities/examples/contactUser.js` - 简单推送
  - `activities/examples/simpleGame.js` - 多轮游戏（160 行）
  - `activities/examples/forum.js` - 论坛互动

### 3️⃣ 统一事件队列

- ✨ **`gateway/unified_events.js`**（142 行新模块）
  - 聚合多源事件（唤醒/微信/邮件/浏览器/股票）
  - 统一格式：`{id, timestamp, type, digest}`
  - 拉取后自动删除，防重复

### 4️⃣ 完整文档和示例

**原项目**：README 主要面向使用者

**本版本**：面向二次开发者
- 📖 **7 篇详细文档**：
  - `docs/FAQ.md` - 7 个常见问题
  - `docs/MISSING_PIECES.md` - 缺失组件说明
  - `docs/MCP_INTEGRATION.md` - MCP 工具集成
  - `docs/FASTMCP_INTEGRATION.md` - HTTP MCP 服务器
  - `examples/gateway-example.js` - 完整网关实现
  - `scheduler/lib/common.js` - 工具库（sendPush/writeToGateway/状态管理）

### 5️⃣ 跨平台和脱敏

- ✅ Windows 路径兼容（`path.join()` / `os.tmpdir()`）
- ✅ 所有敏感信息改为环境变量（`.env.example`）
- ✅ 去除硬编码的 VPS IP、域名、私人称呼

---

## 设计思想来源

**自动唤醒 + 时间线管理 + Admin 面板**：原作者 @callie0313 的设计

**摘要生命周期管理**：本改编版基于生产实践总结（VPS 上运行 6+ 个月迭代出的方案）

**模块化活动系统**：本改编版的架构设计

---

## 许可证说明

- **原项目**：PolyForm Noncommercial 1.0.0（2026-07-23 起，禁止商业用途）
- **本项目**：MIT License（用于本改编版新增的代码和文档）

本改编版尊重原项目的非商业许可，核心架构思想归原作者所有。

---

## 本版本目标

- 🌍 让更多开发者能学习和借鉴这套架构
- 📖 提供清晰的文档和可复用的代码
- 🔧 降低接入门槛，开箱即用
- 🎓 作为教学示例，展示摘要注入的最佳实践

---

## 感谢

感谢 [@callie0313](https://github.com/callie0313) 的原始设计和实现！

原项目解决了 AI 伴侣的核心难题（自主唤醒 + 时间线管理），本改编版在此基础上增加了摘要生命周期管理和模块化支持，希望能帮助更多开发者快速上手。🙏

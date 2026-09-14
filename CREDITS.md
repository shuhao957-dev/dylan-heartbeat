# 致谢与来源

## 原始项目

本项目基于 [@callie0313](https://github.com/callie0313) 的原始实现：
- **原仓库**：https://github.com/callie0313/dylan-heartbeat
- **原作者**：callie0313

## 开源化改编

由 [@shuhao957-dev](https://github.com/shuhao957-dev) 进行开源化改编和发布：

### 主要改进

1. **脱敏和泛化**
   - 移除私人配置（VPS 地址、凭证、私人称呼）
   - 改为环境变量配置
   - 支持自定义 AI 和用户称呼

2. **文档完善**
   - 添加完整的 README 和 API 文档
   - 添加活动系统开发指南
   - 添加快速开始示例
   - 添加常见问题解答

3. **模块化和可复用**
   - 提取核心组件（wake_digest.js, unified_events.js）
   - 提供活动模板和示例
   - 标准化接口规范

4. **开源协议**
   - 添加 MIT License
   - 完善 package.json
   - 规范 Git 提交历史

## 设计思想来源

核心设计思想（摘要生命周期管理、模块化活动系统）均来自原作者的实践和总结。

本开源化版本的目标是：
- 🌍 让更多开发者能使用这套天才设计
- 📖 提供清晰的文档和示例
- 🔧 降低接入门槛

## License

本项目采用 MIT License，与原项目保持一致。

## 感谢

再次感谢 [@callie0313](https://github.com/callie0313) 的精彩设计和实现！🙏

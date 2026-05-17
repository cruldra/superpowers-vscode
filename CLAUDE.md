## 工作流约定

- 具体编码任务一律派子代理（Agent 工具）去做，主会话只讨论需求和方案
- **子代理实施完成后自动 commit**，使用本仓库的 emoji 前缀风格（参考 `git log`）
- 代码文件用 Serena MCP 工具读写（`mcp__serena__find_symbol` / `replace_symbol_body` 等），非代码文件才用 built-in Read/Edit

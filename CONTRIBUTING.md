# Contributing

感谢关注本项目。提交改动前请尽量遵循以下约定。

## 开发环境

- Google Chrome（支持 Manifest V3）
- 可选：Node.js 18+（`npm run check` / `npm run pack`）

## 提交流程

1. Fork 并创建分支：`feature/...` 或 `fix/...`
2. 只修改与需求相关的文件，避免顺手大重构
3. 本地执行 `npm run check` 与 `npm test`
4. 在 Chrome 加载 `chrome-extension/`，走通登录 / 备用邮箱 / 换 token 主路径
5. 打开 Pull Request，说明动机、行为变化与测试方式

## 代码约定

- 保持 content script 页面状态机清晰（`classifyPage` 等）
- 自动化相关逻辑勿在未沟通的情况下删除
- 不在仓库中提交密码、接码密钥、真实 token 或账号列表
- `manifest.json` 的 `version` 与用户可见行为变更一起 bump

## 安全

Issue / PR 中请打码账号与 token。若发现安全问题，请勿公开完整利用细节，优先私下说明影响面。

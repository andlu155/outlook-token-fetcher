# Outlook Token Fetcher

Chrome 扩展：半自动获取 Microsoft / Outlook 账号的 OAuth2 **Refresh Token**（PKCE + `nativeclient` 回调）。

支持自动模式与逐步骤模式、多固定备用邮箱轮流、自动接码、暂停/继续，以及侧栏结果复制与手动导出。

> **用途说明**：仅供你有权操作的账号使用（自有账号、已授权测试环境）。请遵守 Microsoft 服务条款与当地法律。

## 功能

| 能力 | 说明 |
|------|------|
| OAuth2 PKCE | 打开授权页 → 登录/验证 → 捕获 `code` → 换取 `refresh_token` |
| 自动 / 逐步骤 | 全自动跑 1–4 步，或手动点步骤圆圈执行 |
| 备用邮箱 | 固定列表（最多 10 个，按顺序轮流）或随机本地部分 + 域名 |
| 自动接码 | 可选对接自建临时邮箱 Admin API 拉取验证码 |
| 页面识别 | 登录、备用邮箱绑定/再验证、验证码、失效码、通行密钥取消、保持登录、同意、帐户锁定、人机验证提示等 |
| 暂停 / 继续 | 保留队列与当前账号；停止则清空队列 |
| 结果 | 侧栏展示；支持复制与手动导出（不自动下载本地文件） |

## 目录结构

```text
.
├── chrome-extension/          # 扩展本体（加载此目录）
│   ├── manifest.json          # MV3 清单（当前版本见文件）
│   ├── background/            # Service Worker
│   ├── content/               # 登录页自动化
│   ├── popup/                 # Side Panel UI
│   └── options/               # 设置页
├── scripts/                   # 打包等工具脚本
├── package.json
├── LICENSE
└── README.md
```

## 安装（开发者模式）

1. 打开 Chrome → `chrome://extensions`
2. 开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择本仓库的 [`chrome-extension`](chrome-extension) 目录
4. 固定扩展，打开 **侧边栏（Side Panel）** 使用
5. 在扩展 **选项** 中配置备用邮箱与（可选）接码 API

升级后请在 `chrome://extensions` 点击 **重新加载**。

## 使用流程

1. **设置**
   - 固定备用邮箱：每行一个，最多 10 个；处理账号时按顺序循环使用
   - 或随机模式：填写邮箱域名
   - 可选：启用自动接码并填写 API 地址与 Admin 密码
2. **侧栏**粘贴账号列表（常见格式：`邮箱----密码` 或按界面提示的多字段格式）
3. 选择 **自动** 或 **逐步骤**，点击开始
4. 按页面提示完成验证；成功后结果出现在侧栏，可复制或导出

### 步骤含义

| 步骤 | 作用 |
|------|------|
| 1 | 打开 / 重开 OAuth 授权页 |
| 2 | 填写账号密码并继续 |
| 3 | 备用邮箱绑定 / 填验证码（可多次） |
| 4 | 用授权码换取 Refresh Token |

备用邮箱验证成功后（含「旧验证码已失效」类提示），自动模式会重开授权页以完成令牌流程。

## 接码 API（可选）

扩展会请求：

```http
GET {apiUrl}/admin/mails?limit=...&offset=...
Header: x-admin-auth: {adminPassword}
```

需自行部署兼容的临时邮箱后台；扩展不附带服务端。

## 开发

```bash
# 语法检查
npm run check

# 打包 chrome-extension 为 zip（生成 dist/）
npm run pack
```

修改代码后在 `chrome://extensions` 重新加载扩展即可调试。

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 队列、设置、运行状态 |
| `tabs` / `scripting` | 打开授权页、注入/通信 content script |
| `sidePanel` | 侧栏控制台 |
| `declarativeNetRequest` | 辅助请求处理（如清单中已配置） |
| 主机权限 | Microsoft 登录相关域名与 HTTPS（接码 API 等） |

## 版本

以 [`chrome-extension/manifest.json`](chrome-extension/manifest.json) 中的 `version` 为准（当前 **1.9**）。

## License

[MIT](LICENSE)

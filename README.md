# ZO2API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

将 [zo.computer](https://zo.computer) 的 API 转换为标准 OpenAI / Anthropic 格式的代理服务，让你可以在任何支持标准 API 的客户端中使用 ZO 的模型。

## 功能特性

- **双格式兼容** — 同时支持 OpenAI Chat Completions 和 Anthropic Messages API
- **流式输出** — 完整支持 SSE 流式响应
- **工具调用** — 支持 Function Calling / Tool Use
- **动态模型** — 自动获取并缓存可用模型列表
- **多模型支持** — Claude、DeepSeek 等多种模型

## 快速开始

### 1. 安装

```bash
git clone https://github.com/GoblinHonest/zo2api.git
cd zo2api
npm install
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 `ZO_ACCESS_TOKEN`。

### 3. 获取 Access Token

1. 在浏览器中打开 [rustydaisy.zo.computer](https://rustydaisy.zo.computer) 并登录
2. 按 `F12` 打开开发者工具
3. 进入 `Application` → `Cookies` → `api.zo.computer`
4. 复制 `access_token` 的值
5. 粘贴到 `.env` 文件中

### 4. 启动

```bash
npm start
```

服务将在 `http://localhost:3000` 启动。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/chat/completions` | OpenAI 格式聊天接口 |
| `POST` | `/v1/messages` | Anthropic 格式聊天接口 |
| `GET` | `/health` | 健康检查 |

## 使用示例

### OpenAI 格式

```bash
# 非流式请求
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-7",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 流式请求
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### Anthropic 格式

```bash
# 非流式请求
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Python (Anthropic SDK)

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://localhost:3000", api_key="anything")
resp = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.content[0].text)
```

## 可用模型

| 短名 | ZO 模型标识 |
|------|-------------|
| `claude-opus-4-7` | `zo:anthropic/claude-opus-4-7` |
| `claude-opus-4-5` | `zo:anthropic/claude-opus-4-5` |
| `claude-sonnet-4-5` | `zo:anthropic/claude-sonnet-4-5` |
| `deepseek-v4-pro` | `zo:deepseek/deepseek-v4-pro` |

> 也可以直接使用完整的 `zo:vendor/name` 格式。

## 客户端配置

### Cherry Studio / LobeChat / NextChat

- **API 地址**: `http://localhost:3000`
- **API Key**: 任意填写（或留空）
- **模型**: 选择 OpenAI 格式

### Claude 官方客户端 / Anthropic SDK

- **Base URL**: `http://localhost:3000`
- **API Key**: 任意填写

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ZO_ACCESS_TOKEN` | ZO 平台的访问令牌 | （必填） |
| `ZO_API` | ZO API 地址 | `https://api.zo.computer` |
| `ZO_ORIGIN` | ZO 工作区来源 | `https://rustydaisy.zo.computer` |
| `PORT` | 服务监听端口 | `3000` |

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

## 免责声明

**本项目与 zo.computer 及其关联公司没有任何隶属、授权或背书关系。**

1. **非官方项目** — 这是一个独立的第三方工具，不是 zo.computer 的官方产品或服务。

2. **自行承担风险** — 使用本工具可能违反 zo.computer 的服务条款。使用者应自行了解并承担相关风险，开发者不对因使用本工具导致的任何后果负责，包括但不限于账号封禁、服务中断或数据丢失。

3. **无担保** — 本工具按"现状"提供，不作任何明示或暗示的保证，包括但不限于适销性、特定用途适用性或不侵权的保证。

4. **访问令牌安全** — 用户的 `access_token` 是敏感凭据，请妥善保管，切勿泄露或公开分享。开发者不对因令牌泄露导致的任何损失负责。

5. **合规使用** — 用户应确保其使用行为符合适用的法律法规和服务条款。本工具仅供学习和个人使用，不得用于任何商业或非法用途。

6. **随时变更** — 本项目可能因上游 API 变更而随时失效，开发者不保证持续维护或更新。

**使用本工具即表示你已阅读、理解并同意上述条款。如果你不同意，请勿使用本工具。**

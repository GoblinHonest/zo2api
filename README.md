# ZO Proxy

把 zo.computer 的 API 包装成 OpenAI / Anthropic 格式，让你能用在任何支持标准 API 的客户端里。

## 快速开始

```bash
cd zo-proxy
npm install
# 设置你的 access_token
copy .env.example .env   # 然后编辑 .env 填入 access_token

npm start
```

## 获取 access_token

1. 在浏览器打开 https://rustydaisy.zo.computer 并登录
2. F12 → Application → Cookies → api.zo.computer
3. 复制 `access_token` 的值
4. 贴到 `.env` 文件里（或用环境变量 `ZO_ACCESS_TOKEN`）

## 接口

### OpenAI 格式

```bash
# 模型列表
curl http://localhost:3000/v1/models

# 聊天（非流式）
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"你好"}]}'

# 聊天（流式）
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic Messages 格式

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'

# 流式
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 可用模型

| 短名 | 对应 zo 模型 | 格式 |
|---|---|---|
| `claude-opus-4-7` | zo:anthropic/claude-opus-4-7 | OpenAI / Anthropic |
| `claude-opus-4-5` | zo:anthropic/claude-opus-4-5 | OpenAI / Anthropic |
| `claude-sonnet-4-5` | zo:anthropic/claude-sonnet-4-5 | OpenAI / Anthropic |
| `deepseek-v4-pro` | zo:deepseek/deepseek-v4-pro | OpenAI / Anthropic |

也可以直接用 `zo:anthropic/claude-opus-4-7` 这种完整的 zo 格式透传。

## 搭配客户端

### Cherry Studio / LobeChat / NextChat 等
- API 地址: `http://localhost:3000`
- API Key: 随便填一个即可（或留空）
- 模型选择 OpenAI 格式即可

### Claude 官方客户端 (anthropic SDK)
```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:3000", api_key="anything")
resp = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.content[0].text)
```
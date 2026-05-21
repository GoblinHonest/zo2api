import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ============ 配置 ============
const ZO_API = "https://api.zo.computer";
const ZO_ORIGIN = "https://rustydaisy.zo.computer";
const ACCESS_TOKEN = process.env.ZO_ACCESS_TOKEN || "";

// 动态模型列表缓存
let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 短名 -> zo:vendor/name 映射
let shortNameMap = {};
// zo:vendor/name -> 模型详情
let modelInfoMap = {};

function zoHeaders() {
  return {
    "Content-Type": "application/json",
    "Cookie": `access_token=${ACCESS_TOKEN}`,
    "X-Zo-Streaming-Version": "2",
    "X-Zo-Workspace-Origin": ZO_ORIGIN,
    "Idempotency-Key": crypto.randomUUID(),
    "Origin": ZO_ORIGIN,
    "Referer": `${ZO_ORIGIN}/`,
  };
}

function uid() {
  return crypto.randomUUID();
}

/** 生成短名: zo:anthropic/claude-opus-4-7 -> claude-opus-4-7 */
function toShortName(zoName) {
  const parts = zoName.split("/");
  return parts[parts.length - 1];
}

/** 解析模型名 */
function resolveModel(name) {
  // 先查短名映射
  if (shortNameMap[name]) return shortNameMap[name];
  // 如果是完整的 zo:xxx/yyy 格式，直接返回
  if (name.startsWith("zo:")) return name;
  return name;
}

/** 刷新模型列表 */
async function refreshModels() {
  const now = Date.now();
  if (cachedModels && (now - cacheTime) < CACHE_TTL) return cachedModels;

  try {
    const resp = await fetch(`${ZO_API}/models/available`, {
      headers: {
        "Cookie": `access_token=${ACCESS_TOKEN}`,
        "X-Zo-Workspace-Origin": ZO_ORIGIN,
        "Origin": ZO_ORIGIN,
        "Referer": `${ZO_ORIGIN}/`,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    cachedModels = data.models;
    cacheTime = now;

    // 重建映射
    shortNameMap = {};
    modelInfoMap = {};
    for (const m of data.models) {
      const short = toShortName(m.model_name);
      shortNameMap[short] = m.model_name;
      modelInfoMap[m.model_name] = m;
    }

    console.log(`[models] Loaded ${cachedModels.length} models`);
    return cachedModels;
  } catch (err) {
    console.error("[models] Failed to fetch:", err.message);
    // 返回缓存或空
    return cachedModels || [];
  }
}

// ============ SSE 解析 ============

async function* parseZoSse(reader, decoder) {
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event: ")) { currentEvent = line.slice(7).trim(); continue; }
      if (line.startsWith("data: ")) {
        try { yield { sseEvent: currentEvent, data: JSON.parse(line.slice(6)) }; } catch (_) {}
        currentEvent = "";
      }
    }

    if (done) {
      if (buffer.trim()) {
        let evt = "";
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event: ")) { evt = line.slice(7).trim(); continue; }
          if (line.startsWith("data: ")) {
            try { yield { sseEvent: evt, data: JSON.parse(line.slice(6)) }; } catch (_) {}
            evt = "";
          }
        }
      }
      break;
    }
  }
}

function buildQuestion(messages) {
  return messages.map(m => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${c}`;
  }).join("\n");
}

/** 从 ZO 的 FrontendModelResponse 提取 usage，带上 cache */
function extractUsage(zoResp) {
  const input = zoResp.input_tokens || 0;
  const output = zoResp.output_tokens || 0;
  const cacheRead = zoResp.cache_read_tokens || 0;
  const cacheWrite = zoResp.cache_write_tokens || 0;
  return { input, output, cacheRead, cacheWrite };
}

/** 构建 OpenAI 格式的 usage */
function buildOpenAIUsage(usage) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_cache_hit_tokens: usage.cacheRead,
    prompt_cache_write_tokens: usage.cacheWrite,
  };
}

/** 构建 Anthropic 格式的 usage */
function buildAnthropicUsage(usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  };
}

// ============ OpenAI 兼容接口 ============

// GET /v1/models - 动态获取模型
app.get("/v1/models", async (req, res) => {
  try {
    const models = await refreshModels();
    res.json({
      object: "list",
      data: models.map(m => ({
        id: toShortName(m.model_name),
        object: "model",
        created: Math.floor(cacheTime / 1000),
        owned_by: m.vendor.toLowerCase(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  const { model, messages, stream = false } = req.body;
  if (!model || !messages) return res.status(400).json({ error: "model and messages are required" });

  const zoModel = resolveModel(model);
  const question = buildQuestion(messages);

  const zoBody = {
    q: question,
    context_paths: [],
    command_paths: [],
    model_name: zoModel,
    expanded_paths: ["Articles", "Images"],
  };

  try {
    const resp = await fetch(`${ZO_API}/ask`, {
      method: "POST",
      headers: zoHeaders(),
      body: JSON.stringify(zoBody),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err });
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        let delta = null;
        if (sseEvent === "PartDeltaEvent" && data.delta?.part_delta_kind === "text") delta = data.delta.content_delta;
        if (sseEvent === "PartStartEvent" && data.part?.part_kind === "text" && data.part.content) delta = data.part.content;
        if (delta) {
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-" + uid(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-" + uid(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
          const textParts = (data.parts || []).filter(p => p.part_kind === "text");
          if (textParts.length > 0) fullText = textParts.map(p => p.content).join("\n");
        }
        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "text" && data.part.content) {
          fullText = fullText || data.part.content;
        }
      }

      res.json({
        id: "chatcmpl-" + uid(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
        usage: buildOpenAIUsage(zoUsage),
      });
    }
  } catch (err) {
    console.error("ZO API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============ Anthropic Messages 兼容接口 ============

app.post("/v1/messages", async (req, res) => {
  const { model, messages, system, stream = false } = req.body;
  if (!model || !messages) return res.status(400).json({ type: "error", error: { message: "model and messages are required" } });

  const zoModel = resolveModel(model);

  let question = "";
  if (system) {
    const sysText = typeof system === "string" ? system
      : (Array.isArray(system) ? system.map(s => s.text || s.content).join("\n") : "");
    if (sysText) question = `System: ${sysText}\n\n`;
  }
  question += buildQuestion(messages);

  const zoBody = {
    q: question,
    context_paths: [],
    command_paths: [],
    model_name: zoModel,
    expanded_paths: ["Articles", "Images"],
  };

  try {
    const resp = await fetch(`${ZO_API}/ask`, {
      method: "POST",
      headers: zoHeaders(),
      body: JSON.stringify(zoBody),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ type: "error", error: { message: err } });
    }

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const msgId = "msg_" + uid();
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", content: [], model, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);

      // keepalive: Anthropic SDK 接受 comment 行做心跳
      const keepalive = setInterval(() => res.write(": heartbeat\n\n"), 5000);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
        }
        let delta = null;
        if (sseEvent === "PartDeltaEvent" && data.delta?.part_delta_kind === "text") delta = data.delta.content_delta;
        if (sseEvent === "PartStartEvent" && data.part?.part_kind === "text" && data.part.content) delta = data.part.content;
        if (delta) {
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta },
          })}\n\n`);
        }
      }

      clearInterval(keepalive);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: zoUsage.output },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
          const textParts = (data.parts || []).filter(p => p.part_kind === "text");
          if (textParts.length > 0) fullText = textParts.map(p => p.content).join("\n");
        }
        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "text" && data.part.content) {
          fullText = fullText || data.part.content;
        }
      }

      res.json({
        id: "msg_" + uid(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: fullText }],
        model,
        stop_reason: "end_turn",
        usage: buildAnthropicUsage(zoUsage),
      });
    }
  } catch (err) {
    console.error("ZO API error:", err);
    res.status(500).json({ type: "error", error: { message: err.message } });
  }
});

// ============ 健康检查 ============
app.get("/health", (req, res) => {
  res.json({ status: "ok", zo_api: ZO_API, models_cached: !!cachedModels, model_count: cachedModels?.length || 0 });
});

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await refreshModels(); // 启动时预加载模型列表
  console.log(`ZO Proxy running on http://localhost:${PORT}`);
  console.log(`  OpenAI:    POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  Anthropic: POST http://localhost:${PORT}/v1/messages`);
  console.log(`  Models:    GET  http://localhost:${PORT}/v1/models`);
  console.log(`Available: ${Object.keys(shortNameMap).join(", ")}`);
  console.log(`Free models: ${cachedModels?.filter(m => m.type === "free").map(m => toShortName(m.model_name)).join(", ")}`);
});
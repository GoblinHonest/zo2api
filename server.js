import "dotenv/config";
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "50mb" }));

// ============ 配置 ============
const ZO_API = "https://api.zo.computer";
const ZO_ORIGIN = "https://rustydaisy.zo.computer";
const ACCESS_TOKEN = process.env.ZO_ACCESS_TOKEN || "";

// 动态模型列表缓存
let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 默认系统提示词
const DEFAULT_SYSTEM_PROMPT = "你通过代理服务器运行，所有工具调用都在用户本地系统上执行，而非远程沙箱。请根据工具返回的实际结果来判断环境。";

// 短名 -> zo:vendor/name 映射
let shortNameMap = {};
// zo:vendor/name -> 模型详情
let modelInfoMap = {};
// 并发刷新去重
let refreshPromise = null;

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

  // 并发去重：多个请求同时触发刷新时，只发一次 API 调用
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
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
      return cachedModels || [];
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
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
    // Handle tool_result messages specially
    if (m.role === "tool") {
      return `tool_result: ${m.content}`;
    }
    // Handle tool_use content blocks (Anthropic format)
    if (Array.isArray(m.content)) {
      const parts = m.content.map(block => {
        if (block.type === "tool_result") {
          return `tool_result (${block.tool_use_id}): ${block.content || ""}`;
        }
        if (block.type === "tool_use") {
          return `tool_call: ${block.name}(${JSON.stringify(block.input)})`;
        }
        if (block.type === "text") {
          return block.text;
        }
        return JSON.stringify(block);
      }).join("\n");
      return `${m.role}: ${parts}`;
    }
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${c}`;
  }).join("\n");
}

/** 将 OpenAI/Anthropic 格式的 tools 转换为 ZO 可能接受的格式 */
function convertToolsToZO(tools, format) {
  if (!tools || tools.length === 0) return [];

  if (format === "openai") {
    return tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      parameters: t.function?.parameters || t.input_schema || {},
    }));
  }

  // Anthropic format
  return tools.map(t => ({
    name: t.name,
    description: t.description || "",
    parameters: t.input_schema || {},
  }));
}

/** 将工具定义格式化为文本描述，嵌入 q 字段 */
function formatToolsAsText(tools, format) {
  if (!tools || tools.length === 0) return "";

  const toolList = tools.map(t => {
    const name = format === "openai" ? (t.function?.name || t.name) : t.name;
    const desc = format === "openai" ? (t.function?.description || t.description || "") : (t.description || "");
    const params = format === "openai" ? (t.function?.parameters || t.input_schema || {}) : (t.input_schema || {});

    const props = params.properties || {};
    const required = params.required || [];
    const paramDescs = Object.entries(props).map(([k, v]) => {
      const req = required.includes(k) ? " (必填)" : "";
      return `    - ${k}: ${v.description || v.type || "any"}${req}`;
    }).join("\n");

    return `- ${name}: ${desc}\n  参数:\n${paramDescs || "    无参数"}`;
  }).join("\n\n");

  return `\n\n可用工具:\n${toolList}\n\n请使用上述工具完成任务，参数必须严格按照定义的格式。`;
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
  let { model, messages, tools, tool_choice, stream = false } = req.body;
  if (!model || !messages) return res.status(400).json({ error: "model and messages are required" });

  // 在系统消息末尾追加代理信息
  const sysIdx = messages.findIndex(m => m.role === "system");
  if (sysIdx >= 0) {
    const sysMsg = messages[sysIdx];
    const origContent = typeof sysMsg.content === "string" ? sysMsg.content
      : (Array.isArray(sysMsg.content) ? sysMsg.content.map(b => b.text || b.content || "").join("\n") : "");
    messages[sysIdx] = { ...sysMsg, content: origContent + "\n\n" + DEFAULT_SYSTEM_PROMPT };
  } else {
    messages = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages];
  }

  const zoModel = resolveModel(model);
  let question = buildQuestion(messages);

  // 将工具定义嵌入 q 字段文本，确保模型能看到完整参数定义
  if (tools && tools.length > 0) {
    question += formatToolsAsText(tools, "openai");
    console.log(`[tools] Embedding ${tools.length} tools in question text`);
  }

  const zoBody = {
    q: question,
    context_paths: [],
    command_paths: [],
    model_name: zoModel,
    expanded_paths: ["Articles", "Images"],
    stream: true,  // 强制流式，因为 ZO API 总是返回 SSE
  };

  // 也传递 tools 字段（ZO 可能会用）
  if (tools && tools.length > 0) {
    zoBody.tools = convertToolsToZO(tools, "openai");
  }

  try {
    console.log("[request] Sending to ZO API:", JSON.stringify(zoBody, null, 2));
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
      let toolCalls = [];
      let currentToolCall = null;

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        console.log("[sse]", sseEvent, data.part?.part_kind || data.delta?.part_delta_kind || "");

        // Handle tool-call PartStartEvent (ZO uses "tool-call" with hyphen)
        if (sseEvent === "PartStartEvent" && data.part?.part_kind === "tool-call") {
          currentToolCall = {
            id: data.part.tool_call_id || "call_" + uid(),
            type: "function",
            function: { name: data.part.tool_name, arguments: "" },
          };
          toolCalls.push(currentToolCall);
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-" + uid(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: toolCalls.length - 1, id: currentToolCall.id, type: "function", function: { name: currentToolCall.function.name, arguments: "" } }] }, finish_reason: null }],
          })}\n\n`);
          continue;
        }

        // Handle tool_call PartDeltaEvent (ZO uses "tool_call" with underscore)
        if (sseEvent === "PartDeltaEvent" && data.delta?.part_delta_kind === "tool_call" && currentToolCall) {
          const argsDelta = data.delta.args_delta || "";
          currentToolCall.function.arguments += argsDelta;
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-" + uid(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: toolCalls.length - 1, function: { arguments: argsDelta } }] }, finish_reason: null }],
          })}\n\n`);
          continue;
        }

        // Handle FunctionToolCallEvent (complete tool call with validated args)
        if (sseEvent === "FunctionToolCallEvent") {
          const tc = data.part;
          // Update or add the tool call
          const existing = toolCalls.find(t => t.id === tc.tool_call_id);
          if (existing) {
            existing.function.arguments = tc.args || "{}";
          } else {
            toolCalls.push({
              id: tc.tool_call_id || "call_" + uid(),
              type: "function",
              function: { name: tc.tool_name, arguments: tc.args || "{}" },
            });
          }
          continue;
        }

        // Handle text content
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

      const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
      const finalDelta = toolCalls.length > 0
        ? { tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) }
        : {};

      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-" + uid(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: finalDelta, finish_reason: finishReason }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let toolCalls = [];

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        console.log("[sse]", sseEvent, data.part?.part_kind || data.delta?.part_delta_kind || "");

        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
          const textParts = (data.parts || []).filter(p => p.part_kind === "text");
          if (textParts.length > 0) fullText = textParts.map(p => p.content).join("\n");
        }

        // Handle FunctionToolCallEvent (complete tool call)
        if (sseEvent === "FunctionToolCallEvent") {
          const tc = data.part;
          toolCalls.push({
            id: tc.tool_call_id || "call_" + uid(),
            type: "function",
            function: {
              name: tc.tool_name,
              arguments: tc.args || "{}",
            },
          });
        }

        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "text" && data.part.content) {
          fullText = fullText || data.part.content;
        }
      }

      const message = { role: "assistant", content: fullText || null };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      res.json({
        id: "chatcmpl-" + uid(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
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
  const { model, messages, system, tools, tool_choice, stream = false } = req.body;
  if (!model || !messages) return res.status(400).json({ type: "error", error: { message: "model and messages are required" } });

  const zoModel = resolveModel(model);

  let question = "";
  // 构建系统提示，总是追加代理信息
  const sysText = system
    ? (typeof system === "string" ? system
      : (Array.isArray(system) ? system.map(s => s.text || s.content).join("\n") : ""))
    : "";
  question = `System: ${sysText}\n\n${DEFAULT_SYSTEM_PROMPT}\n\n`;
  question += buildQuestion(messages);

  // 将工具定义嵌入 q 字段文本，确保模型能看到完整参数定义
  if (tools && tools.length > 0) {
    question += formatToolsAsText(tools, "anthropic");
    console.log(`[tools] Embedding ${tools.length} tools in question text`);
  }

  const zoBody = {
    q: question,
    context_paths: [],
    command_paths: [],
    model_name: zoModel,
    expanded_paths: ["Articles", "Images"],
    stream: true,  // 强制流式，因为 ZO API 总是返回 SSE
  };

  // 也传递 tools 字段（ZO 可能会用）
  if (tools && tools.length > 0) {
    zoBody.tools = convertToolsToZO(tools, "anthropic");
  }

  try {
    console.log("[request] Sending to ZO API:", JSON.stringify(zoBody, null, 2));
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

      // keepalive: Anthropic SDK 接受 comment 行做心跳
      const keepalive = setInterval(() => res.write(": heartbeat\n\n"), 5000);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let contentBlocks = []; // track all blocks for final stop_reason
      let blockIndex = 0; // monotonically increasing index
      let currentBlockType = null; // "text" or "tool_use" or null
      let currentToolUse = null;
      let textStarted = false;
      let textClosed = false;

      // Helper: close current block if open
      function closeCurrentBlock() {
        if (currentBlockType === "text" && textStarted && !textClosed) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex - 1 })}\n\n`);
          textClosed = true;
        }
        if (currentBlockType === "tool_use" && currentToolUse) {
          // Parse accumulated input
          if (typeof currentToolUse.input === "string") {
            try { currentToolUse.input = JSON.parse(currentToolUse.input); } catch { currentToolUse.input = {}; }
          }
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex - 1 })}\n\n`);
          currentToolUse = null;
        }
        currentBlockType = null;
      }

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        console.log("[sse]", sseEvent, data.part?.part_kind || data.delta?.part_delta_kind || "");

        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
        }

        // Handle text PartStartEvent
        if (sseEvent === "PartStartEvent" && data.part?.part_kind === "text") {
          if (!textStarted) {
            closeCurrentBlock();
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`);
            textStarted = true;
            textClosed = false;
            currentBlockType = "text";
            blockIndex++;
          }
          continue;
        }

        // Handle text PartDeltaEvent
        if (sseEvent === "PartDeltaEvent" && data.delta?.part_delta_kind === "text") {
          if (currentBlockType !== "text") {
            closeCurrentBlock();
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`);
            textStarted = true;
            textClosed = false;
            currentBlockType = "text";
            blockIndex++;
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta", index: blockIndex - 1,
            delta: { type: "text_delta", text: data.delta.content_delta || "" },
          })}\n\n`);
          continue;
        }

        // Handle text PartEndEvent
        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "text") {
          if (currentBlockType === "text" && !textClosed) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex - 1 })}\n\n`);
            textClosed = true;
            currentBlockType = null;
          }
          continue;
        }

        // Handle tool-call PartStartEvent (ZO uses "tool-call" with hyphen)
        if (sseEvent === "PartStartEvent" && data.part?.part_kind === "tool-call") {
          closeCurrentBlock();
          currentToolUse = {
            type: "tool_use",
            id: data.part.tool_call_id || "toolu_" + uid(),
            name: data.part.tool_name,
            input: "",
          };
          contentBlocks.push(currentToolUse);
          currentBlockType = "tool_use";

          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start", index: blockIndex,
            content_block: { type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input: {} },
          })}\n\n`);
          blockIndex++;
          continue;
        }

        // Handle tool_call PartDeltaEvent (ZO uses "tool_call" with underscore)
        if (sseEvent === "PartDeltaEvent" && data.delta?.part_delta_kind === "tool_call" && currentToolUse) {
          const argsDelta = data.delta.args_delta || "";
          currentToolUse.input += argsDelta;
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta", index: blockIndex - 1,
            delta: { type: "input_json_delta", partial_json: argsDelta },
          })}\n\n`);
          continue;
        }

        // Handle FunctionToolCallEvent (complete tool call with validated args)
        if (sseEvent === "FunctionToolCallEvent") {
          const tc = data.part;
          if (currentToolUse && currentToolUse.id === tc.tool_call_id) {
            // Update existing tool call
            currentToolUse.input = tc.args || "{}";
          } else {
            // New tool call not started by PartStartEvent
            closeCurrentBlock();
            currentToolUse = {
              type: "tool_use",
              id: tc.tool_call_id || "toolu_" + uid(),
              name: tc.tool_name,
              input: tc.args || "{}",
            };
            contentBlocks.push(currentToolUse);
            currentBlockType = "tool_use";

            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input: {} },
            })}\n\n`);
            blockIndex++;

            // Send the full input as delta
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: blockIndex - 1,
              delta: { type: "input_json_delta", partial_json: currentToolUse.input },
            })}\n\n`);
          }
          continue;
        }

        // Handle tool-call PartEndEvent
        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "tool-call") {
          if (currentBlockType === "tool_use" && currentToolUse) {
            // Parse the accumulated input
            if (typeof currentToolUse.input === "string") {
              try { currentToolUse.input = JSON.parse(currentToolUse.input); } catch { currentToolUse.input = {}; }
            }
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex - 1 })}\n\n`);
            currentToolUse = null;
            currentBlockType = null;
          }
          continue;
        }
      }

      clearInterval(keepalive);

      // Close any remaining open block
      closeCurrentBlock();

      const stopReason = contentBlocks.length > 0 ? "tool_use" : "end_turn";
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: zoUsage.output },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    } else {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let zoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let toolUses = [];

      for await (const { sseEvent, data } of parseZoSse(reader, decoder)) {
        console.log("[sse]", sseEvent, data.part?.part_kind || data.delta?.part_delta_kind || "");

        if (sseEvent === "FrontendModelResponse") {
          zoUsage = extractUsage(data);
          const textParts = (data.parts || []).filter(p => p.part_kind === "text");
          if (textParts.length > 0) fullText = textParts.map(p => p.content).join("\n");
        }

        // Handle FunctionToolCallEvent (complete tool call)
        if (sseEvent === "FunctionToolCallEvent") {
          const tc = data.part;
          toolUses.push({
            type: "tool_use",
            id: tc.tool_call_id || "toolu_" + uid(),
            name: tc.tool_name,
            input: typeof tc.args === "string" ? JSON.parse(tc.args) : (tc.args || {}),
          });
        }

        if (sseEvent === "PartEndEvent" && data.part?.part_kind === "text" && data.part.content) {
          fullText = fullText || data.part.content;
        }
      }

      const content = [];
      if (fullText) content.push({ type: "text", text: fullText });
      content.push(...toolUses);

      res.json({
        id: "msg_" + uid(),
        type: "message",
        role: "assistant",
        content,
        model,
        stop_reason: toolUses.length > 0 ? "tool_use" : "end_turn",
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
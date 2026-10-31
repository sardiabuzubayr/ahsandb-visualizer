//! OpenAI-compatible chat completions with function calling: OpenAI, OpenRouter, DeepSeek, and
//! Gemini through its OpenAI-compatible endpoint.
use futures::future::BoxFuture;
use serde_json::{Value, json};

use super::{ChatItem, ChatModel, ChatRequest, ChatResponse, RawContent, StopKind, ToolCall, http_error, send_json};
use crate::error::AppResult;
use crate::model::{AiModel, AiProvider};

pub struct Client {
    provider: AiProvider,
    api_key: String,
}

impl Client {
    pub fn new(provider: AiProvider, api_key: String) -> Self {
        Self { provider, api_key }
    }
}

impl ChatModel for Client {
    fn complete<'a>(&'a self, req: &'a ChatRequest) -> BoxFuture<'a, AppResult<ChatResponse>> {
        Box::pin(async move {
            let http = request(self.provider, &self.api_key, reqwest::Method::POST, "chat/completions")
                .json(&build_request(self.provider, req));
            let v = send_json(self.provider, http).await?;
            // OpenRouter can report an upstream failure as HTTP 200 with an `error` object.
            if v["error"].is_object() {
                let code = v["error"]["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(502);
                return Err(http_error(self.provider, code, &v.to_string()));
            }
            Ok(parse_response(self.provider, &v))
        })
    }
}

pub async fn list_models(provider: AiProvider, api_key: &str) -> AppResult<Vec<AiModel>> {
    if provider == AiProvider::Openrouter {
        // OpenRouter's model list is public; this call is what rejects a bad key.
        send_json(provider, request(provider, api_key, reqwest::Method::GET, "key")).await?;
    }
    let v = send_json(provider, request(provider, api_key, reqwest::Method::GET, "models")).await?;
    Ok(parse_models(provider, &v))
}

fn base_url(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Openai => "https://api.openai.com/v1",
        AiProvider::Openrouter => "https://openrouter.ai/api/v1",
        AiProvider::Deepseek => "https://api.deepseek.com",
        AiProvider::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai",
        AiProvider::Anthropic => unreachable!("Anthropic uses ai::anthropic"),
    }
}

fn request(provider: AiProvider, api_key: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let http = super::http().request(method, format!("{}/{path}", base_url(provider))).bearer_auth(api_key);
    match provider {
        // OpenRouter app attribution; the referer is the Tauri webview origin.
        AiProvider::Openrouter => http.header("HTTP-Referer", "tauri://localhost").header("X-Title", "AhsanDB"),
        _ => http,
    }
}

pub fn build_request(provider: AiProvider, req: &ChatRequest) -> Value {
    let mut messages = Vec::new();
    if !req.system.is_empty() {
        messages.push(json!({"role": "system", "content": req.system}));
    }
    for item in &req.items {
        match item {
            ChatItem::User { text } => messages.push(json!({"role": "user", "content": text})),
            // Same provider: the stored message object as-is (keeps e.g. DeepSeek `reasoning_content`).
            ChatItem::Assistant { raw: Some(RawContent { provider: p, content }), .. } if *p == provider => {
                messages.push(content.clone())
            }
            ChatItem::Assistant { text, tool_calls, .. } => {
                if text.is_empty() && tool_calls.is_empty() {
                    continue;
                }
                let mut msg = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = tool_calls
                        .iter()
                        .map(|c| {
                            json!({"id": c.id, "type": "function",
                                "function": {"name": c.name, "arguments": c.input.to_string()}})
                        })
                        .collect();
                }
                messages.push(msg);
            }
            ChatItem::ToolResults { results } => {
                for r in results {
                    // The tool role has no error flag; say it in the content.
                    let content = if r.is_error { format!("Error: {}", r.content) } else { r.content.clone() };
                    messages.push(json!({"role": "tool", "tool_call_id": r.call_id, "content": content}));
                }
            }
        }
    }
    let mut body = json!({"model": req.model, "messages": messages});
    // Newer OpenAI models reject `max_tokens`.
    let max_key = if provider == AiProvider::Openai { "max_completion_tokens" } else { "max_tokens" };
    body[max_key] = json!(req.max_tokens);
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}))
            .collect();
        body["tool_choice"] = json!(if req.allow_tools { "auto" } else { "none" });
    }
    body
}

pub fn parse_response(provider: AiProvider, v: &Value) -> ChatResponse {
    let msg = &v["choices"][0]["message"];
    let tool_calls: Vec<ToolCall> = msg["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let args = &c["function"]["arguments"];
            let input = match args.as_str() {
                Some(s) if s.trim().is_empty() => json!({}),
                // Bad JSON is kept so the agent loop can report "invalid arguments" to the model.
                Some(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({"_raw": s})),
                None if args.is_null() => json!({}),
                None => args.clone(),
            };
            ToolCall {
                id: c["id"].as_str().unwrap_or_default().to_string(),
                name: c["function"]["name"].as_str().unwrap_or_default().to_string(),
                input,
            }
        })
        .collect();
    let stop = match v["choices"][0]["finish_reason"].as_str() {
        Some("length") => StopKind::MaxTokens,
        Some("content_filter") => StopKind::Refusal,
        // Some compat endpoints report "stop" alongside tool calls.
        _ if !tool_calls.is_empty() => StopKind::ToolUse,
        _ => StopKind::EndTurn,
    };
    ChatResponse {
        text: msg["content"].as_str().unwrap_or_default().to_string(),
        tool_calls,
        raw: msg.is_object().then(|| RawContent { provider, content: msg.clone() }),
        stop,
        input_tokens: v["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        output_tokens: v["usage"]["completion_tokens"].as_u64().unwrap_or(0),
    }
}

/// `/models` → chat models with tool calling. OpenRouter says so per model; OpenAI and Gemini are
/// filtered by id.
// shortcut: id heuristics for OpenAI/Gemini (their /models has no capability data), revisit when new
// non-chat families appear in the list.
pub fn parse_models(provider: AiProvider, v: &Value) -> Vec<AiModel> {
    let has = |id: &str, parts: &[&str]| parts.iter().any(|p| id.contains(p));
    let mut models: Vec<AiModel> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let raw_id = m["id"].as_str()?;
            let id = raw_id.strip_prefix("models/").unwrap_or(raw_id).to_string();
            let keep = match provider {
                AiProvider::Openrouter => m["supported_parameters"].as_array().is_some_and(|p| p.iter().any(|x| x == "tools")),
                AiProvider::Openai => {
                    ["gpt-", "o1", "o3", "o4", "chatgpt-"].iter().any(|p| id.starts_with(p))
                        && !has(&id, &["audio", "realtime", "tts", "transcribe", "image", "search", "embedding", "moderation", "instruct"])
                }
                AiProvider::Gemini => {
                    id.contains("gemini") && !has(&id, &["embedding", "image", "tts", "aqa", "live", "native-audio"])
                }
                _ => true,
            };
            let name = match provider {
                AiProvider::Openrouter => m["name"].as_str().unwrap_or(&id).to_string(),
                _ => id.clone(),
            };
            keep.then_some(AiModel { id, name })
        })
        .collect();
    if matches!(provider, AiProvider::Openai | AiProvider::Gemini) {
        models.sort_by(|a, b| b.id.cmp(&a.id));
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{ToolResult, ToolSpec};

    fn req(items: Vec<ChatItem>, allow_tools: bool) -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            system: "sys".into(),
            items,
            tools: vec![ToolSpec {
                name: "run_sql".into(),
                description: "Run SQL".into(),
                input_schema: json!({"type": "object", "properties": {"sql": {"type": "string"}}}),
            }],
            allow_tools,
            max_tokens: 4096,
        }
    }

    fn call() -> ToolCall {
        ToolCall { id: "call_1".into(), name: "run_sql".into(), input: json!({"sql": "select 1"}) }
    }

    fn history(raw_provider: AiProvider) -> Vec<ChatItem> {
        vec![
            ChatItem::User { text: "count".into() },
            ChatItem::Assistant {
                text: String::new(),
                tool_calls: vec![call()],
                raw: Some(RawContent {
                    provider: raw_provider,
                    content: json!({"role": "assistant", "content": null, "reasoning_content": "think",
                        "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "run_sql", "arguments": "{\"sql\":\"select 1\"}"}}]}),
                }),
            },
            ChatItem::ToolResults {
                results: vec![
                    ToolResult { call_id: "call_1".into(), content: "1 row".into(), is_error: false },
                    ToolResult { call_id: "call_2".into(), content: "syntax".into(), is_error: true },
                ],
            },
        ]
    }

    #[test]
    fn request_snapshot_deepseek_with_raw_replay() {
        let body = build_request(AiProvider::Deepseek, &req(history(AiProvider::Deepseek), true));
        assert_eq!(
            body,
            json!({
                "model": "m",
                "max_tokens": 4096,
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "count"},
                    {"role": "assistant", "content": null, "reasoning_content": "think",
                        "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "run_sql", "arguments": "{\"sql\":\"select 1\"}"}}]},
                    {"role": "tool", "tool_call_id": "call_1", "content": "1 row"},
                    {"role": "tool", "tool_call_id": "call_2", "content": "Error: syntax"}
                ],
                "tools": [{"type": "function", "function": {"name": "run_sql", "description": "Run SQL",
                    "parameters": {"type": "object", "properties": {"sql": {"type": "string"}}}}}],
                "tool_choice": "auto"
            })
        );
    }

    #[test]
    fn foreign_raw_is_rebuilt_and_openai_uses_max_completion_tokens() {
        let body = build_request(AiProvider::Openai, &req(history(AiProvider::Deepseek), false));
        assert_eq!(
            body["messages"][2],
            json!({"role": "assistant", "content": null,
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "run_sql", "arguments": "{\"sql\":\"select 1\"}"}}]})
        );
        assert_eq!(body["tool_choice"], "none");
        assert_eq!(body["max_completion_tokens"], 4096);
        assert!(body.get("max_tokens").is_none());
        for p in [AiProvider::Gemini, AiProvider::Openrouter] {
            assert_eq!(build_request(p, &req(vec![], true))["max_tokens"], 4096);
        }
        let mut no_tools = req(vec![], true);
        no_tools.tools.clear();
        let body = build_request(AiProvider::Gemini, &no_tools);
        assert!(body.get("tools").is_none() && body.get("tool_choice").is_none());
    }

    #[test]
    fn parses_tool_calls_with_string_and_invalid_args() {
        let v = json!({
            "choices": [{"finish_reason": "tool_calls", "message": {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "run_sql", "arguments": "{\"sql\":\"select 1\"}"}},
                {"id": "call_2", "type": "function", "function": {"name": "run_sql", "arguments": "{\"sql\": \"select"}}
            ]}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 7}
        });
        let r = parse_response(AiProvider::Openai, &v);
        assert_eq!(r.text, "");
        assert_eq!(r.stop, StopKind::ToolUse);
        assert_eq!(r.tool_calls[0], call());
        assert_eq!(r.tool_calls[1].input, json!({"_raw": "{\"sql\": \"select"}));
        assert_eq!((r.input_tokens, r.output_tokens), (50, 7));
        assert_eq!(r.raw, Some(RawContent { provider: AiProvider::Openai, content: v["choices"][0]["message"].clone() }));
    }

    #[test]
    fn parses_finish_reasons() {
        let resp = |finish: &str, content: Value| json!({"choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}]});
        let r = parse_response(AiProvider::Deepseek, &resp("stop", json!("Done.")));
        assert_eq!((r.stop, r.text.as_str()), (StopKind::EndTurn, "Done."));
        assert_eq!(parse_response(AiProvider::Gemini, &resp("length", json!("Par"))).stop, StopKind::MaxTokens);
        assert_eq!(parse_response(AiProvider::Openai, &resp("content_filter", Value::Null)).stop, StopKind::Refusal);
        // Gemini-style "stop" with tool calls still means tool use.
        let v = json!({"choices": [{"finish_reason": "stop", "message": {"role": "assistant",
            "tool_calls": [{"id": "c", "type": "function", "function": {"name": "run_sql", "arguments": "{}"}}]}}]});
        assert_eq!(parse_response(AiProvider::Gemini, &v).stop, StopKind::ToolUse);
    }

    fn ids(models: Vec<AiModel>) -> Vec<String> {
        models.into_iter().map(|m| m.id).collect()
    }

    #[test]
    fn filters_models_per_provider() {
        let openai = json!({"data": [
            {"id": "gpt-4o"}, {"id": "gpt-5"}, {"id": "o3-mini"}, {"id": "chatgpt-4o-latest"},
            {"id": "gpt-4o-audio-preview"}, {"id": "gpt-4o-realtime-preview"}, {"id": "gpt-image-1"},
            {"id": "gpt-4o-search-preview"}, {"id": "gpt-3.5-turbo-instruct"}, {"id": "text-embedding-3-small"},
            {"id": "omni-moderation-latest"}, {"id": "whisper-1"}, {"id": "dall-e-3"}, {"id": "gpt-4o-mini-tts"}
        ]});
        assert_eq!(ids(parse_models(AiProvider::Openai, &openai)), ["o3-mini", "gpt-5", "gpt-4o", "chatgpt-4o-latest"]);

        let gemini = json!({"data": [
            {"id": "models/gemini-2.5-flash"}, {"id": "models/gemini-2.5-pro"}, {"id": "models/gemini-embedding-001"},
            {"id": "models/gemini-2.5-flash-image"}, {"id": "models/gemini-2.5-flash-preview-tts"},
            {"id": "models/gemini-live-2.5-flash"}, {"id": "models/aqa"}, {"id": "models/imagen-4.0-generate-001"}
        ]});
        assert_eq!(
            parse_models(AiProvider::Gemini, &gemini),
            vec![
                AiModel { id: "gemini-2.5-pro".into(), name: "gemini-2.5-pro".into() },
                AiModel { id: "gemini-2.5-flash".into(), name: "gemini-2.5-flash".into() },
            ]
        );

        let openrouter = json!({"data": [
            {"id": "anthropic/claude-opus-5-5", "name": "Anthropic: Claude Opus 5.5", "supported_parameters": ["tools", "max_tokens"]},
            {"id": "some/no-tools", "name": "No tools", "supported_parameters": ["max_tokens"]},
            {"id": "some/unknown", "name": "Unknown"}
        ]});
        assert_eq!(
            parse_models(AiProvider::Openrouter, &openrouter),
            vec![AiModel { id: "anthropic/claude-opus-5-5".into(), name: "Anthropic: Claude Opus 5.5".into() }]
        );

        let deepseek = json!({"data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}]});
        assert_eq!(ids(parse_models(AiProvider::Deepseek, &deepseek)), ["deepseek-chat", "deepseek-reasoner"]);
    }
}

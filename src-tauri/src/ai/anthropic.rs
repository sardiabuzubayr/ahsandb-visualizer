//! Anthropic Messages API (raw HTTP; no official Rust SDK). `POST https://api.anthropic.com/v1/messages`,
//! headers `x-api-key`, `anthropic-version: 2023-06-01`.
use futures::future::BoxFuture;
use serde_json::{Value, json};

use super::{ChatItem, ChatModel, ChatRequest, ChatResponse, RawContent, StopKind, ToolCall, send_json};
use crate::error::AppResult;
use crate::model::{AiModel, AiProvider};

const API: &str = "https://api.anthropic.com/v1";
const VERSION: &str = "2023-06-01";
/// Header for the scalar `fallbacks: "default"` form (the array form uses a different date).
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub struct Client {
    api_key: String,
}

impl Client {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

impl ChatModel for Client {
    fn complete<'a>(&'a self, req: &'a ChatRequest) -> BoxFuture<'a, AppResult<ChatResponse>> {
        Box::pin(async move {
            let mut http = super::http()
                .post(format!("{API}/messages"))
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", VERSION)
                .json(&build_request(req));
            if uses_fallbacks(&req.model) {
                http = http.header("anthropic-beta", FALLBACK_BETA);
            }
            Ok(parse_response(&send_json(AiProvider::Anthropic, http).await?))
        })
    }
}

pub async fn list_models(api_key: &str) -> AppResult<Vec<AiModel>> {
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    loop {
        // Model ids are URL-safe ([a-z0-9.-]), so no encoding.
        let cursor = after.take().map(|id| format!("&after_id={id}")).unwrap_or_default();
        let http = super::http()
            .get(format!("{API}/models?limit=100{cursor}"))
            .header("x-api-key", api_key)
            .header("anthropic-version", VERSION);
        let page = send_json(AiProvider::Anthropic, http).await?;
        models.extend(parse_models(&page));
        match page["last_id"].as_str() {
            Some(last) if page["has_more"].as_bool() == Some(true) => after = Some(last.to_string()),
            _ => return Ok(models),
        }
    }
}

/// Models whose server-side refusal fallback is opted into.
fn uses_fallbacks(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5")
}

pub fn build_request(req: &ChatRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "messages": messages(&req.items),
        // No `thinking` (adaptive is the default where supported) and no sampling params.
        "output_config": {"effort": "medium"},
        "cache_control": {"type": "ephemeral"},
    });
    if !req.system.is_empty() {
        body["system"] = json!(req.system);
    }
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.input_schema}))
            .collect();
        // Never `any`/`tool`: current models reject forced tool use.
        body["tool_choice"] = json!({"type": if req.allow_tools { "auto" } else { "none" }});
    }
    if uses_fallbacks(&req.model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// Neutral history → Messages API turns: same-role neighbours merged, first message is user.
fn messages(items: &[ChatItem]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for item in items {
        let (role, blocks): (&str, Vec<Value>) = match item {
            ChatItem::User { text, .. } => ("user", vec![json!({"type": "text", "text": text})]),
            // Own blocks (thinking, fallback markers…) must go back unchanged.
            ChatItem::Assistant { raw: Some(RawContent { provider: AiProvider::Anthropic, content }), .. } => {
                ("assistant", content.as_array().cloned().unwrap_or_default())
            }
            ChatItem::Assistant { text, tool_calls, .. } => {
                let text = (!text.is_empty()).then(|| json!({"type": "text", "text": text}));
                let calls = tool_calls.iter().map(|c| json!({"type": "tool_use", "id": c.id, "name": c.name, "input": c.input}));
                ("assistant", text.into_iter().chain(calls).collect())
            }
            ChatItem::ToolResults { results } => (
                "user",
                results
                    .iter()
                    .map(|r| json!({"type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error}))
                    .collect(),
            ),
        };
        if blocks.is_empty() || (out.is_empty() && role == "assistant") {
            continue;
        }
        match out.last_mut() {
            Some(last) if last["role"] == role => last["content"].as_array_mut().expect("content array").extend(blocks),
            _ => out.push(json!({"role": role, "content": blocks})),
        }
    }
    out
}

pub fn parse_response(v: &Value) -> ChatResponse {
    let content = v.get("content").filter(|c| c.is_array()).cloned().unwrap_or_else(|| json!([]));
    let blocks = content.as_array().expect("array");
    let text = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    let tool_calls = blocks
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| ToolCall {
            id: b["id"].as_str().unwrap_or_default().to_string(),
            name: b["name"].as_str().unwrap_or_default().to_string(),
            input: b["input"].clone(),
        })
        .collect();
    let stop = match v["stop_reason"].as_str() {
        Some("tool_use") => StopKind::ToolUse,
        Some("max_tokens") => StopKind::MaxTokens,
        Some("refusal") => StopKind::Refusal,
        // `pause_turn` only comes from server-side tools, which are never sent here.
        _ => StopKind::EndTurn,
    };
    ChatResponse {
        text,
        tool_calls,
        raw: Some(RawContent { provider: AiProvider::Anthropic, content }),
        stop,
        input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: v["usage"]["output_tokens"].as_u64().unwrap_or(0),
    }
}

/// One `/v1/models` page, newest first as returned. Drops models without `effort` support (every
/// request sends `output_config.effort`); models without a capability tree are kept.
pub fn parse_models(v: &Value) -> Vec<AiModel> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["capabilities"]["effort"]["supported"] != json!(false))
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            let name = m["display_name"].as_str().unwrap_or(&id).to_string();
            Some(AiModel { id, name })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{ToolResult, ToolSpec};

    fn req(model: &str, items: Vec<ChatItem>, allow_tools: bool) -> ChatRequest {
        ChatRequest {
            model: model.into(),
            system: "You are a DB assistant.".into(),
            items,
            tools: vec![ToolSpec {
                name: "run_sql".into(),
                description: "Run SQL".into(),
                input_schema: json!({"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]}),
            }],
            allow_tools,
            max_tokens: 16000,
        }
    }

    fn user(t: &str) -> ChatItem {
        ChatItem::User { text: t.into(), id: None }
    }

    fn call() -> ToolCall {
        ToolCall { id: "toolu_1".into(), name: "run_sql".into(), input: json!({"sql": "select 1"}) }
    }

    #[test]
    fn request_snapshot_with_tools_and_fallbacks() {
        let body = build_request(&req("claude-opus-5-5", vec![user("hi")], true));
        assert_eq!(
            body,
            json!({
                "model": "claude-opus-5-5",
                "max_tokens": 16000,
                "system": "You are a DB assistant.",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                "tools": [{"name": "run_sql", "description": "Run SQL",
                    "input_schema": {"type": "object", "properties": {"sql": {"type": "string"}}, "required": ["sql"]}}],
                "tool_choice": {"type": "auto"},
                "output_config": {"effort": "medium"},
                "cache_control": {"type": "ephemeral"},
                "fallbacks": "default",
            })
        );
        assert!(body.get("thinking").is_none() && body.get("temperature").is_none());
    }

    #[test]
    fn tool_choice_none_and_fallbacks_only_on_listed_models() {
        let body = build_request(&req("claude-haiku-5-5", vec![user("hi")], false));
        assert_eq!(body["tool_choice"], json!({"type": "none"}));
        assert!(body.get("fallbacks").is_none());
        for m in ["claude-opus-5", "claude-sonnet-5-5"] {
            assert_eq!(build_request(&req(m, vec![user("hi")], true))["fallbacks"], "default");
        }
        assert!(build_request(&req("claude-sonnet-5", vec![user("hi")], true)).get("fallbacks").is_none());
        let mut no_tools = req("claude-opus-5-5", vec![user("hi")], true);
        no_tools.tools.clear();
        let body = build_request(&no_tools);
        assert!(body.get("tools").is_none() && body.get("tool_choice").is_none());
    }

    #[test]
    fn replays_own_raw_blocks_and_rebuilds_foreign_ones() {
        let raw = json!([
            {"type": "thinking", "thinking": "", "signature": "sig"},
            {"type": "tool_use", "id": "toolu_1", "name": "run_sql", "input": {"sql": "select 1"}}
        ]);
        let results = ChatItem::ToolResults {
            results: vec![ToolResult { call_id: "toolu_1".into(), content: "1 row".into(), is_error: false }],
        };
        let items = |provider| {
            vec![
                user("count"),
                ChatItem::Assistant {
                    text: "Checking.".into(),
                    tool_calls: vec![call()],
                    raw: Some(RawContent { provider, content: raw.clone() }),
                },
                results.clone(),
                user("thanks"),
            ]
        };
        let own = build_request(&req("claude-opus-5-5", items(AiProvider::Anthropic), true));
        assert_eq!(own["messages"][1], json!({"role": "assistant", "content": raw}));
        // Tool results and the following user text merge into one user turn, results first.
        assert_eq!(
            own["messages"][2],
            json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "1 row", "is_error": false},
                {"type": "text", "text": "thanks"}
            ]})
        );
        assert_eq!(own["messages"].as_array().unwrap().len(), 3);

        let foreign = build_request(&req("claude-opus-5-5", items(AiProvider::Openai), true));
        assert_eq!(
            foreign["messages"][1],
            json!({"role": "assistant", "content": [
                {"type": "text", "text": "Checking."},
                {"type": "tool_use", "id": "toolu_1", "name": "run_sql", "input": {"sql": "select 1"}}
            ]})
        );
    }

    #[test]
    fn leading_assistant_dropped_and_empty_assistant_skipped() {
        let items = vec![
            ChatItem::Assistant { text: "stale".into(), tool_calls: vec![], raw: None },
            user("a"),
            ChatItem::Assistant { text: String::new(), tool_calls: vec![], raw: None },
            user("b"),
        ];
        let body = build_request(&req("claude-opus-5-5", items, true));
        assert_eq!(
            body["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}])
        );
    }

    #[test]
    fn parses_text_and_tool_use() {
        let v = json!({
            "content": [
                {"type": "thinking", "thinking": "", "signature": "s"},
                {"type": "text", "text": "Let me look."},
                {"type": "tool_use", "id": "toolu_1", "name": "run_sql", "input": {"sql": "select 1"}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 120, "output_tokens": 45}
        });
        let r = parse_response(&v);
        assert_eq!(r.text, "Let me look.");
        assert_eq!(r.tool_calls, vec![call()]);
        assert_eq!(r.stop, StopKind::ToolUse);
        assert_eq!((r.input_tokens, r.output_tokens), (120, 45));
        assert_eq!(r.raw, Some(RawContent { provider: AiProvider::Anthropic, content: v["content"].clone() }));
    }

    #[test]
    fn parses_refusal_max_tokens_and_unknown_stop() {
        let r = parse_response(&json!({"content": [], "stop_reason": "refusal", "stop_details": null, "usage": {"input_tokens": 9, "output_tokens": 0}}));
        assert_eq!((r.stop, r.text.as_str(), r.tool_calls.len()), (StopKind::Refusal, "", 0));
        let r = parse_response(&json!({"content": [{"type": "text", "text": "Partial"}], "stop_reason": "max_tokens"}));
        assert_eq!((r.stop, r.text.as_str()), (StopKind::MaxTokens, "Partial"));
        assert_eq!(parse_response(&json!({"content": [], "stop_reason": "pause_turn"})).stop, StopKind::EndTurn);
        assert_eq!(parse_response(&json!({"content": [], "stop_reason": "end_turn"})).stop, StopKind::EndTurn);
    }

    #[test]
    fn parses_models_page() {
        let page = json!({
            "data": [
                {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "capabilities": {"effort": {"supported": true}}},
                {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "capabilities": {"effort": {"supported": false}}},
                {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5"}
            ],
            "has_more": false, "last_id": "claude-sonnet-5-5"
        });
        assert_eq!(
            parse_models(&page),
            vec![
                AiModel { id: "claude-opus-5-5".into(), name: "Claude Opus 5.5".into() },
                AiModel { id: "claude-sonnet-5-5".into(), name: "Claude Sonnet 5.5".into() },
            ]
        );
    }
}

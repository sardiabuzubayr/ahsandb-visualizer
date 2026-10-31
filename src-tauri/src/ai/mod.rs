//! AI agent: provider adapters (Anthropic Messages API; OpenAI-compatible chat completions for
//! OpenAI, OpenRouter, DeepSeek and Gemini's OpenAI endpoint) and the agent loop with approvals.
pub mod agent;
pub mod risk;
pub mod tools;
pub mod anthropic;
pub mod openai;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::{AiModel, AiProvider};

/// A tool the model may call (JSON Schema input).
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider's call id, echoed back in the result.
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub content: String,
    pub is_error: bool,
}

/// Provider-neutral conversation history (persisted per connection).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatItem {
    User { text: String },
    /// `raw` = the provider's own assistant content (e.g. Anthropic blocks incl. thinking), replayed
    /// unchanged when the next request goes to the same provider; other providers use text + calls.
    Assistant { text: String, tool_calls: Vec<ToolCall>, raw: Option<RawContent> },
    ToolResults { results: Vec<ToolResult> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawContent {
    pub provider: AiProvider,
    pub content: Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: String,
    pub items: Vec<ChatItem>,
    pub tools: Vec<ToolSpec>,
    /// false = the model must answer in text (sent with tool choice "none"), e.g. after a rejection.
    pub allow_tools: bool,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopKind {
    EndTurn,
    ToolUse,
    MaxTokens,
    /// Declined by the provider's safety system.
    Refusal,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub raw: Option<RawContent>,
    pub stop: StopKind,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// One provider + key. Implemented by `anthropic::Client` and `openai::Client`; tests use fakes.
pub trait ChatModel: Send + Sync {
    fn complete<'a>(&'a self, req: &'a ChatRequest) -> BoxFuture<'a, AppResult<ChatResponse>>;
}

/// The client for a provider (no network until `complete`).
pub fn client(provider: AiProvider, api_key: String) -> Box<dyn ChatModel> {
    match provider {
        AiProvider::Anthropic => Box::new(anthropic::Client::new(api_key)),
        p => Box::new(openai::Client::new(p, api_key)),
    }
}

/// Models with tool calling the key can use; also the "Test key" call (bad key → `AppError::Auth`).
pub async fn list_models(provider: AiProvider, api_key: &str) -> AppResult<Vec<AiModel>> {
    match provider {
        AiProvider::Anthropic => anthropic::list_models(api_key).await,
        p => openai::list_models(p, api_key).await,
    }
}

/// Maps an HTTP status + body from a provider to an app error (401/403 → Auth, 429 → rate limit…).
pub fn http_error(provider: AiProvider, status: u16, body: &str) -> AppError {
    let p = provider.as_str();
    let msg = error_message(body);
    match status {
        401 | 403 => AppError::Auth(format!("{p}: invalid API key or no access to this model ({msg})")),
        // Gemini answers a bad key with 400 INVALID_ARGUMENT / API_KEY_INVALID.
        400 if body.contains("API_KEY_INVALID") => AppError::Auth(format!("{p}: invalid API key ({msg})")),
        // 402 = OpenRouter out of credit.
        402 | 429 => AppError::Connection(format!("{p}: rate limited or out of credit, try again later ({msg})")),
        500..=599 => AppError::Connection(format!("{p}: provider unavailable (HTTP {status}), try again later ({msg})")),
        _ => AppError::Query(format!("{p} returned HTTP {status}: {msg}")),
    }
}

/// The message inside a provider's error JSON (`{error:{message}}`, Gemini: `[{error:{message}}]`),
/// else the body itself (truncated).
fn error_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let v = v.get(0).unwrap_or(&v);
    let found = v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str());
    match found {
        Some(m) => m.to_string(),
        None if body.trim().is_empty() => "no details".into(),
        None => body.chars().take(300).collect(),
    }
}

/// One HTTP client for all providers (connect 10 s, whole request 120 s).
fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("TLS backend for the AI HTTP client")
    })
}

/// Sends the request; non-2xx → `http_error`, network/timeout → `Connection`, body → JSON.
async fn send_json(provider: AiProvider, req: reqwest::RequestBuilder) -> AppResult<Value> {
    let net = |e: reqwest::Error| {
        let what = if e.is_timeout() { "request timed out" } else { "provider unreachable" };
        // reqwest's Display hides the cause (DNS, refused, TLS…); append the source chain.
        let mut detail = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            detail = format!("{detail}: {s}");
            src = s.source();
        }
        AppError::Connection(format!("{}: {what} ({detail})", provider.as_str()))
    };
    let resp = req.send().await.map_err(net)?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(net)?;
    if !(200..300).contains(&status) {
        return Err(http_error(provider, status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AppError::Query(format!("{}: unreadable response ({e})", provider.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_error_mapping() {
        let anth = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        match http_error(AiProvider::Anthropic, 401, anth) {
            AppError::Auth(m) => assert!(m.contains("invalid x-api-key") && m.starts_with("anthropic:"), "{m}"),
            e => panic!("{e:?}"),
        }
        assert!(matches!(http_error(AiProvider::Openai, 403, "{}"), AppError::Auth(_)));
        let gemini = r#"[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}]"#;
        match http_error(AiProvider::Gemini, 400, gemini) {
            AppError::Auth(m) => assert!(m.contains("API key not valid"), "{m}"),
            e => panic!("{e:?}"),
        }
        match http_error(AiProvider::Openai, 429, r#"{"error":{"message":"You exceeded your current quota"}}"#) {
            AppError::Connection(m) => assert!(m.contains("rate limited") && m.contains("exceeded your current quota"), "{m}"),
            e => panic!("{e:?}"),
        }
        assert!(matches!(http_error(AiProvider::Openrouter, 402, "{}"), AppError::Connection(_)));
        match http_error(AiProvider::Anthropic, 529, r#"{"error":{"type":"overloaded_error","message":"Overloaded"}}"#) {
            AppError::Connection(m) => assert!(m.contains("unavailable") && m.contains("Overloaded"), "{m}"),
            e => panic!("{e:?}"),
        }
        assert!(matches!(http_error(AiProvider::Deepseek, 503, ""), AppError::Connection(_)));
        match http_error(AiProvider::Openai, 400, r#"{"error":{"message":"Unsupported parameter: 'max_tokens'"}}"#) {
            AppError::Query(m) => assert_eq!(m, "openai returned HTTP 400: Unsupported parameter: 'max_tokens'"),
            e => panic!("{e:?}"),
        }
        match http_error(AiProvider::Deepseek, 404, "<html>nope</html>") {
            AppError::Query(m) => assert!(m.ends_with("<html>nope</html>"), "{m}"),
            e => panic!("{e:?}"),
        }
    }
}

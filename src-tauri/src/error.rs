use serde::Serialize;

use crate::model::HostKeyInfo;

/// Error returned by every command. Serialized as `{ kind, message, detail? }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    /// Server unreachable, timeout, TLS failure.
    #[error("{0}")]
    Connection(String),
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Query(String),
    #[error("Query cancelled")]
    Cancelled,
    /// Writes on a production connection need `confirmed: true`. Carries the write statements.
    #[error("These statements change data or structure on a production connection")]
    NeedsConfirmation(Vec<String>),
    #[error("This connection is read-only")]
    ReadOnly(Vec<String>),
    #[error("{0}")]
    NotSupported(String),
    /// First connection to this SSH server: the user must decide whether to trust its key.
    #[error("The SSH server {}:{} is not known yet", .0.host, .0.port)]
    HostKeyUnknown(HostKeyInfo),
    /// The SSH server's key differs from the trusted one (possible man-in-the-middle). Never auto-accepted.
    #[error("The SSH host key of {}:{} has changed", .0.host, .0.port)]
    HostKeyMismatch(HostKeyInfo),
    #[error("{0}")]
    Secrets(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "notFound",
            AppError::Connection(_) => "connection",
            AppError::Auth(_) => "auth",
            AppError::Query(_) => "query",
            AppError::Cancelled => "cancelled",
            AppError::NeedsConfirmation(_) => "needsConfirmation",
            AppError::ReadOnly(_) => "readOnly",
            AppError::NotSupported(_) => "notSupported",
            AppError::HostKeyUnknown(_) => "hostKeyUnknown",
            AppError::HostKeyMismatch(_) => "hostKeyMismatch",
            AppError::Secrets(_) => "secrets",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 4)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        match self {
            AppError::NeedsConfirmation(v) | AppError::ReadOnly(v) => st.serialize_field("detail", v)?,
            _ => st.skip_field("detail")?,
        }
        match self {
            AppError::HostKeyUnknown(k) | AppError::HostKeyMismatch(k) => st.serialize_field("hostKey", k)?,
            _ => st.skip_field("hostKey")?,
        }
        st.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

/// Maps driver errors to user-facing kinds. Auth failures and unreachable servers get their own
/// kinds so the UI can say what to fix.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed => {
                AppError::Connection(e.to_string())
            }
            sqlx::Error::Database(db) => {
                // 28P01/28000 = PostgreSQL auth; 1045 = MySQL access denied.
                let code = db.code().map(|c| c.into_owned()).unwrap_or_default();
                if matches!(code.as_str(), "28P01" | "28000" | "1045") {
                    AppError::Auth(db.message().to_string())
                } else {
                    AppError::Query(db.message().to_string())
                }
            }
            sqlx::Error::RowNotFound => AppError::NotFound(e.to_string()),
            _ => AppError::Internal(e.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_message_and_detail() {
        let v = serde_json::to_value(AppError::NeedsConfirmation(vec!["DROP TABLE x".into()])).unwrap();
        assert_eq!(v["kind"], "needsConfirmation");
        assert_eq!(v["detail"][0], "DROP TABLE x");
        let v = serde_json::to_value(AppError::Auth("bad password".into())).unwrap();
        assert_eq!(v["kind"], "auth");
        assert!(v.get("detail").is_none());
    }
}

//! Converts driver rows to JSON cells and column metadata.
//!
//! PostgreSQL and MySQL rows must come from the text protocol (`sqlx::raw_sql`): every value then
//! arrives as the server's own text, which keeps decimals exact and timestamps with their zone.
use serde_json::{Number, Value};
use sqlx::mysql::{MySql, MySqlQueryResult, MySqlRow};
use sqlx::postgres::{PgColumn, PgQueryResult, PgRow, PgValueFormat, Postgres};
use sqlx::sqlite::{Sqlite, SqliteQueryResult, SqliteRow};
use sqlx::{Column as _, Decode, Row, TypeInfo, ValueRef};

use crate::model::{Cell, Column};

/// Per-driver row conversion used by execute and paging.
pub(crate) trait Dialect: sqlx::Database {
    fn cells(row: &Self::Row) -> Vec<Cell>;
    fn affected(r: &Self::QueryResult) -> u64;
}

impl Dialect for Postgres {
    fn cells(row: &PgRow) -> Vec<Cell> {
        (0..row.len())
            .map(|i| {
                let ty = row.column(i).type_info().name();
                match row.try_get_raw(i) {
                    Ok(v) if v.is_null() => Value::Null,
                    Ok(v) if v.format() == PgValueFormat::Text => {
                        v.as_bytes().map_or_else(|_| placeholder(ty), |b| text_cell(ty, b))
                    }
                    // shortcut: binary-format rows (prepared statements) aren't decoded; all callers use raw_sql.
                    _ => placeholder(ty),
                }
            })
            .collect()
    }
    fn affected(r: &PgQueryResult) -> u64 {
        r.rows_affected()
    }
}

impl Dialect for MySql {
    fn cells(row: &MySqlRow) -> Vec<Cell> {
        (0..row.len())
            .map(|i| {
                let ty = row.column(i).type_info().name();
                match row.try_get_raw(i) {
                    Ok(v) if v.is_null() => Value::Null,
                    Ok(v) => <&[u8] as Decode<MySql>>::decode(v).map_or_else(|_| placeholder(ty), |b| text_cell(ty, b)),
                    Err(_) => placeholder(ty),
                }
            })
            .collect()
    }
    fn affected(r: &MySqlQueryResult) -> u64 {
        r.rows_affected()
    }
}

impl Dialect for Sqlite {
    // SQLite values carry their own storage class, independent of the declared column type.
    fn cells(row: &SqliteRow) -> Vec<Cell> {
        (0..row.len())
            .map(|i| {
                let Ok(v) = row.try_get_raw(i) else { return Value::Null };
                if v.is_null() {
                    return Value::Null;
                }
                let class = v.type_info().name().to_string();
                let cell = match class.as_str() {
                    "INTEGER" => <i64 as Decode<Sqlite>>::decode(v).map(|n| int_cell(&n.to_string())),
                    "REAL" => <f64 as Decode<Sqlite>>::decode(v).map(|f| float_cell(&f.to_string())),
                    "BLOB" => <&[u8] as Decode<Sqlite>>::decode(v).map(bytes_cell),
                    _ => <String as Decode<Sqlite>>::decode(v).map(Value::String),
                };
                cell.unwrap_or_else(|_| placeholder(&class))
            })
            .collect()
    }
    fn affected(r: &SqliteQueryResult) -> u64 {
        r.rows_affected()
    }
}

pub(crate) fn columns<C: sqlx::Column + 'static>(cols: &[C]) -> Vec<Column> {
    cols.iter()
        .map(|c| {
            let type_name = c.type_info().name().to_lowercase();
            let pg = (c as &dyn std::any::Any).downcast_ref::<PgColumn>();
            let relation = pg.and_then(|p| Some((p.relation_id()?.0, p.relation_attribute_no()?)));
            Column { name: c.name().to_string(), numeric: is_numeric(&type_name), type_name, relation, ..Default::default() }
        })
        .collect()
}

/// Cell from a value in the server's text format; `ty` is the driver's type name.
pub(crate) fn text_cell(ty: &str, raw: &[u8]) -> Cell {
    let ty = ty.to_ascii_lowercase();
    let base = base_type(&ty);
    // MySQL sends binary columns as raw bytes even in the text protocol.
    if matches!(base, "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" | "bit" | "geometry") {
        // shortcut: MySQL also flags `_bin`-collated text as binary and sqlx hides the collation id, so
        // printable UTF-8 is shown as text; upgrade if sqlx exposes the column charset.
        return match std::str::from_utf8(raw) {
            Ok(s) if !s.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) => Value::String(s.to_string()),
            _ => bytes_cell(raw),
        };
    }
    let Ok(s) = std::str::from_utf8(raw) else { return placeholder(&ty) };
    match base {
        "bytea" => {
            let hex = s.strip_prefix("\\x").unwrap_or(s);
            hex_cell(&hex[..hex.len().min(128)], hex.len() / 2)
        }
        "bool" => Value::String(if s == "t" { "true" } else { "false" }.into()),
        "json" | "jsonb" => {
            Value::String(serde_json::from_str::<Value>(s).map_or_else(|_| s.to_string(), |v| v.to_string()))
        }
        b if is_int(b) => int_cell(s),
        b if is_float(b) => float_cell(s),
        _ => Value::String(s.to_string()),
    }
}

fn int_cell(s: &str) -> Cell {
    match s.parse::<i128>() {
        Ok(n) if n.abs() <= 1 << 53 => Value::from(n as i64),
        _ => Value::String(s.to_string()),
    }
}

fn float_cell(s: &str) -> Cell {
    s.parse::<f64>().ok().and_then(Number::from_f64).map_or_else(|| Value::String(s.to_string()), Value::Number)
}

fn bytes_cell(b: &[u8]) -> Cell {
    hex_cell(&b.iter().take(64).map(|x| format!("{x:02x}")).collect::<String>(), b.len())
}

fn hex_cell(hex_preview: &str, len: usize) -> Cell {
    if len > 64 { Value::String(format!("\\x{hex_preview} ({len} bytes)")) } else { Value::String(format!("\\x{hex_preview}")) }
}

fn placeholder(ty: &str) -> Cell {
    Value::String(format!("<{}>", ty.to_lowercase()))
}

/// `decimal(14,2)` → `decimal`, `bigint unsigned` → `bigint`.
fn base_type(ty: &str) -> &str {
    ty.split(['(', ' ']).next().unwrap_or(ty)
}

fn is_int(b: &str) -> bool {
    matches!(
        b,
        "int2" | "int4" | "int8" | "smallint" | "int" | "integer" | "bigint" | "tinyint" | "mediumint" | "year"
            | "boolean" | "oid" | "serial" | "bigserial" | "smallserial"
    )
}

fn is_float(b: &str) -> bool {
    matches!(b, "float4" | "float8" | "real" | "float" | "double")
}

/// True for integer, decimal and float type names of any supported driver.
pub fn is_numeric(type_name: &str) -> bool {
    let t = type_name.to_ascii_lowercase();
    let b = base_type(&t);
    is_int(b) || is_float(b) || matches!(b, "numeric" | "decimal")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_cells() {
        assert_eq!(text_cell("INT8", b"9007199254740993"), json!("9007199254740993"));
        assert_eq!(text_cell("INT8", b"-9007199254740992"), json!(-9007199254740992i64));
        assert_eq!(text_cell("BIGINT UNSIGNED", b"18446744073709551615"), json!("18446744073709551615"));
        assert_eq!(text_cell("NUMERIC", b"12345678901234567890.12"), json!("12345678901234567890.12"));
        assert_eq!(text_cell("FLOAT8", b"1.5"), json!(1.5));
        assert_eq!(text_cell("FLOAT8", b"NaN"), json!("NaN"));
        assert_eq!(text_cell("BOOL", b"t"), json!("true"));
        assert_eq!(text_cell("BOOLEAN", b"1"), json!(1));
        assert_eq!(text_cell("JSONB", br#"{"a": [1, 2]}"#), json!(r#"{"a":[1,2]}"#));
        assert_eq!(text_cell("BYTEA", b"\\xdeadbeef"), json!("\\xdeadbeef"));
        assert_eq!(text_cell("BLOB", &[0xde, 0xad, 0xbe, 0xef]), json!("\\xdeadbeef"));
        assert_eq!(text_cell("VARBINARY", b"abc"), json!("abc"));
        assert_eq!(text_cell("BINARY", &[0x41, 0x00]), json!("\\x4100"));
        let long = text_cell("BLOB", &[0u8; 100]);
        assert_eq!(long, json!(format!("\\x{} (100 bytes)", "00".repeat(64))));
        assert_eq!(text_cell("TEXT", b""), json!(""));
    }

    #[test]
    fn numeric_types() {
        for t in ["int8", "DECIMAL(14,2)", "bigint unsigned", "double precision", "float4", "numeric"] {
            assert!(is_numeric(t), "{t}");
        }
        for t in ["text", "interval", "point", "bool", "timestamptz"] {
            assert!(!is_numeric(t), "{t}");
        }
    }
}

//! Decides whether a statement only reads. Anything unrecognised is treated as a write (safe default).
use super::split::{block_end, dollar_end, is_ident, line_end, skip_quoted};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementClass {
    /// SELECT, SHOW, EXPLAIN (without ANALYZE), DESCRIBE, VALUES, TABLE, read-only PRAGMA, WITH…SELECT.
    Read,
    /// SET, USE, BEGIN/START TRANSACTION, COMMIT, ROLLBACK (except ones that switch read-only off).
    Session,
    Write,
}

pub fn classify(stmt: &str) -> StatementClass {
    // The driver is unknown here, so lex with both MySQL and standard rules (backslash escapes,
    // `#` comments, `$$` quotes differ); if they disagree, a quote may be hiding a keyword.
    let (my, std) = (from_tokens(&tokens(stmt, true)), from_tokens(&tokens(stmt, false)));
    if my == std { my } else { StatementClass::Write }
}

fn from_tokens(t: &[String]) -> StatementClass {
    use StatementClass::*;
    let has = |w: &str| t.iter().any(|x| x == w);
    let Some(first) = t.iter().find(|x| *x != "(") else { return Write };
    match first.as_str() {
        "SELECT" | "VALUES" | "TABLE" if !has("INTO") => Read,
        "WITH" if !["INSERT", "UPDATE", "DELETE", "MERGE", "INTO"].iter().any(|w| has(w)) => Read,
        "SHOW" | "DESCRIBE" | "DESC" => Read,
        "EXPLAIN" if !has("ANALYZE") && !has("ANALYSE") => Read,
        "PRAGMA" if !has("=") => Read,
        "SET" | "USE" | "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" if !enables_writes(t) => Session,
        _ => Write,
    }
}

/// `… READ WRITE`, or a read-only variable set to off/0/false/default.
fn enables_writes(t: &[String]) -> bool {
    const VARS: [&str; 5] =
        ["TRANSACTION_READ_ONLY", "DEFAULT_TRANSACTION_READ_ONLY", "TX_READ_ONLY", "READ_ONLY", "SUPER_READ_ONLY"];
    const OFF: [&str; 8] = ["OFF", "0", "FALSE", "DEFAULT", "'OFF'", "'0'", "'FALSE'", "'DEFAULT'"];
    t.windows(2).any(|w| w[0] == "READ" && w[1] == "WRITE")
        || t.iter()
            .position(|x| VARS.contains(&x.as_str()))
            .is_some_and(|p| t[p..].iter().any(|x| OFF.contains(&x.as_str())))
}

/// Uppercased words, quoted literals (with their quotes) and single-char symbols; comments skipped.
fn tokens(s: &str, mysql: bool) -> Vec<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let end = match c {
            b'\'' | b'"' => skip_quoted(b, i, c, mysql),
            b'`' if mysql => skip_quoted(b, i, c, false),
            b'$' if !mysql => dollar_end(s, i).unwrap_or(i + 1),
            b'-' if b.get(i + 1) == Some(&b'-') => {
                i = line_end(b, i);
                continue;
            }
            b'#' if mysql => {
                i = line_end(b, i);
                continue;
            }
            // MySQL runs `/*! … */` contents, so lex them as code.
            b'/' if mysql && b[i..].starts_with(b"/*!") => {
                i += 3;
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = block_end(b, i);
                continue;
            }
            c if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            c if is_ident(c) && c != b'$' => i + b[i..].iter().position(|&c| !is_ident(c)).unwrap_or(b.len() - i),
            _ => i + 1,
        };
        out.push(s[i..end].to_ascii_uppercase());
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::StatementClass::*;
    use super::*;

    #[test]
    fn table() {
        let cases = [
            ("SELECT * FROM orders", Read),
            ("select 1", Read),
            ("(SELECT 1) UNION (SELECT 2)", Read),
            ("SHOW TABLES", Read),
            ("EXPLAIN SELECT * FROM t", Read),
            ("DESCRIBE t", Read),
            ("desc t", Read),
            ("VALUES (1), (2)", Read),
            ("TABLE orders", Read),
            ("PRAGMA table_info(t)", Read),
            ("WITH x AS (SELECT 1) SELECT * FROM x", Read),
            ("SELECT 'delete', \"update\" FROM t -- insert\n", Read),
            ("-- note\n/* block */ SELECT 1", Read),
            ("SET search_path TO public", Session),
            ("SET NAMES utf8mb4", Session),
            ("USE shop", Session),
            ("BEGIN", Session),
            ("START TRANSACTION", Session),
            ("COMMIT", Session),
            ("ROLLBACK", Session),
            ("SAVEPOINT a", Session),
            ("RELEASE SAVEPOINT a", Session),
            ("SET default_transaction_read_only = on", Session),
            // Edge cases: all writes.
            ("EXPLAIN ANALYZE SELECT * FROM t", Write),
            ("EXPLAIN (ANALYZE, BUFFERS) SELECT 1", Write),
            ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", Write),
            ("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", Write),
            ("SELECT * INTO new_t FROM t", Write),
            ("SELECT 1 INTO OUTFILE '/tmp/x'", Write),
            ("SELECT 1 INTO @v", Write),
            ("SET TRANSACTION READ WRITE", Write),
            ("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", Write),
            ("START TRANSACTION READ WRITE", Write),
            ("SET transaction_read_only = 0", Write),
            ("SET default_transaction_read_only TO 'off'", Write),
            ("SET @@session.tx_read_only = false", Write),
            ("PRAGMA journal_mode = WAL", Write),
            ("VACUUM", Write),
            ("FROBNICATE everything", Write),
            ("", Write),
            ("-- only a comment", Write),
            ("INSERT INTO t VALUES (1)", Write),
            ("UPDATE t SET a = 1", Write),
            ("DROP TABLE t", Write),
            ("/* SELECT */ DELETE FROM t", Write),
            ("/*!40101 SELECT 1 INTO OUTFILE '/tmp/x' */", Write),
            // A quote that hides a keyword under one dialect's rules.
            ("WITH a AS (SELECT 'x\\'), d AS (DELETE FROM t) SELECT ''", Write),
            ("WITH a AS (SELECT 1 # 2), d AS (DELETE FROM t) SELECT 1", Write),
        ];
        for (sql, want) in cases {
            assert_eq!(classify(sql), want, "{sql}");
        }
    }
}

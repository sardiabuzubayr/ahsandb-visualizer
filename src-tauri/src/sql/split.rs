//! Splits a script into statements. Aware of quotes, comments, PostgreSQL dollar quoting, the
//! MySQL/MariaDB client `DELIMITER` command and SQLite `CREATE TRIGGER … BEGIN … END` bodies.
use crate::model::Driver;

/// Returns trimmed, non-empty statements without their trailing delimiter.
pub fn split(sql: &str, driver: Driver) -> Vec<String> {
    let mut s = StatementStream::new(driver);
    let mut out = s.push(sql);
    out.extend(s.finish());
    out
}

/// Incremental `split`: feed a script in chunks of any size and get exactly the statements `split`
/// gives for the whole text, as soon as each one's delimiter has been read. Only the unfinished
/// statement is buffered.
pub struct StatementStream {
    driver: Driver,
    buf: String,
    delim: String,
    /// Start of the current statement and the scan position, both in `buf`.
    start: usize,
    i: usize,
    /// Whether the current statement has anything besides whitespace and comments.
    has_code: bool,
    line_start: bool,
    /// A construct cut off by the chunk end (quote, comment, …) is rescanned only once `buf` has
    /// doubled past it, so a huge literal costs linear time instead of quadratic.
    retry_at: usize,
}

impl StatementStream {
    pub fn new(driver: Driver) -> Self {
        Self { driver, buf: String::new(), delim: ";".into(), start: 0, i: 0, has_code: false, line_start: true, retry_at: 0 }
    }

    /// Adds text; returns the statements it completed.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        if self.buf.len() < self.retry_at {
            return Vec::new();
        }
        let out = self.scan(false);
        self.buf.drain(..self.start);
        self.i -= self.start;
        self.start = 0;
        self.retry_at = 2 * self.buf.len() - self.i;
        out
    }

    /// Ends the input; returns the last statement if it had no delimiter.
    pub fn finish(mut self) -> Vec<String> {
        self.scan(true)
    }

    /// Runs the state machine from `i`. Unless `last`, stops before any step whose outcome could
    /// still depend on text not read yet (it reaches the end of `buf`).
    fn scan(&mut self, last: bool) -> Vec<String> {
        let mysql = matches!(self.driver, Driver::Mysql | Driver::Mariadb);
        let pg = self.driver == Driver::Postgres;
        let sqlite = self.driver == Driver::Sqlite;
        let sql = self.buf.as_str();
        let b = sql.as_bytes();
        let n = b.len();
        let mut out = Vec::new();
        let (mut start, mut i, mut has_code, mut line_start) = (self.start, self.i, self.has_code, self.line_start);

        while i < n {
            if line_start && mysql {
                let rest = &sql[i..];
                if !last && !rest.contains('\n') && maybe_delimiter_command(rest) {
                    break;
                }
                if let Some((new_delim, end)) = delimiter_command(rest) {
                    if has_code {
                        out.push(sql[start..i].trim().to_string());
                    }
                    self.delim = new_delim;
                    i += end;
                    start = i;
                    has_code = false;
                    continue;
                }
            }
            line_start = false;
            let d = self.delim.as_bytes();
            if !last && n - i < d.len() && d.starts_with(&b[i..]) {
                break;
            }
            if b[i..].starts_with(d) && !(sqlite && inside_sqlite_trigger(&sql[start..i])) {
                if has_code {
                    out.push(sql[start..i].trim().to_string());
                }
                i += d.len();
                start = i;
                has_code = false;
                continue;
            }
            let (next, code) = match b[i] {
                q @ (b'\'' | b'"') => {
                    // PostgreSQL E'…' strings use backslash escapes.
                    let e_string = pg && q == b'\'' && i > 0 && matches!(b[i - 1], b'E' | b'e') && (i < 2 || !is_ident(b[i - 2]));
                    (skip_quoted(b, i, q, mysql || e_string), true)
                }
                b'`' if mysql => (skip_quoted(b, i, b'`', false), true),
                b'-' if b.get(i + 1) == Some(&b'-') => (line_end(b, i), false),
                b'#' if mysql => (line_end(b, i), false),
                // MySQL `/*! … */` comments are executed by the server (e.g. in dumps).
                b'/' if b.get(i + 1) == Some(&b'*') => (block_end(b, i), mysql && b.get(i + 2) == Some(&b'!')),
                b'$' if pg => {
                    // `$tag` cut off by the chunk end may still open a dollar quote.
                    if !last && b[i + 1..].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'_') {
                        break;
                    }
                    (dollar_end(sql, i).unwrap_or(i + 1), true)
                }
                c => (i + 1, !c.is_ascii_whitespace()),
            };
            if !last && next >= n {
                break;
            }
            has_code |= code;
            line_start = b[i] == b'\n';
            i = next;
        }
        if last && has_code {
            out.push(sql[start..].trim().to_string());
        }
        (self.start, self.i, self.has_code, self.line_start) = (start, i, has_code, line_start);
        out
    }
}

/// `rest` (a line start with no `\n` yet) could still turn out to be a `DELIMITER` command.
fn maybe_delimiter_command(rest: &str) -> bool {
    let t = rest.trim_start().as_bytes();
    let k = t.len().min(9);
    t[..k].eq_ignore_ascii_case(&b"delimiter"[..k])
}

/// True while `stmt` is a SQLite `CREATE [TEMP] TRIGGER … BEGIN` whose body hasn't reached `END` yet,
/// so the `;` between body statements must not split.
fn inside_sqlite_trigger(stmt: &str) -> bool {
    let b = stmt.as_bytes();
    let mut i = 0;
    // Skip leading whitespace and comments.
    while i < b.len() {
        match b[i] {
            c if c.is_ascii_whitespace() => i += 1,
            b'-' if b.get(i + 1) == Some(&b'-') => i = line_end(b, i),
            b'/' if b.get(i + 1) == Some(&b'*') => i = block_end(b, i),
            _ => break,
        }
    }
    let words: Vec<String> = stmt[i..].split(|c: char| !c.is_ascii_alphanumeric() && c != '_').take(4).map(str::to_ascii_uppercase).collect();
    let is_trigger = words.first().is_some_and(|w| w == "CREATE")
        && (words.get(1).is_some_and(|w| w == "TRIGGER")
            || (words.get(1).is_some_and(|w| w == "TEMP" || w == "TEMPORARY") && words.get(2).is_some_and(|w| w == "TRIGGER")));
    if !is_trigger || !stmt.to_ascii_uppercase().split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|w| w == "BEGIN") {
        return false;
    }
    let t = stmt.trim_end().as_bytes();
    let ends_with_end = t.len() >= 3 && t[t.len() - 3..].eq_ignore_ascii_case(b"END") && (t.len() == 3 || !is_ident(t[t.len() - 4]));
    !ends_with_end
}

/// `DELIMITER <token>` on the current line → (new delimiter, byte length of the line without `\n`).
fn delimiter_command(rest: &str) -> Option<(String, usize)> {
    let end = rest.find('\n').unwrap_or(rest.len());
    let line = rest[..end].trim();
    let arg = line.get(9..)?;
    if !line[..9].eq_ignore_ascii_case("delimiter") || !arg.starts_with(char::is_whitespace) {
        return None;
    }
    Some((arg.split_whitespace().next()?.to_string(), end))
}

pub(crate) fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

/// `b[i]` is the opening quote; returns the index after the closing one (doubled quote escapes).
pub(crate) fn skip_quoted(b: &[u8], i: usize, q: u8, backslash: bool) -> usize {
    let mut j = i + 1;
    while j < b.len() {
        if backslash && b[j] == b'\\' {
            j += 2;
        } else if b[j] == q {
            if b.get(j + 1) != Some(&q) {
                return j + 1;
            }
            j += 2;
        } else {
            j += 1;
        }
    }
    b.len()
}

/// Index of the `\n` ending a line comment (not consumed), or the end.
pub(crate) fn line_end(b: &[u8], i: usize) -> usize {
    b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p)
}

/// `b[i..]` starts with `/*`; returns the index after `*/`, or the end.
pub(crate) fn block_end(b: &[u8], i: usize) -> usize {
    b[i + 2..].windows(2).position(|w| w == b"*/").map_or(b.len(), |p| i + 2 + p + 2)
}

/// If `s[i..]` opens a dollar quote (`$$` or `$tag$`), returns the index after its closing tag.
pub(crate) fn dollar_end(s: &str, i: usize) -> Option<usize> {
    let b = s.as_bytes();
    // `a$b$` is an identifier and `$1` a parameter, not quotes.
    if (i > 0 && is_ident(b[i - 1])) || b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let len = b[i + 1..].iter().position(|&c| !(c.is_ascii_alphanumeric() || c == b'_'))?;
    if b[i + 1 + len] != b'$' {
        return None;
    }
    let tag = &s[i..i + len + 2];
    let body = i + tag.len();
    Some(s[body..].find(tag).map_or(s.len(), |p| body + p + tag.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg(s: &str) -> Vec<String> {
        split(s, Driver::Postgres)
    }
    fn my(s: &str) -> Vec<String> {
        split(s, Driver::Mysql)
    }

    #[test]
    fn basic_and_trailing_statement() {
        assert_eq!(pg("SELECT 1; SELECT 2;\n\nSELECT 3"), ["SELECT 1", "SELECT 2", "SELECT 3"]);
        assert_eq!(pg(" ;; SELECT 1 ;  "), ["SELECT 1"]);
        assert!(pg("").is_empty());
    }

    #[test]
    fn quotes_and_identifiers_do_not_split() {
        assert_eq!(pg("SELECT 'a;b', 'it''s;'; SELECT \"x;y\""), ["SELECT 'a;b', 'it''s;'", "SELECT \"x;y\""]);
        assert_eq!(pg("SELECT E'a\\';b'; SELECT 2"), ["SELECT E'a\\';b'", "SELECT 2"]);
        assert_eq!(my("SELECT 'a\\';b', `c;d`; SELECT 2"), ["SELECT 'a\\';b', `c;d`", "SELECT 2"]);
        assert_eq!(my("SELECT \"a\\\";b\"; SELECT 2"), ["SELECT \"a\\\";b\"", "SELECT 2"]);
    }

    #[test]
    fn comments() {
        assert_eq!(
            pg("SELECT 1 -- x;y\n, 2; /* a;b */ SELECT 3"),
            ["SELECT 1 -- x;y\n, 2", "/* a;b */ SELECT 3"]
        );
        assert_eq!(my("SELECT 1 # c;d\n; SELECT 2"), ["SELECT 1 # c;d", "SELECT 2"]);
        // `#` is an operator in PostgreSQL, not a comment.
        assert_eq!(pg("SELECT 1 # 2; SELECT 3"), ["SELECT 1 # 2", "SELECT 3"]);
        assert!(pg("-- only a comment;\n/* and ; another */\n  ").is_empty());
        assert_eq!(pg("SELECT 1; -- trailing note"), ["SELECT 1"]);
        assert_eq!(my("/*!40101 SET NAMES utf8 */;"), ["/*!40101 SET NAMES utf8 */"]);
    }

    #[test]
    fn dollar_quotes() {
        let f = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql";
        assert_eq!(pg(&format!("{f}; SELECT 2")), [f, "SELECT 2"]);
        let g = "DO $body$ BEGIN RAISE NOTICE '$$;'; END $body$";
        assert_eq!(pg(&format!("{g};SELECT $1;")), [g, "SELECT $1"]);
        assert_eq!(pg("SELECT a$b$c; SELECT 2"), ["SELECT a$b$c", "SELECT 2"]);
    }

    #[test]
    fn mysql_delimiter() {
        let script = "DELIMITER //\n\
            CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND //\n\
            delimiter ;\n\
            CALL p();\nSELECT 3";
        assert_eq!(
            my(script),
            ["CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", "CALL p()", "SELECT 3"]
        );
        assert_eq!(split("DELIMITER $$\nSELECT 1$$", Driver::Mariadb), ["SELECT 1"]);
        // Not a client command for other drivers.
        assert_eq!(pg("DELIMITER //\nSELECT 1;"), ["DELIMITER //\nSELECT 1"]);
    }

    #[test]
    fn sqlite_trigger_body() {
        let t = "CREATE TRIGGER trg AFTER INSERT ON t BEGIN\n  UPDATE t SET n = n + 1;\n  INSERT INTO log VALUES ('end');\nEND";
        assert_eq!(split(&format!("{t};\nSELECT 1;"), Driver::Sqlite), [t, "SELECT 1"]);
        let temp = "-- note\ncreate temp trigger x before delete on t begin select 1; end";
        assert_eq!(split(&format!("{temp}; SELECT 2"), Driver::Sqlite), [temp, "SELECT 2"]);
        // Other statements and drivers are unaffected.
        assert_eq!(split("SELECT 'BEGIN'; SELECT 2", Driver::Sqlite), ["SELECT 'BEGIN'", "SELECT 2"]);
    }

    #[test]
    fn non_ascii_outside_quotes() {
        assert_eq!(pg("CREATE TABLE café (x int); SELECT 'é'"), ["CREATE TABLE café (x int)", "SELECT 'é'"]);
    }

    /// Every input, chunked at every char boundary and in fixed-size pieces, splits like the whole text.
    #[test]
    fn stream_matches_split_for_any_chunking() {
        let cases = [
            "SELECT 1; SELECT 2;\n\nSELECT 3",
            " ;; SELECT 1 ;  ",
            "SELECT 'a;b', 'it''s;'; SELECT \"x;y\"",
            "SELECT E'a\\';b'; E'x;' ;e'\\'';' ; SELECT 2",
            "SELECT 'a\\';b', `c;d`; SELECT \"a\\\";b\"; SELECT 2",
            "SELECT 1 -- x;y\n, 2; /* a;b */ SELECT 3; SELECT 1 # c;d\n; -",
            "/*!40101 SET NAMES utf8 */;\r\n/* only ; comment */;\r\nSELECT 1; -- trailing note",
            "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 2",
            "DO $body$ BEGIN RAISE NOTICE '$$;'; END $body$;SELECT $1; SELECT a$b$c; SELECT $",
            "DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND //\ndelimiter ;\nCALL p();\nSELECT 3",
            "  DELIMITER END_X \nSELECT 'END_X' END_X SELECT 2 END_\nX END_X\nDELIMITER ;\nSELECT 3;",
            "DELIMITER $$\nSELECT 1$$\nDELIMITE\nR $$; DELIMITERx; SELECT 2",
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN\n  UPDATE t SET n = n + 1;\n  INSERT INTO log VALUES ('end');\nEND;\nSELECT 1;",
            "-- note\ncreate temp trigger x before delete on t begin select 1; end; SELECT 'BEGIN'; SELECT 2",
            "INSERT INTO café VALUES ('naïve; ü', \"日本;語\"); SELECT '🙂;' ; -- 💥;\nSELECT 2",
            include_str!("../../../scripts/seed/postgres.sql"),
            include_str!("../../../scripts/seed/mysql.sql"),
        ];
        for driver in [Driver::Postgres, Driver::Mysql, Driver::Mariadb, Driver::Sqlite] {
            for text in cases {
                let want = split(text, driver);
                let check = |chunks: Vec<&str>| {
                    let mut s = StatementStream::new(driver);
                    let mut got: Vec<String> = chunks.iter().flat_map(|c| s.push(c)).collect();
                    got.extend(s.finish());
                    assert_eq!(got, want, "{driver:?} {chunks:?}");
                };
                let bounds: Vec<usize> = (0..=text.len()).filter(|&i| text.is_char_boundary(i)).collect();
                for &at in &bounds {
                    check(vec![&text[..at], &text[at..]]);
                }
                for size in 1..=13 {
                    check(bounds.windows(2).step_by(size).map(|w| w[0]).chain([text.len()]).collect::<Vec<_>>().windows(2).map(|w| &text[w[0]..w[1]]).collect());
                }
            }
        }
    }
}

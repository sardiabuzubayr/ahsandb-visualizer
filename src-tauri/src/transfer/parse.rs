//! Reading import files in chunks: decoding (UTF-8 / ISO-8859-1), gunzip, CSV (RFC 4180), JSON
//! arrays of objects, and suggested column types per driver.
use std::fmt;
use std::fs::File;
use std::io::{BufRead as _, BufReader, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::model::{Cell, Driver, FileFormat, FileOptions};

/// Bytes read from disk per step.
pub const CHUNK: usize = 256 * 1024;
const MAX_JSON: u64 = 512 * 1024 * 1024;

/// A parsed JSON file: column names and rows of exactly `columns.len()` cells.
#[derive(Debug, PartialEq)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// Incremental decoding: bytes split anywhere give the same text as decoding them whole.
/// `UTF-8` (BOM stripped; invalid bytes → error naming the line) or `ISO-8859-1` (byte = char).
pub struct Decoder {
    latin1: bool,
    /// Undecoded bytes: an incomplete code point at the end of the last chunk.
    pending: Vec<u8>,
    line: usize,
    bom_checked: bool,
}

impl Decoder {
    pub fn new(encoding: &str) -> AppResult<Self> {
        let latin1 = match encoding.to_ascii_uppercase().replace('_', "-").as_str() {
            "ISO-8859-1" | "LATIN1" | "LATIN-1" => true,
            "UTF-8" | "UTF8" => false,
            other => return Err(AppError::NotSupported(format!("Unsupported encoding: {other}"))),
        };
        Ok(Self { latin1, pending: Vec::new(), line: 1, bom_checked: latin1 })
    }

    pub fn decode(&mut self, bytes: &[u8]) -> AppResult<String> {
        if self.latin1 {
            return Ok(bytes.iter().map(|&b| b as char).collect());
        }
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(e) => return Err(self.invalid(e.valid_up_to())),
        };
        let rest = self.pending.split_off(valid);
        let mut text = String::from_utf8(std::mem::replace(&mut self.pending, rest)).expect("validated above");
        self.line += text.bytes().filter(|&b| b == b'\n').count();
        if !self.bom_checked && !text.is_empty() {
            self.bom_checked = true;
            if text.starts_with('\u{feff}') {
                text.drain(..3);
            }
        }
        Ok(text)
    }

    /// End of input: a code point cut off at the end is an error.
    pub fn finish(&self) -> AppResult<()> {
        if self.pending.is_empty() { Ok(()) } else { Err(self.invalid(0)) }
    }

    fn invalid(&self, at: usize) -> AppError {
        let line = self.line + self.pending[..at].iter().filter(|&&b| b == b'\n').count();
        AppError::Query(format!("The file is not valid UTF-8 (line {line})"))
    }
}

/// Counts bytes read from the inner reader.
struct Counted<R>(R, Arc<AtomicU64>);

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.0.read(buf)?;
        self.1.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// A file read and decoded `chunk` bytes at a time, gunzipped on the fly when `gunzip` is set and
/// it starts with the gzip magic.
pub struct TextReader {
    src: Box<dyn Read + Send>,
    gz: bool,
    path: String,
    read: Arc<AtomicU64>,
    decoder: Decoder,
    buf: Vec<u8>,
}

impl TextReader {
    pub fn open(path: &str, encoding: &str, gunzip: bool, chunk: usize) -> AppResult<Self> {
        let decoder = Decoder::new(encoding)?;
        let read = Arc::new(AtomicU64::new(0));
        let io = |e: std::io::Error| AppError::Io(format!("Could not read {path}: {e}"));
        let mut file = BufReader::with_capacity(CHUNK, Counted(File::open(path).map_err(io)?, read.clone()));
        let gz = gunzip && file.fill_buf().map_err(io)?.starts_with(&[0x1f, 0x8b]);
        let src: Box<dyn Read + Send> = if gz { Box::new(flate2::bufread::MultiGzDecoder::new(file)) } else { Box::new(file) };
        Ok(Self { src, gz, path: path.into(), read, decoder, buf: vec![0; chunk] })
    }

    /// The next piece of text, `None` at the end of the file.
    pub fn next_text(&mut self) -> AppResult<Option<String>> {
        let n = self.src.read(&mut self.buf).map_err(|e| match self.gz {
            true => AppError::Query(format!("The file is not a valid gzip archive: {e}")),
            false => AppError::Io(format!("Could not read {}: {e}", self.path)),
        })?;
        if n == 0 {
            self.decoder.finish()?;
            return Ok(None);
        }
        self.decoder.decode(&self.buf[..n]).map(Some)
    }

    /// Bytes read from disk so far (compressed bytes for gzip).
    pub fn pos(&self) -> u64 {
        self.read.load(Ordering::Relaxed)
    }
}

/// Incremental RFC 4180 parser: `delim`-separated, `"`-quoted fields with `""` escapes and line
/// breaks inside quotes; CRLF, LF or CR end a record. Blank lines are skipped. Text split anywhere
/// gives the same records.
pub struct CsvParser {
    delim: char,
    row: Vec<String>,
    field: String,
    in_quotes: bool,
    quoted: bool,
    /// A `"` inside quotes: an escape if the next char is `"`, else the closing quote.
    quote_pending: bool,
    /// The last record ended with `\r`: a following `\n` belongs to it.
    skip_lf: bool,
}

impl CsvParser {
    pub fn new(delim: char) -> Self {
        Self { delim, row: Vec::new(), field: String::new(), in_quotes: false, quoted: false, quote_pending: false, skip_lf: false }
    }

    /// Adds text; returns the records it completed.
    pub fn push(&mut self, text: &str) -> Vec<Vec<String>> {
        let mut out = Vec::new();
        for c in text.chars() {
            if std::mem::take(&mut self.skip_lf) && c == '\n' {
                continue;
            }
            if std::mem::take(&mut self.quote_pending) {
                if c == '"' {
                    self.field.push('"');
                    continue;
                }
                self.in_quotes = false;
            } else if self.in_quotes {
                match c {
                    '"' => self.quote_pending = true,
                    _ => self.field.push(c),
                }
                continue;
            }
            match c {
                '"' if self.field.is_empty() && !self.quoted => (self.in_quotes, self.quoted) = (true, true),
                c if c == self.delim => {
                    self.row.push(std::mem::take(&mut self.field));
                    self.quoted = false;
                }
                '\r' | '\n' => {
                    self.skip_lf = c == '\r';
                    self.end_record(&mut out);
                }
                _ => self.field.push(c),
            }
        }
        out
    }

    /// Ends the input; returns the last record if it had no line break.
    pub fn finish(mut self) -> Option<Vec<String>> {
        let mut out = Vec::new();
        self.end_record(&mut out);
        out.pop()
    }

    fn end_record(&mut self, out: &mut Vec<Vec<String>>) {
        if !self.row.is_empty() || !self.field.is_empty() || self.quoted {
            self.row.push(std::mem::take(&mut self.field));
            out.push(std::mem::take(&mut self.row));
        }
        self.quoted = false;
    }
}

/// All records of a CSV text (see `CsvParser`).
pub fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut p = CsvParser::new(delim);
    let mut rows = p.push(text);
    rows.extend(p.finish());
    rows
}

/// An import file's columns and its rows, read lazily: CSV streams; JSON is parsed whole.
/// Rows have exactly `columns.len()` cells (strings for CSV, JSON scalars for JSON; nested JSON as
/// JSON text).
pub struct TableReader {
    pub columns: Vec<String>,
    src: Rows,
}

enum Rows {
    Csv(CsvRows),
    Json { rows: std::vec::IntoIter<Vec<Cell>>, len: usize, size: u64 },
}

struct CsvRows {
    reader: TextReader,
    /// `None` once the file is done.
    parser: Option<CsvParser>,
    queue: std::vec::IntoIter<Vec<String>>,
}

/// Opens the file described by `file` and reads its columns. CSV: with `header` the first record
/// names the columns (blank names → `columnN`); without, columns are `column1…` as wide as the
/// first record. Short rows are padded with NULL, extra fields dropped.
pub fn open_table(file: &FileOptions) -> AppResult<TableReader> {
    open_table_chunked(file, CHUNK)
}

pub(crate) fn open_table_chunked(file: &FileOptions, chunk: usize) -> AppResult<TableReader> {
    let mut reader = TextReader::open(&file.path, &file.encoding, false, chunk)?;
    if file.format == FileFormat::Json {
        // shortcut: JSON arrays are parsed whole; stream with serde_json's StreamDeserializer if huge JSON files matter
        if std::fs::metadata(&file.path).is_ok_and(|m| m.len() > MAX_JSON) {
            return Err(AppError::NotSupported("JSON files over 512 MB can't be imported; convert the file to CSV".into()));
        }
        let mut text = String::new();
        while let Some(t) = reader.next_text()? {
            text.push_str(&t);
        }
        let t = json_table(&text)?;
        let len = t.rows.len();
        return Ok(TableReader { columns: t.columns, src: Rows::Json { rows: t.rows.into_iter(), len, size: reader.pos() } });
    }
    let parser = CsvParser::new(file.delimiter.chars().next().unwrap_or(','));
    let mut csv = CsvRows { reader, parser: Some(parser), queue: Vec::new().into_iter() };
    let first = csv.next_record()?;
    let width = first.as_ref().map_or(0, Vec::len);
    let columns = (0..width)
        .map(|i| first.as_ref().filter(|_| file.header).map(|h| h[i].trim().to_string()).filter(|n| !n.is_empty()).unwrap_or(format!("column{}", i + 1)))
        .collect();
    if let (Some(first), false) = (first, file.header) {
        csv.queue = std::iter::once(first).chain(std::mem::take(&mut csv.queue)).collect::<Vec<_>>().into_iter();
    }
    Ok(TableReader { columns, src: Rows::Csv(csv) })
}

impl CsvRows {
    fn next_record(&mut self) -> AppResult<Option<Vec<String>>> {
        loop {
            if let Some(r) = self.queue.next() {
                return Ok(Some(r));
            }
            let Some(p) = &mut self.parser else { return Ok(None) };
            let records = match self.reader.next_text() {
                Ok(Some(text)) => p.push(&text),
                Ok(None) => self.parser.take().and_then(CsvParser::finish).into_iter().collect(),
                Err(e) => {
                    self.parser = None;
                    return Err(e);
                }
            };
            self.queue = records.into_iter();
        }
    }
}

impl TableReader {
    /// File bytes behind the rows returned so far (an estimate for JSON).
    pub fn pos(&self) -> u64 {
        match &self.src {
            Rows::Csv(csv) => csv.reader.pos(),
            Rows::Json { rows, len, size } => size * (len - rows.len()) as u64 / (*len).max(1) as u64,
        }
    }
}

impl Iterator for TableReader {
    type Item = AppResult<Vec<Cell>>;

    fn next(&mut self) -> Option<Self::Item> {
        let csv = match &mut self.src {
            Rows::Json { rows, .. } => return rows.next().map(Ok),
            Rows::Csv(csv) => csv,
        };
        let width = self.columns.len();
        let row = csv.next_record().transpose()?;
        Some(row.map(|mut r| (0..width).map(|i| r.get_mut(i).map_or(Value::Null, |f| Value::String(std::mem::take(f)))).collect()))
    }
}

/// A JSON object with its keys in file order (serde_json's map is sorted without `preserve_order`).
struct Ordered(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = m.next_entry::<String, Value>()? {
                    out.push(entry);
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// A top-level array of objects → table. Columns = keys in first-seen order; missing keys are
/// NULL; nested objects/arrays become JSON text. Anything else → `Query` error.
pub fn json_table(text: &str) -> AppResult<Table> {
    let objects: Vec<Ordered> = serde_json::from_str(text)
        .map_err(|e| AppError::Query(format!("JSON import expects an array of objects, e.g. [{{\"id\": 1}}]: {e}")))?;
    let mut columns: Vec<String> = Vec::new();
    for o in &objects {
        for (k, _) in &o.0 {
            if !columns.contains(k) {
                columns.push(k.clone());
            }
        }
    }
    let rows = objects
        .into_iter()
        .map(|o| {
            let mut row = vec![Value::Null; columns.len()];
            for (k, v) in o.0 {
                let i = columns.iter().position(|c| *c == k).expect("collected above");
                row[i] = match v {
                    Value::Object(_) | Value::Array(_) => Value::String(v.to_string()),
                    v => v,
                };
            }
            row
        })
        .collect();
    Ok(Table { columns, rows })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Integer,
    Decimal,
    Boolean,
    Date,
    Timestamp,
    Text,
}

fn kind_of(v: &Cell) -> Option<Kind> {
    let s = match v {
        Value::Null => return None,
        Value::Bool(_) => return Some(Kind::Boolean),
        Value::Number(n) => return Some(if n.is_f64() { Kind::Decimal } else { Kind::Integer }),
        Value::String(s) if s.trim().is_empty() => return None,
        Value::String(s) => s.trim(),
        _ => return Some(Kind::Text),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    let date = |s: &str| s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok();
    Some(if digits(unsigned) && s.parse::<i64>().is_ok() {
        Kind::Integer
    } else if unsigned.bytes().all(|b| b.is_ascii_digit() || b"eE+-.".contains(&b)) && unsigned.starts_with(|c: char| c.is_ascii_digit() || c == '.') && s.parse::<f64>().is_ok() {
        Kind::Decimal
    } else if s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false") {
        Kind::Boolean
    } else if date(s) {
        Kind::Date
    } else if s.len() >= 16
        && s.is_char_boundary(10)
        && date(&s[..10])
        && matches!(s.as_bytes()[10], b' ' | b'T')
        && s.is_char_boundary(16)
        && chrono::NaiveTime::parse_from_str(&s[11..16], "%H:%M").is_ok()
        && (s.len() == 16 || s.as_bytes()[16] == b':')
    {
        Kind::Timestamp
    } else {
        Kind::Text
    })
}

/// Suggested SQL type for a column from its first ≤ 1000 non-empty values.
pub fn infer_type<'a>(driver: Driver, values: impl Iterator<Item = &'a Cell>) -> String {
    let mut f = Infer::default();
    for v in values {
        if !f.add(v) {
            break;
        }
    }
    f.sql_type(driver)
}

/// `infer_type` one value at a time, for rows that stream past.
#[derive(Debug, Default, Clone)]
pub struct Infer {
    kind: Option<Kind>,
    seen: usize,
}

impl Infer {
    /// Folds in a value; false once further values can't change the result.
    pub fn add(&mut self, v: &Cell) -> bool {
        if self.seen >= 1000 || self.kind == Some(Kind::Text) {
            return false;
        }
        let Some(k) = kind_of(v) else { return true };
        self.seen += 1;
        self.kind = Some(match (self.kind, k) {
            (None, k) => k,
            (Some(a), b) if a == b => a,
            (Some(Kind::Integer | Kind::Decimal), Kind::Integer | Kind::Decimal) => Kind::Decimal,
            (Some(Kind::Date | Kind::Timestamp), Kind::Date | Kind::Timestamp) => Kind::Timestamp,
            _ => Kind::Text,
        });
        self.seen < 1000 && self.kind != Some(Kind::Text)
    }

    pub fn sql_type(&self, driver: Driver) -> String {
        let (pg, my, lite) = match self.kind.unwrap_or(Kind::Text) {
            Kind::Integer => ("bigint", "BIGINT", "INTEGER"),
            Kind::Decimal => ("numeric", "DECIMAL(18,6)", "REAL"),
            Kind::Boolean => ("boolean", "TINYINT(1)", "INTEGER"),
            Kind::Date => ("date", "DATE", "TEXT"),
            Kind::Timestamp => ("timestamp", "DATETIME", "TEXT"),
            Kind::Text => ("text", "TEXT", "TEXT"),
        };
        match driver {
            Driver::Postgres => pg,
            Driver::Mysql | Driver::Mariadb => my,
            Driver::Sqlite | Driver::Redis => lite,
        }
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn csv_rfc4180() {
        let text = "a,b,c\r\n1,\"x, y\",\"say \"\"hi\"\"\"\r\n2,\"line1\nline2\",\n\n3,,\"\"\n";
        assert_eq!(parse_csv(text, ','), vec![
            s(&["a", "b", "c"]),
            s(&["1", "x, y", "say \"hi\""]),
            s(&["2", "line1\nline2", ""]),
            s(&["3", "", ""]),
        ]);
        assert_eq!(parse_csv("a;b\nc;d", ';'), vec![s(&["a", "b"]), s(&["c", "d"])]);
        assert_eq!(parse_csv("a\tb\r\nc\td\r\n", '\t'), vec![s(&["a", "b"]), s(&["c", "d"])]);
        assert_eq!(parse_csv("\"\"\n", ','), vec![s(&[""])]);
        assert!(parse_csv("", ',').is_empty());
    }

    fn decode(bytes: &[u8], encoding: &str) -> AppResult<String> {
        let mut d = Decoder::new(encoding)?;
        let text = d.decode(bytes)?;
        d.finish()?;
        Ok(text)
    }

    /// Writes `bytes` to a temp file and reads it as a table, `chunk` bytes at a time.
    fn table(bytes: &[u8], header: bool, delimiter: &str, encoding: &str, chunk: usize) -> AppResult<(Vec<String>, Vec<Vec<Cell>>)> {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), bytes).unwrap();
        let file = FileOptions { path: f.path().to_string_lossy().into(), format: FileFormat::Csv, delimiter: delimiter.into(), header, encoding: encoding.into() };
        let mut t = open_table_chunked(&file, chunk)?;
        let rows = t.by_ref().collect::<AppResult<_>>()?;
        Ok((t.columns, rows))
    }

    #[test]
    fn csv_header_and_ragged_rows() {
        let (columns, rows) = table(b"id,name\n1\n2,b,extra\n", true, ",", "UTF-8", CHUNK).unwrap();
        assert_eq!(columns, s(&["id", "name"]));
        assert_eq!(rows, vec![vec![json!("1"), json!(null)], vec![json!("2"), json!("b")]]);
        let (columns, rows) = table(b"1,a\n2,b\n", false, ",", "UTF-8", CHUNK).unwrap();
        assert_eq!(columns, s(&["column1", "column2"]));
        assert_eq!(rows, vec![vec![json!("1"), json!("a")], vec![json!("2"), json!("b")]]);
        let (columns, rows) = table(b"id,,x\n", true, ",", "UTF-8", CHUNK).unwrap();
        assert_eq!(columns, s(&["id", "column2", "x"]));
        assert!(rows.is_empty());
        assert_eq!(table(b"", true, ",", "UTF-8", CHUNK).unwrap(), (vec![], vec![]));
    }

    /// Records split across chunks: quoted line breaks, `""` escapes, CRLF, BOM and multi-byte chars.
    #[test]
    fn csv_streams_across_chunks() {
        let text = "\u{feff}id;note\r\n1;\"multi\r\nline; \"\"q\"\"\"\r\n2;café 🙂\r\n\r\n3;\"\"\r4;\"x\n\ny\"\n5";
        let whole = parse_csv(text, ';');
        assert_eq!(whole[1], s(&["1", "multi\r\nline; \"q\""]));
        assert_eq!(whole.len(), 6);
        // The parser alone, split at every char boundary.
        for at in (0..=text.len()).filter(|&i| text.is_char_boundary(i)) {
            let mut p = CsvParser::new(';');
            let mut got = p.push(&text[..at]);
            got.extend(p.push(&text[at..]));
            got.extend(p.finish());
            assert_eq!(got, whole, "split at {at}");
        }
        // The file reader, with chunk boundaries inside code points, quotes and CRLF pairs.
        let want = table(text.as_bytes(), true, ";", "UTF-8", CHUNK).unwrap();
        assert_eq!(want.0, s(&["id", "note"]));
        assert_eq!(want.1.len(), 5);
        assert_eq!(want.1[3], vec![json!("4"), json!("x\n\ny")]);
        for chunk in 1..=9 {
            assert_eq!(table(text.as_bytes(), true, ";", "UTF-8", chunk).unwrap(), want, "chunk {chunk}");
        }
    }

    #[test]
    fn encodings() {
        let bom = [b"\xef\xbb\xbf".as_slice(), b"id\n1\n"].concat();
        assert_eq!(decode(&bom, "UTF-8").unwrap(), "id\n1\n");
        assert_eq!(decode(b"caf\xe9", "ISO-8859-1").unwrap(), "café");
        let e = decode(b"id\n1\ncaf\xe9\n", "UTF-8").unwrap_err();
        assert!(matches!(&e, AppError::Query(m) if m.contains("line 3")), "{e}");
        let e = decode(b"id\n\xe2\x82", "UTF-8").unwrap_err();
        assert!(matches!(&e, AppError::Query(m) if m.contains("line 2")), "{e}");
        assert!(matches!(Decoder::new("UTF-16"), Err(AppError::NotSupported(_))));
        // Byte by byte: same text, BOM still stripped, bad byte still found on its line.
        let text = [b"\xef\xbb\xbf".as_slice(), "a\u{e9}\n\u{1f642}\u{feff}\n".as_bytes()].concat();
        let mut d = Decoder::new("UTF-8").unwrap();
        let got: String = text.iter().map(|b| d.decode(&[*b]).unwrap()).collect();
        assert_eq!(got, "a\u{e9}\n\u{1f642}\u{feff}\n");
        let mut d = Decoder::new("utf8").unwrap();
        let e = b"x\n\ny\xff".iter().map(|b| d.decode(&[*b])).find_map(Result::err).unwrap();
        assert!(e.to_string().contains("line 3"), "{e}");
        let e = table(b"id\n1\ncaf\xe9\n", true, ",", "UTF-8", 2).unwrap_err();
        assert!(e.to_string().contains("line 3"), "{e}");
    }

    #[test]
    fn json_arrays() {
        let t = json_table(r#"[{"z": 1, "a": "x", "n": {"k": [1]}}, {"a": null, "b": true, "z": 2.5}]"#).unwrap();
        assert_eq!(t.columns, s(&["z", "a", "n", "b"]));
        assert_eq!(t.rows, vec![
            vec![json!(1), json!("x"), json!(r#"{"k":[1]}"#), json!(null)],
            vec![json!(2.5), json!(null), json!(null), json!(true)],
        ]);
        assert!(json_table("[]").unwrap().rows.is_empty());
        for bad in [r#"{"a": 1}"#, "[1, 2]", r#"[{"a": 1}, "x"]"#, "not json", ""] {
            assert!(matches!(json_table(bad), Err(AppError::Query(m)) if m.starts_with("JSON import expects")), "{bad}");
        }
    }

    #[test]
    fn inferred_types() {
        let infer = |d, v: Vec<Cell>| infer_type(d, v.iter());
        let cases: [(Vec<Cell>, [&str; 3]); 9] = [
            (vec![json!("1"), json!("-20"), json!(""), json!(null)], ["bigint", "BIGINT", "INTEGER"]),
            (vec![json!("1"), json!("2.5")], ["numeric", "DECIMAL(18,6)", "REAL"]),
            (vec![json!(3), json!(1.5)], ["numeric", "DECIMAL(18,6)", "REAL"]),
            (vec![json!("true"), json!("FALSE"), json!(false)], ["boolean", "TINYINT(1)", "INTEGER"]),
            (vec![json!("2024-01-31")], ["date", "DATE", "TEXT"]),
            (vec![json!("2024-01-31"), json!("2024-02-01T10:30"), json!("2024-02-01 10:30:15.5")], ["timestamp", "DATETIME", "TEXT"]),
            (vec![json!("1"), json!("abc")], ["text", "TEXT", "TEXT"]),
            (vec![json!("2024-13-01"), json!("inf"), json!("NaN")], ["text", "TEXT", "TEXT"]),
            (vec![json!(null), json!("")], ["text", "TEXT", "TEXT"]),
        ];
        for (values, [pg, my, lite]) in cases {
            assert_eq!(infer(Driver::Postgres, values.clone()), pg, "{values:?}");
            assert_eq!(infer(Driver::Mysql, values.clone()), my);
            assert_eq!(infer(Driver::Mariadb, values.clone()), my);
            assert_eq!(infer(Driver::Sqlite, values.clone()), lite);
        }
        // Only the first 1000 non-empty values count.
        let mut v = vec![json!("1"); 1000];
        v.push(json!("abc"));
        assert_eq!(infer(Driver::Postgres, v), "bigint");
    }
}

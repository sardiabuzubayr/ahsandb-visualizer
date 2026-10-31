//! Output files and row formats for exports: a `.part` file renamed on success (optionally gzip),
//! CSV (RFC 4180), JSON array of objects and batched SQL INSERTs.
use std::borrow::Cow;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

use flate2::Compression;
use flate2::write::GzEncoder;

use crate::ddl::{literal, quote_ident};
use crate::model::{Cell, Column, Driver};

enum Sink {
    Plain(BufWriter<File>),
    Gz(GzEncoder<BufWriter<File>>),
}

/// Writes to `<path>.part`; `commit` renames it to `path`. Dropped without `commit` (error, cancel,
/// panic), the part file is removed, so a failed export never leaves a partial file behind.
pub struct PartFile {
    sink: Option<Sink>,
    part: PathBuf,
    path: PathBuf,
}

impl PartFile {
    pub fn create(path: &str, gzip: bool) -> io::Result<Self> {
        if path.trim().is_empty() {
            return Err(io::Error::other("No output file chosen"));
        }
        let part = PathBuf::from(format!("{path}.part"));
        let file = BufWriter::new(File::create(&part)?);
        let sink = if gzip { Sink::Gz(GzEncoder::new(file, Compression::default())) } else { Sink::Plain(file) };
        Ok(Self { sink: Some(sink), part, path: PathBuf::from(path) })
    }

    /// Flushes (and finishes the gzip stream), then renames the part file to the final path.
    pub fn commit(mut self) -> io::Result<()> {
        let file = match self.sink.take() {
            Some(Sink::Plain(w)) => w.into_inner().map_err(|e| e.into_error())?,
            Some(Sink::Gz(w)) => w.finish()?.into_inner().map_err(|e| e.into_error())?,
            None => return Err(io::Error::other("already committed")),
        };
        file.sync_all()?;
        std::fs::rename(&self.part, &self.path)
    }
}

impl Write for PartFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.sink.as_mut() {
            Some(Sink::Plain(w)) => w.write(buf),
            Some(Sink::Gz(w)) => w.write(buf),
            None => Err(io::Error::other("file closed")),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.sink.as_mut() {
            Some(Sink::Plain(w)) => w.flush(),
            Some(Sink::Gz(w)) => w.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        // After a successful commit the part file is gone (renamed); otherwise remove the leftover.
        self.sink.take();
        let _ = std::fs::remove_file(&self.part);
    }
}

/// A cell as plain text (CSV): NULL → empty, numbers/booleans in JSON notation.
pub fn cell_text(cell: &Cell) -> Cow<'_, str> {
    match cell {
        Cell::Null => Cow::Borrowed(""),
        Cell::String(s) => Cow::Borrowed(s),
        other => Cow::Owned(other.to_string()),
    }
}

/// One CSV record with CRLF (RFC 4180): fields containing the delimiter, a quote, CR or LF are
/// quoted, with quotes doubled.
pub fn csv_line<'a>(fields: impl IntoIterator<Item = Cow<'a, str>>, delim: char) -> String {
    let mut line = String::new();
    for (i, f) in fields.into_iter().enumerate() {
        if i > 0 {
            line.push(delim);
        }
        if f.contains([delim, '"', '\r', '\n']) {
            line.push('"');
            line.push_str(&f.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(&f);
        }
    }
    line + "\r\n"
}

/// `{"col":value,…}` in column order (serde_json maps would sort the keys).
pub fn json_object(cols: &[Column], row: &[Cell]) -> String {
    let fields: Vec<String> = cols
        .iter()
        .zip(row)
        .map(|(c, v)| format!("{}:{}", Cell::String(c.name.clone()), v))
        .collect();
    format!("{{{}}}", fields.join(","))
}

/// `INSERT INTO <table> (cols) VALUES\n(…),\n(…);\n` for one batch; `table` is already quoted.
/// Empty batch → empty string.
pub fn insert_sql(driver: Driver, table: &str, cols: &[Column], rows: &[Vec<Cell>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let names: Vec<String> = cols.iter().map(|c| quote_ident(driver, &c.name)).collect();
    let values: Vec<String> = rows
        .iter()
        .map(|r| format!("({})", r.iter().map(|v| literal(driver, v)).collect::<Vec<_>>().join(", ")))
        .collect();
    format!("INSERT INTO {table} ({}) VALUES\n{};\n", names.join(", "), values.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str) -> Column {
        Column { name: name.into(), type_name: "text".into(), numeric: false, pk: false, fk: false }
    }

    #[test]
    fn csv_escapes() {
        let row = [json!("plain"), json!("a,b"), json!("say \"hi\""), json!("l1\nl2"), json!("cr\r"), json!(null), json!(1.5), json!(true)];
        assert_eq!(
            csv_line(row.iter().map(cell_text), ','),
            "plain,\"a,b\",\"say \"\"hi\"\"\",\"l1\nl2\",\"cr\r\",,1.5,true\r\n"
        );
        // Another delimiter: commas no longer need quotes, semicolons do.
        assert_eq!(csv_line(["a,b", "c;d"].map(Cow::from), ';'), "a,b;\"c;d\"\r\n");
        assert_eq!(csv_line(["x\ty"].map(Cow::from), '\t'), "\"x\ty\"\r\n");
        assert_eq!(csv_line(Vec::<Cow<str>>::new(), ','), "\r\n");
    }

    #[test]
    fn json_objects() {
        let cols = [col("z"), col("a"), col("n"), col("q")];
        let row = [json!(null), json!(42), json!("12.50"), json!("he said \"x\"\n")];
        assert_eq!(json_object(&cols, &row), r#"{"z":null,"a":42,"n":"12.50","q":"he said \"x\"\n"}"#);
        let v: serde_json::Value = serde_json::from_str(&json_object(&cols, &row)).unwrap();
        assert_eq!(v["a"], json!(42));
    }

    #[test]
    fn insert_batches() {
        let cols = [col("id"), col("name")];
        let rows = vec![vec![json!(1), json!("O'Neil")], vec![json!(2), json!(null)]];
        assert_eq!(
            insert_sql(Driver::Postgres, "\"t\"", &cols, &rows),
            "INSERT INTO \"t\" (\"id\", \"name\") VALUES\n(1, 'O''Neil'),\n(2, NULL);\n"
        );
        assert_eq!(
            insert_sql(Driver::Mariadb, "`t`", &cols, &[vec![json!(1), json!(r"a\b")]]),
            "INSERT INTO `t` (`id`, `name`) VALUES\n(1, 'a\\\\b');\n"
        );
        assert_eq!(insert_sql(Driver::Sqlite, "\"t\"", &cols, &[]), "");
    }

    #[test]
    fn part_file_commit_and_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.sql");
        let p = path.to_str().unwrap();
        let part = dir.path().join("out.sql.part");

        let mut f = PartFile::create(p, false).unwrap();
        f.write_all(b"hello").unwrap();
        assert!(part.exists() && !path.exists());
        f.commit().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        assert!(!part.exists());

        // Dropped without commit (failure / cancel): the part file is removed, the old output kept.
        let mut f = PartFile::create(p, false).unwrap();
        f.write_all(b"partial").unwrap();
        drop(f);
        assert!(!part.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");

        // Missing folder → io error, nothing created.
        assert!(PartFile::create(dir.path().join("nope/x.sql").to_str().unwrap(), false).is_err());
    }

    #[test]
    fn part_file_gzip() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.sql.gz");
        let mut f = PartFile::create(path.to_str().unwrap(), true).unwrap();
        f.write_all("SELECT 1;\n".repeat(100).as_bytes()).unwrap();
        f.commit().unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(File::open(&path).unwrap()).read_to_string(&mut text).unwrap();
        assert_eq!(text, "SELECT 1;\n".repeat(100));
    }
}

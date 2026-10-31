//! Database dump (SQL script) and data export (CSV / JSON / SQL INSERT).
use std::borrow::Cow;
use std::io::Write;

use futures::StreamExt;
use sqlx::mysql::{MySql, MySqlRow};
use sqlx::postgres::{PgRow, Postgres};
use sqlx::sqlite::{Sqlite, SqliteRow};
use sqlx::{Column as _, Decode, Executor, Row, TypeInfo, ValueRef};

use super::JobCtx;
use super::writer::{PartFile, cell_text, csv_line, insert_sql, json_object};
use crate::db::Pool;
use crate::db::meta;
use crate::db::preview::Plan;
use crate::db::value::{Dialect, columns};
use crate::ddl::{literal, load_table, plan_schema_changes, qualified, quote_ident};
use crate::error::{AppError, AppResult};
use crate::model::{
    Cell, Column, Connection, DataFormat, DataSource, Driver, DumpContent, DumpObject, ExportDataOptions,
    ExportDatabaseOptions, JobDone, NodeKind, ObjectKind, TableChange, TableDef,
};
use crate::objects::{routines, triggers, views};
use crate::sql::classify::{StatementClass, classify};
use crate::sql::split::split;

/// Writes a re-runnable SQL script of the selected objects. Order: sequences, tables (without
/// foreign keys where the driver can add them later), data, foreign keys, views, routines,
/// triggers, events. MySQL/MariaDB routine/trigger/event bodies are wrapped in `DELIMITER ;;`.
/// Writes to `<path>.part` and renames on success; a cancelled/failed job removes the part file.
pub async fn export_database(pool: &Pool, conn: &Connection, opts: &ExportDatabaseOptions, ctx: &JobCtx) -> JobDone {
    finish(ctx, dump(pool, conn, opts, ctx).await, &opts.path)
}

/// Streams a table or query result to CSV (RFC 4180), JSON (array of objects) or SQL INSERTs.
pub async fn export_data(pool: &Pool, conn: &Connection, opts: &ExportDataOptions, ctx: &JobCtx) -> JobDone {
    finish(ctx, data(pool, conn, opts, ctx).await, &opts.path)
}

fn finish(ctx: &JobCtx, r: AppResult<u64>, path: &str) -> JobDone {
    match r {
        Ok(rows) => JobDone { ok: true, succeeded: rows, message: path.to_string(), ..ctx.done() },
        Err(AppError::Cancelled) => JobDone { cancelled: true, message: "Cancelled".into(), ..ctx.done() },
        Err(e) => JobDone { message: e.to_string(), ..ctx.done() },
    }
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// The dump being written: statements end in `;` and a blank line.
struct Script {
    f: PartFile,
    mysql: bool,
}

impl Script {
    fn stmt(&mut self, sql: &str) -> AppResult<()> {
        writeln!(self.f, "{sql};\n")?;
        Ok(())
    }

    fn plan(&mut self, plan: &Plan) -> AppResult<()> {
        plan.statements.iter().try_for_each(|s| self.stmt(&s.sql))
    }

    /// Routine/trigger/event statements: MySQL/MariaDB bodies contain `;`, so they go inside
    /// `DELIMITER ;;` (understood by `sql::split` and the mysql client).
    fn block(&mut self, stmts: &[String]) -> AppResult<()> {
        if !self.mysql {
            return stmts.iter().try_for_each(|s| self.stmt(s));
        }
        writeln!(self.f, "DELIMITER ;;")?;
        for s in stmts {
            writeln!(self.f, "{s};;")?;
        }
        writeln!(self.f, "DELIMITER ;\n")?;
        Ok(())
    }

    /// Objects the generators can't express (e.g. PG materialized views) are noted and skipped.
    fn usable<T>(&mut self, r: AppResult<T>, what: &str) -> AppResult<Option<T>> {
        match r {
            Ok(v) => Ok(Some(v)),
            Err(AppError::NotSupported(m)) => {
                writeln!(self.f, "-- skipped {}: {}\n", one_line(what), one_line(&m))?;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
}

fn sqls(plan: &Plan) -> Vec<String> {
    plan.statements.iter().map(|s| s.sql.clone()).collect()
}

async fn dump(pool: &Pool, conn: &Connection, opts: &ExportDatabaseOptions, ctx: &JobCtx) -> AppResult<u64> {
    let d = conn.driver;
    let mysql = matches!(d, Driver::Mysql | Driver::Mariadb);
    let schema = opts.schema.as_str();
    // MySQL/MariaDB dumps name objects without their database, so they load into any database.
    let out_schema = if mysql { "" } else { schema };
    let structure = opts.content != DumpContent::Data;
    let data = opts.content != DumpContent::Structure;
    let drop = opts.drop_existing;
    let objects = if opts.objects.is_empty() { list_objects(pool, conn, schema).await? } else { opts.objects.clone() };
    let names = |k: ObjectKind| objects.iter().filter(|o| o.kind == k).map(|o| o.name.clone()).collect::<Vec<_>>();

    let mut tables = Vec::new();
    for name in names(ObjectKind::Table) {
        let mut t = load_table(pool, schema, &name).await?;
        t.schema = out_schema.to_string();
        tables.push(t);
    }
    let tables = dependency_order(tables);

    let mut out = Script { f: PartFile::create(&opts.path, opts.gzip)?, mysql };
    writeln!(
        out.f,
        "-- AhsanDB dump\n-- Connection: {}\n-- Schema: {}\n-- Created: {}\n",
        one_line(&conn.name),
        one_line(schema),
        chrono::Local::now().to_rfc3339()
    )?;
    if mysql {
        out.stmt("SET NAMES utf8mb4")?;
        out.stmt("SET FOREIGN_KEY_CHECKS=0")?;
    } else if d == Driver::Sqlite {
        out.stmt("PRAGMA foreign_keys=OFF")?;
    }
    if opts.transaction {
        out.stmt("BEGIN")?;
    }

    if structure {
        if drop {
            // Views first: PG refuses (without CASCADE) to drop a table a view still uses.
            for v in names(ObjectKind::View) {
                out.stmt(&format!("DROP VIEW IF EXISTS {}", qualified(d, out_schema, &v)))?;
            }
            for t in tables.iter().rev() {
                out.stmt(&format!("DROP TABLE IF EXISTS {}", qualified(d, out_schema, &t.name)))?;
            }
        }
        if d == Driver::Postgres {
            let owned = owned_sequences(pool, schema).await?;
            // shortcut: sequences owned by a column are skipped (the column is re-created as identity,
            // which brings its own sequence); an owned sequence that isn't the column default is lost.
            for s in names(ObjectKind::Sequence).iter().filter(|s| !owned.contains(s)) {
                if drop {
                    out.stmt(&format!("DROP SEQUENCE IF EXISTS {}", qualified(d, out_schema, s)))?;
                }
                let ddl = views::object_ddl(pool, ObjectKind::Sequence, schema, s).await?;
                // shortcut: the current value is restored only when the dump has both structure and data.
                let ddl = if data { ddl.replace("\n-- SELECT setval(", "\nSELECT setval(") } else { ddl };
                writeln!(out.f, "{ddl}\n")?;
            }
        }
        // SQLite keeps FKs inline (no ALTER … ADD CONSTRAINT); PG/MySQL add them after the data.
        let creates: Vec<TableChange> =
            tables.iter().map(|t| TableChange { original: None, target: Some(without_fks(t, d != Driver::Sqlite)) }).collect();
        out.plan(&plan_schema_changes(d, &creates)?)?;
    }

    let mut rows = 0;
    if data {
        let batch = opts.batch_size.max(1) as usize;
        for t in &tables {
            rows += table_rows(pool, d, schema, t, batch, ctx, &mut out.f, rows).await?;
        }
        if d == Driver::Postgres {
            for t in &tables {
                let tab = qualified(d, out_schema, &t.name);
                for c in t.columns.iter().filter(|c| c.auto_increment) {
                    out.stmt(&format!(
                        "SELECT setval(pg_get_serial_sequence({}, {}), COALESCE(MAX({}), 0) + 1, false) FROM {tab}",
                        literal(d, &Cell::String(tab.clone())),
                        literal(d, &Cell::String(c.name.clone())),
                        quote_ident(d, &c.name)
                    ))?;
                }
            }
        }
    }

    if structure {
        if d != Driver::Sqlite {
            let fks: Vec<TableChange> = tables
                .iter()
                .filter(|t| !t.foreign_keys.is_empty())
                .map(|t| TableChange { original: Some(without_fks(t, true)), target: Some(t.clone()) })
                .collect();
            out.plan(&plan_schema_changes(d, &fks)?)?;
        }
        // shortcut: views are written in name order; a view built on a later-named view fails on import.
        for name in names(ObjectKind::View) {
            let Some(mut v) = out.usable(views::load_view(pool, schema, &name).await, &format!("view {name}"))? else { continue };
            if mysql {
                // information_schema qualifies every table with its database; drop that so it loads anywhere.
                // shortcut: plain text replace, also hits the same text inside string literals.
                v.query = v.query.replace(&format!("{}.", quote_ident(d, schema)), "");
            }
            v.schema = out_schema.to_string();
            out.plan(&views::plan_view(d, None, &v)?)?;
        }
        for (kind, label) in [(ObjectKind::Function, "function"), (ObjectKind::Procedure, "procedure")] {
            for name in names(kind) {
                let r = routines::load_routine(pool, conn, schema, &name, label).await;
                let Some(mut r) = out.usable(r, &format!("{label} {name}"))? else { continue };
                r.database = out_schema.to_string();
                // With drop_existing the routine is its own "original": DROP IF EXISTS / OR REPLACE per driver.
                out.block(&sqls(&routines::plan_routine(d, drop.then_some(&r), &r)?))?;
            }
        }
        for name in names(ObjectKind::Trigger) {
            let Some(mut t) = out.usable(triggers::load_trigger(pool, schema, &name).await, &format!("trigger {name}"))? else {
                continue;
            };
            t.schema = out_schema.to_string();
            out.block(&sqls(&triggers::plan_trigger(d, drop.then_some(&t), Some(&t))?))?;
        }
        if mysql {
            for name in names(ObjectKind::Event) {
                let mut stmts = vec![];
                if drop {
                    stmts.push(format!("DROP EVENT IF EXISTS {}", quote_ident(d, &name)));
                }
                let ddl = views::object_ddl(pool, ObjectKind::Event, schema, &name).await?;
                stmts.push(ddl.trim_end().trim_end_matches(';').to_string());
                out.block(&stmts)?;
            }
        }
    }

    if opts.transaction {
        out.stmt("COMMIT")?;
    }
    if mysql {
        out.stmt("SET FOREIGN_KEY_CHECKS=1")?;
    } else if d == Driver::Sqlite {
        out.stmt("PRAGMA foreign_keys=ON")?;
    }
    if ctx.cancelled() {
        return Err(AppError::Cancelled);
    }
    out.f.commit()?;
    ctx.progress(rows, None, "", true);
    Ok(rows)
}

/// `t` without foreign keys when `strip`.
fn without_fks(t: &TableDef, strip: bool) -> TableDef {
    let mut t = t.clone();
    if strip {
        t.foreign_keys.clear();
    }
    t
}

/// Referenced tables first (FKs within the same schema), so data loads in order even with FKs on.
/// A cycle keeps the remaining order.
fn dependency_order(mut rest: Vec<TableDef>) -> Vec<TableDef> {
    let mut out = Vec::with_capacity(rest.len());
    while !rest.is_empty() {
        let waits = |t: &TableDef| {
            t.foreign_keys
                .iter()
                .any(|fk| fk.ref_schema.is_none() && fk.ref_table != t.name && rest.iter().any(|r| r.name == fk.ref_table))
        };
        let i = (0..rest.len()).find(|&i| !waits(&rest[i])).unwrap_or(0);
        out.push(rest.remove(i));
    }
    out
}

/// INSERT batches of one table (ordered by its primary key), with progress per batch. Returns rows written.
#[allow(clippy::too_many_arguments)]
async fn table_rows(
    pool: &Pool,
    d: Driver,
    schema: &str,
    t: &TableDef,
    batch: usize,
    ctx: &JobCtx,
    f: &mut PartFile,
    before: u64,
) -> AppResult<u64> {
    if ctx.cancelled() {
        return Err(AppError::Cancelled);
    }
    let order = if t.primary_key.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", t.primary_key.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", "))
    };
    let sql = format!("SELECT * FROM {}{order}", qualified(d, schema, &t.name));
    let target = qualified(d, &t.schema, &t.name);
    let label = format!("{schema}.{}", t.name);
    ctx.progress(before, None, &label, true);
    let mut done = 0;
    let n = stream_rows(pool, &sql, batch, ctx, &mut |cols, rows| {
        f.write_all(insert_sql(d, &target, cols, rows).as_bytes())?;
        done += rows.len() as u64;
        ctx.progress(before + done, None, &label, false);
        Ok(())
    })
    .await?;
    if n > 0 {
        writeln!(f)?;
    }
    Ok(n)
}

/// Sequences owned by a column (serial / identity) of `schema`.
async fn owned_sequences(pool: &Pool, schema: &str) -> AppResult<Vec<String>> {
    let Pool::Pg(p) = pool else { return Ok(vec![]) };
    Ok(sqlx::query_scalar(
        "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
           AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
         WHERE c.relkind = 'S' AND n.nspname = $1",
    )
    .bind(schema)
    .fetch_all(p)
    .await?)
}

/// Every object of `schema`, from the navigator tree.
async fn list_objects(pool: &Pool, conn: &Connection, schema: &str) -> AppResult<Vec<DumpObject>> {
    let tree = match pool {
        Pool::Pg(_) => meta::database_tree(pool, conn).await?.children.unwrap_or_default(),
        Pool::My(_) => meta::schema_tree(pool, &Connection { database: Some(schema.into()), ..conn.clone() }).await?,
        Pool::Lite(_) => meta::schema_tree(pool, conn).await?,
    };
    let node = tree
        .into_iter()
        .find(|n| n.label == schema && matches!(n.kind, NodeKind::Schema | NodeKind::Database))
        .ok_or_else(|| AppError::NotFound(format!("Schema {schema} not found")))?;
    Ok(node
        .children
        .unwrap_or_default()
        .into_iter()
        .flat_map(|group| group.children.unwrap_or_default())
        .filter_map(|n| {
            let kind = match n.kind {
                NodeKind::Table => ObjectKind::Table,
                NodeKind::View => ObjectKind::View,
                NodeKind::Function => ObjectKind::Function,
                NodeKind::Procedure => ObjectKind::Procedure,
                NodeKind::Trigger => ObjectKind::Trigger,
                NodeKind::Sequence => ObjectKind::Sequence,
                NodeKind::Event => ObjectKind::Event,
                _ => return None,
            };
            Some(DumpObject { kind, name: n.label })
        })
        .collect())
}

async fn data(pool: &Pool, conn: &Connection, opts: &ExportDataOptions, ctx: &JobCtx) -> AppResult<u64> {
    let d = conn.driver;
    let (sql, source) = match &opts.source {
        DataSource::Table { schema, table } => (format!("SELECT * FROM {}", qualified(d, schema, table)), Some(table.as_str())),
        DataSource::Query { sql } => match split(sql, d).as_slice() {
            // One statement only: a read followed by `; DELETE …` must not slip through.
            [one] if classify(one) == StatementClass::Read => (one.clone(), None),
            _ => return Err(AppError::Query("Only read queries can be exported".into())),
        },
    };
    let mut delim = opts.delimiter.as_deref().filter(|s| !s.is_empty()).unwrap_or(",").chars();
    let delim = match (delim.next(), delim.next()) {
        (Some(c), None) if !matches!(c, '"' | '\r' | '\n') => c,
        _ => return Err(AppError::Query("The CSV delimiter must be one character (not a quote or line break)".into())),
    };
    let table = quote_ident(d, opts.table_name.as_deref().filter(|n| !n.trim().is_empty()).or(source).unwrap_or("export"));
    let batch = match opts.format {
        DataFormat::Sql => opts.batch_size.unwrap_or(100).max(1) as usize,
        _ => 1000,
    };
    let label = source.unwrap_or("query").to_string();
    let mut f = PartFile::create(&opts.path, false)?;
    if opts.format == DataFormat::Json {
        f.write_all(b"[")?;
    }
    let mut done = 0;
    let n = stream_rows(pool, &sql, batch, ctx, &mut |cols, rows| {
        let mut chunk = String::new();
        match opts.format {
            DataFormat::Csv => {
                if done == 0 && opts.header {
                    chunk += &csv_line(cols.iter().map(|c| Cow::from(c.name.as_str())), delim);
                }
                for r in rows {
                    chunk += &csv_line(r.iter().map(cell_text), delim);
                }
            }
            DataFormat::Json => {
                for (i, r) in rows.iter().enumerate() {
                    chunk += if done == 0 && i == 0 { "\n" } else { ",\n" };
                    chunk += &json_object(cols, r);
                }
            }
            DataFormat::Sql => chunk = insert_sql(d, &table, cols, rows),
        }
        f.write_all(chunk.as_bytes())?;
        done += rows.len() as u64;
        ctx.progress(done, None, &label, false);
        Ok(())
    })
    .await?;
    if opts.format == DataFormat::Json {
        f.write_all(if n == 0 { b"]\n" } else { b"\n]\n" })?;
    }
    f.commit()?;
    ctx.progress(n, None, &label, true);
    Ok(n)
}

type Sink<'a> = dyn FnMut(&[Column], &[Vec<Cell>]) -> AppResult<()> + Send + 'a;

/// Streams `sql` (text protocol) in batches to `sink`, checking for cancel between batches. The sink is
/// called at least once (with no rows for an empty result) so headers can be written. Returns the row count.
async fn stream_rows(pool: &Pool, sql: &str, batch: usize, ctx: &JobCtx, sink: &mut Sink<'_>) -> AppResult<u64> {
    // A macro over the concrete drivers: a generic fn with an HRTB Executor bound makes the future
    // fail the `Send` check of spawned jobs (rustc "not general enough").
    macro_rules! run {
        ($p:expr, $db:ty) => {{
            let mut c = $p.acquire().await?;
            let mut cols = Vec::new();
            let mut buf = Vec::with_capacity(batch);
            let mut n = 0;
            {
                let mut rows = sqlx::raw_sql(sql).fetch(&mut *c);
                while let Some(row) = rows.next().await {
                    let row = row?;
                    if cols.is_empty() {
                        cols = columns(row.columns());
                    }
                    buf.push(<$db>::export_cells(&row));
                    if buf.len() >= batch {
                        if ctx.cancelled() {
                            return Err(AppError::Cancelled);
                        }
                        sink(&cols, &buf)?;
                        n += buf.len() as u64;
                        buf.clear();
                    }
                }
            }
            if ctx.cancelled() {
                return Err(AppError::Cancelled);
            }
            if n == 0 && buf.is_empty() {
                cols = columns((&mut *c).describe(sql).await?.columns());
            }
            if n == 0 || !buf.is_empty() {
                sink(&cols, &buf)?;
            }
            Ok(n + buf.len() as u64)
        }};
    }
    match pool {
        Pool::Pg(p) => run!(p, Postgres),
        Pool::My(p) => run!(p, MySql),
        Pool::Lite(p) => run!(p, Sqlite),
    }
}

/// Row → cells for export: like the grid's cells, but binary values are complete (not shortened)
/// and PG booleans are real booleans.
trait ExportRow: Dialect {
    fn export_cells(row: &Self::Row) -> Vec<Cell>;
}

// shortcut: binary values that aren't valid UTF-8 are written as `\x…` hex text, which MySQL/SQLite
// store as that text, not the bytes (PG bytea reads it back fine); emit X'…' literals if needed.
fn binary_cell(b: &[u8]) -> Cell {
    match std::str::from_utf8(b) {
        // Control characters (a NUL ends a SQLite statement) count as binary, as in the grid.
        Ok(s) if !s.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) => Cell::String(s.to_string()),
        _ => Cell::String(format!("\\x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())),
    }
}

impl ExportRow for Postgres {
    fn export_cells(row: &PgRow) -> Vec<Cell> {
        let mut cells = Postgres::cells(row);
        for (i, cell) in cells.iter_mut().enumerate() {
            let Ok(v) = row.try_get_raw(i) else { continue };
            if v.is_null() {
                continue;
            }
            match (row.column(i).type_info().name(), v.as_bytes()) {
                // The full `\x…` text, which bytea accepts back as a literal.
                ("BYTEA", Ok(b)) => *cell = Cell::String(String::from_utf8_lossy(b).into_owned()),
                ("BOOL", Ok(b)) => *cell = Cell::Bool(b == b"t"),
                _ => {}
            }
        }
        cells
    }
}

impl ExportRow for MySql {
    fn export_cells(row: &MySqlRow) -> Vec<Cell> {
        const BINARY: [&str; 8] = ["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit", "geometry"];
        let mut cells = MySql::cells(row);
        for (i, cell) in cells.iter_mut().enumerate() {
            let ty = row.column(i).type_info().name().to_ascii_lowercase();
            if BINARY.contains(&ty.split([' ', '(']).next().unwrap_or_default())
                && let Ok(v) = row.try_get_raw(i)
                && !v.is_null()
                && let Ok(b) = <&[u8] as Decode<MySql>>::decode(v)
            {
                *cell = binary_cell(b);
            }
        }
        cells
    }
}

impl ExportRow for Sqlite {
    fn export_cells(row: &SqliteRow) -> Vec<Cell> {
        let mut cells = Sqlite::cells(row);
        for (i, cell) in cells.iter_mut().enumerate() {
            if let Ok(v) = row.try_get_raw(i)
                && !v.is_null()
                && v.type_info().name() == "BLOB"
                && let Ok(b) = <&[u8] as Decode<Sqlite>>::decode(v)
            {
                *cell = binary_cell(b);
            }
        }
        cells
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnDef, ForeignKeyDef};

    fn table(name: &str, refs: &[&str]) -> TableDef {
        TableDef {
            schema: "s".into(),
            name: name.into(),
            columns: vec![ColumnDef {
                name: "id".into(),
                original_name: None,
                type_name: "int".into(),
                nullable: false,
                default: None,
                auto_increment: false,
            }],
            primary_key: vec![],
            foreign_keys: refs
                .iter()
                .map(|r| ForeignKeyDef {
                    name: None,
                    columns: vec!["id".into()],
                    ref_schema: None,
                    ref_table: r.to_string(),
                    ref_columns: vec!["id".into()],
                    on_delete: None,
                    on_update: None,
                })
                .collect(),
            indexes: vec![],
            checks: vec![],
        }
    }

    #[test]
    fn tables_in_dependency_order() {
        let names = |v: Vec<TableDef>| v.into_iter().map(|t| t.name).collect::<Vec<_>>();
        let order = dependency_order(vec![table("items", &["orders", "products"]), table("orders", &["customers", "orders"]), table("products", &[]), table("customers", &[])]);
        assert_eq!(names(order), ["products", "customers", "orders", "items"]);
        // A cycle keeps the given order instead of looping.
        assert_eq!(names(dependency_order(vec![table("a", &["b"]), table("b", &["a"])])), ["a", "b"]);
    }

    #[test]
    fn binary_cells() {
        assert_eq!(binary_cell(b"text"), Cell::String("text".into()));
        assert_eq!(binary_cell(&[0xde, 0xad, 0xbe, 0xef]), Cell::String("\\xdeadbeef".into()));
        assert_eq!(binary_cell(&[0x41, 0]), Cell::String("\\x4100".into()));
        assert_eq!(binary_cell(&[0u8; 100]), Cell::String(format!("\\x{}", "00".repeat(100))));
    }

    #[test]
    fn finish_maps_outcomes() {
        let (ctx, _) = JobCtx::for_test();
        let ok = finish(&ctx, Ok(5), "/tmp/x.sql");
        assert!(ok.ok && ok.succeeded == 5 && ok.message == "/tmp/x.sql");
        let c = finish(&ctx, Err(AppError::Cancelled), "/tmp/x.sql");
        assert!(!c.ok && c.cancelled);
        let e = finish(&ctx, Err(AppError::Query("Only read queries can be exported".into())), "/tmp/x.sql");
        assert!(!e.ok && !e.cancelled && e.message == "Only read queries can be exported");
    }
}

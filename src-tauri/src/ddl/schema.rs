//! CREATE / ALTER / DROP generation per dialect.
use std::collections::HashSet;

use super::load::strip_parens;
use super::{qualified, quote_ident};
use crate::db::preview::{FK_CHECK, FK_OFF, FK_ON, Plan, PlannedStatement};
use crate::error::{AppError, AppResult};
use crate::model::{CheckDef, ColumnDef, Driver, ForeignKeyDef, IndexDef, TableChange, TableDef};

pub(super) const MYSQL_WARNING: &str =
    "MySQL/MariaDB applies DDL statement by statement; a failure leaves earlier statements applied";

/// CREATE / ALTER (rename, add/drop/modify columns, PK, FKs, indexes, checks) / DROP for each change.
/// SQLite alters it can't express (type/nullability/default change, drop column with FKs, PK/FK change)
/// use the documented table-rebuild procedure inside the transaction. Transactional for PG/SQLite;
/// MySQL/MariaDB DDL is not (implicit commit) — the plan says so and adds a warning.
///
/// Statement order (PG/MySQL): drop FKs → drop indexes/checks → drop tables → alter tables → create
/// tables (referenced first, FKs inline) → add indexes/checks → add FKs (alters, and FK cycles between
/// new tables), so nothing is dropped while still referenced.
pub fn plan_schema_changes(driver: Driver, changes: &[TableChange]) -> AppResult<Plan> {
    for t in changes.iter().filter_map(|c| c.target.as_ref()) {
        validate(driver, t)?;
    }
    let mut plan = if driver == Driver::Sqlite { sqlite(changes)? } else { server(driver, changes)? };
    plan.warnings.extend(fk_type_warnings(changes));
    if is_mysql(driver) && !plan.statements.is_empty() {
        plan.transactional = false;
        plan.warnings.insert(0, MYSQL_WARNING.into());
    }
    Ok(plan)
}

fn is_mysql(d: Driver) -> bool {
    matches!(d, Driver::Mysql | Driver::Mariadb)
}

fn q(d: Driver, s: &str) -> String {
    quote_ident(d, s)
}

fn list(d: Driver, cols: &[String]) -> String {
    cols.iter().map(|c| q(d, c)).collect::<Vec<_>>().join(", ")
}

/// Lowercase, single-spaced: `Character  Varying(20)` → `character varying(20)`.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn default_of(c: &ColumnDef) -> Option<&str> {
    c.default.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn ref_schema<'a>(fk: &'a ForeignKeyDef, default: &'a str) -> &'a str {
    fk.ref_schema.as_deref().filter(|s| !s.is_empty()).unwrap_or(default)
}

/// Constraint name, generated as `<table>_<cols>_fkey` (63 chars max, PostgreSQL's limit) when empty.
fn fk_name(table: &str, fk: &ForeignKeyDef) -> String {
    match fk.name.as_deref().filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => format!("{table}_{}_fkey", fk.columns.join("_")).chars().take(63).collect(),
    }
}

/// Validated referential action, uppercase; `None` for the database default.
fn action(a: &Option<String>) -> AppResult<Option<String>> {
    let Some(a) = a.as_deref().map(|a| a.split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase()).filter(|a| !a.is_empty()) else {
        return Ok(None);
    };
    if ["CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT", "NO ACTION"].contains(&a.as_str()) {
        Ok(Some(a))
    } else {
        Err(AppError::Query(format!("Unknown foreign key action: {a}")))
    }
}

/// Action for comparisons: the default spelled out equals no action given.
fn norm_action(d: Driver, a: &Option<String>) -> Option<String> {
    action(a).ok().flatten().filter(|a| a != "NO ACTION" && !(is_mysql(d) && a == "RESTRICT"))
}

fn validate(d: Driver, t: &TableDef) -> AppResult<()> {
    let bad = |m: String| Err(AppError::Query(m));
    if t.name.trim().is_empty() {
        return bad("Table name is empty".into());
    }
    if t.columns.is_empty() {
        return bad(format!("Table {} has no columns", t.name));
    }
    let mut names = HashSet::new();
    for c in &t.columns {
        if c.name.trim().is_empty() {
            return bad(format!("A column of {} has no name", t.name));
        }
        if !names.insert(c.name.as_str()) {
            return bad(format!("Column {} appears twice", c.name));
        }
        if c.type_name.trim().is_empty() && d != Driver::Sqlite {
            return bad(format!("Column {} has no type", c.name));
        }
        if d == Driver::Sqlite && c.auto_increment && t.primary_key != [c.name.clone()] {
            return bad(format!("SQLite auto-increment needs {} to be the only primary key column", c.name));
        }
    }
    let missing = |cols: &[String]| cols.iter().find(|c| !names.contains(c.as_str())).cloned();
    if let Some(c) = missing(&t.primary_key) {
        return bad(format!("Primary key column {c} doesn't exist"));
    }
    for fk in &t.foreign_keys {
        if fk.columns.is_empty() || fk.columns.len() != fk.ref_columns.len() || fk.ref_table.trim().is_empty() {
            return bad(format!("Foreign key {} needs matching columns and a referenced table", fk_name(&t.name, fk)));
        }
        if let Some(c) = missing(&fk.columns) {
            return bad(format!("Foreign key column {c} doesn't exist"));
        }
        action(&fk.on_delete)?;
        action(&fk.on_update)?;
    }
    for i in &t.indexes {
        if i.name.trim().is_empty() {
            return bad(format!("An index on {} has no name", t.name));
        }
        if i.columns.is_empty() {
            return bad(format!("Index {} has no columns", i.name));
        }
        if let Some(c) = missing(&i.columns) {
            return bad(format!("Index column {c} doesn't exist"));
        }
    }
    if t.checks.iter().any(|c| c.expression.trim().is_empty()) {
        return bad(format!("A check on {} has no expression", t.name));
    }
    Ok(())
}

/// `name type [identity] [NOT NULL] [DEFAULT x] [AUTO_INCREMENT]`; `rowid` = SQLite
/// `INTEGER PRIMARY KEY AUTOINCREMENT` column (the table then has no separate PRIMARY KEY clause).
fn column_sql(d: Driver, c: &ColumnDef, rowid: bool) -> String {
    let name = q(d, &c.name);
    if rowid {
        return format!("{name} INTEGER PRIMARY KEY AUTOINCREMENT");
    }
    let mut s = format!("{name} {}", c.type_name.trim()).trim_end().to_string();
    if d == Driver::Postgres && c.auto_increment {
        s += " GENERATED BY DEFAULT AS IDENTITY";
    }
    if !c.nullable {
        s += " NOT NULL";
    } else if is_mysql(d) {
        s += " NULL"; // explicit: MySQL TIMESTAMP columns are otherwise NOT NULL
    }
    if let Some(x) = default_of(c).filter(|_| !(d == Driver::Postgres && c.auto_increment)) {
        s += &format!(" DEFAULT {x}");
    }
    if is_mysql(d) && c.auto_increment {
        s += " AUTO_INCREMENT";
    }
    s
}

fn fk_clause(d: Driver, t: &TableDef, fk: &ForeignKeyDef) -> String {
    // SQLite REFERENCES can't name a schema.
    let target =
        if d == Driver::Sqlite { q(d, &fk.ref_table) } else { qualified(d, ref_schema(fk, &t.schema), &fk.ref_table) };
    let mut s = format!(
        "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {target} ({})",
        q(d, &fk_name(&t.name, fk)),
        list(d, &fk.columns),
        list(d, &fk.ref_columns)
    );
    if let Some(a) = action(&fk.on_delete).ok().flatten() {
        s += &format!(" ON DELETE {a}");
    }
    if let Some(a) = action(&fk.on_update).ok().flatten() {
        s += &format!(" ON UPDATE {a}");
    }
    s
}

fn check_clause(d: Driver, c: &CheckDef) -> String {
    match c.name.as_deref().filter(|n| !n.is_empty()) {
        Some(n) => format!("CONSTRAINT {} CHECK ({})", q(d, n), c.expression.trim()),
        None => format!("CHECK ({})", c.expression.trim()),
    }
}

/// SQLite reserves `sqlite_*` names (auto-indexes of UNIQUE constraints): recreate those as `<table>_<cols>_key`.
fn index_name(d: Driver, table: &str, i: &IndexDef) -> String {
    if d == Driver::Sqlite && i.name.to_lowercase().starts_with("sqlite_") {
        format!("{table}_{}_key", i.columns.join("_"))
    } else {
        i.name.clone()
    }
}

fn create_index(d: Driver, schema: &str, table: &str, i: &IndexDef) -> String {
    let name = index_name(d, table, i);
    let on = match d {
        Driver::Sqlite => format!("{} ON {}", qualified(d, schema, &name), q(d, table)),
        _ => format!("{} ON {}", q(d, &name), qualified(d, schema, table)),
    };
    format!("CREATE {}INDEX {on} ({})", if i.unique { "UNIQUE " } else { "" }, list(d, &i.columns))
}

fn drop_index(d: Driver, schema: &str, table: &str, name: &str) -> Vec<String> {
    match d {
        // A unique index may belong to a UNIQUE constraint, which must be dropped as a constraint.
        Driver::Postgres => vec![
            format!("ALTER TABLE {} DROP CONSTRAINT IF EXISTS {}", qualified(d, schema, table), q(d, name)),
            format!("DROP INDEX IF EXISTS {}", qualified(d, schema, name)),
        ],
        Driver::Sqlite => vec![format!("DROP INDEX {}", qualified(d, schema, name))],
        _ => vec![format!("DROP INDEX {} ON {}", q(d, name), qualified(d, schema, table))],
    }
}

/// CREATE TABLE named `as_name` with columns, PK, the given FKs and checks inline.
fn create_table(d: Driver, t: &TableDef, fks: &[&ForeignKeyDef], as_name: &str) -> String {
    let rowid = |c: &ColumnDef| d == Driver::Sqlite && c.auto_increment;
    let mut lines: Vec<String> = t.columns.iter().map(|c| column_sql(d, c, rowid(c))).collect();
    if !t.primary_key.is_empty() && !t.columns.iter().any(rowid) {
        lines.push(format!("PRIMARY KEY ({})", list(d, &t.primary_key)));
    }
    lines.extend(fks.iter().map(|fk| fk_clause(d, t, fk)));
    lines.extend(t.checks.iter().map(|c| check_clause(d, c)));
    format!("CREATE TABLE {} (\n  {}\n)", qualified(d, &t.schema, as_name), lines.join(",\n  "))
}

/// Column-level comparison of an original table with its target, with the original's PK, FKs and
/// indexes rewritten to target column names (dropped columns map to a name nothing can match).
struct Diff<'a> {
    kept: Vec<(&'a ColumnDef, &'a ColumnDef)>,
    added: Vec<&'a ColumnDef>,
    dropped: Vec<&'a ColumnDef>,
    pk: Vec<String>,
    fks: Vec<ForeignKeyDef>,
    indexes: Vec<IndexDef>,
}

fn diff<'a>(o: &'a TableDef, t: &'a TableDef) -> Diff<'a> {
    let mut kept: Vec<(&ColumnDef, &ColumnDef)> = vec![];
    let mut added = vec![];
    for tc in &t.columns {
        let orig = tc.original_name.as_deref().and_then(|n| o.columns.iter().find(|oc| oc.name == n));
        match orig {
            Some(oc) if !kept.iter().any(|(k, _)| k.name == oc.name) => kept.push((oc, tc)),
            _ => added.push(tc),
        }
    }
    let dropped = o.columns.iter().filter(|oc| !kept.iter().any(|(k, _)| k.name == oc.name)).collect();
    let fwd = |c: &String| match kept.iter().find(|(k, _)| &k.name == c) {
        Some((_, tc)) => tc.name.clone(),
        None => format!("\0{c}"),
    };
    let fwd_all = |cols: &[String]| cols.iter().map(fwd).collect::<Vec<_>>();
    let pk = fwd_all(&o.primary_key);
    let fks = o
        .foreign_keys
        .iter()
        .map(|f| {
            let mut f = f.clone();
            f.columns = fwd_all(&f.columns);
            if f.ref_table == o.name && ref_schema(&f, &o.schema) == o.schema {
                f.ref_table = t.name.clone();
                f.ref_columns = fwd_all(&f.ref_columns);
            }
            f
        })
        .collect();
    let indexes = o.indexes.iter().map(|i| IndexDef { columns: fwd_all(&i.columns), ..i.clone() }).collect();
    Diff { kept, added, dropped, pk, fks, indexes }
}

fn names_compatible(a: &Option<String>, b: &Option<String>) -> bool {
    match (a.as_deref().filter(|n| !n.is_empty()), b.as_deref().filter(|n| !n.is_empty())) {
        (Some(x), Some(y)) => x == y,
        _ => true,
    }
}

/// Same constraint: equal definition, and equal names when both have one.
fn fk_matches(d: Driver, schema: &str, a: &ForeignKeyDef, b: &ForeignKeyDef) -> bool {
    names_compatible(&a.name, &b.name)
        && a.columns == b.columns
        && a.ref_table == b.ref_table
        && a.ref_columns == b.ref_columns
        && ref_schema(a, schema) == ref_schema(b, schema)
        && norm_action(d, &a.on_delete) == norm_action(d, &b.on_delete)
        && norm_action(d, &a.on_update) == norm_action(d, &b.on_update)
}

fn check_matches(a: &CheckDef, b: &CheckDef) -> bool {
    names_compatible(&a.name, &b.name) && norm(strip_parens(&a.expression)) == norm(strip_parens(&b.expression))
}

fn column_changed(a: &ColumnDef, b: &ColumnDef) -> bool {
    norm(&a.type_name) != norm(&b.type_name)
        || a.nullable != b.nullable
        || default_of(a) != default_of(b)
        || a.auto_increment != b.auto_increment
}

/// Dropped tables, referencing tables first (so no DROP hits a table still referenced from the set).
fn drop_order<'a>(dropped: &[&'a TableDef]) -> Vec<&'a TableDef> {
    let mut rest = dropped.to_vec();
    let mut out = vec![];
    while !rest.is_empty() {
        let referenced = |i: usize| {
            rest.iter().enumerate().any(|(j, other)| {
                j != i && other.foreign_keys.iter().any(|fk| fk.ref_table == rest[i].name && ref_schema(fk, &other.schema) == rest[i].schema)
            })
        };
        let i = (0..rest.len()).find(|&i| !referenced(i)).unwrap_or(0);
        out.push(rest.remove(i));
    }
    out
}

#[derive(Default)]
struct Phases {
    drop_fks: Vec<String>,
    drop_other: Vec<String>,
    drop_tables: Vec<String>,
    body: Vec<String>,
    add_other: Vec<String>,
    add_fks: Vec<String>,
}

/// New tables, referenced ones first (topological over FKs among them); a cycle keeps change order.
fn create_order<'a>(created: &[&'a TableDef]) -> Vec<&'a TableDef> {
    let mut rest = created.to_vec();
    let mut out = vec![];
    while !rest.is_empty() {
        let waits = |t: &TableDef| {
            t.foreign_keys.iter().any(|fk| {
                let rs = ref_schema(fk, &t.schema);
                !(rs == t.schema && fk.ref_table == t.name) && rest.iter().any(|r| r.schema == rs && r.name == fk.ref_table)
            })
        };
        let i = (0..rest.len()).find(|&i| !waits(rest[i])).unwrap_or(0);
        out.push(rest.remove(i));
    }
    out
}

fn server(d: Driver, changes: &[TableChange]) -> AppResult<Plan> {
    let mut ph = Phases::default();
    let mut plan = Plan { transactional: true, ..Default::default() };
    let mut created = vec![];
    let mut dropped = vec![];
    for ch in changes {
        match (&ch.original, &ch.target) {
            (None, None) => {}
            (None, Some(t)) => created.push(t),
            (Some(o), None) => {
                dropped.push(o);
                plan.destructive = true;
            }
            (Some(o), Some(t)) => alter_server(d, o, t, &mut ph, &mut plan)?,
        }
    }
    // CREATEs run after alters (so they can reference renamed tables), referenced tables first. An FK
    // to a new table not created yet (a cycle) is added with ALTER TABLE after all CREATEs.
    let order = create_order(&created);
    for (n, t) in order.iter().enumerate() {
        let (inline, later): (Vec<&ForeignKeyDef>, Vec<&ForeignKeyDef>) = t.foreign_keys.iter().partition(|fk| {
            let rs = ref_schema(fk, &t.schema);
            !order[n..].iter().any(|r| r.schema == rs && r.name == fk.ref_table && !std::ptr::eq(*r, *t))
        });
        ph.body.push(create_table(d, t, &inline, &t.name));
        ph.add_other.extend(t.indexes.iter().map(|i| create_index(d, &t.schema, &t.name, i)));
        let tab = qualified(d, &t.schema, &t.name);
        ph.add_fks.extend(later.iter().map(|fk| format!("ALTER TABLE {tab} ADD {}", fk_clause(d, t, fk))));
    }
    ph.drop_tables = drop_order(&dropped).iter().map(|o| format!("DROP TABLE {}", qualified(d, &o.schema, &o.name))).collect();
    plan.statements = [ph.drop_fks, ph.drop_other, ph.drop_tables, ph.body, ph.add_other, ph.add_fks]
        .into_iter()
        .flatten()
        .map(PlannedStatement::new)
        .collect();
    Ok(plan)
}

fn alter_server(d: Driver, o: &TableDef, t: &TableDef, ph: &mut Phases, plan: &mut Plan) -> AppResult<()> {
    if o.schema != t.schema {
        return Err(AppError::NotSupported("Moving a table to another schema isn't supported".into()));
    }
    let mysql = is_mysql(d);
    let otab = qualified(d, &o.schema, &o.name);
    let ttab = qualified(d, &t.schema, &t.name);
    let df = diff(o, t);

    // Drops use the original table name: they run before any rename.
    for (orig, mapped) in o.foreign_keys.iter().zip(&df.fks) {
        if !t.foreign_keys.iter().any(|f| fk_matches(d, &t.schema, f, mapped)) {
            let name = q(d, &fk_name(&o.name, orig));
            ph.drop_fks.push(if mysql {
                format!("ALTER TABLE {otab} DROP FOREIGN KEY {name}")
            } else {
                format!("ALTER TABLE {otab} DROP CONSTRAINT {name}")
            });
        }
    }
    for f in &t.foreign_keys {
        if !df.fks.iter().any(|m| fk_matches(d, &t.schema, f, m)) {
            ph.add_fks.push(format!("ALTER TABLE {ttab} ADD {}", fk_clause(d, t, f)));
        }
    }
    for (orig, mapped) in o.indexes.iter().zip(&df.indexes) {
        if !t.indexes.contains(mapped) {
            ph.drop_other.extend(drop_index(d, &o.schema, &o.name, &orig.name));
        }
    }
    for i in &t.indexes {
        if !df.indexes.contains(i) {
            ph.add_other.push(create_index(d, &t.schema, &t.name, i));
        }
    }
    for c in &o.checks {
        if !t.checks.iter().any(|tc| check_matches(tc, c)) {
            let Some(name) = c.name.as_deref() else {
                return Err(AppError::NotSupported(format!("Check ({}) has no name and can't be dropped", c.expression)));
            };
            ph.drop_other.push(format!("ALTER TABLE {otab} DROP CONSTRAINT {}", q(d, name)));
        }
    }
    for c in &t.checks {
        if !o.checks.iter().any(|oc| check_matches(c, oc)) {
            ph.add_other.push(format!("ALTER TABLE {ttab} ADD {}", check_clause(d, c)));
        }
    }

    let body = &mut ph.body;
    if o.name != t.name {
        body.push(format!("ALTER TABLE {otab} RENAME TO {}", if mysql { ttab.clone() } else { q(d, &t.name) }));
    }
    let pk_changed = df.pk != t.primary_key;
    if !mysql {
        // shortcut: swapping two column names (a→b, b→a) collides; needs a temporary name.
        for (oc, tc) in df.kept.iter().filter(|(oc, tc)| oc.name != tc.name) {
            body.push(format!("ALTER TABLE {ttab} RENAME COLUMN {} TO {}", q(d, &oc.name), q(d, &tc.name)));
        }
    }
    if pk_changed && !o.primary_key.is_empty() {
        body.push(if mysql {
            format!("ALTER TABLE {ttab} DROP PRIMARY KEY")
        } else {
            // The PK constraint's name isn't part of TableDef (and survives table renames), so look it up.
            format!(
                "DO $ahsandb$ BEGIN EXECUTE (SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) \
                 FROM pg_constraint WHERE conrelid = {}::regclass AND contype = 'p'); END $ahsandb$",
                super::literal(d, &serde_json::Value::String(ttab.clone()))
            )
        });
    }
    for c in &df.dropped {
        body.push(format!("ALTER TABLE {ttab} DROP COLUMN {}", q(d, &c.name)));
        plan.destructive = true;
    }
    for (oc, tc) in &df.kept {
        if mysql {
            if oc.name != tc.name || column_changed(oc, tc) {
                body.push(format!("ALTER TABLE {ttab} CHANGE COLUMN {} {}", q(d, &oc.name), column_sql(d, tc, false)));
            }
        } else {
            body.extend(pg_modify(&ttab, oc, tc));
        }
    }
    // shortcut: adding an AUTO_INCREMENT column to an existing MySQL table fails unless it's already a key.
    for c in &df.added {
        body.push(format!("ALTER TABLE {ttab} ADD COLUMN {}", column_sql(d, c, false)));
    }
    if pk_changed && !t.primary_key.is_empty() {
        body.push(format!("ALTER TABLE {ttab} ADD PRIMARY KEY ({})", list(d, &t.primary_key)));
    }
    Ok(())
}

/// PostgreSQL ALTER COLUMN steps, ordered so identity changes see the right nullability/default.
fn pg_modify(ttab: &str, oc: &ColumnDef, tc: &ColumnDef) -> Vec<String> {
    let d = Driver::Postgres;
    let a = format!("ALTER TABLE {ttab} ALTER COLUMN {}", q(d, &tc.name));
    let mut out = vec![];
    if oc.auto_increment && !tc.auto_increment {
        // Works for identity; for serial the nextval() default is what goes.
        out.push(format!("{a} DROP IDENTITY IF EXISTS"));
        if default_of(tc).is_none() {
            out.push(format!("{a} DROP DEFAULT"));
        }
    }
    if norm(&oc.type_name) != norm(&tc.type_name) {
        let ty = tc.type_name.trim();
        out.push(format!("{a} TYPE {ty} USING {}::{ty}", q(d, &tc.name)));
    }
    if oc.nullable != tc.nullable {
        out.push(format!("{a} {} NOT NULL", if tc.nullable { "DROP" } else { "SET" }));
    }
    let od = default_of(oc).filter(|_| !oc.auto_increment);
    let td = default_of(tc).filter(|_| !tc.auto_increment);
    if od != td {
        out.push(match td {
            Some(x) => format!("{a} SET DEFAULT {x}"),
            None => format!("{a} DROP DEFAULT"),
        });
    }
    if !oc.auto_increment && tc.auto_increment {
        // shortcut: the identity starts at 1 even when rows exist; set RESTART manually if needed.
        out.push(format!("{a} ADD GENERATED BY DEFAULT AS IDENTITY"));
    }
    out
}

fn sqlite(changes: &[TableChange]) -> AppResult<Plan> {
    let d = Driver::Sqlite;
    let mut plan = Plan { transactional: true, ..Default::default() };
    let mut st: Vec<String> = vec![];
    let mut rebuilt: Vec<&str> = vec![];
    let mut created = vec![];
    let mut dropped = vec![];
    for ch in changes {
        match (&ch.original, &ch.target) {
            (None, None) => {}
            (None, Some(t)) => created.push(t),
            (Some(o), None) => {
                dropped.push(o);
                plan.destructive = true;
            }
            (Some(o), Some(t)) => {
                if alter_sqlite(o, t, &mut st, &mut plan)? {
                    rebuilt.push(&t.name);
                }
            }
        }
    }
    // SQLite resolves REFERENCES lazily (cycles are fine, FKs always inline); the order is just tidier.
    for t in create_order(&created) {
        st.push(create_table(d, t, &t.foreign_keys.iter().collect::<Vec<_>>(), &t.name));
        st.extend(t.indexes.iter().map(|i| create_index(d, &t.schema, &t.name, i)));
    }
    let drops = drop_order(&dropped).into_iter().map(|o| format!("DROP TABLE {}", qualified(d, &o.schema, &o.name)));
    st.splice(0..0, drops);
    if !rebuilt.is_empty() {
        // Rebuilds run with FK enforcement off (see preview::FK_OFF), then verify the rebuilt tables.
        st.insert(0, FK_OFF.into());
        st.extend(rebuilt.iter().map(|n| format!("{FK_CHECK}({})", q(d, n))));
        st.push(FK_ON.into());
    }
    plan.statements = st.into_iter().map(PlannedStatement::new).collect();
    Ok(plan)
}

/// SQLite accepts a constant default for ADD COLUMN (no CURRENT_* or expressions).
fn constant_default(c: &ColumnDef) -> bool {
    default_of(c).is_none_or(|x| !x.contains('(') && !x.to_uppercase().starts_with("CURRENT_"))
}

/// Native ALTERs where SQLite supports them; otherwise the 12-step rebuild (renames still go first
/// natively so SQLite rewrites references in other tables, indexes, triggers and views). Returns
/// whether the table is rebuilt.
fn alter_sqlite(o: &TableDef, t: &TableDef, st: &mut Vec<String>, plan: &mut Plan) -> AppResult<bool> {
    let d = Driver::Sqlite;
    if o.schema != t.schema {
        return Err(AppError::NotSupported("Moving a table to another schema isn't supported".into()));
    }
    let df = diff(o, t);
    if o.name != t.name {
        st.push(format!("ALTER TABLE {} RENAME TO {}", qualified(d, &o.schema, &o.name), q(d, &t.name)));
    }
    let cur = qualified(d, &t.schema, &t.name);
    for (oc, tc) in df.kept.iter().filter(|(oc, tc)| oc.name != tc.name) {
        st.push(format!("ALTER TABLE {cur} RENAME COLUMN {} TO {}", q(d, &oc.name), q(d, &tc.name)));
    }
    if !df.dropped.is_empty() {
        plan.destructive = true;
    }
    let same_set = |a: usize, b: usize, all_a_in_b: bool, all_b_in_a: bool| a == b && all_a_in_b && all_b_in_a;
    let fks_same = same_set(
        df.fks.len(),
        t.foreign_keys.len(),
        df.fks.iter().all(|m| t.foreign_keys.iter().any(|f| fk_matches(d, &t.schema, f, m))),
        t.foreign_keys.iter().all(|f| df.fks.iter().any(|m| fk_matches(d, &t.schema, f, m))),
    );
    let checks_same = same_set(
        o.checks.len(),
        t.checks.len(),
        o.checks.iter().all(|c| t.checks.iter().any(|tc| check_matches(tc, c))),
        t.checks.iter().all(|c| o.checks.iter().any(|oc| check_matches(c, oc))),
    );
    let removed_idx: Vec<(&IndexDef, &IndexDef)> =
        o.indexes.iter().zip(&df.indexes).filter(|(_, m)| !t.indexes.contains(m)).collect();
    let surviving_idx: Vec<&IndexDef> = o.indexes.iter().zip(&df.indexes).filter(|(_, m)| t.indexes.contains(m)).map(|(i, _)| i).collect();
    let add_ok = |c: &&ColumnDef| {
        !c.auto_increment && !t.primary_key.contains(&c.name) && (c.nullable || default_of(c).is_some()) && constant_default(c)
    };
    let drop_ok = |c: &&ColumnDef| {
        !o.primary_key.contains(&c.name)
            && !surviving_idx.iter().any(|i| i.columns.contains(&c.name))
            && !o.foreign_keys.iter().any(|f| f.columns.contains(&c.name))
            && !o.checks.iter().any(|k| k.expression.contains(&c.name))
    };
    let rebuild = df.pk != t.primary_key
        || !fks_same
        || !checks_same
        || df.kept.iter().any(|(oc, tc)| column_changed(oc, tc))
        || !df.added.iter().all(add_ok)
        || !df.dropped.iter().all(drop_ok)
        || removed_idx.iter().any(|(i, _)| i.name.to_lowercase().starts_with("sqlite_"));
    if !rebuild {
        for (i, _) in &removed_idx {
            st.extend(drop_index(d, &o.schema, &o.name, &i.name));
        }
        for c in &df.dropped {
            st.push(format!("ALTER TABLE {cur} DROP COLUMN {}", q(d, &c.name)));
        }
        for c in &df.added {
            st.push(format!("ALTER TABLE {cur} ADD COLUMN {}", column_sql(d, c, false)));
        }
        for i in t.indexes.iter().filter(|i| !df.indexes.contains(i)) {
            st.push(create_index(d, &t.schema, &t.name, i));
        }
        return Ok(false);
    }
    // https://www.sqlite.org/lang_altertable.html#otheralter, but the rows wait in a TEMP copy instead of
    // building `_ahsandb_new_<name>` and renaming it: SQLite ≥ 3.35 refuses that RENAME while a view
    // still references the dropped table ("error in view …: no such table").
    let tmp = q(d, &format!("_ahsandb_old_{}", t.name));
    // Columns were renamed natively above, so kept columns have their target names in the old table.
    let copy = list(d, &df.kept.iter().map(|(_, tc)| tc.name.clone()).collect::<Vec<_>>());
    if !df.kept.is_empty() {
        st.push(format!("CREATE TEMP TABLE {tmp} AS SELECT {copy} FROM {cur}"));
    }
    st.push(format!("DROP TABLE {cur}"));
    st.push(create_table(d, t, &t.foreign_keys.iter().collect::<Vec<_>>(), &t.name));
    if !df.kept.is_empty() {
        st.push(format!("INSERT INTO {cur} ({copy}) SELECT {copy} FROM temp.{tmp}"));
        st.push(format!("DROP TABLE temp.{tmp}"));
    }
    st.extend(t.indexes.iter().map(|i| create_index(d, &t.schema, &t.name, i)));
    // shortcut: triggers on the rebuilt table are dropped with it; recreating them needs their SQL from sqlite_master.
    plan.warnings.push(format!("Table {} will be rebuilt (its triggers are not kept)", t.name));
    Ok(true)
}

/// "types differ" for new FKs whose referenced table is also in the change set.
fn fk_type_warnings(changes: &[TableChange]) -> Vec<String> {
    let targets: Vec<&TableDef> = changes.iter().filter_map(|c| c.target.as_ref()).collect();
    let mut out = vec![];
    for ch in changes {
        let Some(t) = &ch.target else { continue };
        for fk in &t.foreign_keys {
            if ch.original.as_ref().is_some_and(|o| o.foreign_keys.contains(fk)) {
                continue;
            }
            let Some(rt) = targets.iter().find(|r| r.name == fk.ref_table && r.schema == ref_schema(fk, &t.schema)) else { continue };
            for (c, rc) in fk.columns.iter().zip(&fk.ref_columns) {
                let a = t.columns.iter().find(|x| &x.name == c);
                let b = rt.columns.iter().find(|x| &x.name == rc);
                if let (Some(a), Some(b)) = (a, b)
                    && norm(&a.type_name) != norm(&b.type_name)
                {
                    out.push(format!(
                        "Foreign key {}: {}.{c} ({}) and {}.{rc} ({}) types differ",
                        fk_name(&t.name, fk),
                        t.name,
                        a.type_name,
                        rt.name,
                        b.type_name
                    ));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnDef {
        ColumnDef { name: name.into(), original_name: Some(name.into()), type_name: ty.into(), nullable: true, default: None, auto_increment: false }
    }

    fn new_col(name: &str, ty: &str) -> ColumnDef {
        ColumnDef { original_name: None, ..col(name, ty) }
    }

    fn table(schema: &str, name: &str, columns: Vec<ColumnDef>) -> TableDef {
        TableDef { schema: schema.into(), name: name.into(), columns, primary_key: vec![], foreign_keys: vec![], indexes: vec![], checks: vec![] }
    }

    fn fk(cols: &[&str], ref_table: &str, ref_cols: &[&str]) -> ForeignKeyDef {
        ForeignKeyDef {
            name: None,
            columns: cols.iter().map(|s| s.to_string()).collect(),
            ref_schema: None,
            ref_table: ref_table.into(),
            ref_columns: ref_cols.iter().map(|s| s.to_string()).collect(),
            on_delete: None,
            on_update: None,
        }
    }

    fn sql(p: &Plan) -> Vec<&str> {
        p.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    /// parent(id identity PK, code unique) + child(id PK, parent_id FK → parent, qty check).
    fn create_pair(schema: &str) -> Vec<TableChange> {
        let mut parent = table(schema, "parent", vec![
            ColumnDef { auto_increment: true, nullable: false, ..new_col("id", "bigint") },
            ColumnDef { nullable: false, default: Some("'x'".into()), ..new_col("code", "varchar(20)") },
        ]);
        parent.primary_key = vec!["id".into()];
        parent.indexes = vec![IndexDef { name: "parent_code_key".into(), columns: vec!["code".into()], unique: true }];
        let mut child = table(schema, "child", vec![
            ColumnDef { nullable: false, ..new_col("id", "integer") },
            new_col("parent_id", "integer"),
            new_col("qty", "integer"),
        ]);
        child.primary_key = vec!["id".into()];
        child.foreign_keys = vec![ForeignKeyDef { on_delete: Some("cascade".into()), ..fk(&["parent_id"], "parent", &["id"]) }];
        child.checks = vec![CheckDef { name: Some("qty_pos".into()), expression: "qty > 0".into() }];
        // child listed first: its FK to the new parent must still come after both CREATEs.
        vec![TableChange { original: None, target: Some(child) }, TableChange { original: None, target: Some(parent) }]
    }

    #[test]
    fn create_postgres() {
        let p = plan_schema_changes(Driver::Postgres, &create_pair("s")).unwrap();
        assert_eq!(sql(&p), [
            "CREATE TABLE \"s\".\"parent\" (\n  \"id\" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  \"code\" varchar(20) NOT NULL DEFAULT 'x',\n  PRIMARY KEY (\"id\")\n)",
            "CREATE TABLE \"s\".\"child\" (\n  \"id\" integer NOT NULL,\n  \"parent_id\" integer,\n  \"qty\" integer,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"child_parent_id_fkey\" FOREIGN KEY (\"parent_id\") REFERENCES \"s\".\"parent\" (\"id\") ON DELETE CASCADE,\n  CONSTRAINT \"qty_pos\" CHECK (qty > 0)\n)",
            "CREATE UNIQUE INDEX \"parent_code_key\" ON \"s\".\"parent\" (\"code\")",
        ]);
        assert!(p.transactional && !p.destructive);
        assert_eq!(p.warnings, ["Foreign key child_parent_id_fkey: child.parent_id (integer) and parent.id (bigint) types differ"]);
    }

    #[test]
    fn create_order_and_cycles() {
        let new = |name: &str, refs: &[&str]| {
            let mut t = table("s", name, vec![new_col("id", "int"), new_col("r", "int")]);
            t.foreign_keys = refs.iter().map(|r| fk(&["r"], r, &["id"])).collect();
            TableChange { original: None, target: Some(t) }
        };
        let names = |p: &Plan| -> Vec<String> {
            p.statements.iter().map(|s| s.sql.split('(').next().unwrap_or_default().trim().to_string()).collect()
        };
        // shipments → orders_new → customers_new, listed in the worst order; self-references stay inline.
        let p = plan_schema_changes(Driver::Postgres, &[new("shipments", &["orders_new"]), new("orders_new", &["customers_new", "orders_new"]), new("customers_new", &[])]).unwrap();
        assert_eq!(names(&p), [r#"CREATE TABLE "s"."customers_new""#, r#"CREATE TABLE "s"."orders_new""#, r#"CREATE TABLE "s"."shipments""#]);
        assert!(p.statements.iter().all(|s| !s.sql.starts_with("ALTER")));
        assert!(p.statements[1].sql.contains(r#"REFERENCES "s"."orders_new""#));
        // a ↔ b cycle: the FK that can't be inline is added after both CREATEs.
        let p = plan_schema_changes(Driver::Mariadb, &[new("a", &["b"]), new("b", &["a"])]).unwrap();
        let s = sql(&p);
        assert_eq!(s.len(), 3);
        assert!(s[0].starts_with("CREATE TABLE `s`.`a`") && !s[0].contains("FOREIGN KEY"), "{}", s[0]);
        assert!(s[1].starts_with("CREATE TABLE `s`.`b`") && s[1].contains("REFERENCES `s`.`a`"), "{}", s[1]);
        assert_eq!(s[2], "ALTER TABLE `s`.`a` ADD CONSTRAINT `a_r_fkey` FOREIGN KEY (`r`) REFERENCES `s`.`b` (`id`)");
        // SQLite: cycles are fine inline (REFERENCES resolved lazily).
        let p = plan_schema_changes(Driver::Sqlite, &[new("a", &["b"]), new("b", &["a"])]).unwrap();
        assert!(sql(&p).iter().all(|s| s.starts_with("CREATE TABLE") && s.contains("FOREIGN KEY")));
    }

    #[test]
    fn create_mysql_and_sqlite() {
        let p = plan_schema_changes(Driver::Mariadb, &create_pair("db")).unwrap();
        assert_eq!(sql(&p)[0], "CREATE TABLE `db`.`parent` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `code` varchar(20) NOT NULL DEFAULT 'x',\n  PRIMARY KEY (`id`)\n)");
        assert!(sql(&p)[1].contains("CONSTRAINT `child_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `db`.`parent` (`id`) ON DELETE CASCADE"));
        assert!(!p.transactional);
        assert_eq!(p.warnings[0], MYSQL_WARNING);

        let mut changes = create_pair("main");
        changes[1].target.as_mut().unwrap().columns[0].type_name = "INTEGER".into();
        let p = plan_schema_changes(Driver::Sqlite, &changes).unwrap();
        assert_eq!(sql(&p), [
            "CREATE TABLE \"parent\" (\n  \"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\n  \"code\" varchar(20) NOT NULL DEFAULT 'x'\n)",
            "CREATE UNIQUE INDEX \"parent_code_key\" ON \"parent\" (\"code\")",
            "CREATE TABLE \"child\" (\n  \"id\" integer NOT NULL,\n  \"parent_id\" integer,\n  \"qty\" integer,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"child_parent_id_fkey\" FOREIGN KEY (\"parent_id\") REFERENCES \"parent\" (\"id\") ON DELETE CASCADE,\n  CONSTRAINT \"qty_pos\" CHECK (qty > 0)\n)",
        ]);
        assert!(p.transactional);
    }

    #[test]
    fn validation() {
        let bad = |t: TableDef| plan_schema_changes(Driver::Postgres, &[TableChange { original: None, target: Some(t) }]);
        assert!(matches!(bad(table("s", "", vec![col("a", "int")])), Err(AppError::Query(_))));
        assert!(matches!(bad(table("s", "t", vec![col("a", "")])), Err(AppError::Query(_))));
        assert!(matches!(bad(table("s", "t", vec![col("a", "int"), col("a", "int")])), Err(AppError::Query(_))));
        let mut t = table("s", "t", vec![col("a", "int")]);
        t.foreign_keys = vec![ForeignKeyDef { on_delete: Some("DROP TABLE x".into()), ..fk(&["a"], "p", &["id"]) }];
        assert!(matches!(bad(t), Err(AppError::Query(m)) if m.contains("action")));
        let mut t = table("s", "t", vec![col("a", "int")]);
        t.indexes = vec![IndexDef { name: "".into(), columns: vec!["a".into()], unique: false }];
        assert!(matches!(bad(t), Err(AppError::Query(_))));
        assert!(plan_schema_changes(Driver::Postgres, &[TableChange { original: None, target: None }]).unwrap().statements.is_empty());
    }

    /// orders(id PK, customer_id FK, status, note, qty) altered: rename table + note→remark, qty type,
    /// status NOT NULL + default, drop customer_id (and its FK), new index, new FK, new column.
    fn alter_case(schema: &str) -> TableChange {
        let mut o = table(schema, "orders", vec![
            ColumnDef { nullable: false, ..col("id", "bigint") },
            col("customer_id", "bigint"),
            col("status", "text"),
            col("note", "text"),
            col("qty", "integer"),
        ]);
        o.primary_key = vec!["id".into()];
        o.foreign_keys = vec![ForeignKeyDef { name: Some("orders_customer_id_fkey".into()), ..fk(&["customer_id"], "customers", &["id"]) }];
        o.indexes = vec![IndexDef { name: "orders_note_idx".into(), columns: vec!["note".into()], unique: false }];
        let mut t = o.clone();
        t.name = "orders2".into();
        t.columns.remove(1);
        t.columns[1] = ColumnDef { nullable: false, default: Some("'new'".into()), ..col("status", "text") };
        t.columns[2].name = "remark".into();
        t.columns[3].type_name = "bigint".into();
        t.columns.push(new_col("shop_id", "bigint"));
        t.foreign_keys = vec![fk(&["shop_id"], "shops", &["id"])];
        t.indexes = vec![
            IndexDef { name: "orders_note_idx".into(), columns: vec!["remark".into()], unique: false },
            IndexDef { name: "orders_qty_idx".into(), columns: vec!["qty".into()], unique: false },
        ];
        TableChange { original: Some(o), target: Some(t) }
    }

    #[test]
    fn alter_postgres() {
        let p = plan_schema_changes(Driver::Postgres, &[alter_case("public")]).unwrap();
        assert_eq!(sql(&p), [
            r#"ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_customer_id_fkey""#,
            r#"ALTER TABLE "public"."orders" RENAME TO "orders2""#,
            r#"ALTER TABLE "public"."orders2" RENAME COLUMN "note" TO "remark""#,
            r#"ALTER TABLE "public"."orders2" DROP COLUMN "customer_id""#,
            r#"ALTER TABLE "public"."orders2" ALTER COLUMN "status" SET NOT NULL"#,
            r#"ALTER TABLE "public"."orders2" ALTER COLUMN "status" SET DEFAULT 'new'"#,
            r#"ALTER TABLE "public"."orders2" ALTER COLUMN "qty" TYPE bigint USING "qty"::bigint"#,
            r#"ALTER TABLE "public"."orders2" ADD COLUMN "shop_id" bigint"#,
            r#"CREATE INDEX "orders_qty_idx" ON "public"."orders2" ("qty")"#,
            r#"ALTER TABLE "public"."orders2" ADD CONSTRAINT "orders2_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops" ("id")"#,
        ]);
        assert!(p.destructive && p.transactional);
    }

    #[test]
    fn alter_mysql() {
        let p = plan_schema_changes(Driver::Mysql, &[alter_case("shop")]).unwrap();
        assert_eq!(sql(&p), [
            "ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `orders_customer_id_fkey`",
            "ALTER TABLE `shop`.`orders` RENAME TO `shop`.`orders2`",
            "ALTER TABLE `shop`.`orders2` DROP COLUMN `customer_id`",
            "ALTER TABLE `shop`.`orders2` CHANGE COLUMN `status` `status` text NOT NULL DEFAULT 'new'",
            "ALTER TABLE `shop`.`orders2` CHANGE COLUMN `note` `remark` text NULL",
            "ALTER TABLE `shop`.`orders2` CHANGE COLUMN `qty` `qty` bigint NULL",
            "ALTER TABLE `shop`.`orders2` ADD COLUMN `shop_id` bigint NULL",
            "CREATE INDEX `orders_qty_idx` ON `shop`.`orders2` (`qty`)",
            "ALTER TABLE `shop`.`orders2` ADD CONSTRAINT `orders2_shop_id_fkey` FOREIGN KEY (`shop_id`) REFERENCES `shop`.`shops` (`id`)",
        ]);
        assert!(!p.transactional && p.destructive);
    }

    #[test]
    fn alter_pk_checks_identity_postgres() {
        let mut o = table("s", "t", vec![ColumnDef { nullable: false, ..col("a", "integer") }, col("b", "integer")]);
        o.primary_key = vec!["a".into()];
        o.checks = vec![CheckDef { name: Some("t_b_check".into()), expression: "(b > 0)".into() }];
        let mut t = o.clone();
        t.primary_key = vec!["a".into(), "b".into()];
        t.columns[0].auto_increment = true;
        t.columns[1].nullable = false;
        t.checks = vec![CheckDef { name: None, expression: "b > 0".into() }, CheckDef { name: None, expression: "b < 9".into() }];
        let p = plan_schema_changes(Driver::Postgres, &[TableChange { original: Some(o.clone()), target: Some(t) }]).unwrap();
        let s = sql(&p);
        assert!(s[0].starts_with("DO $ahsandb$ BEGIN EXECUTE (SELECT format('ALTER TABLE %s DROP CONSTRAINT %I'"), "{}", s[0]);
        assert!(s[0].contains(r#"conrelid = '"s"."t"'::regclass AND contype = 'p'"#));
        assert_eq!(s[1..], [
            r#"ALTER TABLE "s"."t" ALTER COLUMN "a" ADD GENERATED BY DEFAULT AS IDENTITY"#,
            r#"ALTER TABLE "s"."t" ALTER COLUMN "b" SET NOT NULL"#,
            r#"ALTER TABLE "s"."t" ADD PRIMARY KEY ("a", "b")"#,
            r#"ALTER TABLE "s"."t" ADD CHECK (b < 9)"#,
        ]);
        // Identity off: drop identity (or serial default).
        let mut t = o.clone();
        t.columns[0].auto_increment = true;
        let mut o2 = o.clone();
        o2.columns[0].auto_increment = true;
        let mut t2 = o2.clone();
        t2.columns[0].auto_increment = false;
        let p = plan_schema_changes(Driver::Postgres, &[TableChange { original: Some(o2), target: Some(t2) }]).unwrap();
        assert_eq!(sql(&p), [
            r#"ALTER TABLE "s"."t" ALTER COLUMN "a" DROP IDENTITY IF EXISTS"#,
            r#"ALTER TABLE "s"."t" ALTER COLUMN "a" DROP DEFAULT"#,
        ]);
        // Unchanged definition → nothing to do.
        let p = plan_schema_changes(Driver::Postgres, &[TableChange { original: Some(o.clone()), target: Some(o) }]).unwrap();
        assert!(p.statements.is_empty());
        let _ = t;
    }

    #[test]
    fn drops_ordered_and_index_drops() {
        let parent = table("s", "parent", vec![col("id", "int")]);
        let mut child = table("s", "child", vec![col("pid", "int")]);
        child.foreign_keys = vec![fk(&["pid"], "parent", &["id"])];
        let changes = [
            TableChange { original: Some(parent), target: None },
            TableChange { original: Some(child), target: None },
        ];
        let p = plan_schema_changes(Driver::Postgres, &changes).unwrap();
        assert_eq!(sql(&p), [r#"DROP TABLE "s"."child""#, r#"DROP TABLE "s"."parent""#]);
        assert!(p.destructive);

        let mut o = table("s", "t", vec![col("a", "int")]);
        o.indexes = vec![IndexDef { name: "t_a_key".into(), columns: vec!["a".into()], unique: true }];
        let mut t = o.clone();
        t.indexes.clear();
        let ch = [TableChange { original: Some(o), target: Some(t) }];
        assert_eq!(sql(&plan_schema_changes(Driver::Postgres, &ch).unwrap()), [
            r#"ALTER TABLE "s"."t" DROP CONSTRAINT IF EXISTS "t_a_key""#,
            r#"DROP INDEX IF EXISTS "s"."t_a_key""#,
        ]);
        assert_eq!(sql(&plan_schema_changes(Driver::Mariadb, &ch).unwrap()), ["DROP INDEX `t_a_key` ON `s`.`t`"]);
        assert_eq!(sql(&plan_schema_changes(Driver::Sqlite, &ch).unwrap()), [r#"DROP INDEX "s"."t_a_key""#]);
    }

    #[test]
    fn sqlite_native_alters() {
        let mut o = table("main", "t", vec![ColumnDef { nullable: false, ..col("id", "INTEGER") }, col("a", "TEXT"), col("b", "TEXT")]);
        o.primary_key = vec!["id".into()];
        o.indexes = vec![IndexDef { name: "t_a".into(), columns: vec!["a".into()], unique: false }];
        let mut t = o.clone();
        t.name = "t2".into();
        t.columns[1].name = "a2".into();
        t.columns.remove(2);
        t.columns.push(ColumnDef { nullable: false, default: Some("0".into()), ..new_col("c", "INT") });
        t.indexes = vec![
            IndexDef { name: "t_a".into(), columns: vec!["a2".into()], unique: false },
            IndexDef { name: "t_c".into(), columns: vec!["c".into()], unique: true },
        ];
        let p = plan_schema_changes(Driver::Sqlite, &[TableChange { original: Some(o), target: Some(t) }]).unwrap();
        assert_eq!(sql(&p), [
            r#"ALTER TABLE "t" RENAME TO "t2""#,
            r#"ALTER TABLE "t2" RENAME COLUMN "a" TO "a2""#,
            r#"ALTER TABLE "t2" DROP COLUMN "b""#,
            r#"ALTER TABLE "t2" ADD COLUMN "c" INT NOT NULL DEFAULT 0"#,
            r#"CREATE UNIQUE INDEX "t_c" ON "t2" ("c")"#,
        ]);
        assert!(p.destructive && p.warnings.is_empty());
    }

    #[test]
    fn sqlite_rebuild() {
        let mut o = table("main", "child", vec![ColumnDef { nullable: false, ..col("id", "INTEGER") }, col("pid", "INTEGER"), col("note", "TEXT")]);
        o.primary_key = vec!["id".into()];
        o.indexes = vec![IndexDef { name: "sqlite_autoindex_child_1".into(), columns: vec!["note".into()], unique: true }];
        let mut t = o.clone();
        t.columns[2] = ColumnDef { nullable: false, name: "remark".into(), ..col("note", "VARCHAR(10)") };
        t.columns.push(ColumnDef { default: Some("CURRENT_TIMESTAMP".into()), ..new_col("at", "TEXT") });
        t.foreign_keys = vec![fk(&["pid"], "parent", &["id"])];
        t.indexes[0].columns = vec!["remark".into()];
        let p = plan_schema_changes(Driver::Sqlite, &[TableChange { original: Some(o), target: Some(t) }]).unwrap();
        assert_eq!(sql(&p), [
            "PRAGMA foreign_keys = OFF",
            r#"ALTER TABLE "child" RENAME COLUMN "note" TO "remark""#,
            r#"CREATE TEMP TABLE "_ahsandb_old_child" AS SELECT "id", "pid", "remark" FROM "child""#,
            r#"DROP TABLE "child""#,
            "CREATE TABLE \"child\" (\n  \"id\" INTEGER NOT NULL,\n  \"pid\" INTEGER,\n  \"remark\" VARCHAR(10) NOT NULL,\n  \"at\" TEXT DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (\"id\"),\n  CONSTRAINT \"child_pid_fkey\" FOREIGN KEY (\"pid\") REFERENCES \"parent\" (\"id\")\n)",
            r#"INSERT INTO "child" ("id", "pid", "remark") SELECT "id", "pid", "remark" FROM temp."_ahsandb_old_child""#,
            r#"DROP TABLE temp."_ahsandb_old_child""#,
            r#"CREATE UNIQUE INDEX "child_remark_key" ON "child" ("remark")"#,
            r#"PRAGMA foreign_key_check("child")"#,
            "PRAGMA foreign_keys = ON",
        ]);
        assert!(p.transactional);
        assert_eq!(p.warnings, ["Table child will be rebuilt (its triggers are not kept)"]);
    }

    #[test]
    fn sqlite_autoincrement_needs_single_pk() {
        let t = table("main", "t", vec![ColumnDef { auto_increment: true, ..new_col("id", "INTEGER") }]);
        let r = plan_schema_changes(Driver::Sqlite, &[TableChange { original: None, target: Some(t) }]);
        assert!(matches!(r, Err(AppError::Query(_))));
    }
}

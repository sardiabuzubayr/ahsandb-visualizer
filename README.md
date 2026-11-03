# AhsanDB Visualizer

Cross-platform desktop database client for PostgreSQL, MySQL, MariaDB, SQLite and Redis. Features:
- multiple connections with SSH tunnels;
- a SQL editor, data viewer, ER diagram and visual object editors;
- a Redis key browser and console;
- import/export;
- an AI agent whose changes need your approval, guided by a data dictionary of what your tables mean.

![AhsanDB Visualizer: data viewer with the AI agent panel](.github/screenshot.png)

## Features

**Connections**
- PostgreSQL, MySQL, MariaDB, SQLite and Redis, with SSH tunnels (password, key file or agent) and TLS.
- Environment tags (dev, staging, production): writes on production ask for confirmation first; a connection can also be read-only.
- Several databases per connection, each table's and database's size in the navigator.
- Open tabs and connections come back after a restart.

**SQL and data**
- SQL editor with autocomplete, formatting, scripts, query history and `.sql` files; results as a grid or a chart.
- Table data viewer: filter, sort, edit cells (enum columns as a dropdown), add and delete rows. Every change is shown as SQL before it runs.
- Record view: selected rows side by side, column names on the left.
- Command palette (⌘K) for tables, connections and actions.

**Schema and objects**
- ER diagram: draft schema edits, review the SQL, apply; export as PNG or SVG.
- Visual editors for tables, views, triggers and stored procedures/functions.
- Roles and privilege matrix; create, rename and drop databases.

**Import and export**
- Dump a database to SQL, import SQL files, export table data, import CSV into a table.

**Redis**
- Key browser: pattern, type and expiry filters, keys sorted by memory size.
- View and edit strings, hashes, lists, sets, sorted sets and streams; set TTLs, rename and delete keys.
- Console with command history. Writes on production ask first; blocking commands, MULTI and SELECT are refused.
- Server info and memory use.

**AI agent**
- Ask about your data in plain language; reads run on their own and every change waits for your approval.
- Type `@` to mention a table of the current database.
- A data dictionary per schema tells the agent what tables, columns and code values mean (see below).
- Copy any chat entry; delete a question together with the agent's answer.

The UI is in English or Indonesian, with dark and light themes.

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Toolchain | Rust (edition 2024) | 1.99.1 |
| | Node.js / npm (nvm, `.nvmrc`) | 24.22.1 / 11.19.1 |
| App shell | Tauri | 2.12.5 (CLI 2.12.4) |
| Backend | sqlx (Postgres, MySQL, SQLite) | 0.8.6 |
| | tokio | 1.54.1 |
| | russh (SSH tunnel) | 0.64.1 |
| | redis-rs | 1.7.1 |
| | reqwest (AI providers) | 0.13.5 |
| | ring (secret encryption) | 0.17.14 |
| Frontend | React | 19.3.1 |
| | TypeScript | 7.0.2 |
| | Vite | 8.3.5 |
| | Tailwind CSS | 4.3.3 |
| | CodeMirror | 6.0.2 |
| | React Flow (@xyflow/react) | 12.12.0 |
| | ECharts | 6.1.0 |
| | sql-formatter | 15.9.0 |
| Tests | Vitest | 5.0.5 |

## Prerequisites

You need:
- Rust (via rustup);
- Node.js 24.22.1 via nvm (`nvm install && nvm use` reads `.nvmrc`);
- on macOS, Xcode Command Line Tools (`xcode-select --install`).

To try the app against a real database, optionally run a local PostgreSQL, MySQL/MariaDB and/or Redis. SQLite needs no server.

## Run

```sh
npm install
npm run tauri dev     # build the Rust backend and open the desktop app
npm run dev           # browser-only UI with mock data at http://localhost:1420 (development only)
```

The first build compiles the Rust crates and takes a few minutes.

App data lives in the OS app data folder under `com.ahsandb.visualizer`. On macOS that is `~/Library/Application Support/com.ahsandb.visualizer/`. It contains:
- `app.db`: connections (without passwords), query history, agent chats and the data dictionary.
- `secrets.bin`: passwords and API keys, encrypted with AES-256-GCM.
- `secrets.key`: the key for `secrets.bin`.

`secrets.bin` and `secrets.key` are readable only by your user (mode 0600). The OS keychain is not used. This protects secrets from casual reads and copied backups, but not from malware running as your user.

## Sample database

```sh
createdb ahsandb_test && psql -d ahsandb_test -f scripts/seed/postgres.sql
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS ahsandb_test" && mysql -uroot ahsandb_test < scripts/seed/mysql.sql
scripts/dev-sshd.sh   # throwaway SSH server on 127.0.0.1:2222 for tunnel testing
```

The connection dialog's **Database** field accepts:
- one name;
- a comma-separated list;
- nothing, to show all databases.

## AI agent

1. Add an API key in **Settings → AI** (Anthropic, OpenAI, OpenRouter, DeepSeek or Gemini).
2. Open the agent with **⌘J**.
3. Each connection's **AI access** controls what the agent may read: Off, Schema only, or Schema + data.

What the agent may do:
- It runs read queries directly.
- Every change waits for your approval.
- For critical actions on production connections, you must also type the object name.

On Redis connections the agent scans keys, reads values and runs commands with the same approval rules.

### Data dictionary

Most databases have no comments, so the agent would otherwise guess what tables and columns mean from their names. Right-click a table or schema → **Data dictionary** to give it real meanings:
- **Tables & columns**: a description per table and a note per column, including what code values stand for (e.g. `1 = active, 2 = cancelled`).
- **Glossary**: the words your team uses and what they map to (e.g. "Paid" → `invoices.outstanding = 0`).
- **Learn schema**: the agent drafts notes table by table from the structure and, with AI access "Schema + data", a few sample rows and distinct values. Drafts are reviewed before they count as verified and never replace a verified note.
- When you correct the agent in chat, it offers to save the correction; nothing is saved until you approve the card.

The dictionary is stored in the app, never in your database. Existing database comments are read and shown as a source. The agent gets the notes next to the schema and the glossary in every conversation; unreviewed drafts are marked as such.

## Test

```sh
npm run typecheck && npm test
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

The PostgreSQL, MySQL, Redis and SSH integration tests run only when these variables are set:

```sh
AHSANDB_TEST_PG=postgres://$(whoami)@localhost:5432/ahsandb_test \
AHSANDB_TEST_MYSQL=mysql://root@localhost:3306/ahsandb_test \
AHSANDB_TEST_REDIS=redis://127.0.0.1:6379/0 \
AHSANDB_TEST_SSHD=1 cargo test
```

Further Redis tests (auth, TLS, a server refusing `MEMORY USAGE`) are described at the top of `src-tauri/tests/redis.rs`.

Tests leave `ahsandb_test` unchanged: they work on temporary `ahsandb_t_<random>` objects. Redis tests touch only `ahsandb_t_<random>:` keys and delete them. AI tests never call a real provider.

## Build

Build on the target OS, since Tauri does not cross-compile reliably. Output goes to `src-tauri/target/release/bundle/`. Builds are not code-signed.

| OS | Extra prerequisites | Command |
|---|---|---|
| macOS | Xcode Command Line Tools | `npm run tauri build` (`.app`, `.dmg`) |
| Windows 10/11 | Visual Studio Build Tools ("Desktop development with C++"); WebView2 ships with Windows | `npm run tauri build -- --bundles msi,nsis` |
| Linux (Debian/Ubuntu) | `sudo apt install libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev build-essential file` | `npm run tauri build -- --bundles deb,appimage` |

Windows and Linux builds are untested so far. Known gaps there:
- The title bar is styled for macOS, so it shows twice with an empty gap.
- Shortcut hints show `⌘` (Ctrl works).
- SSH agent auth is unavailable on Windows; use a password or key file instead.

## License

[Apache License 2.0](LICENSE)

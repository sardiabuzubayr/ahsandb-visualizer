//! Redis command lines: splitting into arguments (redis-cli style quoting) and the app's risk class
//! for a command, used by the console, read-only connections and the agent.

/// What a command does, decided by the app from its name (and subcommand).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmdClass {
    /// Reads key names, types, sizes or server state, but no values (allowed with schema-only AI access).
    Meta,
    /// Reads values.
    Read,
    /// Changes data or server state.
    Write,
    /// Destroys many keys or is hard to undo (FLUSHDB, DEL, CONFIG SET…).
    Critical,
    /// Never run from the app: it would block, change the shared connection or stop the server.
    Blocked(&'static str),
}

/// Splits a command line like redis-cli: whitespace separates arguments; "…" understands `\n \r \t
/// \" \\ \xHH`; '…' is literal except `\'`. Unbalanced quotes are an error.
pub fn split_args(line: &str) -> Result<Vec<String>, String> {
    let mut args = vec![];
    let mut chars = line.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&first) = chars.peek() else { return Ok(args) };
        let mut cur = String::new();
        if first == '"' || first == '\'' {
            chars.next();
            loop {
                match chars.next() {
                    None => return Err("Unbalanced quotes in the command".into()),
                    Some(c) if c == first => break,
                    Some('\\') if first == '\'' => match chars.next() {
                        Some('\'') => cur.push('\''),
                        Some(c) => {
                            cur.push('\\');
                            cur.push(c);
                        }
                        None => return Err("Unbalanced quotes in the command".into()),
                    },
                    Some('\\') => match chars.next() {
                        Some('n') => cur.push('\n'),
                        Some('r') => cur.push('\r'),
                        Some('t') => cur.push('\t'),
                        Some('x') => {
                            let hex: String = chars.by_ref().take(2).collect();
                            match u8::from_str_radix(&hex, 16) {
                                Ok(b) if hex.len() == 2 => cur.push(b as char),
                                _ => return Err(format!("Invalid escape \\x{hex} in the command")),
                            }
                        }
                        Some(c) => cur.push(c),
                        None => return Err("Unbalanced quotes in the command".into()),
                    },
                    Some(c) => cur.push(c),
                }
            }
            if chars.peek().is_some_and(|c| !c.is_whitespace()) {
                return Err("A closing quote must be followed by a space".into());
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                cur.push(c);
                chars.next();
            }
        }
        args.push(cur);
    }
}

/// Quotes one argument so `split_args` reads it back unchanged (used to show commands the app builds).
pub fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\' || c.is_control()) {
        return a.to_string();
    }
    let mut s = String::from("\"");
    for c in a.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => s.push_str(&format!("\\x{:02x}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

pub fn command_line(args: &[String]) -> String {
    args.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")
}

const META: &[&str] = &[
    "SCAN", "KEYS", "TYPE", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME", "EXISTS", "DBSIZE", "INFO", "PING", "ECHO", "TIME", "LASTSAVE",
    "ROLE", "RANDOMKEY", "STRLEN", "HLEN", "HEXISTS", "HSTRLEN", "HKEYS", "LLEN", "SCARD", "ZCARD", "XLEN", "OBJECT", "LOLWUT",
];

const READ: &[&str] = &[
    "GET", "MGET", "GETRANGE", "SUBSTR", "LCS", "DUMP", "HGET", "HMGET", "HGETALL", "HVALS", "HRANDFIELD", "HSCAN", "LRANGE", "LINDEX",
    "LPOS", "SMEMBERS", "SISMEMBER", "SMISMEMBER", "SRANDMEMBER", "SSCAN", "SINTER", "SUNION", "SDIFF", "SINTERCARD", "ZRANGE",
    "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANGEBYLEX", "ZCOUNT", "ZLEXCOUNT", "ZSCORE", "ZMSCORE",
    "ZRANK", "ZREVRANK", "ZRANDMEMBER", "ZSCAN", "ZINTER", "ZUNION", "ZDIFF", "ZINTERCARD", "XRANGE", "XREVRANGE", "XREAD", "XINFO",
    "XPENDING", "BITCOUNT", "BITPOS", "GETBIT", "BITFIELD_RO", "PFCOUNT", "GEOPOS", "GEODIST", "GEOHASH", "GEOSEARCH", "GEORADIUS_RO",
    "GEORADIUSBYMEMBER_RO", "SORT_RO", "TOUCH",
];

/// Commands with read-only subcommands; any other subcommand is a write.
const READ_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("CONFIG", &["GET"]),
    ("CLIENT", &["LIST", "INFO", "GETNAME", "ID", "TRACKINGINFO", "GETREDIR", "NO-EVICT", "NO-TOUCH"]),
    ("MEMORY", &["USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "HELP"]),
    ("SLOWLOG", &["GET", "LEN", "HELP"]),
    ("COMMAND", &["COUNT", "INFO", "DOCS", "LIST", "GETKEYS", "GETKEYSANDFLAGS", "HELP"]),
    ("LATENCY", &["LATEST", "HISTORY", "DOCTOR", "GRAPH", "HISTOGRAM", "HELP"]),
    ("MODULE", &["LIST", "HELP"]),
    ("ACL", &["WHOAMI", "LIST", "USERS", "CAT", "GETUSER", "LOG", "DRYRUN", "GENPASS", "HELP"]),
    ("FUNCTION", &["LIST", "DUMP", "STATS", "HELP"]),
    ("SCRIPT", &["EXISTS", "HELP"]),
    ("PUBSUB", &["CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB", "HELP"]),
];

const CRITICAL: &[&str] = &["FLUSHDB", "FLUSHALL", "DEL", "UNLINK", "SWAPDB", "MOVE", "RENAME", "RESTORE", "MIGRATE", "BGREWRITEAOF", "SAVE", "BGSAVE"];

/// Critical subcommands of otherwise read/write commands.
const CRITICAL_SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("CONFIG", &["SET", "RESETSTAT", "REWRITE"]),
    ("CLIENT", &["KILL", "PAUSE", "NO-EVICT"]),
    ("SCRIPT", &["FLUSH", "KILL"]),
    ("FUNCTION", &["FLUSH", "DELETE", "RESTORE", "KILL"]),
    ("ACL", &["SETUSER", "DELUSER", "LOAD", "SAVE"]),
];

const BLOCKED: &[(&str, &str)] = &[
    ("SELECT", "Pick the database in the sidebar instead of SELECT"),
    ("SUBSCRIBE", "Subscriptions are not supported"),
    ("PSUBSCRIBE", "Subscriptions are not supported"),
    ("SSUBSCRIBE", "Subscriptions are not supported"),
    ("UNSUBSCRIBE", "Subscriptions are not supported"),
    ("PUNSUBSCRIBE", "Subscriptions are not supported"),
    ("SUNSUBSCRIBE", "Subscriptions are not supported"),
    ("MONITOR", "MONITOR streams forever and is not supported"),
    ("SYNC", "Replication commands are not supported"),
    ("PSYNC", "Replication commands are not supported"),
    ("REPLICAOF", "Replication commands are not supported"),
    ("SLAVEOF", "Replication commands are not supported"),
    ("FAILOVER", "Replication commands are not supported"),
    ("MULTI", "Transactions are not supported on the shared connection"),
    ("EXEC", "Transactions are not supported on the shared connection"),
    ("DISCARD", "Transactions are not supported on the shared connection"),
    ("WATCH", "Transactions are not supported on the shared connection"),
    ("UNWATCH", "Transactions are not supported on the shared connection"),
    ("QUIT", "The connection is managed by the app"),
    ("RESET", "The connection is managed by the app"),
    ("HELLO", "The connection is managed by the app"),
    ("AUTH", "Set the user and password in the connection settings"),
    ("SHUTDOWN", "Shutting down the server is not allowed from the app"),
    ("DEBUG", "DEBUG is not allowed from the app"),
    ("BLPOP", "Blocking commands would stall the connection"),
    ("BRPOP", "Blocking commands would stall the connection"),
    ("BRPOPLPUSH", "Blocking commands would stall the connection"),
    ("BLMOVE", "Blocking commands would stall the connection"),
    ("BLMPOP", "Blocking commands would stall the connection"),
    ("BZPOPMIN", "Blocking commands would stall the connection"),
    ("BZPOPMAX", "Blocking commands would stall the connection"),
    ("BZMPOP", "Blocking commands would stall the connection"),
    ("WAIT", "Blocking commands would stall the connection"),
    ("WAITAOF", "Blocking commands would stall the connection"),
];

/// Risk class of a parsed command. Unknown commands (modules, new ones) count as writes.
pub fn classify(args: &[String]) -> CmdClass {
    let Some(name) = args.first().map(|a| a.to_ascii_uppercase()) else { return CmdClass::Blocked("The command is empty") };
    let sub = args.get(1).map(|a| a.to_ascii_uppercase()).unwrap_or_default();
    if let Some((_, why)) = BLOCKED.iter().find(|(n, _)| *n == name) {
        return CmdClass::Blocked(why);
    }
    if (name == "XREAD" || name == "XREADGROUP") && args.iter().any(|a| a.eq_ignore_ascii_case("BLOCK")) {
        return CmdClass::Blocked("Blocking commands would stall the connection");
    }
    if name == "CLIENT" && sub == "REPLY" {
        return CmdClass::Blocked("The connection is managed by the app");
    }
    let has = |table: &[(&str, &[&str])]| table.iter().any(|(n, subs)| *n == name && subs.contains(&sub.as_str()));
    if CRITICAL.contains(&name.as_str()) || has(CRITICAL_SUBCOMMANDS) {
        return CmdClass::Critical;
    }
    if META.contains(&name.as_str()) {
        return CmdClass::Meta;
    }
    if READ.contains(&name.as_str()) || has(READ_SUBCOMMANDS) {
        return CmdClass::Read;
    }
    CmdClass::Write
}

/// Keys a critical command acts on, for the production confirmation (DEL/UNLINK keys, RENAME/MOVE source).
pub fn target_keys(args: &[String]) -> Vec<String> {
    match args.first().map(|a| a.to_ascii_uppercase()).as_deref() {
        Some("DEL" | "UNLINK") => args[1..].to_vec(),
        Some("RENAME" | "MOVE" | "RESTORE" | "MIGRATE") => args.get(1).cloned().into_iter().collect(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn splits_like_redis_cli() {
        assert_eq!(split_args(r#"  SET user:1 "Ahmad \"A\"\n" 'it\'s'  "#).unwrap(), s(&["SET", "user:1", "Ahmad \"A\"\n", "it's"]));
        assert_eq!(split_args(r#"SET k "\x41\x42""#).unwrap(), s(&["SET", "k", "AB"]));
        assert_eq!(split_args(r#"SET k ''"#).unwrap(), s(&["SET", "k", ""]));
        assert!(split_args("").unwrap().is_empty());
        assert!(split_args(r#"SET k "open"#).is_err());
        assert!(split_args(r#"SET k "a"b"#).is_err());
    }

    #[test]
    fn quote_round_trips() {
        for a in ["plain", "with space", "q\"uote", "back\\slash", "line\nbreak", "", "tab\t", "it's"] {
            assert_eq!(split_args(&quote_arg(a)).unwrap(), vec![a.to_string()], "{a}");
        }
    }

    #[test]
    fn classifies_commands() {
        assert_eq!(classify(&s(&["scan", "0"])), CmdClass::Meta);
        assert_eq!(classify(&s(&["HGETALL", "h"])), CmdClass::Read);
        assert_eq!(classify(&s(&["config", "get", "maxmemory"])), CmdClass::Read);
        assert_eq!(classify(&s(&["SET", "k", "v"])), CmdClass::Write);
        assert_eq!(classify(&s(&["JSON.SET", "k", "$", "1"])), CmdClass::Write);
        assert_eq!(classify(&s(&["config", "set", "maxmemory", "1"])), CmdClass::Critical);
        assert_eq!(classify(&s(&["FLUSHDB"])), CmdClass::Critical);
        assert_eq!(classify(&s(&["del", "a", "b"])), CmdClass::Critical);
        assert!(matches!(classify(&s(&["select", "1"])), CmdClass::Blocked(_)));
        assert!(matches!(classify(&s(&["XREAD", "BLOCK", "0", "STREAMS", "s", "$"])), CmdClass::Blocked(_)));
        assert_eq!(classify(&s(&["XREAD", "STREAMS", "s", "0"])), CmdClass::Read);
        assert!(matches!(classify(&[]), CmdClass::Blocked(_)));
        assert_eq!(target_keys(&s(&["DEL", "a", "b"])), s(&["a", "b"]));
    }
}

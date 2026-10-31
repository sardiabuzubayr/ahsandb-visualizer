mod common;

use ahsandb_lib::db;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::conn;

#[tokio::test]
async fn closed_port_is_a_connection_error() {
    for driver in [Driver::Postgres, Driver::Mysql] {
        let c = Connection { host: Some("127.0.0.1".into()), port: Some(1), ..conn(driver) };
        let err = db::connect(&c, None, None).await.err().expect("must fail");
        assert!(matches!(err, AppError::Connection(_)), "{driver:?}: {err:?}");
    }
}

#[tokio::test]
async fn ssh_without_tunnel_is_internal_error() {
    let ssh = SshConfig { host: "bastion".into(), port: 22, user: "u".into(), auth: SshAuth::Agent, key_path: None, keepalive_secs: None };
    let c = Connection { ssh: Some(ssh), host: Some("10.255.255.1".into()), ..conn(Driver::Postgres) };
    assert!(matches!(db::connect(&c, None, None).await, Err(AppError::Internal(_))));
}

#[tokio::test]
async fn missing_tls_file_is_io_error_before_connecting() {
    for driver in [Driver::Postgres, Driver::Mysql] {
        let c = Connection {
            host: Some("10.255.255.1".into()),
            ssl_ca_path: Some("~/no-such-ahsandb-ca.pem".into()),
            ..conn(driver)
        };
        let err = db::connect(&c, None, None).await.err().expect("must fail");
        assert!(matches!(&err, AppError::Io(m) if m.contains("no-such-ahsandb-ca.pem")), "{driver:?}: {err:?}");
    }
}

#[tokio::test]
async fn unknown_pool_is_not_connected() {
    let mgr = db::Manager::default();
    assert!(matches!(mgr.pool("nope").await, Err(AppError::NotFound(_))));
}

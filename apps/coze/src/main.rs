use remoteai_coze::{
    api::Services,
    database::Database,
    embedding::LocalEmbedder,
    error::{Error, Result},
    mcp,
    proxy::ModelProxy,
    server::Host,
};
use serde::Deserialize;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    data_dir: PathBuf,
    token: String,
    proxy_url: String,
    proxy_token: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let argument = std::env::args().nth(1).ok_or(Error::Invalid)?;
    if let Some(path) = argument.strip_prefix("--coze-mcp=") {
        return mcp::run_stdio(&PathBuf::from(path));
    }
    if argument == "--version" {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if argument != "--serve" {
        return Err(Error::Invalid);
    }
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    if line.len() > 8192 {
        return Err(Error::Invalid);
    }
    let config: Bootstrap = serde_json::from_str(&line).map_err(|_| Error::Invalid)?;
    if !config.data_dir.is_absolute() {
        return Err(Error::Invalid);
    }
    let root = std::env::current_exe()?
        .parent()
        .ok_or(Error::Invalid)?
        .to_owned();
    let db = Database::open(&config.data_dir)?;
    db.connect()?.execute(
        "UPDATE runs SET status='interrupted',error='上次运行已中断。'
        WHERE status='running'",
        [],
    )?;
    let services = Arc::new(Services::new(
        db,
        Arc::new(LocalEmbedder::new(&root.join("models"))),
        ModelProxy::new(&config.proxy_url, config.proxy_token)?,
    ));
    let host = Arc::new(Host::bind(config.token, root.join("ui"))?);
    if let Err(error) = remoteai_coze::external::restore(&services) {
        eprintln!("Coze external tools were not restarted: {error}");
    }
    println!(
        "{}",
        serde_json::json!({"url":host.url,"version":env!("CARGO_PKG_VERSION")})
    );
    std::io::stdout().flush()?;
    // The parent's pipe is the lease. App crashes and normal shutdown both terminate this child.
    std::thread::Builder::new()
        .name("coze-parent".into())
        .spawn(|| {
            let mut line = String::new();
            loop {
                match std::io::stdin().read_line(&mut line) {
                    Ok(0) | Err(_) => std::process::exit(0),
                    Ok(_) => line.clear(),
                }
            }
        })?;
    host.run(services)
}

//! Read-only local compatibility check. Reports counts, never conversation bodies or credentials.
use csw_codex_desktop_bridge::{Client, Config};
use serde_json::json;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?.ok_or("REMOTEAI_CODEX_BRIDGE_URL is required")?;
    let client = Client::connect(config).await?;
    let list = client
        .request(json!({"operation": "list", "limit": 10}))
        .await?;
    let sessions = list["data"].as_array().ok_or("Invalid session list")?;
    println!("sessions_on_first_page={}", sessions.len());
    if let Some(id) = sessions.first().and_then(|row| row["id"].as_str()) {
        for _ in 0..20 {
            let result = client
                .request(json!({"operation": "read", "threadId": id}))
                .await?;
            let turns = result["thread"]["turns"].as_array().map_or(0, Vec::len);
            if result["thread"]["status"]["type"] != "notLoaded" {
                println!("native_owner_connected=true; turns={turns}");
                client.close().await;
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        client.close().await;
        return Err("Native owner did not connect within the read-only probe window".into());
    }
    client.close().await;
    Ok(())
}

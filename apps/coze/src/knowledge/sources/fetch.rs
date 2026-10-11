use crate::error::{Error, Result};
use crate::jobs::JobControl;
use std::{net::IpAddr, time::Duration};

const MAX_WEB_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

pub(super) struct Page {
    pub url: String,
    pub bytes: Vec<u8>,
    pub html: bool,
}

/// Resolve and pin every hop independently so neither redirects nor DNS rebinding reach the PC.
pub(super) fn get(address: &str, control: &JobControl) -> Result<Page> {
    control.check()?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Error::Network)?
        .block_on(get_async(address, control))
}

async fn get_async(address: &str, control: &JobControl) -> Result<Page> {
    let mut url = validate_url(address)?;
    for _ in 0..=MAX_REDIRECTS {
        let client = client(&url, control).await?;
        let response = tokio::select! {
            _ = control.cancelled() => return Err(Error::Cancelled),
            result = client.get(url.clone()).send() => result.map_err(|_| Error::Network)?,
        };
        if response.status().is_redirection() {
            let target = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(Error::Network)?;
            url = validate_url(url.join(target).map_err(|_| Error::Invalid)?.as_str())?;
            continue;
        }
        return read_page(response, url, control).await;
    }
    Err(Error::Network)
}

async fn read_page(
    mut response: reqwest::Response,
    url: url::Url,
    control: &JobControl,
) -> Result<Page> {
    if !response.status().is_success() {
        return Err(Error::Network);
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html")
        .to_owned();
    if !mime.starts_with("text/html")
        && !mime.starts_with("text/plain")
        && !mime.starts_with("application/xhtml+xml")
    {
        return Err(Error::Format);
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = control.cancelled() => return Err(Error::Cancelled),
            result = response.chunk() => result.map_err(|_| Error::Network)?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len() + chunk.len() > MAX_WEB_BYTES as usize {
            return Err(Error::Limit);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Page {
        url: url.into(),
        bytes,
        html: !mime.starts_with("text/plain"),
    })
}

async fn client(url: &url::Url, control: &JobControl) -> Result<reqwest::Client> {
    let host = url.host_str().ok_or(Error::Invalid)?;
    let address = (host, url.port_or_known_default().ok_or(Error::Invalid)?);
    let addresses: Vec<_> = tokio::select! {
        _ = control.cancelled() => return Err(Error::Cancelled),
        result = tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host(address)) =>
            result.map_err(|_| Error::Network)?.map_err(|_| Error::Network)?.collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(Error::Invalid);
    }
    reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Network)
}

pub(super) fn validate_url(address: &str) -> Result<url::Url> {
    if address.len() > 4096 {
        return Err(Error::Invalid);
    }
    let mut url = url::Url::parse(address).map_err(|_| Error::Invalid)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(Error::Invalid);
    }
    url.set_fragment(None);
    Ok(url)
}

pub(super) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_documentation()
                && octets[0] != 0
                && octets[0] < 224
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
                && !(octets[0] == 192 && octets[1] == 0)
                && !(octets[0] == 198 && (18..=19).contains(&octets[1]))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] & 0xe000 == 0x2000
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
        }
    }
}

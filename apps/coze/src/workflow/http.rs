use super::graph::HttpMethod;
use crate::error::{Error, Result};
use serde_json::Value;
use std::{
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

/// Workflow HTTP nodes use public HTTPS destinations and never carry the local proxy credential.
pub(crate) fn request(address: &str, method: HttpMethod, body: &Value) -> Result<Value> {
    let url = url::Url::parse(address).map_err(|_| Error::Invalid)?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Invalid);
    }
    let host = url.host_str().ok_or(Error::Invalid)?;
    let addresses: Vec<_> = (host, url.port_or_known_default().ok_or(Error::Invalid)?)
        .to_socket_addrs()
        .map_err(|_| Error::Network)?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(Error::Invalid);
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Network)?;
    let method = match method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Delete => reqwest::Method::DELETE,
    };
    let mut request = client.request(method.clone(), url);
    if method != reqwest::Method::GET {
        request = request.json(body);
    }
    let response = request.send().map_err(|_| Error::Network)?;
    if !response.status().is_success() {
        return Err(Error::Network);
    }
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Network)?;
    if bytes.len() > 1024 * 1024 {
        return Err(Error::Limit);
    }
    Ok(serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())))
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && !ip.is_multicast()
                && !ip.is_documentation()
                && ip.octets()[0] != 0
                && ip.octets()[0] < 224
                && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && ip.to_ipv4_mapped().is_none()
                && ip.segments()[0] & 0xe000 == 0x2000
        }
    }
}

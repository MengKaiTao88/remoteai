use super::{Error, Result, MAX_PACKAGE_BYTES};
use reqwest::{
    header::{CONTENT_RANGE, RANGE},
    Client, Response, StatusCode,
};
use std::time::Duration;

pub(super) struct Origin {
    client: Client,
    url: String,
}

impl Origin {
    pub fn new(url: &str) -> Result<Self> {
        let parsed = url::Url::parse(url).map_err(|_| Error::Invalid)?;
        // Metadata is selected by the existing official updater, never supplied by a peer.
        if parsed.scheme() != "https" && !(cfg!(test) && parsed.host_str() == Some("127.0.0.1")) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            url: url.into(),
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| Error::Unavailable)?,
        })
    }

    pub async fn size(&self) -> Result<usize> {
        let response = self.request(0, 1).await?;
        let (start, end, size) = content_range(&response)?;
        if start != 0 || end != 0 || size == 0 || size > MAX_PACKAGE_BYTES {
            return Err(Error::Invalid);
        }
        Ok(size)
    }

    async fn request(&self, offset: usize, length: usize) -> Result<Response> {
        self.client
            .get(&self.url)
            .header(RANGE, format!("bytes={offset}-{}", offset + length - 1))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await
            .map_err(|_| Error::Unavailable)
    }

    pub async fn block(&self, offset: usize, length: usize, size: usize) -> Result<Vec<u8>> {
        let mut response = self.request(offset, length).await?;
        if content_range(&response)? != (offset, offset + length - 1, size) {
            return Err(Error::Invalid);
        }
        let mut bytes = Vec::with_capacity(length);
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            if chunk.len() > length - bytes.len() {
                return Err(Error::Invalid);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != length {
            return Err(Error::Invalid);
        }
        Ok(bytes)
    }
}

fn content_range(response: &Response) -> Result<(usize, usize, usize)> {
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(Error::Unavailable);
    }
    let value = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::Invalid)?;
    parse_range(value)
}

fn parse_range(value: &str) -> Result<(usize, usize, usize)> {
    let (range, size) = value
        .strip_prefix("bytes ")
        .and_then(|v| v.split_once('/'))
        .ok_or(Error::Invalid)?;
    let (start, end) = range.split_once('-').ok_or(Error::Invalid)?;
    let parse = |value: &str| value.parse::<usize>().map_err(|_| Error::Invalid);
    let (start, end, size) = (parse(start)?, parse(end)?, parse(size)?);
    if start > end || end >= size || size > MAX_PACKAGE_BYTES {
        return Err(Error::Invalid);
    }
    Ok((start, end, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn size_probe_requires_the_requested_single_byte_range() {
        for (range, accepted) in [("0-0", true), ("1-1", false), ("0-1", false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/package", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 4096);
                    request.push(socket.read_u8().await.unwrap());
                }
                let response = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {range}/10\r\nContent-Length: 1\r\n\r\nx"
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let result = Origin::new(&url).unwrap().size().await;
            assert_eq!(result.is_ok(), accepted, "range: {range}");
            server.await.unwrap();
        }
    }

    #[test]
    fn rejects_ambiguous_or_out_of_bounds_ranges() {
        assert_eq!(parse_range("bytes 0-1023/2048").unwrap(), (0, 1023, 2048));
        for value in ["bytes */2048", "bytes 4-2/8", "bytes 0-8/8", "bytes 0-0/0"] {
            assert!(parse_range(value).is_err());
        }
    }
}

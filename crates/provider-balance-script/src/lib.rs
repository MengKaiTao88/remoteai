//! Bounded, pure balance-response parsers. No host, filesystem, module-loader or network bindings exist.
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use url::Url;

pub const MAX_SCRIPT_BYTES: usize = 16 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MEMORY_LIMIT: usize = 8 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;
const EXECUTION_LIMIT: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BalanceScript {
    pub url: String,
    pub auth: Authentication,
    pub script: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Authentication {
    #[serde(rename = "bearer")]
    Bearer,
    #[serde(rename = "x-api-key")]
    ApiKey,
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("market.scriptInvalid")]
    Invalid,
    #[error("market.scriptFailed")]
    Execution,
    #[error("market.scriptResponse")]
    Response,
}

/// Only a same-origin HTTPS GET is allowed. Redirects and credential-bearing URLs must also be refused by the host.
impl BalanceScript {
    pub fn validate(&self, base_url: &str) -> Result<Url, Error> {
        let base = Url::parse(base_url).map_err(|_| Error::Invalid)?;
        let url = Url::parse(&self.url).map_err(|_| Error::Invalid)?;
        if base.scheme() != "https"
            || url.origin() != base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || self.url.len() > 512
            || self.script.is_empty()
            || self.script.len() > MAX_SCRIPT_BYTES
        {
            return Err(Error::Invalid);
        }
        Ok(url)
    }
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Balance {
    pub amount: f64,
    pub currency: String,
}

/// Runs one synchronous parseBalance(response) function. No promises or queued jobs are executed.
/// The caller supplies only the HTTP response body, never API keys, headers, tokens or app objects.
pub fn parse(script: &str, response: &str) -> Result<Balance, Error> {
    if script.is_empty() || script.len() > MAX_SCRIPT_BYTES || response.len() > MAX_RESPONSE_BYTES {
        return Err(Error::Invalid);
    }
    let runtime = Runtime::new().map_err(|_| Error::Execution)?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let deadline = Instant::now() + EXECUTION_LIMIT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|_| Error::Execution)?;
    let output: String = context
        .with(|ctx| {
            // Capture pristine JSON methods before untrusted code can replace globals.
            let source = format!(
                "(function(){{const parse=JSON.parse,stringify=JSON.stringify;\n{script}\n\
             return function(body){{return stringify(parseBalance(parse(body)));}};}})()"
            );
            let parser: Function = ctx.eval(source)?;
            parser.call((response,))
        })
        .map_err(|_: rquickjs::Error| Error::Execution)?;
    if output.len() > 1024 {
        return Err(Error::Response);
    }
    let value: Balance = serde_json::from_str(&output).map_err(|_| Error::Response)?;
    if !value.amount.is_finite()
        || value.amount.abs() > 1e15
        || !matches!(value.currency.as_str(), "USD" | "CNY" | "EUR" | "JPY")
    {
        return Err(Error::Response);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_balance_without_access_to_credentials_or_host() {
        let source =
            "function parseBalance(r) { return {amount:r.data.remaining/100, currency:'USD'}; }";
        assert_eq!(
            parse(source, r#"{"data":{"remaining":0}}"#).unwrap(),
            Balance {
                amount: 0.0,
                currency: "USD".into(),
            }
        );
        for forbidden in [
            "fetch('https://example.test')",
            "require('fs')",
            "process.env",
            "Deno.readTextFile('/etc/passwd')",
            "XMLHttpRequest",
            "apiKey",
            "import('fs')",
        ] {
            let script = format!("function parseBalance(r) {{ return {forbidden}; }}");
            assert!(parse(&script, "{}").is_err());
        }
    }
    #[test]
    fn limits_execution_memory_and_output() {
        for script in [
            "while(true) {}",
            "function parseBalance(){while(true){}}",
            "function parseBalance(){return 'x'.repeat(100000000);}",
            "function parseBalance(){return {amount:1,currency:'USD',apiKey:'secret'};}",
            "function parseBalance(){return {amount:NaN,currency:'USD'};}",
        ] {
            let start = Instant::now();
            assert!(parse(script, "{}").is_err());
            assert!(start.elapsed() < Duration::from_secs(2));
        }
    }
    #[test]
    fn confines_requests_to_the_selected_origin() {
        let mut script = BalanceScript {
            url: "https://api.test/balance".into(),
            auth: Authentication::Bearer,
            script: "function parseBalance(r) {return r;}".into(),
        };
        assert!(script.validate("https://api.test/v1").is_ok());
        for url in [
            "https://other.test/balance",
            "http://api.test/balance",
            "https://u:p@api.test/balance",
            "https://api.test/balance?token=secret",
            "file:///etc/passwd",
            "https://api.test/balance#secret",
        ] {
            script.url = url.into();
            assert!(script.validate("https://api.test/v1").is_err());
        }
    }
}

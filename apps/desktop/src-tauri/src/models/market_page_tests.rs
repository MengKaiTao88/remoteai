use super::*;
use serde_json::json;

#[test]
fn accepts_page_queries_and_validates_headers_and_provenance() {
    let mut source: ProviderMarketSource = serde_json::from_value(json!({
        "id":"11111111-1111-4111-8111-111111111111",
        "page":{"url":"https://example.test/dashboard?view=usage#balance", "query":"tag=a&tag=b",
        "headers":{"X-Region":"east"}}
    }))
    .unwrap();
    assert!(source.validate().is_ok());
    source.page.headers.insert("x-region".into(), "west".into());
    assert!(source.validate().is_err());
    source.page.headers.clear();
    source.page.url = "https://user:secret@example.test".into();
    assert!(source.validate().is_err());
    source.page.url = "https://example.test".into();
    source.id = "not-a-market-id".into();
    assert!(source.validate().is_err());
}

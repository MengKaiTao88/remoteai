// Generated from packages/i18n/platform/desktop/src-tauri/src/local_proxy/official_websocket/account_context_copy.rs. Do not edit.
use crate::storage::InterfaceLanguage;

pub(super) fn message(language: InterfaceLanguage) -> &'static str {
    match language {
        InterfaceLanguage::Zh => "此会话需要原账号可访问的内容。补齐所需内容后，即可在这里继续。",
        InterfaceLanguage::En => "This conversation needs content from the original account. Add the missing content here to continue.",
        InterfaceLanguage::Ru => "Для продолжения беседы нужны данные исходного аккаунта. Добавьте недостающие материалы в эту беседу.",
        InterfaceLanguage::Ja => "この会話には元のアカウントの内容が必要です。不足している内容をこの会話に追加すると続けられます。",
    }
}

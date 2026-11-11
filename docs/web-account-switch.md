# Web chat account switching with the official backend

The existing Web and phone picker sends `guiAccountSelect` to the computer, which calls
`codex_gui_switch_account`. Previously the official backend always returned an unavailable-account
error, while `codex_gui_account_selection` always returned `none`, even though the picker displayed
the computer's available accounts and Providers.

For official conversations, the computer now reads the active proxy target and delegates manual
selection to the same validated account, Provider, or aggregate activation used by the desktop.
The official process retains its running proxy connection. A successful switch publishes the
authoritative selection to connected clients. Failed activation never reports success.

Legacy GUI conversations retain their independent GUI selection and revision handling. Provider
groups are not represented as an individual account. The wire format and existing public Web client
remain compatible; this repair is installed on the computer.

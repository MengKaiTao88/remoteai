# Official async question lifecycle

The official question card is reconstructed from historical agent messages, while ordinary
accepted user input can supersede a card without a structured question reply. The pinned gateway
previously treated only `<send_user_message_question_reply>` as resolution. This resurrected older
questions after the desktop had moved on, leaving remote viewers in a waiting-for-input state.

The native compatibility adapter now processes canonical turns and accepted input in order.
Structured replies resolve exact parsed question identities, including partially answered groups,
and retain unrelated simultaneous cards. Ordinary user messages and accepted steering messages
supersede older prompts. Queued, rejected or unaccepted steering messages cannot dismiss a card.
Completed turns alone do not resolve unanswered questions; new questions after input remain pending.
Initiating input stored in turn params is also recognized. Both the display projection and response
validation use the same adapter, preventing a stale card from being submitted again.

The adapter does not change native history, answer any question, retry a submission or delete a draft.
Synchronous native requests retain their authoritative pending-request lifecycle. Existing bridge
`serverRequest/resolved` notifications clear desktop, remote and Web viewers when the owner state
removes a request. No Web deployment is required for this gateway-side compatibility correction.

Regression coverage includes cross-turn official answers, canonical history, partial groups, multiple
cards, ordinary follow-ups, accepted versus queued steering and independent viewer resolution.
Live read-only evidence from the reported GlassDesk chat confirmed two obsolete historical prompts
were still advertised by the gateway before repair. The screenshot's queued message was already
absent from the live local outbox at inspection, so it was not resent or deleted.

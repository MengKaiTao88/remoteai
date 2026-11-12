# Official conversation permission synchronization

Official conversations obtain their displayed access setting from the owner's `permissionMode`,
alongside the existing conversation-scoped model settings snapshot. The adapter maps `ask`,
`auto-review`, and `full-access` to the existing Remote AI picker values. Reading a conversation or
receiving a permission update never writes permission settings. Permission-only changes publish a
new snapshot even when the model and messages have not changed.

An explicit picker edit uses the gateway's existing authenticated permissions endpoint. The owner
must confirm application, and a reread must match before the picker reports success. Disconnected
sessions, unsupported settings and unconfirmed writes do not optimistically replace the label.
Ordinary model saves and message sends do not copy stale picker values into the official session.

Composer snapshots include the actual access for their original conversation. A remote client
viewing or changing one conversation must not overwrite another conversation or the desktop draft.
The existing Web and Native composer protocol already carries these values; no new remote operation
or client deployment is required to display the corrected authoritative setting.

Official conversations never fall back to saving a local permission preference when their permission
metadata is temporarily absent. They still require the owner to apply and confirm the edit. Model
selection edits preserve the recorded permission authority while their own save is pending. Regression
coverage includes repeated edits through the complete remote client and its actual browser picker.

The native owner stores current-turn `currentPermissions` separately from `latestThreadSettings` for
the next turn. Resolve each policy as a complete bucket: never flatten a stale turn's `permissions`
alias into a newer canonical `activePermissionProfile`. The compatibility reader preserves both
the actual and upcoming modes. A differing next-turn choice carries `accessUpdate: nextTurn` through
the desktop and remote composer snapshots, with a compact clock hint. Changing the next-turn policy
does not retroactively change permissions of a running turn or interrupt it. Older public Web builds
continue to accept the same settings but need a client update to display the timing hint.

The legacy GUI backend retains its existing approval and sandbox behavior. Its model synchronization
does not write permissions. New-conversation defaults and custom official policy profiles are outside
the three preset mappings and are not inferred as full access.

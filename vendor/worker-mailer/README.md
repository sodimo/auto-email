# vendor/worker-mailer

A patched, trimmed copy of [worker-mailer](https://github.com/zou-yu/worker-mailer)
**v1.2.1** (MIT, © zou-yu — see LICENSE, retained). Vendored rather than taken
from npm because upstream is stale and auto-email needs changes it will not get.

## Patches

1. **Configurable EHLO/HELO hostname** (`ehloHostname` option). Upstream
   hardcodes `EHLO 127.0.0.1`. This is not cosmetic: Strato accepts the
   message with `250 queued` and then **silently drops it** when the recipient
   is on the same provider — which is every `@sodimo.eu` address. We announce
   `sodimo.eu` (`settings.ehlo_hostname`).

2. **`buildMessage()` returns RFC 5322 bytes.** Upstream's `getEmailData()`
   returned a wire-format string with SMTP dot-stuffing applied and the
   `\r\n.\r\n` terminator appended. Those belong to the transport, not the
   message: IMAP APPEND needs the clean bytes, and appending the wire form
   would corrupt every archived copy. Dot-stuffing and termination now live in
   the SMTP writer (`mailer.ts#writeBody`), so one `buildMessage()` result
   feeds both SMTP and IMAP.

3. **Phase-tagged, sequential sending.** Upstream queued emails and drained
   them from a detached background loop, so a caller learned only *that* a send
   failed. `sendRaw()` is now a direct sequential call that throws `SmtpError`
   carrying the phase and the server response, and computes `retryable`. That
   is what lets the outbox retry a connection failure while never retrying a
   send whose delivery is genuinely uncertain (see SPEC.md).

## Removed

`bcc` (upstream writes a literal `BCC:` header, leaking every recipient to all
of them — deleted so it cannot be used by mistake), `cc`, attachments, DSN, the
`BlockingQueue`, and the `static send()` one-shot helper. auto-email sends one
message per recipient from a single pooled session, so none of it applies.
Attachments come back only if the paid plan does (SPEC.md, non-goals).

## Updating

There is no npm dependency to bump. To take upstream changes, diff against
`v1.2.1` of the original repo and re-apply the three patches above. The
`tests/vendor-mailer.test.ts` suite pins the behaviour that matters: the EHLO
hostname reaches the wire, `buildMessage()` output is dot-stuffing-free, and
nothing emits a BCC header.

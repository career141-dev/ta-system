# Follow-up demo

Admins can open Settings → Follow-up demo, enter a sample candidate and role,
then send either approved WhatsApp template or the first/reminder email.
Each button sends one message; it does not start a sequence or change a
candidate or application. Use contact details belonging to the demo audience.

WhatsApp uses the deployment's main Meta number. Email uses the backend's
configured sender (`OUTBOUND_EMAIL_SENDER`, or `MS_SENDER_EMAIL` when unset).
The admin only enters the receiver; there is no sender field. The result names
the email sender and destination actually used.

All messages pass the do-not-contact check, outreach gate and outbound lock.
With real outreach off, the existing test destination is used; if none is
configured, sending is refused. A redirected result stays visible in amber.
The demo does not enable real outreach or change deployment settings.

WhatsApp demos share the daily template limit with candidate messages. An
accepted demo adds only a timestamp to `demoTemplateSends` for budget counting;
no contact details or candidate records are stored by the demo. As with the
existing candidate sender, the limit checks the count before sending rather
than reserving capacity atomically across simultaneous sends.

“Sent” means Meta or Microsoft Graph accepted the request. Verify receipt on
the destination device or inbox to establish delivery. Demo messages have no
candidate communication row for delivery or reply tracking. If the result
says sending succeeded but budget recording failed, do not resend that message.

Local checks use `deploy/local/start-app.sh` with the local Convex backend.
`deploy/local/start-ui.sh` can check the screen and missing-backend response,
but cannot send. Production release and any outreach configuration changes
remain subject to the release workflow and owner's decision.

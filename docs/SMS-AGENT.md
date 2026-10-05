# Configure the Faultline Retell SMS agent

Faultline sends cluster-scoped end users three kinds of messages for a customer-facing critical incident: the initial outage, a changed restoration estimate, and recovery. Delivery is deduplicated per incident, recipient, update type, and ETA. Contacts whose `service` matches the incident's `logicalService` (or primary workload) are selected; `*` and `all` subscribe a contact to every service in that cluster.

## 1. Prepare an SMS-capable number

In Retell, open **Phone Numbers**, select the number that Faultline will use, and enable the SMS add-on under **Advanced Add-Ons**. Custom outbound messages and two-way SMS require a Retell/Twilio or imported Twilio number with the applicable A2P 10DLC approval. A pool number without A2P is only for preset in-call messages and cannot send Faultline's custom outage text.

Complete the business profile, brand, and campaign. The campaign must accurately describe automated transactional service-status messages. Provide the real opt-in flow, live privacy/terms URLs, two representative messages, and STOP/HELP disclosures. Do not upload a recipient until their opt-in has been recorded by your organization.

Suggested samples (replace the business name and placeholders with the submitted campaign values):

```text
Faultline: The [Service] service is currently unavailable. Estimated restoration: [Time]. Reply STOP to opt out.

Faultline: The [Service] incident has been resolved. Normal service has been restored. Reply STOP to opt out.
```

## 2. Create the chat agent

The screen in the supplied screenshot is the correct single-prompt editor, but ensure the agent was created as **Chat Agent**, not Voice Agent:

1. In **Agents**, choose **Create an Agent** → **Chat Agent** → **Single prompt**.
2. Name it `Faultline SMS Agent`.
3. Paste the prompt below into the large prompt editor.
4. Leave functions and knowledge base empty. Faultline supplies the approved message; the agent must not invent operational facts.
5. Under **Chat settings**, choose a suitable inactivity timeout (the default is acceptable). Set an optional auto-close message only if it matches the registered campaign.
6. In **Webhook settings**, set the public notification-service endpoint to `https://<notification-host>/webhooks/retell`. Faultline validates `X-Retell-Signature`.
7. Click **Publish**, then copy the chat agent ID.

Prompt:

```text
You are Faultline's transactional service-status SMS agent.

For a new outbound SMS conversation, send the content of
{{notification_message}} exactly as supplied. Do not add, remove, reword, or
infer an outage cause, severity, restoration time, resolution, link, or other
fact. Never claim an ETA unless it appears in {{notification_message}}.

If the recipient replies with a question, answer briefly using only facts that
already appear in {{notification_message}}. If the answer is not present, say
that no further confirmed information is available and that another status
update will be sent when available.

Never ask for credentials, passwords, payment details, or personal data.
Carrier opt-out keywords such as STOP are handled by the messaging provider;
do not attempt to override an opt-out.
```

In Retell's **Test LLM** panel, supply a test dynamic variable:

```json
{
  "notification_message": "Faultline: The payments service is currently unavailable. Current estimated restoration time is 15:30 UTC. Reply STOP to opt out."
}
```

The first response should preserve that text exactly. Test again with no ETA and confirm the agent does not invent one.

## 3. Bind the number and configure Faultline

On the selected phone-number page, assign the chat agent as the **Outbound SMS agent** (and as the inbound agent only if you want two-way replies). Then configure `apps/notification/.env`:

```dotenv
RETELL_API_KEY=<Retell API key>
RETELL_FROM_NUMBER=+15551234567
RETELL_VOICE_AGENT_ID=<existing voice agent id>
RETELL_SMS_AGENT_ID=<chat agent id>
NOTIFICATION_ORGANIZATION_ID=default
```

The current worker validates Retell through the existing voice agent and phone number; the SMS dashboard separately reports whether `RETELL_SMS_AGENT_ID` is present. Restart the notification service after changing the environment.

Provider status is dynamic: the notification worker checks Retell on startup and every 60 seconds, while the dashboards poll the API. Environment files are read only when the process starts. After adding, removing, or commenting a Retell value, restart the notification service. If the worker stops reporting for 150 seconds, both dashboards mark its saved heartbeat as stale instead of continuing to show it as connected.

## 4. Apply storage and upload recipients

```powershell
npm run db:migrate
```

Open an onboarded cluster in Faultline and choose **SMS Agent**. Confirm the opt-in attestation, then upload CSV, JSON, or a text-based PDF, up to 5 MB and 5,000 rows. Scanned/image-only PDFs are rejected.

CSV/PDF text-table header:

```csv
name,email,contact,service
Ada Lovelace,ada@example.com,+15551234567,payments
Grace Hopper,grace@example.com,+15557654321,*
```

JSON may be an array or `{ "contacts": [...] }`:

```json
[
  {"name":"Ada Lovelace","email":"ada@example.com","contact":"+15551234567","service":"payments"}
]
```

`contact` must be E.164. Re-importing the same cluster, phone, and service updates the existing record. The same phone may be independently registered for another cluster. Email is retained for contact administration but is not sent to Retell.

## 5. Verify safely

Use a number you control and click **Test SMS**. Confirm the page records the test delivery. Then create a critical test incident through the normal lifecycle, with `logicalService` matching the uploaded `service` and `estimatedRestorationAt` set when an ETA is confirmed. Verify initial, ETA-change, and resolution records in **Recent SMS deliveries**.

Never run automated tests with production Retell credentials or bulk-import recipients without documented consent.

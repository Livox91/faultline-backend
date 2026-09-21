# Configure and test the Faultline calling agent

Faultline decides **who** to contact, **why**, and whether escalation should continue. Retell only places the call, reads the supplied incident message, and reports the engineer's response.

## Safety first

- Use a Retell test number and your own phone number until the workflow is verified.
- Never run automated tests with production Retell credentials. The test suite mocks the communication provider and makes no calls or sends no SMS messages.
- Keep API keys in `apps/notification/.env`; do not commit that file.
- Start with one contact, one escalation step, and `maximumAttempts: 1` to prevent surprise calls.

## 1. Configure Retell

Create or select these resources in Retell:

1. A voice agent.
2. A Retell phone number that supports outbound calling.
3. Optionally, an SMS/chat agent if SMS delivery will be tested.

Configure the voice agent to use Faultline's supplied dynamic variables. Faultline sends:

| Variable | Purpose |
| --- | --- |
| `voice_script` | Complete opening script for the call |
| `notification_message` | Audience-safe incident message |
| `incident_id` | Faultline incident identifier |
| `notification_attempt_id` | Current durable notification attempt identifier |
| `recipient_id` | Resolved Faultline contact identifier |
| `severity` | Current incident severity |
| `affected_service` | Logical affected service |
| `cluster` | Cluster identifier for internal engineering calls |
| `environment` | Incident namespace/environment |
| `status` | Current incident state |
| `acknowledgement_prompt` | Prompt asking whether the engineer accepts ownership |
| `acknowledgement_confirmation` | Confirmation to read after acknowledgement |
| `allowed_actions` | Actions accepted by Faultline |

A minimal agent instruction is:

```text
You are the Faultline incident calling agent.
Read {{voice_script}} accurately and concisely.
Do not invent a cause, ETA, resolution, or technical detail.
Ask the acknowledgement question once.
If the engineer clearly accepts ownership, submit ACKNOWLEDGE_INCIDENT.
If the engineer clearly declines, submit DECLINE_INCIDENT.
If the answer is unclear, submit UNKNOWN and ask for clarification.
Never modify incident state yourself; Faultline is the source of truth.
```

Do not let the agent paraphrase identifiers, infer an ETA, or claim a root cause. The deterministic message is already created by Faultline.

### Acknowledgement function

Configure a Retell custom function or webhook action that sends `POST` to:

```text
https://<public-notification-host>/v1/voice/actions
```

The JSON body must be:

```json
{
  "incidentId": "<incident_id>",
  "notificationAttemptId": "<notification_attempt_id>",
  "recipientId": "<recipient_id>",
  "action": "ACKNOWLEDGE_INCIDENT",
  "providerCallId": "<current Retell call id>",
  "timestamp": "<current ISO-8601 timestamp>"
}
```

`action` must be one of `ACKNOWLEDGE_INCIDENT`, `DECLINE_INCIDENT`, or `UNKNOWN`. The endpoint requires a valid `x-retell-signature`; unsigned requests are rejected. Map the first three fields from their matching dynamic variables (they are also attached as call metadata), and use Retell's current call identifier for `providerCallId`. Do not ask the model to invent any of these values.

Configure Retell's call-status webhook to send events to:

```text
https://<public-notification-host>/webhooks/retell
```

This endpoint also verifies `x-retell-signature`. Duplicate and out-of-order status callbacks are safely ignored.

For local development, expose port `3004` through an HTTPS tunnel and use that public HTTPS origin for both URLs. Treat the tunnel URL as temporary and never expose the API without Retell signature verification.

## 2. Configure Faultline

Create the notification environment file:

```powershell
Copy-Item apps/notification/.env.example apps/notification/.env
```

Set these values in `apps/notification/.env`:

```dotenv
NODE_ENV=development
APP_VERSION=0.1.0
PORT=3004
DATABASE_URL=postgresql://faultline:<password>@127.0.0.1:5432/faultline
BROKER_URL=nats://127.0.0.1:4222
RETELL_API_KEY=<retell-api-key>
RETELL_FROM_NUMBER=+15551234567
RETELL_VOICE_AGENT_ID=<voice-agent-id>
RETELL_SMS_AGENT_ID=<optional-chat-agent-id>
NOTIFICATION_ORGANIZATION_ID=default
NOTIFICATION_HIGH_ESCALATION_ENABLED=false
```

Phone numbers must use E.164 format, such as `+15551234567`. `RETELL_SMS_AGENT_ID` is optional unless a policy contains an SMS channel. Keep high-severity calling disabled until the critical-only path is working.

The notification app also needs the same PostgreSQL and NATS configuration used by the API and processor. Apply all migrations before starting it:

```powershell
npm ci
npm run infra:up
$env:DATABASE_URL = "postgresql://faultline:<password>@127.0.0.1:5432/faultline"
npm run db:migrate
npm run build
npm run start:notification
```

Check startup and dependency readiness:

```powershell
Invoke-RestMethod http://localhost:3004/health
Invoke-RestMethod http://localhost:3004/health/ready
```

## 3. Configure recipients and escalation

Use the API on port `3000` to create a test contact. Use a phone number you control:

```powershell
$contact = Invoke-RestMethod http://localhost:3000/contacts -Method Post -ContentType 'application/json' -Body (@{
  organizationId = 'default'
  name = 'Calling Agent Test'
  role = 'ENGINEER'
  phoneNumber = '+15551234567'
  smsEnabled = $false
  voiceEnabled = $true
  enabled = $true
} | ConvertTo-Json)
```

Create a critical-only, single-attempt policy:

```powershell
$policyBody = @{
  organizationId = 'default'
  name = 'Safe calling-agent test'
  enabled = $true
  sendResolution = $false
  match = @{ severities = @('CRITICAL') }
  steps = @(@{
    order = 1
    target = @{ type = 'CONTACT'; id = $contact.id }
    channels = @('VOICE')
    maximumAttempts = 1
    retryDelayMs = 0
    waitBeforeNextStepMs = 0
  })
}
Invoke-RestMethod http://localhost:3000/escalation-policies -Method Post -ContentType 'application/json' -Body ($policyBody | ConvertTo-Json -Depth 8)
```

An escalation step may instead target an on-call schedule:

```json
{ "type": "ON_CALL_SCHEDULE", "id": "<schedule-id>" }
```

Faultline resolves the active engineer when each attempt begins, validates contact/channel availability, and stores the concrete contact on the attempt.

## 4. Test without making a real call

Run the focused notification tests:

```powershell
npm run build
node --test tests/notifications.test.cjs
```

Run the complete suite:

```powershell
npm test
```

These tests use a mock communication provider. They verify call request construction, signed-webhook rejection, acknowledgement, decline, retries, escalation, lifecycle messages, on-call changes, callback deduplication, and persistence recovery without contacting Retell.

You can also verify that unsigned public endpoints fail closed:

```powershell
Invoke-WebRequest http://localhost:3004/webhooks/retell -Method Post -ContentType 'application/json' -Body '{"call_id":"fake"}' -SkipHttpErrorCheck
Invoke-WebRequest http://localhost:3004/v1/voice/actions -Method Post -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
```

Both requests should return `401 Unauthorized`. Do not use a fabricated signature as a substitute for a real Retell end-to-end test.

## 5. Perform one controlled real-call test

1. Confirm the policy has one step, one attempt, voice only, and your test contact.
2. Confirm the notification app's readiness endpoint is healthy.
3. Confirm both public HTTPS URLs are configured in Retell.
4. Generate a critical test incident through the normal telemetry/detection path, or use an existing controlled development incident. Do not insert notification attempts directly.
5. Answer the call and clearly say that you acknowledge the incident.
6. Inspect the resulting state:

```powershell
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/notification-attempts
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/escalation
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/communications
```

Expected results:

- The attempt contains a Retell provider request ID and the resolved contact ID.
- Acknowledgement changes the attempt to `ACKNOWLEDGED`.
- Escalation changes to `ACKNOWLEDGED` and no later step starts.
- Replaying the same callback produces no additional side effects.

For a decline test, say that you cannot take the incident and verify the next configured escalation step is used. Add retries and additional recipients only after the one-call test succeeds.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Notification app fails at startup | Required Retell, database, application, and broker variables are present and valid |
| Retell API returns 401/403 | API key and agent ownership; do not log the key |
| No call arrives | E.164 numbers, enabled contact, `voiceEnabled`, active policy match, active on-call shift, and Retell number outbound capability |
| Voice action returns 401 | Retell signature header and the exact raw request body reached Faultline unchanged |
| Voice action returns 400 | All six body fields are present and IDs match the stored attempt |
| Call succeeds but escalation continues | The agent submitted `ACKNOWLEDGE_INCIDENT`, not free-form text, and used the current call/attempt/contact IDs |
| SMS fails | `RETELL_SMS_AGENT_ID` is configured and the contact is SMS-enabled |
| Retry contacts the wrong engineer | Inspect the on-call schedule's active shift/override and `GET /on-call/schedules/:id/current` |

Faultline intentionally refuses unsigned actions and mismatched incident, attempt, recipient, or provider-call relationships. Those failures protect incident state and should be fixed at the Retell mapping rather than bypassed.

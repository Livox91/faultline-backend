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
# Leave these blank for a Slack-only deployment. Configure the first three together
# to enable voice, then add the SMS agent ID if SMS is also required.
RETELL_API_KEY=
RETELL_FROM_NUMBER=
RETELL_VOICE_AGENT_ID=
RETELL_SMS_AGENT_ID=
NOTIFICATION_ORGANIZATION_ID=default
NOTIFICATION_HIGH_ESCALATION_ENABLED=false
```

Retell is optional for a Slack-only notification worker. Once any Retell value is set,
`RETELL_API_KEY`, `RETELL_FROM_NUMBER`, and `RETELL_VOICE_AGENT_ID` must be configured
together; partial configuration fails closed. Phone numbers must use E.164 format, such
as `+15551234567`. `RETELL_SMS_AGENT_ID` is additionally required when a policy contains
an SMS channel. Keep high-severity calling disabled until the critical-only path is
working.

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

The current `npm run faultline:start` development composition starts API, ingestion,
processor, and storage, but not the notification application. Run notification as a
separate supervised process in production (or as its own Kubernetes workload); otherwise
voice, SMS, and Slack configuration can be correct while no notification consumer is
running.

## 3. Configure recipients and escalation

The contact, group, on-call, and escalation-policy endpoints are authenticated management
endpoints. Sign in as an Admin and include its access token in these examples:

```powershell
$headers = @{ Authorization = 'Bearer <admin-access-token>' }
```

Operationally these writes should be Admin-only. The current controllers require an
authenticated account but do not yet carry an explicit Admin-role decorator, so strict
Admin-only enforcement is an implementation gap to close before exposing the management
API to untrusted users.

Use the API on port `3000` to create a test contact. Use a phone number you control:

```powershell
$contact = Invoke-RestMethod http://localhost:3000/contacts -Method Post -Headers $headers -ContentType 'application/json' -Body (@{
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
Invoke-RestMethod http://localhost:3000/escalation-policies -Method Post -Headers $headers -ContentType 'application/json' -Body ($policyBody | ConvertTo-Json -Depth 8)
```

An escalation step may instead target an on-call schedule:

```json
{ "type": "ON_CALL_SCHEDULE", "id": "<schedule-id>" }
```

Faultline resolves the active engineer when each attempt begins, validates contact/channel availability, and stores the concrete contact on the attempt.

### Production model: assign an onsite engineer to a service

There are two distinct identities to configure. They should normally represent the same
person, but they serve different security boundaries and are not linked automatically:

1. A Faultline `onsiteengineer` **user account** controls sign-in and which projects the
   engineer may inspect. Create it in the Admin users screen or with `npm run user:create`,
   then assign the projects that contain the service.
2. A notification **contact** with role `ENGINEER` or `SENIOR_ENGINEER` stores the E.164
   phone number and whether voice and SMS delivery are permitted. Put this contact in a
   group or an on-call schedule, and target it from a service-specific escalation policy.

`npm run cluster:onboard` currently registers the Kubernetes cluster and installs the
collectors only. It does **not** discover a service owner, create a user/contact, or attach
an escalation policy. The initial plan—collect service ownership while onboarding a
container—therefore needs to be implemented as an Admin UI/service-onboarding workflow.
Until that workflow exists, an Admin performs the following steps after a workload is
onboarded:

1. Identify the service value Faultline records for incidents. Escalation-policy
   `match.services` currently matches `incident.primaryResource.workload` exactly, so use
   the Kubernetes workload name and preserve its spelling/case.
2. Create or invite the `onsiteengineer` user and assign the relevant Faultline project.
   Project assignment controls data access; it does not configure calls or SMS.
3. Create the engineer's notification contact with an E.164 number and the required
   channel flags.
4. For a single permanent owner, target the contact directly. For a team, create a
   notification group. For rotations, create an on-call schedule, add dated shifts and
   overrides, and target `ON_CALL_SCHEDULE` from the escalation step.
5. Create one enabled escalation policy whose `match.services` contains that workload.
   Put the primary engineer/on-call schedule first and senior or team contacts in later
   steps.
6. Verify the current rotation with
   `GET /on-call/schedules/:id/current`, then run one controlled incident test.

For example, a service-specific match and an on-call target have this shape:

```json
{
  "organizationId": "default",
  "name": "Payments production escalation",
  "enabled": true,
  "sendResolution": true,
  "match": {
    "severities": ["CRITICAL"],
    "services": ["payments-api"]
  },
  "steps": [
    {
      "order": 1,
      "target": { "type": "ON_CALL_SCHEDULE", "id": "<payments-schedule-id>" },
      "channels": ["VOICE", "SMS"],
      "maximumAttempts": 2,
      "retryDelayMs": 60000,
      "waitBeforeNextStepMs": 120000
    }
  ]
}
```

The current Contacts & On-call and Escalation pages display backend configuration, but
do not yet provide the complete create/edit workflow. In a deployed product, these
operations should be exposed as an Admin-only setup wizard rather than requiring direct
API calls.

### Production model: configure end customers for SMS

End customers are notification recipients, not Faultline login users. Create a contact
with role `END_USER`, enable SMS, disable voice unless it is explicitly required, and add
the contact to a group for the affected service or customer tenant:

```powershell
$customer = Invoke-RestMethod http://localhost:3000/contacts -Method Post -Headers $headers -ContentType 'application/json' -Body (@{
  organizationId = 'default'
  name = 'Acme Operations'
  role = 'END_USER'
  phoneNumber = '+15551234567'
  smsEnabled = $true
  voiceEnabled = $false
  enabled = $true
} | ConvertTo-Json)

$customerGroup = Invoke-RestMethod http://localhost:3000/notification-groups -Method Post -Headers $headers -ContentType 'application/json' -Body (@{
  organizationId = 'default'
  name = 'Payments customers'
  contactIds = @($customer.id)
  enabled = $true
} | ConvertTo-Json)
```

Add an `END_USER` communication rule to the service's escalation policy. These rules are
separate from engineering escalation steps: the latter find an incident owner, while
communication rules send audience-safe lifecycle updates.

```json
{
  "audience": "END_USER",
  "target": { "type": "GROUP", "id": "<payments-customers-group-id>" },
  "channels": ["SMS"],
  "subscriptions": ["INITIAL", "STATUS_UPDATES", "RESOLUTION"],
  "services": ["payments"],
  "minimumIntervalMs": 900000
}
```

For communication rules, `services` currently matches `incident.logicalService`
exactly. This may differ from the Kubernetes workload used by `match.services`; for
example, the policy could match workload `payments-api` while public updates use logical
service `payments`. Confirm both values from a real incident before enabling customer
delivery. `minimumIntervalMs` suppresses repeated updates inside the interval, and the
message builder deliberately omits cluster, namespace, container, evidence, and root
cause details from end-user messages.

Retell must have an SMS/chat agent in `RETELL_SMS_AGENT_ID`, and
`RETELL_FROM_NUMBER` must be capable of sending SMS to the destination country. Faultline
calls Retell's SMS chat API with the generated safe message and the recipient's E.164
number.

Production note: the current contact model records delivery eligibility but does not yet
store consent evidence, locale, quiet hours, tenant ownership, opt-out state, or STOP
handling. Those controls and applicable telecom/privacy requirements must be implemented
before importing real customer lists. Until then, add only controlled recipients who
have explicitly opted in.

## 4. Configure Slack incident delivery

Slack delivery is independent of Retell voice/SMS. The notification application creates
one Slack incident ticket for a newly created classified incident, updates the top-level
message as the incident changes, and posts significant lifecycle events as thread
replies. Delivery is idempotent, and Slack failures are contained so they do not stop
incident processing.

### Create and install the Slack app

1. Create a Slack app for the customer's workspace and add a bot user.
2. Grant the bot the `chat:write` OAuth scope. If the bot will not be invited to public
   channels, Slack may also require `chat:write.public`; inviting the bot explicitly is
   the safer default. Private channels always require the bot to be invited.
3. Install or reinstall the app to the workspace after changing scopes.
4. Copy the Bot User OAuth Token (`xoxb-...`). Store it only in
   `apps/notification/.env`; never put it in frontend code or commit it.
5. Invite the bot to every default, service, and team channel it may use.
6. Record channel IDs such as `C0123456789`, not display names such as
   `#payments-incidents`. Slack exposes the ID in channel details and copied channel
   links.

Slack documents `chat:write` and `chat:write.public` in its official
[OAuth scope reference](https://docs.slack.dev/reference/scopes/chat.write) and
[public-channel scope reference](https://docs.slack.dev/reference/scopes/chat.write.public/).

Configure `apps/notification/.env`:

```dotenv
SLACK_ENABLED=true
SLACK_BOT_TOKEN=xoxb-<bot-token>
SLACK_INCIDENT_CHANNEL_ID=C0123456789
SLACK_DASHBOARD_URL=https://faultline.example.com/

# Direct service -> channel routing. Keys are normalized to lowercase.
SLACK_SERVICE_CHANNELS={"payments":"C1111111111","checkout":"C2222222222"}

# Optional two-stage service -> owning team -> channel routing.
SLACK_SERVICE_OWNERS={"catalog":"commerce","search":"discovery"}
SLACK_TEAM_CHANNELS={"commerce":"C3333333333","discovery":"C4444444444"}
```

`SLACK_ENABLED=true` alone is insufficient: the integration becomes active only when
both `SLACK_BOT_TOKEN` and `SLACK_INCIDENT_CHANNEL_ID` are present. Restart the
notification application after changing the file:

```powershell
npm run build
npm run start:notification
```

Channel selection follows this order:

1. `SLACK_SERVICE_CHANNELS[service]`;
2. `SLACK_SERVICE_OWNERS[service]` followed by `SLACK_TEAM_CHANNELS[team]`;
3. `SLACK_INCIDENT_CHANNEL_ID` as the default.

The selected service is the incident's logical service, then its primary workload, then
the alphabetically first affected workload. Mapping keys are trimmed and lowercased.
The dashboard URL is optional; when present, Slack messages link to
`/incidents/:incidentId`.

Test with a controlled classified incident and check the notification application's
logs for `slack.ticket.created`, `slack.ticket.updated`, or a safe
`slack.ticket.*_failed` event. An authenticated Faultline user can inspect the persisted
ticket metadata with:

```powershell
Invoke-RestMethod http://localhost:3000/incidents/<incident-id>/external-tickets/slack -Headers $headers
```

If the response contains `{"ticket":null}`, check that Slack is fully enabled, the
incident has a classification, the bot is a member of the resolved channel, the channel
ID is correct, and the notification application—not only the API/processor/storage
pipeline—is running.

## 5. Test without making a real call

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

## 6. Perform one controlled real-call test

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
| Notification app fails at startup | Database, application, and broker variables are valid; if Retell is partially configured, supply all three core Retell values or leave all Retell values blank for Slack-only mode |
| Retell API returns 401/403 | API key and agent ownership; do not log the key |
| No call arrives | E.164 numbers, enabled contact, `voiceEnabled`, active policy match, active on-call shift, and Retell number outbound capability |
| Voice action returns 401 | Retell signature header and the exact raw request body reached Faultline unchanged |
| Voice action returns 400 | All six body fields are present and IDs match the stored attempt |
| Call succeeds but escalation continues | The agent submitted `ACKNOWLEDGE_INCIDENT`, not free-form text, and used the current call/attempt/contact IDs |
| SMS fails | `RETELL_SMS_AGENT_ID` is configured and the contact is SMS-enabled |
| Retry contacts the wrong engineer | Inspect the on-call schedule's active shift/override and `GET /on-call/schedules/:id/current` |
| No customer SMS is sent | Contact role is `END_USER`, SMS is enabled, the communication rule targets that contact/group, its subscriptions include the lifecycle event, and its service exactly matches `incident.logicalService` |
| No Slack ticket is created | Notification app is running; all three required Slack settings are present; incident is classified; bot belongs to the resolved channel; channel IDs and JSON maps are valid |
| Slack uses the wrong channel | Check direct service mapping first, then service-owner/team mapping, then the default; keys are lowercase after parsing |

Faultline intentionally refuses unsigned actions and mismatched incident, attempt, recipient, or provider-call relationships. Those failures protect incident state and should be fixed at the Retell mapping rather than bypassed.

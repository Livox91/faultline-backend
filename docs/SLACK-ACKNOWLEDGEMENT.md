# Slack incident acknowledgements

Faultline can calculate MTTA from either the existing Retell calling-agent response or
an engineer action on the incident's Slack ticket. The first acknowledgement wins;
later voice or Slack responses do not replace its timestamp.

## Slack app setup

1. Under **Event Subscriptions**, enable events and subscribe the bot to
   `reaction_added` and the message events required by the
   incident channel type (`message.channels` for public channels and
   `message.groups` for private channels).
2. Add the OAuth scopes required by those subscriptions (`reactions:read`, plus
   channel/group history as applicable), reinstall the Slack app, invite it to the
   incident channel, and restart the notification service after configuring one of
   the delivery modes below.

### Socket Mode (recommended for local development)

1. Enable **Socket Mode** in Slack.
2. Under **Basic Information**, create an app-level token with the
   `connections:write` scope. This token starts with `xapp-`; it is different from
   the `xoxb-` bot token.
3. Configure:

   ```dotenv
   SLACK_SOCKET_MODE_ENABLED=true
   SLACK_APP_TOKEN=xapp-...
   ```

No public Request URL or signing secret is required for Socket Mode event delivery.
Faultline opens and refreshes the WebSocket connection and acknowledges each Slack
envelope only after it has processed the event.

### HTTP Request URL

1. Disable Socket Mode.
2. In **Basic Information**, copy the Signing Secret to `SLACK_SIGNING_SECRET`.
3. Set the Event Subscriptions Request URL to
   `https://<notification-host>/webhooks/slack/events` and configure:

   ```dotenv
   SLACK_SOCKET_MODE_ENABLED=false
   SLACK_SIGNING_SECRET=...
   ```

An engineer can acknowledge an incident by replying `ack`, `acknowledge`, or `acknowledged` in the
ticket thread, or by reacting to the top-level ticket with one of:
`white_check_mark`, `heavy_check_mark`, `ballot_box_with_check`, `thumbsup`, or `+1`.
Other replies and reactions are ignored.

Every HTTP callback must have a valid Slack `v0` signature and a timestamp no more
than five minutes old; Socket Mode uses Slack's authenticated WebSocket envelope.
Faultline maps the callback to the persisted Slack ticket instead
of trusting an incident ID supplied by Slack, records the Slack user ID and event ID,
stops active escalation, and publishes the existing `INCIDENT_ACKNOWLEDGED` lifecycle
event. The reporting queries already join the acknowledgement record, so MTTA requires
no separate reporting change.

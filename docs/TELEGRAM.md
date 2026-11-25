# Private Telegram alerts

Meida can send its conditional stock/options research alerts to one paired private Telegram chat. Setup and the background worker are implemented. Actual delivery is not verified until the owner configures a bot, pairs the chat, and receives a test message. Telegram is the implemented delivery channel; Slack and WhatsApp remain future integrations.

## Before setup

- Run one Meida server instance with persistent SQLite storage. On Railway, retain the persistent volume and use one replica as described in [SETUP.md](SETUP.md).
- Configure a valid `TOKEN_ENCRYPTION_KEY` on the server. This existing 32-byte key encrypts both Schwab tokens and the Telegram bot connection. Preserve it across deployments.
- Use a Telegram account and create a bot dedicated to Meida. A bot already used by another app may have a webhook or update consumer that conflicts with pairing.

The Telegram token is entered through Meida's authenticated **Connections** screen. There is no Telegram-specific environment variable and no need to paste a token into an assistant chat or manually find a chat ID. For local development, Telegram still requires the encryption key even though loopback access does not require an owner password.

## Pair your chat

1. Open Telegram's official [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts to create your own dedicated bot. Keep the resulting token private.
2. In Meida, open **Connections → Telegram alerts**. Enter the token in **Bot token**, then select **Connect bot**. Meida validates the bot and checks that an existing webhook will not conflict with pairing. It does not remove someone else's webhook.
3. Select **Open private pairing link**. In Telegram, press **Start**. Use the generated link rather than sending a bare `/start`: the link carries the one-time code that identifies this pairing attempt.
4. Return to Meida and select **I've started the bot**. Meida accepts only the matching code from a private human chat. Pairing links expire after ten minutes; create a new one if needed. Keep the link private until pairing is complete.
5. Select **Send test message**, then check that it arrives in your intended private chat. This is an explicit setup test, not a market signal. A test does not require Schwab or enable market alerts. Test attempts have a one-minute cooldown.

The saved connection, including the bot token and destination, is encrypted at rest in SQLite. Status responses show the bot username and a masked chat label, not the saved token. The token field is not saved in browser storage. Protect the server key and persistent database separately.

## Enable market alerts

1. Connect your approved Schwab application and select **Schwab** as Meida's data source.
2. In **Telegram alerts**, choose **Intraday & swing**, **Intraday only**, or **Swing only** under **Trading horizon**.
3. Enable **Send market alerts**.

This enables independent server monitoring of the saved watchlist and alert rules. The browser can be closed. The server process must remain running and connected to the network; a stopped service, sleeping computer, or suspended host cannot scan or send.

The worker checks official market-session hours and attempts a fresh scan every 60 seconds during regular trading hours. It does not monitor premarket, after-hours, or overnight sessions. The horizon selector chooses eligible signal types; choosing **Swing only** does not add an after-hours daily-close service.

Turn off **Send market alerts** to pause monitoring. Selecting Demo or losing the Schwab connection also pauses it; enabled monitoring can resume when Schwab is connected and selected again. **Disconnect Telegram** removes Meida's saved bot connection and disables its alerts. It does not revoke the bot token at Telegram; use BotFather if revocation is needed.

## Delivery behavior and limits

| Behavior                      | Current implementation                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan cadence                  | At most one background scan attempt per 60 seconds, during confirmed regular market hours. Manual, dashboard, and background scans share one execution gate.                                                                                                     |
| Delivery cadence              | Worker runs every 20 seconds and sends at most one market alert per tick: up to three per minute. Slower scans, cooldowns, or errors can reduce this rate.                                                                                                       |
| Eligible data                 | Only Schwab-source signals from an open-session scan. Both snapshot and signal must be no older than 120 seconds at send time; the signal engine also enforces its data-quality requirements. Demo signals are never sent.                                       |
| Horizon                       | Intraday and swing together, intraday only, or swing only.                                                                                                                                                                                                       |
| Selection                     | Qualifying candidates are considered by signal strength. That ranking is not a probability of profit.                                                                                                                                                            |
| Deduplication                 | First qualifying alert for each instrument, rule, direction, market session, and bot/chat destination. Receipts persist in SQLite and are retained for three days. Changing thresholds does not guarantee another message for the same combination that session. |
| Pending candidates            | Only candidates still present in the latest applicable scan and still fresh can be sent. There is no replay of an old backlog after downtime. Some candidates can expire before delivery.                                                                        |
| Rate limits                   | A Telegram `429` response applies a cooldown. A still-current candidate may be retried afterward.                                                                                                                                                                |
| Uncertain send                | Attempts are recorded before the network request. If a timeout, crash, or other failure makes acceptance uncertain, the same alert is not retried automatically. This avoids blind duplicate retries but can miss an alert.                                      |
| Authentication/access failure | Bot authentication or chat-access failures can disable market alerts. Resolve the connection, test it, and enable alerts again.                                                                                                                                  |

This is periodic REST monitoring, not Schwab WebSocket/tick streaming. The cadence is not a guaranteed delivery deadline, and a brief condition between scans can be missed. The app does not promise exactly-once delivery, complete coverage, or notification receipt on the phone.

Telegram acceptance means its API returned a message result; it does not establish that you read the message or that the phone displayed a notification. Check Telegram's chat notification settings and the device's notification permissions. **Last market alert sent** in Meida tracks accepted market alerts; a successful setup test can leave that timestamp unchanged.

Alerts include the symbol/contract, trading horizon, Eastern Time timestamp, measured evidence, conditional action, confirmation, invalidation, and an app link. They are research prompts and never submit brokerage orders. Review current quotes before acting. The current system sends initial qualifying alerts; it is not a complete position-monitoring, target-execution, or exit-notification service.

## Troubleshooting

- **Setup unavailable:** configure `TOKEN_ENCRYPTION_KEY`. If the key changed, restore the correct key or reconnect the bot; encrypted data from a different key cannot be read.
- **Existing webhook / updates handled elsewhere:** use a new dedicated bot, or resolve the other integration yourself. Meida does not automatically delete a webhook or take over another application's bot.
- **No matching Start message:** open the current pairing link, press **Start**, then confirm in Meida. A bare `/start`, an old link, or a group message will not match. If the link expired, create a new one.
- **Test failed:** check the displayed error, ensure the bot is not blocked, and wait for any cooldown before another explicit test. If the token was revoked, reconnect with its replacement. Do not paste token-bearing URLs or provider credentials into support messages.
- **Paired but alerts paused:** select Schwab, reconnect it if needed, and enable **Send market alerts**. Dashboard auto-scan is a separate setting.
- **No market messages:** confirm the market is open, the server is running, the last background scan is recent, the selected horizon has candidates, and data/threshold requirements pass. No qualifying signal is a valid outcome.
- **A signal appeared in the app but was not messaged:** it may already have been attempted that session, expired, fallen out of the latest scan, failed the selected horizon, or been skipped after an uncertain send. There is no stale backlog replay.
- **Uncertain-delivery message:** check the private chat and use **Send test message** to verify the connection. The original market alert is deliberately not resent automatically.

## Operating boundary

Use a single running instance against its persistent SQLite database. This worker does not coordinate replicas or provide a durable customer notification queue. Customer delivery still needs individual identities/destinations, tenant isolation, operational monitoring, and appropriate Schwab/exchange data rights. Personal bot pairing does not establish customer redistribution permission.

## Official Telegram references

- [Bot creation and first messages](https://core.telegram.org/bots/tutorial): BotFather setup and messaging basics.
- [Bot API](https://core.telegram.org/bots/api): `getUpdates`, `getWebhookInfo`, `sendMessage`, update offsets, and rate-limit response parameters. Polling and webhook update delivery cannot be used simultaneously; Meida uses polling to confirm pairing.
- [Bots FAQ](https://core.telegram.org/bots/faq): Telegram's messaging limits and bot behavior. Meida's three-market-alerts-per-minute cap is its own conservative application limit.

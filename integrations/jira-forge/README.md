# GUIJam for Jira

A Forge app that connects Jira Cloud to [GUIJam](../../README.md), the dev tool that edits a running web app in place. Developers turn UI tickets into GUIJam prompts, and every change they keep is posted back to its ticket with before and after screenshots, the element's file and line, and the diff.

The app makes no AI calls. All AI runs in each developer's own AI CLI, on their machine.

**Install:** a Jira site admin opens the [installation link](https://developer.atlassian.com/console/install/9f6e7bd4-561f-42c1-967c-534533ca84fd?signature=AYABeNHZxmIIzqskV6bj6ZDb2BwAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB9X7SgA05cnObTkvhYN1xbQAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDNEhzAe7TPWDBVqk6wIBEIA7keQSd6CapbYmtUGdkeKKsGD9awYJ3ooCpMpwMF2EDUNbpBp%2F9PeiHpLYzLpKRCnH1ToDtNvaJyOei0kAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgEaeJ%2BkdCobmSDv47DLtIySAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMGEExVBpjK5bbUYmTAgEQgDvy5cWJv19sweBbrSFr5C3xdwywv%2BBv20pRtihL1aMr7o8uQnVvR9vasue1xGfDidyWyh8RzUzmiGXFBQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAWqyfoA4bYp55SbOGUdCdOkAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAwmXimEV%2FsYgm0GihwCARCAO2yT52i7N%2B%2BDNBN%2F2F87pJutoitrvTBVazhVeMuRbv%2BmP8xV9sDbTccsGcHKl%2BfdohjSFjjtL%2BQGx983AgAAAAAMAAAQAAAAAAAAAAAAAAAAAKlWUN4JXPX85evX3RKxCVz%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLbFlcEhVS0TGlPnle4N%2FWi6ZPs4%2FxogfU6%2BLKHwDp0vbTyhpPRk4JYHRWIvoxpoJGa%2F4o%2Fn8CSg1cuvGh0MKv91WQ%3D&product=jira) and picks the site.

## What it adds to Jira

| Module | What it does |
|---|---|
| `jira:issuePanel` **GUIJam** | Shows the ticket's GUIJam status, who applied the change and when, before and after screenshots, the changed files and the diff, and an **Open in GUIJam** link. It's also where a developer pairs GUIJam and revokes devices. |
| `jira:issueAction` **Send to GUIJam** | In the ••• menu. Marks the ticket as queued for GUIJam. |
| `jira:entityProperty` | Indexes the `guijam` issue property so JQL works: `guijamStatus = queued`, `guijamFile ~ "Pricing"`, `guijamAppliedAt >= -7d`. |
| `webtrigger` **guijam-bridge** | The HTTPS endpoint GUIJam on a developer's machine calls. |
| `rovo:mcp` and two `action` tools | `list-ui-tickets` and `get-guijam-result`, read-only, for Rovo agents and other MCP clients. See [`skill.md`](skill.md). |

## Security model

- **No Atlassian credentials leave Jira.** Pairing creates a random 256-bit token. The app stores only its SHA-256 hash in Forge storage, and shows the token once inside a pairing code. The developer's machine keeps the token in `~/.config/guijam/trackers.toml` with mode 0600.
- **Each request acts as the paired person, not the app.** Web trigger URLs are public, so every bridge request must carry a valid bearer token. Before any read or write, the app checks the paired person's own Jira permissions on that ticket (`/rest/api/3/permissions/check` for their account). Search results are filtered the same way. Writing needs Add comments, Create attachments and Edit issues, plus Transition issues to move a ticket.
- **Projects are scoped at pairing time.** Pairing records the projects the person can browse, as that person, and the bridge only touches those projects. If Jira refuses the per-account check, the app falls back to the rights recorded for each project, refreshed every 10 minutes while the person uses the panel.
- **Revocable.** Revoke a device in the panel, or run `npx guijam jira unpair`, which revokes it in Jira too. A person can have up to 10 paired devices.
- **Rate-limited and size-capped.** 120 requests a minute per device, 5 MB per request, and 3 MB per image.
- **Idempotent.** A result is posted at most once per GUIJam change id, so a retry never posts twice.
- **Ticket text is untrusted.** GUIJam passes it to the AI CLI as untrusted text. The CLI still gets no write tools, and GUIJam validates every edit.

## Scopes

| Scope | Why |
|---|---|
| `read:jira-work` | Read tickets, attachments and transitions; search with JQL; list projects at pairing. |
| `write:jira-work` | Post comments, upload screenshots, set the `guijam` property, move tickets, create reported tickets. |
| `read:jira-user` | Show the paired person's display name. |
| `read:permission:jira` | Check the paired person's permissions before each read and write. |
| `storage:app` | Store pairing hashes, results, rate limits and idempotency keys. |

The panel also loads images from `*.atlassian.net`, which are the ticket's own attachments.

## Deploy and share

Requires Node 22 or 24 and a Jira Cloud site where you're an admin.

```bash
cd integrations/jira-forge
pnpm install
pnpm exec forge login          # asks for an Atlassian API token
pnpm exec forge register       # writes this app's id into manifest.yml
pnpm exec forge deploy -e development
pnpm exec forge install -e development --site <your-site>.atlassian.net --product jira
```

To share it with others, the judges included:

```bash
pnpm exec forge deploy -e production
```

Then in the [developer console](https://developer.atlassian.com/console/myapps/): open the app, go to **Distribution**, choose **Edit**, select **Sharing**, save, and copy the installation link. Whoever installs it must be an admin of their site.

To use the MCP tools, Rovo must be on for the site, and a site admin must turn on external MCP access for the app.

## Develop

```bash
pnpm typecheck
pnpm test
```

The bridge's request and response types are generated from [`contracts/tracker.schema.json`](../../contracts/tracker.schema.json) into `src/generated/bridge.ts` by `pnpm contracts:gen` at the repo root. The daemon's Rust types come from the same schema, so the two sides can't drift.

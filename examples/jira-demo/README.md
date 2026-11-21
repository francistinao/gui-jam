# GUIJam for Jira: demo app

A small "Brew & Co." subscriptions page for trying GUIJam with Jira. Three of its four demo tickets can be done without any AI tool installed. The fourth needs an AI coding CLI such as Claude Code.

## 1. Install the Jira app

Open the [GUIJam for Jira installation link](https://developer.atlassian.com/console/install/9f6e7bd4-561f-42c1-967c-534533ca84fd?signature=AYABeNHZxmIIzqskV6bj6ZDb2BwAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB9X7SgA05cnObTkvhYN1xbQAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDNEhzAe7TPWDBVqk6wIBEIA7keQSd6CapbYmtUGdkeKKsGD9awYJ3ooCpMpwMF2EDUNbpBp%2F9PeiHpLYzLpKRCnH1ToDtNvaJyOei0kAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgEaeJ%2BkdCobmSDv47DLtIySAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMGEExVBpjK5bbUYmTAgEQgDvy5cWJv19sweBbrSFr5C3xdwywv%2BBv20pRtihL1aMr7o8uQnVvR9vasue1xGfDidyWyh8RzUzmiGXFBQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAWqyfoA4bYp55SbOGUdCdOkAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAwmXimEV%2FsYgm0GihwCARCAO2yT52i7N%2B%2BDNBN%2F2F87pJutoitrvTBVazhVeMuRbv%2BmP8xV9sDbTccsGcHKl%2BfdohjSFjjtL%2BQGx983AgAAAAAMAAAQAAAAAAAAAAAAAAAAAKlWUN4JXPX85evX3RKxCVz%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLbFlcEhVS0TGlPnle4N%2FWi6ZPs4%2FxogfU6%2BLKHwDp0vbTyhpPRk4JYHRWIvoxpoJGa%2F4o%2Fn8CSg1cuvGh0MKv91WQ%3D&product=jira), choose your Jira Cloud site, and approve. You need to be an admin of that site. Create a Jira project if you don't have one, and note its key, such as `WEB`.

## 2. Run this app

Requires Node 22 or later and pnpm.

```bash
git clone https://github.com/francistinao/guijam-jira-demo
cd guijam-jira-demo
pnpm install
pnpm dev
```

Open the address Vite prints. The GUIJam toolbar is at the bottom right.

## 3. Pair GUIJam with Jira

In Jira, open any ticket, find the **GUIJam** panel, and choose **Pair GUIJam**. Copy the command it shows and run it in this folder:

```bash
npx guijam jira pair gjp_...
```

## 4. Create the demo tickets

```bash
pnpm seed:jira --project WEB
```

Use your own project key. This creates four tickets, each with a screenshot.

## 5. Work a ticket

1. In the app, choose **Select object** in the toolbar and click the **Subscribe** button.
2. In the panel, choose **Link a Jira ticket**, then **Make the Subscribe button blue and pill-shaped**.
3. Optionally, under **On apply, move to**, pick a status such as In Review.
4. Set **Fill** to `ocean` and **Radius** to full, then choose **Apply**.
5. About 10 seconds later, GUIJam posts to the ticket. Open it in Jira: the GUIJam panel shows the before and after screenshots, `src/App.tsx` with its line, and the diff.

The other tickets work the same way:
- **Rename the hero heading:** select the heading and type the new text under **Content**.
- **Rename the Barista plan:** select the plan name. GUIJam finds `'Barista'` in `src/plans.ts`, and you type the new name.
- **Most popular badge:** select the card, choose **Ask AI**, link the ticket, and choose **Use ticket text**. This one needs an AI CLI.

**Undo** within 10 seconds of applying and nothing is posted.

To file a ticket from the app instead, select any element and choose **Report to Jira**.

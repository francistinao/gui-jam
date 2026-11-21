# GUIJam for Jira: demo app

A small "Brew & Co." subscriptions page for trying GUIJam with Jira. Three of its four demo tickets can be done without any AI tool installed. The fourth needs an AI coding CLI such as Claude Code.

## 1. Install the Jira app

Open the installation link for **GUIJam for Jira**, choose your Jira Cloud site, and approve. You need to be an admin of that site. Create a Jira project if you don't have one, and note its key, such as `WEB`.

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

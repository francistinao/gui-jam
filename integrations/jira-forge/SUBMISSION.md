# GUIJam for Jira: Codegeist 2026 submission

**Category:** Apps for Software Teams
**Bonus prize:** Best app with Atlassian MCP (`rovo:mcp`)

## The problem

UI tickets are where front-end work gets lost. QA writes "the Subscribe button looks wrong on pricing". A developer has to find the page, then the component, then the line. They make the change, then go back to Jira to describe it, often without a screenshot. Reviewers can't easily see what changed, and nobody can find "the ticket that changed this button" later.

## What it does

GUIJam is an open-source dev tool that turns a running web app into an editable surface. You select or circle any element, then fine-tune it directly or ask your own AI coding CLI for three live variants. It writes minimal edits to the exact source file, with undo. **GUIJam for Jira** connects that loop to Jira:

- **Tickets in.** In GUIJam's Select or Draw panel, a developer links a Jira ticket. Its text and screenshots become the prompt. Exact requests, such as a color, a radius or a text change, need no AI at all.
- **Results out.** When the developer keeps a change, GUIJam posts it to the ticket once Undo is no longer offered:
  - before and after screenshots;
  - the element's `file:line`;
  - the diff;
  - who applied it, and whether an AI CLI or a direct edit made it;
  - optionally, a status move such as In Review.

  Undo in time and nothing is posted. Undo later and the ticket says it was reverted.
- **Report to Jira.** QA and designers running the app click any element and file a ticket. The screenshot, `file:line` and page address are filled in for them, so the developer starts at the right line.
- **For the whole team in Jira.** The GUIJam issue panel shows each result without anyone running GUIJam. **Send to GUIJam** queues a ticket. JQL such as `guijamStatus = queued` and `guijamFile ~ "Pricing"` works because the app indexes its issue property.
- **For agents.** Two read-only MCP tools, `list-ui-tickets` and `get-guijam-result`, let Rovo and third-party agents answer "what changed for WEB-12, and in which file?". Use them with [`skill.md`](skill.md).

## How it meets the Forge requirement

The app is built on Forge, with a manifest and these modules:

| Module | Role |
|---|---|
| `webtrigger` (dynamic, `urlFormat: v2`) | The bridge that GUIJam on a developer's machine calls, authenticated by a hashed pairing token |
| `jira:issuePanel` (UI Kit) | Results, status, pairing and device revocation |
| `jira:issueAction` (UI Kit) | Send to GUIJam |
| `jira:entityProperty` | JQL: `guijamStatus`, `guijamFile`, `guijamAppliedAt` |
| `rovo:mcp` and 2 `action` modules | Read-only MCP tools |
| Forge KVS | Pairing hashes, results, idempotency keys, rate limits |

Jira REST calls run in Forge:
- `requestJira` as the app, behind a per-account permission check;
- `asUser` in resolvers and MCP tools.

No external servers, no LLM calls, and no Atlassian credentials leave Jira.

## Security

See [README.md](README.md#security-model). In short:
- Pairing tokens are random, stored only as hashes, and revocable from Jira or the CLI.
- Every request is checked against the paired person's own permissions.
- Search results are filtered the same way.
- Posting is idempotent.
- Requests are rate-limited and size-capped.

## What existed before, and what was built in the period

The submission period started on Oct 27, 2026. GUIJam's repository was created on Nov 17, 2026 (first commit `332012c`), so all of GUIJam, including this Jira integration, was built during the period.

The Jira integration added:
- the Forge app in `integrations/jira-forge`;
- the tracker contracts in `contracts/tracker.schema.json`;
- the daemon's tracker client, pairing and pending posts in `crates/gjd-daemon/src/tracker`;
- the widget's ticket field, Report to Jira and the deep link in `packages/overlay`;
- the `guijam jira` commands;
- the demo app in `examples/jira-demo`.

## Testing instructions for judges

You need a Jira Cloud site where you're an admin, and Node 22 or later. No AI tool or API key is needed for the main path.

1. Install the app from the installation link. Create a Jira project if you need one, and note its key, such as `WEB`.
2. Follow [examples/jira-demo/README.md](../../examples/jira-demo/README.md):
   1. clone and run the demo app;
   2. open any ticket's **GUIJam** panel and pair;
   3. run `pnpm seed:jira --project WEB`;
   4. work the first three tickets with no AI.
3. In Jira, open a worked ticket. The GUIJam panel shows the before and after screenshots, the file and line, and the diff.
4. Try **Undo** within 10 seconds, and **Report to Jira** from any element.
5. Search JQL `guijamStatus = applied`.
6. **Optional, MCP:** with Rovo on and external MCP access turned on for the app, ask an agent "Which UI tickets are queued for GUIJam?".

**Limits:**
- Jira Cloud only. Forge doesn't run on Data Center.
- A developer must run their app's dev server with GUIJam, which is a dev-only tool.
- The fourth demo ticket needs an AI coding CLI such as Claude Code.

## Video shot list (under 5 minutes)

| Time | Shot |
|---|---|
| 0:00 | The problem: a vague UI ticket bounces between QA and a developer. |
| 0:25 | In Jira: the ticket, then **Send to GUIJam**. |
| 0:40 | The developer's app: Select the button, **Link a Jira ticket**, set Fill and Radius, **Apply**. |
| 1:30 | The Jira panel: before and after, `src/App.tsx:18`, the diff, and the status moved to In Review. |
| 2:00 | Text from data: select a plan card, and GUIJam finds `'Barista'` in `plans.ts`. |
| 2:30 | **Undo** within 10 seconds: nothing is posted. |
| 2:50 | QA's **Report to Jira** from an element, and the new ticket with the screenshot and file. |
| 3:20 | An AI ticket: **Use ticket text**, three variants from the developer's own CLI, keep one, posted. |
| 4:00 | MCP: an agent answers "what changed for WEB-3?". |
| 4:20 | The security model on one slide: hashed pairing tokens, per-user permission checks, no LLM in Jira. |

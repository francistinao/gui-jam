# GUIJam for Jira

Use these tools to see what GUIJam changed for UI tickets in Jira. GUIJam is a dev tool that
edits a running web app in place and posts each kept change back to its Jira ticket.

## Tools

- `list-ui-tickets`: tickets linked to GUIJam. Optional `status`: `queued`, `in_progress`,
  `applied` or `reverted`. Each result has the ticket key, summary, Jira status, GUIJam status
  and the changed element's `file:line`.
- `get-guijam-result`: one ticket's GUIJam result. Required `issueKey`, such as `WEB-12`. It
  returns who applied the change, when, whether an AI CLI or a direct edit made it, the
  element's `file:line`, the changed files, the diff, and the ids of the before and after
  screenshots attached to the ticket.

## Good uses

- "Which UI tickets are waiting for GUIJam?" calls `list-ui-tickets` with `status: queued`.
- "What changed for WEB-12, and in which file?" calls `get-guijam-result`.
- Review a change: read the diff from `get-guijam-result`, then open the file it names.

Both tools only read. They run with your own Jira permissions, so they only return tickets you
can see.

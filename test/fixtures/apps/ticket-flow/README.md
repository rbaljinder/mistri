# ticket-flow

A fixture for row-driven flows (test/flows-host.test.ts): a signed delivery
opens a ticket, the ticket's history starts the flow its rows describe, and
the flow sets a field, asks a team (an App step kind, the `askTeam` command),
waits for `ticket.answered` about that ticket, and closes it when the answer
was yes. The App's `app.json`, database, flow rows and connection file are
written by the test in its own temporary directory; only the modules that
must import `tablewalk` live here.

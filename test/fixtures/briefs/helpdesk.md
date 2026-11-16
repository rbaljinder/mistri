# Brief: Signal Desk

A support desk: tickets from customers, agents on teams, replies. A command that writes a table with no machine step of its own (Assign).

## Machine block

```json mistri-brief
{
  "app": {
    "name": "Signal Desk",
    "theme": "lumen",
    "logo": "users"
  },
  "entities": {
    "team": {
      "name": "text! unique"
    },
    "agent": {
      "name": "text!",
      "email": "email! unique",
      "team": "ref team"
    },
    "customer": {
      "name": "text!",
      "email": "email! unique",
      "company": "text"
    },
    "ticket": {
      "subject": "text!",
      "customer": "ref customer!",
      "agent": "ref agent",
      "priority": "choice low|normal|high|urgent =normal",
      "status": "choice new|open|waiting|solved|closed =new",
      "opened_at": "datetime!",
      "body": "longtext"
    },
    "reply": {
      "ticket": "ref ticket!",
      "agent": "ref agent",
      "body": "longtext!",
      "sent_at": "datetime!"
    }
  },
  "roles": {
    "lead": {
      "label": "Team lead",
      "read": true,
      "write": true,
      "commands": [
        "assignTicket",
        "solveTicket",
        "reopenTicket"
      ]
    },
    "agent": {
      "label": "Agent",
      "read": true,
      "write": [
        "ticket",
        "reply"
      ],
      "commands": [
        "solveTicket",
        "reopenTicket"
      ]
    }
  },
  "commands": [
    {
      "id": "assignTicket",
      "on": "ticket",
      "label": "Assign",
      "set": {},
      "refuse": [
        "the agent is on another team"
      ]
    },
    {
      "id": "solveTicket",
      "on": "ticket",
      "label": "Solve",
      "when": "status = open or status = waiting",
      "set": {
        "status": "solved"
      },
      "refuse": []
    },
    {
      "id": "reopenTicket",
      "on": "ticket",
      "label": "Reopen",
      "when": "status = solved",
      "set": {
        "status": "open"
      },
      "refuse": []
    }
  ]
}
```

# Brief: Reel Rentals

A film equipment rental house: items with serials and a condition, bookings for date ranges, a workshop queue. Dense, desk-first.

## Machine block

```json mistri-brief
{
  "app": {
    "name": "Reel Rentals",
    "theme": "graphite",
    "logo": "camera"
  },
  "entities": {
    "category": {
      "name": "text! unique"
    },
    "item": {
      "name": "text!",
      "serial": "text! unique",
      "category": "ref category!",
      "condition": "choice good|worn|damaged =good",
      "daily_rate": "money!",
      "status": "choice available|out|workshop|retired =available"
    },
    "crew": {
      "name": "text!",
      "email": "email! unique",
      "phone": "phone"
    },
    "booking": {
      "crew": "ref crew!",
      "starts_on": "date!",
      "ends_on": "date!",
      "status": "choice requested|confirmed|out|returned|cancelled =requested",
      "note": "longtext"
    },
    "booking_item": {
      "booking": "ref booking!",
      "item": "ref item!"
    },
    "repair": {
      "item": "ref item!",
      "fault": "longtext!",
      "status": "choice reported|in_progress|done =reported",
      "cost": "money"
    },
    "tech": {
      "name": "text!",
      "email": "email! unique"
    }
  },
  "roles": {
    "manager": {
      "label": "Manager",
      "read": true,
      "write": true,
      "commands": [
        "confirmBooking",
        "checkOut",
        "checkIn",
        "cancelBooking",
        "sendToWorkshop"
      ]
    },
    "counter": {
      "label": "Counter",
      "read": true,
      "write": [
        "crew",
        "booking"
      ],
      "commands": [
        "checkOut",
        "checkIn"
      ]
    },
    "workshop": {
      "label": "Workshop",
      "read": [
        "item",
        "repair",
        "category"
      ],
      "write": [
        "repair"
      ],
      "commands": []
    }
  },
  "commands": [
    {
      "id": "confirmBooking",
      "on": "booking",
      "label": "Confirm",
      "when": "status = requested",
      "set": {
        "status": "confirmed"
      },
      "refuse": [
        "an item is already booked for those days"
      ]
    },
    {
      "id": "checkOut",
      "on": "booking",
      "label": "Check out",
      "when": "status = confirmed",
      "set": {
        "status": "out"
      },
      "refuse": []
    },
    {
      "id": "checkIn",
      "on": "booking",
      "label": "Check in",
      "when": "status = out",
      "set": {
        "status": "returned"
      },
      "refuse": []
    },
    {
      "id": "cancelBooking",
      "on": "booking",
      "label": "Cancel",
      "when": "status = requested or status = confirmed",
      "set": {
        "status": "cancelled"
      },
      "refuse": [
        "no reason given"
      ]
    },
    {
      "id": "sendToWorkshop",
      "on": "item",
      "label": "Send to workshop",
      "when": "status = available",
      "set": {
        "status": "workshop"
      },
      "refuse": []
    }
  ]
}
```

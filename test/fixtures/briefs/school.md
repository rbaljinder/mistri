# Brief: Maple Street Music School

A music school: courses, enrollments, a profile per student (unique reference). A name longer than a phone bar holds.

## Machine block

```json mistri-brief
{
  "app": {
    "name": "Maple Street Music School",
    "theme": "bloom",
    "logo": "heart"
  },
  "entities": {
    "teacher": {
      "name": "text!",
      "email": "email! unique",
      "instrument": "text"
    },
    "student": {
      "name": "text!",
      "guardian_email": "email!",
      "born_on": "date",
      "level": "choice beginner|intermediate|advanced =beginner"
    },
    "course": {
      "title": "text! unique",
      "teacher": "ref teacher!",
      "weekday": "choice mon|tue|wed|thu|fri|sat",
      "fee": "money!",
      "seats": "int! =8"
    },
    "enrollment": {
      "student": "ref student!",
      "course": "ref course!",
      "status": "choice applied|enrolled|withdrawn =applied",
      "enrolled_on": "date",
      "paid": "bool =false"
    },
    "profile": {
      "student": "ref student! unique",
      "allergies": "longtext",
      "pickup_person": "text"
    }
  },
  "roles": {
    "office": {
      "label": "Office",
      "read": true,
      "write": true,
      "commands": [
        "enroll",
        "withdraw",
        "markPaid"
      ]
    },
    "teacher": {
      "label": "Teacher",
      "read": [
        "course",
        "enrollment",
        "student"
      ],
      "write": [],
      "commands": []
    }
  },
  "commands": [
    {
      "id": "enroll",
      "on": "enrollment",
      "label": "Enroll",
      "when": "status = applied",
      "set": {
        "status": "enrolled"
      },
      "refuse": [
        "the course is full"
      ]
    },
    {
      "id": "withdraw",
      "on": "enrollment",
      "label": "Withdraw",
      "when": "status = enrolled",
      "set": {
        "status": "withdrawn"
      },
      "refuse": []
    },
    {
      "id": "markPaid",
      "on": "enrollment",
      "label": "Mark paid",
      "set": {
        "paid": "1"
      },
      "refuse": []
    }
  ]
}
```

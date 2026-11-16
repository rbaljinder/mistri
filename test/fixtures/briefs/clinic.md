# Brief: Stillwater Physio

Status: approved by the clinic owner (answered by the building agent on the customer's behalf, non-interactive session) on 2026-11-15

## What I heard

- **Purpose:** One place for a two-site physiotherapy clinic to book and run appointments, and for patients to follow their own care from a phone.
- **People and roles:** Reception (books, reschedules, checks in, cancels, answers patients' requests, keeps patient details); therapists (see their own day, write a short visit note, complete a visit); patients (see only their own appointments and details, ask to reschedule or cancel, fill in an intake form before the first visit). An admin manages accounts.
- **Tenancy:** one organization (two sites are rows, not tenants).
- **Domain:** sites; therapists (each based at a site); patients; appointments (a patient with a therapist at a site at a time: booked → checked in → completed, or cancelled / no-show); visit notes (one short note per completed visit, by the therapist); change requests (a patient asks to reschedule or cancel an appointment: pending → approved / declined); intake forms (one per patient before the first visit).
- **Rules and journeys:** A patient never sees another patient's rows. A patient cannot change an appointment directly, only ask; reception decides. A request is refused for an appointment that is not the patient's, is in the past, or is already cancelled or completed. A visit note is written only by the therapist of that appointment (or reception never). Journeys: (1) reception books an appointment, checks the patient in; (2) therapist opens their day, completes the visit with a note; (3) patient signs in on a phone, sees upcoming visits, asks to reschedule, fills intake.
- **Data:** new, SQLite, no imports, believable sample data.
- **Outside world:** none signed out (patients sign in; reception creates their record first). No email/SMS in this build (assumed).
- **Look and feel:** calm and trustworthy; Sage (people, care, scheduling: soft cards, a calmer page) in the teal palette; phone is the patients' main device; dark mode works.
- **Locale:** English (en-US), USD not used (no money), America/Denver (assumed).

Assumed, not asked: clinical notes are short free text, not a medical record system; no payments or insurance; no reminders by SMS/email; patients do not self-book (they ask, reception books); patient accounts are matched to their patient row by email.

## What I will build

**Schema**

- site: name, address, phone
- therapist: name, email, specialty, site; active
- patient: name, email, phone, date of birth, address, emergency contact name and phone, preferred site
- appointment: patient, therapist, site, starts at, minutes, kind (initial assessment | follow-up | review), reason, status booked → checked_in → completed | cancelled | no_show
- visit_note: appointment, therapist, summary, plan, written at
- change_request: appointment, patient, kind (reschedule | cancel), preferred time (words), reason, status pending → approved | declined, reply
- intake_form: patient, main complaint, pain level 0-10, since when, medical history, medications, allergies, consent, submitted at

**Screens**

Reception: Today (figures: today's visits, checked in, waiting requests; today's schedule; pending requests) · Appointments (tabs Today / Upcoming / Past / Cancelled / All, New) · Calendar · Requests (queue) · Patients (list, record with appointments, intake, requests) · Setup folded (therapists, sites).
Therapist: My day (today's visits, mine) · My appointments · appointment page with Write visit note / Complete.
Patient (phone): Home (next visit, upcoming, intake reminder) · My appointments (Upcoming / Past) · appointment page with Ask to reschedule / Ask to cancel · Intake form · My details.

**Commands**

- Ask to reschedule / Ask to cancel on appointment, where status = booked: writes a pending change request. Refuses: not your appointment; already started; a request is already pending.
- Approve request / Decline request on change request, where pending. Approve of a cancel cancels the appointment; of a reschedule moves it to the time reception gives. Refuses: appointment no longer booked.
- Write visit note on appointment, where checked in or completed: adds the note and completes the visit. Refuses: not the appointment's therapist; empty summary.
- Submit intake: writes the patient's intake form. Refuses: no consent; already submitted.
- Update my details: a patient changes their own phone, address and emergency contact.

**Roles and access**

| Role | Reads | Writes | Runs |
| --- | --- | --- | --- |
| reception | all but visit notes' text | patient, appointment | approve/decline request |
| therapist | all | — | write visit note |
| patient | own rows only (row policy) | — | ask to reschedule/cancel, submit intake, update my details |
| admin | all | all reception writes, sites, therapists | all desk commands |

**Theme direction:** Sage with the teal palette, comfortable density; it should feel like a quiet waiting room, not a console.

**Not in this build:** reminders by email/SMS, payments, self-booking into free slots, public (signed-out) pages.

## Machine block

```json mistri-brief
{
  "app": { "name": "Stillwater Physio", "theme": "sage", "logo": "heart" },
  "entities": {
    "site": { "name": "text! unique", "address": "text", "phone": "phone" },
    "therapist": { "name": "text!", "email": "email! unique", "specialty": "text", "site": "ref site!", "active": "bool =true" },
    "patient": {
      "name": "text!", "email": "email! unique", "phone": "phone", "date_of_birth": "date", "address": "text",
      "emergency_contact": "text", "emergency_phone": "phone", "site": "ref site"
    },
    "appointment": {
      "patient": "ref patient!", "therapist": "ref therapist!", "site": "ref site!",
      "starts_at": "datetime!", "minutes": "int! =45",
      "kind": "choice initial|follow_up|review =follow_up",
      "reason": "text",
      "status": "choice booked|checked_in|completed|cancelled|no_show =booked"
    },
    "visit_note": { "appointment": "ref appointment!", "therapist": "ref therapist!", "summary": "longtext!", "plan": "longtext", "written_at": "datetime!" },
    "change_request": {
      "appointment": "ref appointment!", "patient": "ref patient!",
      "kind": "choice reschedule|cancel =reschedule", "preferred_time": "text", "reason": "longtext",
      "status": "choice pending|approved|declined =pending", "reply": "text", "requested_at": "datetime!"
    },
    "intake_form": {
      "patient": "ref patient! unique", "complaint": "longtext!", "pain_level": "int", "since": "text",
      "history": "longtext", "medications": "text", "allergies": "text", "consent": "bool", "submitted_at": "datetime!"
    }
  },
  "roles": {
    "reception": { "label": "Reception", "read": true, "write": ["patient", "appointment"], "commands": ["approveRequest", "declineRequest"] },
    "therapist": { "label": "Therapist", "read": true, "write": [], "commands": ["writeVisitNote"] },
    "patient": { "label": "Patient", "read": ["site", "therapist", "patient", "appointment", "change_request", "intake_form"], "write": [], "commands": ["askReschedule", "askCancel", "submitIntake", "updateMyDetails"] },
    "admin": { "label": "Admin", "read": true, "write": true, "commands": ["approveRequest", "declineRequest"] }
  },
  "commands": [
    { "id": "askReschedule", "on": "appointment", "label": "Ask to reschedule", "when": "status = booked", "set": {}, "refuse": ["It is not your appointment", "It has already started", "A request is already waiting"] },
    { "id": "askCancel", "on": "appointment", "label": "Ask to cancel", "when": "status = booked", "set": {}, "refuse": ["It is not your appointment", "It has already started", "A request is already waiting"] },
    { "id": "approveRequest", "on": "change_request", "label": "Approve request", "when": "status = pending", "set": { "status": "approved" }, "refuse": ["The appointment is no longer booked"] },
    { "id": "declineRequest", "on": "change_request", "label": "Decline request", "when": "status = pending", "set": { "status": "declined" }, "refuse": [] },
    { "id": "writeVisitNote", "on": "appointment", "label": "Write visit note", "when": "status = checked_in", "set": { "status": "completed" }, "refuse": ["You are not this appointment's therapist"] },
    { "id": "submitIntake", "on": "patient", "label": "Submit intake", "set": {}, "refuse": ["Consent is needed", "Already submitted"] },
    { "id": "updateMyDetails", "on": "patient", "label": "Update my details", "set": {}, "refuse": ["It is not your record"] }
  ]
}
```

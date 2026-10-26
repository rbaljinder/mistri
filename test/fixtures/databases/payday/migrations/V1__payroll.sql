-- Payroll for one company: departments and people, pay runs and their statements,
-- time off, timesheets, benefits, documents and onboarding.
CREATE TABLE department(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, cost_center TEXT NOT NULL, lead_id INTEGER REFERENCES employee(id));
CREATE TABLE employee(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, department_id INTEGER NOT NULL REFERENCES department(id), title TEXT NOT NULL, location TEXT NOT NULL, employment_status TEXT NOT NULL CHECK(employment_status IN ('onboarding','active','leave','inactive')), start_date DATE NOT NULL, pay_type TEXT NOT NULL CHECK(pay_type IN ('salary','hourly')), salary INTEGER, pay_rate INTEGER, manager_id INTEGER REFERENCES employee(id), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pay_run(id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, title TEXT NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL, run_by DATE NOT NULL, pay_date DATE NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','review','approved','paid')), employee_count INTEGER NOT NULL, gross_total INTEGER NOT NULL, employee_taxes INTEGER NOT NULL, deductions_total INTEGER NOT NULL, net_total INTEGER NOT NULL, employer_taxes INTEGER NOT NULL, approved_by TEXT, approved_at TIMESTAMP, approval_note TEXT, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pay_stub(id INTEGER PRIMARY KEY, pay_run_id INTEGER NOT NULL REFERENCES pay_run(id), employee_id INTEGER NOT NULL REFERENCES employee(id), pay_date DATE NOT NULL, regular_hours NUMERIC, overtime_hours NUMERIC, bonus INTEGER NOT NULL, gross INTEGER NOT NULL, federal_tax INTEGER NOT NULL, state_tax INTEGER NOT NULL, social_security INTEGER NOT NULL, medicare INTEGER NOT NULL, benefits INTEGER NOT NULL, retirement INTEGER NOT NULL, net INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','pending','paid')));
CREATE TABLE time_off_policy(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, accrual TEXT NOT NULL, annual_hours INTEGER NOT NULL, carryover_hours INTEGER NOT NULL, paid BOOLEAN NOT NULL);
CREATE TABLE time_off_balance(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), policy_id INTEGER NOT NULL REFERENCES time_off_policy(id), accrued_hours NUMERIC NOT NULL, used_hours NUMERIC NOT NULL, available_hours NUMERIC NOT NULL, UNIQUE(employee_id, policy_id));
CREATE TABLE time_off(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), policy_id INTEGER NOT NULL REFERENCES time_off_policy(id), start_date DATE NOT NULL, end_date DATE NOT NULL, hours NUMERIC NOT NULL CHECK(hours > 0), status TEXT NOT NULL CHECK(status IN ('pending','approved','declined')), note TEXT, decision_note TEXT, version INTEGER NOT NULL DEFAULT 0, CHECK(end_date >= start_date));
CREATE TABLE timesheet(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), week_start DATE NOT NULL, week_end DATE NOT NULL, regular_hours NUMERIC NOT NULL, overtime_hours NUMERIC NOT NULL, total_hours NUMERIC NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','submitted','approved')), submitted_on DATE, approved_by TEXT, approved_at TIMESTAMP, version INTEGER NOT NULL DEFAULT 0, UNIQUE(employee_id, week_start));
CREATE TABLE time_entry(id INTEGER PRIMARY KEY, timesheet_id INTEGER NOT NULL REFERENCES timesheet(id), work_date DATE NOT NULL, hours NUMERIC NOT NULL, note TEXT);
CREATE TABLE benefit_plan(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, carrier TEXT NOT NULL, summary TEXT NOT NULL, employee_cost INTEGER, employer_cost INTEGER);
CREATE TABLE benefit(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), plan_id INTEGER NOT NULL REFERENCES benefit_plan(id), coverage TEXT, status TEXT NOT NULL CHECK(status IN ('enrolled','pending','waived')), enrolled_on DATE NOT NULL, employee_cost INTEGER NOT NULL, employer_cost INTEGER NOT NULL);
CREATE TABLE document(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), title TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','signed')), requested_on DATE NOT NULL, due_date DATE, signed_on DATE, reminded_on DATE, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE onboarding_task(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id), title TEXT NOT NULL, category TEXT NOT NULL, due_date DATE NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','done')));
CREATE TABLE company(id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, legal_name TEXT NOT NULL, ein TEXT NOT NULL, address TEXT NOT NULL, pay_schedule TEXT NOT NULL CHECK(pay_schedule IN ('weekly','biweekly','semimonthly','monthly')), payroll_contact TEXT NOT NULL, overtime_after_hours INTEGER NOT NULL CHECK(overtime_after_hours > 0), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE company_event(id INTEGER PRIMARY KEY, event_date DATE NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('anniversary','first_day','holiday')), title TEXT NOT NULL, employee_id INTEGER REFERENCES employee(id));
-- The references a record's lists find their rows by (mistri check names each).
CREATE INDEX employee_manager ON employee(manager_id);
CREATE INDEX employee_department ON employee(department_id);
CREATE INDEX pay_stub_employee ON pay_stub(employee_id);
CREATE INDEX pay_stub_pay_run ON pay_stub(pay_run_id);
CREATE INDEX time_off_employee ON time_off(employee_id);
CREATE INDEX time_off_by_policy ON time_off(policy_id);
CREATE INDEX time_off_balance_policy ON time_off_balance(policy_id);
CREATE INDEX time_entry_timesheet ON time_entry(timesheet_id);
CREATE INDEX benefit_employee ON benefit(employee_id);
CREATE INDEX benefit_by_plan ON benefit(plan_id);
CREATE INDEX document_employee ON document(employee_id);
CREATE INDEX onboarding_task_employee ON onboarding_task(employee_id);

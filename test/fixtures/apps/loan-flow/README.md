# loan-flow

A fixture for durable workflows (test/workflow-host.test.ts): a signed
delivery applies for a loan, the fact `loan.applied` starts the `loan`
workflow, and the workflow waits a second and approves it. The App's
`app.json`, database and connection file are written by the test beside its
own temporary directory; only the modules that must import `tablewalk` live
here.

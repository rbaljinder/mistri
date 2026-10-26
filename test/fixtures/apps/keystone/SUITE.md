# Keystone suite contract

Keystone is one example project with six apps over one PostgreSQL business
database. All data is synthetic. No credit is offered, bureau consulted or
money moved. [Setup and launch](README.md) is the executable starting point;
[database setup](../../databases/keystone/README.md) describes its fixtures.

| App | Mount | Readers and authority |
| --- | --- | --- |
| Lender | `/` | Invited lender staff, with role grants and column ceilings |
| Leads | `/leads` | Dealer tenants; platform staff and service principals in a separate realm |
| Dealer | `/dealer` | Owners and managers, scoped to their dealerships by a row policy |
| Site | `/site` | Public catalog and inquiry forms for one configured dealership |
| Marketplace | `/marketplace` | Public browsing; account-owned shortlist and inquiries |
| Customer | `/customer` | Invited borrowers, scoped to their own loans and related records |

## Mounting and sign-in

The `start-suite.mjs` launcher runs one Tablewalk process and listener, with
Lender at the root and five mounted Apps. A suite-owned account store and cookie
provide one sign-in. A separate persisted ledger grants roles per App by stable
account ID; the native account role and email grant no App access. Operator
setup explicitly bootstraps each App's administrator. App administrators can
then issue subject-bound, one-time App invitations through the suite interface.
The chooser reveals granted Apps; sign-out from any mount invalidates the one
session everywhere. The suite's `landing` rules send lender staff to Lender,
dealership staff with a Leads membership to the lead desk, managers to Dealer
and borrowers to Customer; a page of an App the account was not granted opens
the chooser, never that App.

Dealer staff retain separate `dealer_user.account_id` (Leads) and
`dealer_user.dealer_account_id` (Dealer) business bindings, populated explicitly
with the shared account ID. Tenant memberships and policy grants remain local
to their App. Lender authority never implies Leads authority. Leads' tenant
invitations grant membership after the recipient has suite App access.

The lead desk supplies a tenant policy, commands and jobs. Dealer, marketplace
and customer supply row policies over their captured App connections. The public manifest contains no
server handlers or secrets. Mutable configuration and authentication stores
stay outside these source directories.

## A deal through the apps

1. A visitor sends an inquiry from the site or marketplace, or starts the
   lead desk’s saved application through a dealer’s intake address.
2. Dealer staff work the lead, record an applicant and compare deal structures.
   Submission creates the lender’s application and schedules its decision clock.
3. Lender staff underwrite, decide, clear conditions, audit and fund the loan.
4. Borrowers view the funded loan in the customer portal. Their scheduled
   payments stay pending until lender servicing posts them.
5. Dealer managers maintain listings, branding and team membership from the
   settings app. Those records are the same business data the other apps use.

Each command is defined once on the server and named by string in the app.
Generated command declarations type those names. Role grants, tenant membership,
row policies and transaction checks enforce access; list filters and action
visibility do not substitute for them. Ordinary field edits have explicit
ceilings; publication and listing changes use commands that set their own dates.

## Demonstration boundaries

- The suite explicitly shares authentication; sharing a business database alone
  grants nothing and does not make a transaction span Apps or databases. Ignition’s separate platform-only source
  remains a regression fixture; Keystone does not reproduce that topology.
- The dealer site has a configured dealership and look. It does not select a
  tenant or brand from an arbitrary hostname.
- Public lists filter the catalog, but public read grants still apply to the
  granted columns of records reached directly. Public columns contain no
  private applicant or lender information.
- Dealer business status and tenant membership status are separate records.
  A deployment coordinates tenant suspension through its maintenance tools.
- The example does not add tenant document uploads, payment processing,
  email delivery or dynamic host branding. Tenant API declarations do not mount
  a bearer transport in the suite launcher.

The six apps are independently checked against their own schema and command
declarations. Their explicit accounts, App grants and tenant stores are
provisioned before startup. Setup refuses an existing database or runtime;
restart preserves the provisioned identity and grants.

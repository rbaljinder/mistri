<img src="mark.svg" alt="mistri" width="48" height="48" />

# @mistriwork/engine

The engine both products stand on: the adapters (SQLite, Postgres, MySQL), the
catalog, the query language, keyset pages, the HTTP kit and the shared rules.
No React.

It is a layer of [mistri](https://mistriwork.dev), published so the App
framework and the database browser (`tablewalk`) install the same engine. Install
`tablewalk` or `mistri`; this package comes with either. The source and the
import boundary it keeps are in
[the repository](https://github.com/rbaljinder/mistri/tree/main/packages/engine).

This package is internal plumbing for `mistri` and `tablewalk`, with no semver
promise to an App's author: its `exports` name each module those two import,
and any of them may change or go in any release. An App imports `mistri`'s
names (or `tablewalk`'s), never these.

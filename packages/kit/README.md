<img src="mark.svg" alt="mistri" width="48" height="48" />

# @mistriwork/kit

The shared React client both shells, mistri's and tablewalk's, are drawn with:
the walk and the address, Grid, Value, the record page, lists, filters and
charts. Its `dist/client` is the page the server sends.

It is a layer of [mistri](https://mistriwork.dev), published so the App
framework and the database browser (`tablewalk`) serve the same client. Install
`tablewalk` or `mistri`; this package comes with either.
[Source](https://github.com/rbaljinder/mistri/tree/main/packages/kit).

This package is internal plumbing for `mistri` and `tablewalk`, with no semver
promise to an App's author: its `exports` name each module those two import,
and any of them may change or go in any release. An App imports `mistri`'s
names (or `tablewalk`'s), never these.

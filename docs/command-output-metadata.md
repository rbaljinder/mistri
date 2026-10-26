# Internal command output metadata

`commandShapes.ts` records an immutable descriptor alongside each built-in
output parser. `describeShape()` is internal, not a new package export. Command
registration preserves that metadata while retaining its synchronous-result
guard. Introspection runs no handler, validator or application parser and reads
no properties from an unknown parser.

Provenance is tracked in a process-local WeakMap shared by source and emitted
builder copies through a versioned global symbol. Arbitrary `{ parse }` objects,
including ones with an attached descriptor property or symbol, remain opaque.
This is trusted-code bookkeeping, not a sandbox against code deliberately
tampering with process globals. Only builders create metadata; registration
transfers existing provenance to its guard wrapper.

The vocabulary is deliberately not JSON Schema:

- Integers include safe-integer bounds; IDs narrow these to positive values.
  Finite numbers retain authored bounds.
- Text records UTF-16 code-unit length and regexp source plus effective flags
  (`g` and `y` are removed, matching the parser). A future exporter must not
  translate these blindly to JSON Schema `maxLength` or a flagless pattern.
- Dates record the existing parser's four-digit Gregorian range, including
  year 0000. This slice does not change date validation or add a wire codec.
- Optional and nullable wrappers remain distinct, including at nested positions.
  Undefined is not JSON null; future publication must check where optional
  values can occur rather than merely deleting them from a required-key list.
- `oneOf()` produces `anyOf` metadata with `first-match` selection: overlapping
  alternatives are valid and the first parser's projection wins. It is not
  exclusive JSON Schema `oneOf`.
- Objects record declared-key projection; undeclared input keys are dropped,
  not refused. Output schemas must describe the projected result, not pretend
  to be an exact input acceptance schema.
- Opaque children remain visible in composite metadata. `hasOpaqueShape()`
  detects them; a future publication gate must refuse these graphs. This is
  necessary, not sufficient, for publication: JSON representability still
  needs its own checks.

Numeric/list options, text constraints and regexp values are captured when the
builder is created, consistently with the descriptor. Later mutation of an
options object no longer changes a registered parser. Existing unusual runtime
declarations that cannot be faithfully described as JSON (nonfinite bounds or
literals, negative-zero literals, and the legacy special `__proto__` object key)
remain runnable but receive opaque metadata rather than fabricated guarantees.

Tests cover immutable snapshots, optional/null/composite values, overlap,
registration without execution and a separately compiled builder copy. These
are metadata foundations only: no OpenAPI exporter or network route is added.

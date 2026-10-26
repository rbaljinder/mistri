/** The intake fixture's dealer addresses (support/tenantIntakeFixture.ts), shared
 * with its spec without importing the fixture's server modules. A deployment's
 * are random; these are fixed so the spec can publish a dealer's link. */
export const INTAKE_ADDRESSES = Object.freeze({
  north: 'north-intake-AAAAAAAAAAAAAAAA',
  south: 'south-intake-BBBBBBBBBBBBBBBB',
});

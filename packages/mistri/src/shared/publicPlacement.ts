/** Public transport metadata. The opaque binding is never a form answer. */
export interface PublicFormPlacement {
  readonly version: 1;
  readonly binding: string;
  readonly submission: string;
  readonly expiresAt: string;
  readonly recoverUntil: string;
  readonly recoveryUrl: string;
}

/** Published navigation contract. Suite startup checks it against the deployed
 * lender; importing either App's generated command registry here would merge
 * independent per-App registries in the source App's TypeScript program. */
export declare const lender: {
  readonly id: 'lender';
  readonly resources: { readonly loan_application: unknown };
};

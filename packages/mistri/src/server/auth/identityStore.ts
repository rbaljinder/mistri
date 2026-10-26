/**
 * The tables an App's auth store holds for federated identity, declared as a
 * Better Auth plugin schema so the file store gets them from Better Auth's own
 * migration and the PostgreSQL store's pinned layout is exactly what that
 * migration would plan (postgresAuthStore.ts).
 *
 * Always present, whether or not an App configures an identity provider or a
 * directory, and whether or not the optional packages are installed: the
 * store's layout is a fact of the mistri version, never of configuration.
 *
 * - `idpSession`: which identity provider's session a mistri session came
 *   from (an OIDC `sid`, a SAML SessionIndex), so a provider's back-channel
 *   logout can find the sessions it ends (backchannelLogout.ts).
 * - The seven SCIM tables are @better-auth/scim 1.7.10's own schema, field for
 *   field, declared here so a plugin release can never move the layout:
 *   test/identity-store.test.ts holds them equal to that version's export.
 */

const string = (required: boolean, extra: Record<string, unknown> = {}) => ({ type: 'string', required, ...extra }) as const;
const date = (required: boolean, extra: Record<string, unknown> = {}) => ({ type: 'date', required, ...extra }) as const;
const number = (extra: Record<string, unknown> = {}) => ({ type: 'number', required: true, ...extra }) as const;
const user = { references: { model: 'user', field: 'id' } };
const hidden = { returned: false };

/** The session index back-channel logout reads. Ends with its session (`on delete cascade`). */
const IDP_SESSION = {
  idpSession: {
    fields: {
      sessionId: string(true, { input: false, index: true, references: { model: 'session', field: 'id', onDelete: 'cascade' } }),
      provider: string(true, { input: false }),
      issuer: string(true, { input: false }),
      subject: string(true, { input: false, index: true }),
      sid: string(false, { input: false, index: true }),
      sessionIndex: string(false, { input: false }),
      createdAt: date(true, { input: false }),
    },
  },
};

/** @better-auth/scim 1.7.10's schema, in its own order (its `scim(...).schema`). */
const SCIM = {
  scimConnectionBinding: {
    fields: {
      connectionId: string(true, { index: true }),
      connectionKey: string(true, { unique: true, ...hidden }),
      provisioningDomainId: string(true),
      createdAt: date(true),
      decommissionedAt: date(false),
      decommissionStatus: string(true, { defaultValue: 'active' }),
      decommissionCursorUserId: string(false, hidden),
      decommissionReconciledUserCount: number({ defaultValue: 0 }),
      decommissionBatchCount: number({ defaultValue: 0 }),
      decommissionRevision: number({ defaultValue: 0, ...hidden }),
      decommissionCompletedAt: date(false),
      decommissionLeaseId: string(false, hidden),
      decommissionLeaseExpiresAt: date(false, hidden),
    },
  },
  scimIdentityTombstone: {
    fields: {
      connectionId: string(true, { index: true }),
      provisioningDomainId: string(true, { index: true }),
      externalId: string(true),
      externalIdKey: string(true, { unique: true, ...hidden }),
      userId: string(true, { index: true, ...user }),
      profile: string(true),
      deletedAt: date(true),
    },
  },
  scimSubject: {
    fields: {
      userId: string(true, { unique: true, ...user }),
      profileSourceId: string(false, { index: true }),
      revision: number(),
      createdAt: date(true),
      updatedAt: date(true),
    },
  },
  scimUser: {
    fields: {
      connectionId: string(true, { index: true }),
      provisioningDomainId: string(true, { index: true }),
      userId: string(true, { index: true, ...user }),
      connectionUserKey: string(true, { unique: true, ...hidden }),
      userName: string(true),
      userNameKey: string(true, { unique: true, ...hidden }),
      primaryEmail: string(true),
      workEmailValueIndex: string(true, hidden),
      emailValueIndex: string(true, hidden),
      displayName: string(true),
      formattedName: string(true),
      givenName: string(false),
      familyName: string(false),
      serializedEmails: string(true, hidden),
      serializedAttributes: string(false, hidden),
      externalId: string(false),
      externalIdKey: string(false, { unique: true, ...hidden }),
      active: { type: 'boolean', required: true },
      orderKey: string(true, { unique: true, ...hidden }),
      createdAt: date(true),
      updatedAt: date(true),
    },
  },
  scimProjectionGrant: {
    fields: {
      connectionId: string(true, { index: true }),
      provisioningDomainId: string(true, { index: true }),
      scimUserId: string(true, { index: true, references: { model: 'scimUser', field: 'id' } }),
      userId: string(true, { index: true, ...user }),
      sourceKind: string(true),
      sourceId: string(true),
      sourceValue: string(false),
      role: string(true),
      grantKey: string(true, { unique: true, ...hidden }),
      createdAt: date(true),
      updatedAt: date(true),
    },
  },
  scimGroup: {
    fields: {
      connectionId: string(true, { index: true }),
      provisioningDomainId: string(true, { index: true }),
      revision: number({ defaultValue: 0, ...hidden }),
      displayName: string(true),
      displayNameKey: string(true, { unique: true, ...hidden }),
      externalId: string(false),
      externalIdKey: string(false, { unique: true, ...hidden }),
      orderKey: string(true, { unique: true, ...hidden }),
      createdAt: date(true),
      updatedAt: date(true),
    },
  },
  scimGroupMember: {
    fields: {
      connectionId: string(true, { index: true }),
      groupId: string(true, { index: true, references: { model: 'scimGroup', field: 'id' } }),
      scimUserId: string(true, { index: true, references: { model: 'scimUser', field: 'id' } }),
      membershipKey: string(true, { unique: true, ...hidden }),
      createdAt: date(true),
    },
  },
};

/** The SCIM tables alone, for the equality test against the plugin's export. */
export const SCIM_DIRECTORY_SCHEMA = SCIM;
export const IDP_SESSION_MODEL = 'idpSession';

const IDENTITY_STORE_SCHEMA = { ...IDP_SESSION, ...SCIM };

/** The Better Auth plugin that declares the tables. It adds no endpoint and no hook. */
export const identityStorePlugin = () => ({ id: 'mistri-identity-store', schema: IDENTITY_STORE_SCHEMA });

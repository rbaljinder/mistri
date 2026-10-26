/* The most commands one App registers, and so the most command ids a policy's
   resultReferences names (one extractor per registered command). A bound
   against a hostile or runaway declaration, read once at start; nothing per
   request scales with it, since a command is looked up by id. It was 256 in
   the tenant enrollment, which a desk App with a service desk, a CRM and a
   sales setup passed (a field report reached 260), then 1024 in the policies alone.
   One number now, for the registry and both policies, at sixteen times the
   largest App written so far: a startup that checks four thousand
   definitions still takes well under a second. The 256 on a command id's
   *length*, and on roles or tables, is a different bound. */
export const MAX_COMMAND_IDS = 4096;

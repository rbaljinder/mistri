/** The article a generated sentence puts before a table's name: "an invoice record", "a customer record". Its own
    module because both test generators use it and testInit.ts already loads testInitTenant.ts. */
export const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

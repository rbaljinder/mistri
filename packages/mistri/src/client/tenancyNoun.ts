/**
 * What the App calls a tenant (`auth.tenancy.label`, "Customer"), in the
 * forms a sentence needs: "Customer:", "enter the customer", "customers",
 * and whether "an" goes before it. `fallback` is the platform's own word, in
 * the reader's language, for an App that names none. English plurals, which
 * is what the words around them are: dealers, agencies, branches. One
 * rule for every tenancy surface: the chooser, Enter and its dialog.
 */
export function tenancyNoun(label: string | undefined, fallback: string): { Name: string; name: string; names: string; vowel: boolean } {
  const Name = label ?? `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)}`;
  const name = Name.toLowerCase();
  const names = /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
  return { Name, name, names, vowel: /^[aeiou]/i.test(name) };
}

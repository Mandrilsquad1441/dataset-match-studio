const NAME_FIELDS = [
  "name", "displayname", "recordname", "entityname", "companyname", "businessname",
  "organizationname", "organisationname", "itemname", "productname", "fullname",
  "customername", "accountname", "clientname", "personname", "contactname",
  "legalname", "tradename", "title", "label", "company", "entity", "product",
  "item", "business", "organization", "organisation",
] as const;

/** Suggest a name column without treating metadata such as company_type as a name. */
export function inferNameField(headers: readonly string[]): string {
  const normalized = headers.map((header) => header.normalize("NFKC").toLowerCase().replace(/[\s_.-]+/g, ""));
  for (const alias of NAME_FIELDS) {
    const index = normalized.indexOf(alias);
    if (index !== -1) return headers[index];
  }
  return headers[0] ?? "";
}

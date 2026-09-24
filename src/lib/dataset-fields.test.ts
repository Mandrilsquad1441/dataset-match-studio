import { describe, expect, it } from "vitest";
import { inferNameField } from "./dataset-fields";

describe("inferNameField", () => {
  it("selects company_name from the shuffled Case 1 incoming headers", () => {
    const headers = [
      "city", "region", "payment_terms", "currency", "status", "company_type",
      "customer_since", "founded", "revenue_band", "language", "registration_id",
      "company_name", "employee_band", "branch_code", "import_batch", "time_zone",
      "contract_type", "phone", "notes", "last_verified", "customer_tier", "renewal_month",
      "source_key", "credit_grade", "segment", "account_owner", "email", "website",
      "legacy_account_id", "country", "industry", "account_status", "updated_at",
      "preferred_channel", "legal_name", "crm_system", "shipping_country", "sales_region",
      "support_tier", "parent_name", "suite", "compliance_status", "tax_id", "building",
      "street", "postal_code", "vat_status", "trade_name", "billing_country", "risk_rating",
    ];
    expect(headers.indexOf("company_type")).toBeLessThan(headers.indexOf("company_name"));
    expect(inferNameField(headers)).toBe("company_name");
  });

  it.each([
    "name", "display_name", "Company Name", "itemName", "product_name", "Full Name",
    "entity.name", " record-name ", "CustomerName", "BUSINESS_NAME", "organisation_name",
  ])("recognizes %s and returns its original spelling", (header) => {
    expect(inferNameField(["id", "company_type", "product_category", header])).toBe(header);
  });

  it("prefers an explicit name over title, label and bare entity fields", () => {
    expect(inferNameField(["company", "title", "label", "display_name"])).toBe("display_name");
    expect(inferNameField(["legal_name", "trade_name", "company_name"])).toBe("company_name");
    expect(inferNameField(["company_name", "name"])).toBe("name");
  });

  it.each(["title", "label"])("uses generic %s before bare entity fields", (header) => {
    expect(inferNameField(["company_type", "company", header])).toBe(header);
  });

  it.each(["company", "entity", "product", "item"])("uses an exact %s fallback", (header) => {
    expect(inferNameField(["source_key", `${header}_type`, header])).toBe(header);
  });

  it("does not infer a name from partial words or metadata", () => {
    expect(inferNameField(["source_key", "company_type", "product_category", "entity_id", "filename", "username", "parent_name"])).toBe("source_key");
  });

  it("preserves the first header as the final fallback and handles no headers", () => {
    expect(inferNameField(["SKU", "description", "price"])).toBe("SKU");
    expect(inferNameField([])).toBe("");
  });

  it("does not mutate headers and keeps the first equivalent name", () => {
    const headers = Object.freeze(["id", "Company Name", "company_name"]);
    expect(inferNameField(headers)).toBe("Company Name");
    expect(headers).toEqual(["id", "Company Name", "company_name"]);
  });
});

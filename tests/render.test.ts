import { describe, expect, it } from "vitest";
import { buildRowsTableHtml, buildRowsText, frenchDate, render } from "../src/lib/render.js";

describe("render", () => {
  it("substitutes {{var}} and tolerates inner whitespace", () => {
    expect(render("Bonjour {{nom}}, {{ ville }}", { nom: "Rani", ville: "Bordeaux" }, { escape: false }).output).toBe(
      "Bonjour Rani, Bordeaux",
    );
  });

  it("escapes HTML in {{var}} but not in {{{var}}}", () => {
    const vars = { x: '<b>"a" & \'b\'</b>' };
    expect(render("{{x}}", vars, { escape: true }).output).toBe(
      "&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;",
    );
    expect(render("{{{x}}}", vars, { escape: true }).output).toBe('<b>"a" & \'b\'</b>');
  });

  it("leaves text bodies literal in both forms", () => {
    const vars = { x: "<tag>" };
    expect(render("{{x}} {{{x}}}", vars, { escape: false }).output).toBe("<tag> <tag>");
  });

  it("blanks unknown or null variables and reports them", () => {
    const result = render("[{{a}}][{{b}}][{{c}}]", { a: "ok", b: null }, { escape: false });
    expect(result.output).toBe("[ok][][]");
    expect(result.missing).toEqual(["b", "c"]);
  });

  it("renders numbers and zero rather than treating them as absent", () => {
    const result = render("{{n}}", { n: 0 }, { escape: false });
    expect(result.output).toBe("0");
    expect(result.missing).toEqual([]);
  });

  it("ignores unmatched braces instead of throwing", () => {
    expect(render("{{ }} {{a-b}} {{", { a: 1 }, { escape: false }).output).toBe("{{ }} {{a-b}} {{");
  });
});

describe("row rendering", () => {
  const rows = [
    { numero: "F-1001", client: "Acme & Co", montant: 1250.5 },
    { numero: "F-1002", client: "<script>", montant: 90 },
  ];

  it("builds a table with escaped headers and cells", () => {
    const html = buildRowsTableHtml(rows);
    expect(html).toContain("<th");
    expect(html).toContain("Acme &amp; Co");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("says so in French when there is nothing to report", () => {
    expect(buildRowsTableHtml([])).toContain("Aucune donnée à signaler");
    expect(buildRowsText([])).toBe("Aucune donnée à signaler.");
  });

  it("lists rows in the text body", () => {
    const text = buildRowsText(rows);
    expect(text).toContain("[1]");
    expect(text).toContain("numero: F-1001");
    expect(text).toContain("[2]");
  });
});

describe("frenchDate", () => {
  it("formats in French, in UTC", () => {
    expect(frenchDate(new Date("2026-07-29T06:00:00Z"))).toBe("mercredi 29 juillet 2026");
  });
});

#!/usr/bin/env node
//
// Generates one MDX page per ACTIVE catalog endpoint, straight from the live
// `endpoints` table, plus the navigation that lists them.
//
// The catalog is the source of truth. Every field on a tool page (the title,
// the blurb, the "use when" note, the input table, the example call, the
// response sample and above all the PRICE) is derived here, so a page can
// never drift from what the API actually does. Hand-editing a file under
// tools/ is a mistake: the next run overwrites it. Change the row in the
// database instead.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/generate-tool-pages.mjs
//
// Options:
//   --from <file.json>   render from a saved dump instead of querying (offline)
//   --dump <file.json>   write the rows it fetched, for the flag above
//   --check              render and report differences, write nothing
//
// What it writes:
//   tools/<category>/<slug-with-dashes>.mdx   one page per active endpoint
//   docs.json                                 the "Tools" navigation group
//   .catalog-nav.json                         the same nav as a standalone fragment
//
// PRICE COPY IS THE PART TO BE CAREFUL WITH. Three rule types now reach a
// reader and they do not mean the same thing:
//
//   cost_plus  the rate is what the provider charged us last time, times the
//              markup. The total follows the rows the call actually produced,
//              and the ceiling is a cap.
//   per_call   a flat resale price. Exact, known before the call, nothing to
//              settle afterwards. It must not carry cost_plus's hedging.
//   metered    an exact rate against a measurable input (bytes of text,
//              seconds of audio). The rate is exact; the TOTAL still scales
//              with request size, and the ceiling is a real cap.
//
// And the rule all three share, enforced by platform/tests/unit/price-view.test.ts:
// NEVER phrase a price as a floor. No "from $X", no "starting at". Both a
// cost_plus quote and a metered ceiling are maximums, and understating them
// is the one error a buyer cannot recover from.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Categories are ordered for the reader, not alphabetically: the things most
// callers arrive wanting come first. A category with no entry here throws
// rather than landing in an unnamed group, so adding one is a deliberate act.
const CATEGORY_ORDER = [
  "search",
  "social",
  "people",
  "maps",
  "ecommerce",
  "image",
  "voice",
];

const CATEGORY_LABEL = {
  search: "Search",
  social: "Social",
  people: "People and companies",
  maps: "Maps and places",
  ecommerce: "Shopping and commerce",
  image: "Image generation",
  voice: "Voice and audio",
};

// Mintlify shows the frontmatter description as the page's meta description
// and in search results, where anything past ~160 characters is cut anyway.
const META_DESCRIPTION_MAX = 160;

// Long input schemas (tiktok.api carries 61 fields) would bury the page in
// table. The passthrough note under the table already tells a reader the list
// is not exhaustive.
const MAX_INPUT_ROWS = 14;

// ---------------------------------------------------------------------------
// Money. Ported from platform/lib/money.ts and platform/lib/views.ts so a
// generated page quotes the same string the API returns for the same rule.
// ---------------------------------------------------------------------------

const MICRO_PER_USD = 1_000_000;

// Two, four or six decimals: the fewest that still show the amount exactly,
// in the steps the rest of the product uses. $0.18, $0.0825, $0.000450.
function formatUsd(micro) {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  const dollars = Math.floor(abs / MICRO_PER_USD);
  const fracStr = (abs % MICRO_PER_USD).toString().padStart(6, "0");
  let decimals = 6;
  if (fracStr.endsWith("0000")) decimals = 2;
  else if (fracStr.endsWith("00")) decimals = 4;
  return `${sign}$${dollars}.${fracStr.slice(0, decimals)}`;
}

// The billed unit, read off the charge event so there is no second source of
// truth. "place-scraped" reads as "place", "search-page-scraped" as "page".
function unitLabelFor(perUnitEvent) {
  if (!perUnitEvent) return "result";
  const cleaned = perUnitEvent
    .replace(/^apify-/, "")
    .replace(/-scraped$|-dataset-item$|-applied$/g, "");
  if (!cleaned || cleaned === "default" || cleaned === "item") return "result";
  const words = cleaned.split("-").filter(Boolean);
  return words[words.length - 1] || "result";
}

function plural(word) {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

const groupDigits = (n) => n.toLocaleString("en-US");

function priceSection(rule, slug) {
  if (!rule || typeof rule !== "object") {
    throw new Error(`${slug}: no price_rule`);
  }

  if (rule.type === "per_call") {
    const price = formatUsd(rule.base_micro);
    return [
      `**${price} per call.** A flat price. Every call that succeeds costs exactly this, whatever it returns, and you know the number before you make the call.`,
      "",
      "There is no ceiling to read and no usage to reconcile afterwards. A call that fails, times out or is stopped releases its hold in full and costs nothing.",
    ].join("\n");
  }

  if (rule.type === "metered") {
    // The rate is EXACT here, which is the whole point of this rule type, so
    // none of cost_plus's hedging belongs in this copy. The ceiling still
    // gets "up to", because a ceiling is a maximum.
    const rateMicro = Math.round(
      rule.rate_units * rule.unit_cost_micro * rule.markup
    );
    const maxMicro = Math.max(
      Math.round(rule.max_units * rule.unit_cost_micro * rule.markup),
      rule.min_micro
    );
    return [
      `**${formatUsd(rateMicro)} per ${rule.rate_label}.** An exact rate, not an estimate. The total is that rate times the ${rule.unit_label} in your request, so you can work out what a call costs before you make it.`,
      "",
      `No call costs less than ${formatUsd(rule.min_micro)} or more than ${formatUsd(maxMicro)}, the price of the largest request this endpoint takes, ${groupDigits(rule.max_units)} ${rule.unit_label}. \`discover\` and \`inspect\` quote your exact request before it runs.`,
    ].join("\n");
  }

  if (rule.type === "cost_plus") {
    const base =
      rule.estimate?.per_unit_base_micro ?? rule.estimate?.per_unit_micro;
    const unit = unitLabelFor(rule.estimate?.per_unit_event);
    if (typeof base === "number" && base > 0) {
      const rate = formatUsd(Math.round(base * rule.markup));
      return [
        `**${rate} per ${unit}.** That is the rate you pay for each ${unit} the call returns, so the total depends on how many it produces.`,
        "",
        `Billing follows actual usage, so a call that returns fewer ${plural(unit)} costs less. \`discover\` and \`inspect\` also return a ceiling for your specific request, which is a maximum you will never be charged above.`,
      ].join("\n");
    }
    // No per-unit figure to publish. Quote the cap and nothing else, and say
    // plainly that it is a cap: a bare number here would read as the price.
    return [
      `**Up to ${formatUsd(rule.max_micro)} per call.** That is a maximum you will never be charged above, not what a call costs.`,
      "",
      "Billing follows actual usage, and the hold scales with what you request. `discover` and `inspect` return the ceiling for your specific request before it runs.",
    ].join("\n");
  }

  if (rule.type === "per_result") {
    const rate = formatUsd(rule.per_result_micro);
    return [
      `**${rate} per result.** That is the rate you pay for each result the call returns, so the total depends on how many it produces.`,
      "",
      `A call returns at most ${groupDigits(rule.max_results_cap)} results, so that is the most it can bill.`,
    ].join("\n");
  }

  throw new Error(`${slug}: unknown price rule type ${rule.type}`);
}

// ---------------------------------------------------------------------------
// Input table
// ---------------------------------------------------------------------------

function typeCell(prop) {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.map((v) => `\`${v}\``).join(", ");
  }
  return `\`${prop.type ?? "any"}\``;
}

function notesCell(prop) {
  const description = prop.description ?? "";
  if (prop.default === undefined) return description;
  return `${description} Defaults to \`${JSON.stringify(prop.default)}\`.`;
}

function tableRow(name, prop, required) {
  return `| \`${name}\` | ${typeCell(prop)} | ${required ? "yes" : ""} | ${notesCell(prop)} |`;
}

function inputTable(schema) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const lines = [
    "| Field | Type | Required | Notes |",
    "| --- | --- | --- | --- |",
  ];
  for (const [name, prop] of Object.entries(properties).slice(
    0,
    MAX_INPUT_ROWS
  )) {
    lines.push(tableRow(name, prop, required.has(name)));
    // One level of nesting, flattened. An object field whose own properties
    // are hidden would otherwise leave a reader with no way to fill it in.
    if (prop.type === "object" && prop.properties) {
      const nestedRequired = new Set(prop.required ?? []);
      for (const [childName, childProp] of Object.entries(prop.properties)) {
        lines.push(
          tableRow(`${name}.${childName}`, childProp, nestedRequired.has(childName))
        );
      }
    }
  }
  return lines.join("\n");
}

// Two different contracts, so two different notes. Most of the catalog hands
// your input to the upstream tool untouched, which means undocumented fields
// still work. The endpoints Goro wraps directly do not: their schema closes
// additionalProperties and an unknown field is a 400, not a passthrough.
function inputNote(schema) {
  if (schema.additionalProperties === false) {
    return [
      "<Note>",
      "  These are all the fields this endpoint accepts. Anything else is rejected as",
      "  a `validation_error` rather than forwarded to the provider.",
      "</Note>",
    ].join("\n");
  }
  return [
    "<Note>",
    "  Goro forwards your input to the underlying tool unchanged, so any field the",
    "  tool accepts works here even if it is not listed above.",
    "</Note>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Example call
// ---------------------------------------------------------------------------

// A count small enough that a reader who pastes the example does not spend
// real money discovering what the default was.
const SAMPLE_COUNT = 3;

function countValue(prop) {
  const floor = Math.max(SAMPLE_COUNT, prop.minimum ?? 0);
  return typeof prop.maximum === "number" ? Math.min(floor, prop.maximum) : floor;
}

function exampleValue(prop) {
  if (Array.isArray(prop.examples) && prop.examples.length > 0) {
    return prop.examples[0];
  }
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (prop.type === "array") return ["example"];
  if (prop.type === "integer" || prop.type === "number") return countValue(prop);
  if (prop.type === "boolean") return prop.default ?? true;
  if (prop.type === "object") return {};
  return "example";
}

function exampleInput(row) {
  const properties = row.input_schema.properties ?? {};
  const input = {};
  for (const name of row.input_schema.required ?? []) {
    const prop = properties[name];
    if (prop) input[name] = exampleValue(prop);
  }
  // The field the hold is sized from, if the caller has not already set it.
  // Showing it with a small value is the difference between an example that
  // costs a fraction of a cent and one that runs the endpoint's default.
  const unitKey = row.price_rule?.estimate?.unit_key;
  if (unitKey && properties[unitKey] && !(unitKey in input)) {
    input[unitKey] = countValue(properties[unitKey]);
  }
  return input;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function responseSection(sample) {
  const rows = Array.isArray(sample) ? sample : [sample];
  const first = rows[0];
  if (first !== null && typeof first === "object" && !Array.isArray(first)) {
    return [
      "One row of the response. Values are illustrative.",
      "",
      "```json",
      JSON.stringify(first, null, 2),
      "```",
    ].join("\n");
  }
  // Scalar rows, e.g. a list of media URLs. One element on its own would not
  // show the shape, so print the whole thing.
  return [
    "The full response. Values are illustrative.",
    "",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
  ].join("\n");
}

function renderPage(row) {
  const meta = row.description
    .replaceAll('"', "'")
    .slice(0, META_DESCRIPTION_MAX);
  const body = JSON.stringify({ slug: row.slug, input: exampleInput(row) });

  return `---
title: "${row.name}"
description: "${meta}"
---

${row.description}

<Note>${row.when_to_use}</Note>

## Price

${priceSection(row.price_rule, row.slug)}

## Input

${inputTable(row.input_schema)}

${inputNote(row.input_schema)}

## Example

\`\`\`bash
curl -X POST https://api.usegoro.ai/v1/run \\
  -H "Authorization: Bearer $GORO_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${body}'
\`\`\`

## Response

${responseSection(row.output_sample)}
`;
}

const pagePath = (row) =>
  `tools/${row.category}/${row.slug.replaceAll(".", "-")}.mdx`;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navGroups(rows) {
  const byCategory = new Map();
  for (const row of rows) {
    if (!CATEGORY_LABEL[row.category]) {
      throw new Error(
        `${row.slug}: category "${row.category}" has no navigation label. Add it to CATEGORY_ORDER and CATEGORY_LABEL.`
      );
    }
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(pagePath(row).replace(/\.mdx$/, ""));
  }
  return CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
    group: CATEGORY_LABEL[category],
    pages: byCategory.get(category).sort(),
  }));
}

function updateDocsJson(rows, write) {
  const path = join(ROOT, "docs.json");
  const raw = readFileSync(path, "utf8");
  const config = JSON.parse(raw);
  const tools = config.navigation.groups.find((g) => g.group === "Tools");
  if (!tools) throw new Error('docs.json has no "Tools" navigation group');
  tools.pages = ["tools/overview", ...navGroups(rows)];
  // The file is checked in without a trailing newline. Keep it that way so a
  // regeneration that changed nothing produces an empty diff.
  const next = JSON.stringify(config, null, 2);
  if (next === raw) return false;
  if (write) writeFileSync(path, next);
  return true;
}

// A standalone copy of the same groups, sorted by category key, for pasting
// into a navigation config by hand. docs.json is what Mintlify reads.
function updateCatalogNav(rows, write) {
  const path = join(ROOT, ".catalog-nav.json");
  const groups = navGroups(rows).sort((a, b) => a.group.localeCompare(b.group));
  const byLabel = new Map(Object.entries(CATEGORY_LABEL).map(([k, v]) => [v, k]));
  groups.sort((a, b) => byLabel.get(a.group).localeCompare(byLabel.get(b.group)));
  const next = JSON.stringify(groups, null, 2);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (next === current) return false;
  if (write) writeFileSync(path, next);
  return true;
}

// Two hand-written pages state how big the catalog is. Keeping the number
// here means adding an endpoint cannot quietly leave a stale count behind.
const TOOL_COUNT_MENTIONS = [
  ["tools/overview.mdx", /Goro exposes \d+ tools/, "Goro exposes $N tools"],
  ["guide/quickstart-mcp.mdx", /the \d+ catalog/, "the $N catalog"],
];

function updateToolCount(rows, write) {
  let changed = false;
  for (const [file, pattern, replacement] of TOOL_COUNT_MENTIONS) {
    const path = join(ROOT, file);
    const current = readFileSync(path, "utf8");
    if (!pattern.test(current)) {
      throw new Error(`${file}: no tool count matched ${pattern}. Fix the pattern.`);
    }
    const next = current.replace(
      pattern,
      replacement.replace("$N", String(rows.length))
    );
    if (next === current) continue;
    changed = true;
    console.log(`edit  ${file}`);
    if (write) writeFileSync(path, next);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchEndpoints() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --from <dump.json>"
    );
  }
  const response = await fetch(
    `${url}/rest/v1/endpoints?select=*&active=eq.true&order=category,slug`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!response.ok) {
    throw new Error(`endpoints query failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const check = args.includes("--check");
  const from = flag("--from");
  const dump = flag("--dump");

  const rows = from
    ? JSON.parse(readFileSync(from, "utf8"))
    : await fetchEndpoints();
  if (dump) writeFileSync(dump, JSON.stringify(rows, null, 2));

  const active = rows
    .filter((r) => r.active)
    .sort((a, b) => a.slug.localeCompare(b.slug));

  let changed = 0;
  for (const row of active) {
    const relative = pagePath(row);
    const path = join(ROOT, relative);
    const next = renderPage(row);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (next === current) continue;
    changed += 1;
    console.log(`${current === null ? "new " : "edit"}  ${relative}`);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    }
  }

  if (updateDocsJson(active, !check)) {
    changed += 1;
    console.log("edit  docs.json");
  }
  if (updateCatalogNav(active, !check)) {
    changed += 1;
    console.log("edit  .catalog-nav.json");
  }
  if (updateToolCount(active, !check)) changed += 1;

  console.log(
    `${active.length} active endpoints, ${changed} file${changed === 1 ? "" : "s"} ${check ? "would change" : "written"}`
  );
  if (check && changed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

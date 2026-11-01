// Downloads the current catalogue from CelesTrak and packs it for the page. Be polite: CelesTrak updates every two hours and blocks heavy use.
import { writeFileSync, mkdirSync } from "node:fs";
import { pack } from "../src/orbit.js";
const res = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json");
if (!res.ok) throw new Error(`CelesTrak said ${res.status}`);
const text = await res.text();
const records = JSON.parse(text);
mkdirSync("data", { recursive: true });
writeFileSync("data/active.json", text);
writeFileSync("public/catalogue.json", JSON.stringify({ fetched: new Date().toISOString(), rows: pack(records) }));
console.log(`${records.length} objects`);

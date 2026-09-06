// Fails the build if src/core reaches for anything a runtime might not have.
// Runs on the TypeScript sources so a stray import is caught before tsc
// resolves it to something that happens to work on Node.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../src/core/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const banned = [
  { re: /from\s+["']node:/, why: "node: import" },
  { re: /from\s+["']\.\.\//, why: "import from outside core" },
  { re: /\bBuffer\b(?!\s+only)/, why: "Buffer" },
  { re: /\bprocess\./, why: "process" },
  { re: /\brequire\(/, why: "require()" },
  { re: /\bglobalThis\.fetch\b/, why: "globalThis.fetch", allow: ["fetch-transport.ts"] },
];

let failures = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const lines = readFileSync(join(dir, file), "utf-8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name the things they avoid
    for (const b of banned) {
      if (b.allow?.includes(file)) continue;
      if (b.re.test(line)) {
        failures++;
        console.error(`src/core/${file}:${i + 1}: ${b.why}: ${line.trim()}`);
      }
    }
  });
}
if (failures) {
  console.error(`\n${failures} platform reference(s) in src/core`);
  process.exit(1);
}
console.log("src/core has no platform imports");

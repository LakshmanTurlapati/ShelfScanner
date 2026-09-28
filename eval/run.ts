import { readdirSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("eval/golden");
const labeled = readdirSync(dir).filter((name) => name.endsWith(".json"));

const metrics = ["spine recall", "spine precision", "match rate", "rating coverage", "false merges", "cost per scan"];

if (labeled.length === 0) {
  console.log("No labeled photos in eval/golden. Real shelf photos are still needed; nothing was invented.");
  for (const metric of metrics) console.log(`${metric}\t—`);
  process.exit(0);
}

console.log(`Would score ${labeled.length} labeled photo(s). A live run needs OPENROUTER_API_KEY and is not part of unit tests.`);
for (const metric of metrics) console.log(`${metric}\tpending`);

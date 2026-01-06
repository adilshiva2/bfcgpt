/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

const BANK_JSON = path.join(__dirname, "..", "data", "question-bank.json");

if (!fs.existsSync(BANK_JSON)) {
  console.error("Missing data/question-bank.json. Run npm run build-question-bank first.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(BANK_JSON, "utf8"));
const counts = {};
for (const item of data) {
  counts[item.firm] = (counts[item.firm] || 0) + 1;
}

const firms = Object.keys(counts).sort();
console.log(`Loaded ${data.length} questions from ${firms.length} firms.`);
for (const firm of firms) {
  console.log(`${firm}: ${counts[firm]}`);
}

const fs = require("fs");
const path = require("path");

const webAppUrl = String(process.env.GAS_WEB_APP_URL || "").trim();
const apiKey = String(process.env.GAS_API_KEY || "").trim();
const snapshotPath = path.join(__dirname, "..", "google-apps-script", "nutcheck-snapshot.json");

async function main() {
  if (!webAppUrl || !apiKey) {
    throw new Error("กรุณาตั้งค่า GAS_WEB_APP_URL และ GAS_API_KEY ก่อน");
  }

  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`ไม่พบไฟล์ snapshot ที่ ${snapshotPath}`);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const response = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      action: "importSnapshot",
      snapshot
    })
  });

  const json = await response.json();
  console.log(JSON.stringify(json, null, 2));

  if (!response.ok || !json.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

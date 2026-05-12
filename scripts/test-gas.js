const webAppUrl = String(process.env.GAS_WEB_APP_URL || "").trim();
const apiKey = String(process.env.GAS_API_KEY || "").trim();

async function main() {
  if (!webAppUrl || !apiKey) {
    throw new Error("กรุณาตั้งค่า GAS_WEB_APP_URL และ GAS_API_KEY ก่อน");
  }

  const response = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey,
      action: "health"
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

// Quick script to decode base64 stderr from shell exec response
const stderrBase64 = process.argv[2];

if (!stderrBase64) {
  console.error("Usage: node decode-response.js <stderr_base64>");
  process.exit(1);
}

try {
  const stderr = Buffer.from(stderrBase64, "base64").toString("utf8");
  console.log("Decoded stderr:");
  console.log("---");
  console.log(stderr);
  console.log("---");
} catch (e) {
  console.error("Error decoding:", e.message);
  process.exit(1);
}

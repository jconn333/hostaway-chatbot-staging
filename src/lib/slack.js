export async function postSlackMessage(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    throw new Error("SLACK_WEBHOOK_URL is not set");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed: ${res.status} ${body}`);
  }
}

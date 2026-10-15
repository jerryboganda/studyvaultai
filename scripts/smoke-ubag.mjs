#!/usr/bin/env node
/* global Buffer, fetch */
// Live smoke test of a UBAG gateway through the same request shape the extension sends.
//
//   UBAG_USER=name UBAG_PASS=secret node scripts/smoke-ubag.mjs [baseUrl] [model]
//
// Credentials come from the environment only (never a file, never printed). It lists the models and
// sends ONE short chat message; it prints status codes, latency and model ids, not secrets or the
// answer text beyond 120 characters. Not part of CI: it needs a real gateway and real credentials.
const base = (process.argv[2] ?? 'https://ubag.polytronx.com/v1/openai').replace(/\/+$/, '');
const user = process.env.UBAG_USER;
const pass = process.env.UBAG_PASS;
if (!user || !pass) {
  console.error('Set UBAG_USER and UBAG_PASS in the environment.');
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;

async function main() {
  const modelsRes = await fetch(`${base}/models`, { headers: { authorization: auth } });
  console.log(`GET /models -> HTTP ${modelsRes.status} (${secs()})`);
  if (!modelsRes.ok) process.exit(1);
  const models = (await modelsRes.json()).data?.map((m) => m.id) ?? [];
  console.log(
    `models (${models.length}): ${models.slice(0, 12).join(', ')}${models.length > 12 ? ', ...' : ''}`,
  );
  const model = process.argv[3] ?? models.find((m) => !m.includes('|')) ?? models[0];
  if (!model) process.exit(1);

  // Same body twice would join the same job; a nonce makes this probe its own job.
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    stream: false,
    ubag_wait_ms: 240000,
    ubag_nonce: `smoke-${Date.now()}`,
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(
      `POST /chat/completions (${model}) attempt ${attempt} -> HTTP ${res.status} (${secs()})`,
    );
    if (res.status === 504) continue; // still running: sending the same body joins the job
    const text = await res.text();
    try {
      const reply = JSON.parse(text).choices?.[0]?.message?.content;
      console.log(`reply: ${String(reply ?? text).slice(0, 120)}`);
    } catch {
      console.log(`body: ${text.slice(0, 120)}`);
    }
    process.exit(res.ok ? 0 : 1);
  }
  console.log('still running after the allowed waits');
  process.exit(1);
}
main().catch((e) => {
  console.error(`failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

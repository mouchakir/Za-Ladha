import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("ladha");
  const json = (o, s = 200) =>
    new Response(JSON.stringify(o), {
      status: s,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const realPin = async () => (await store.get("pin")) || "1234";

  if (req.method === "GET") {
    const c = await store.get("config", { type: "json" });
    return c ? json(c) : json({}, 404);
  }

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad" }, 400); }
    if (b.pin !== (await realPin())) return json({ error: "pin" }, 401);
    if (b.action === "login") return json({ ok: true });
    if (b.action === "save") { await store.setJSON("config", b.config); return json({ ok: true }); }
    if (b.action === "setpin" && b.newpin) { await store.set("pin", String(b.newpin)); return json({ ok: true }); }
  }
  return json({ error: "no" }, 400);
};

export const config = { path: "/api/config" };

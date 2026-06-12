import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { neon } from "@neondatabase/serverless";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

app.use(express.json({ limit: "50mb" }));

// ─── Cloudinary ───────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper: upload buffer to Cloudinary
async function uploadToCloudinary(
  buffer: Buffer,
  mimetype: string
): Promise<string> {
  const isVideo = mimetype.startsWith("video/");
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: isVideo ? "video" : "image",
        folder: "couple-app",
        transformation: isVideo ? undefined : [{ quality: "auto", fetch_format: "auto" }],
      },
      (error, result) => {
        if (error || !result) reject(error || new Error("Upload failed"));
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ─── Neon Database ────────────────────────────────────────────────
let sql: ReturnType<typeof neon> | null = null;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("No DATABASE_URL set — data will not persist to Neon.");
    return;
  }
  try {
    sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS diary_entries (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    console.log("Neon DB connected and tables ready.");
  } catch (err) {
    console.error("Failed to init Neon DB:", err);
    sql = null;
  }
}

// ─── Media Upload ─────────────────────────────────────────────────
// Use memory storage so we can stream to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.post("/api/upload-media", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  // If Cloudinary is configured, upload there
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    try {
      const url = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
      return res.json({ url });
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
      // Fall through to base64 fallback
    }
  }

  // Fallback: return base64 data URL (works offline / without Cloudinary config)
  const mime = req.file.mimetype;
  const b64 = req.file.buffer.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;
  res.json({ url: dataUrl });
});

// ─── Data CRUD endpoints ──────────────────────────────────────────

// GET /api/posts
app.get("/api/posts", async (_req, res) => {
  if (!sql) return res.json([]);
  try {
    const rows = (await sql`SELECT data FROM posts ORDER BY (data->>'timestamp') ASC`) as any[];
    res.json(rows.map((r: any) => r.data));
  } catch (err) {
    console.error("GET /api/posts error:", err);
    res.json([]);
  }
});

// PUT /api/posts — replaces all posts
app.put("/api/posts", async (req, res) => {
  if (!sql) return res.json({ ok: true, persisted: false });
  const { posts } = req.body as { posts: any[] };
  if (!Array.isArray(posts)) return res.status(400).json({ error: "posts must be array" });
  try {
    if (posts.length === 0) {
      await sql`DELETE FROM posts`;
    } else {
      const ids = posts.map((p) => p.id) as string[];
      const datas = posts.map((p) => JSON.stringify(p));
      await sql`DELETE FROM posts`;
      await sql`
        INSERT INTO posts (id, data)
        SELECT * FROM UNNEST(${ids}::text[], ${datas}::jsonb[])
      `;
    }
    res.json({ ok: true, persisted: true });
  } catch (err) {
    console.error("PUT /api/posts error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/events
app.get("/api/events", async (_req, res) => {
  if (!sql) return res.json([]);
  try {
    const rows = (await sql`SELECT data FROM events ORDER BY updated_at ASC`) as any[];
    res.json(rows.map((r: any) => r.data));
  } catch (err) {
    console.error("GET /api/events error:", err);
    res.json([]);
  }
});

// PUT /api/events — replaces all events
app.put("/api/events", async (req, res) => {
  if (!sql) return res.json({ ok: true, persisted: false });
  const { events } = req.body as { events: any[] };
  if (!Array.isArray(events)) return res.status(400).json({ error: "events must be array" });
  try {
    if (events.length === 0) {
      await sql`DELETE FROM events`;
    } else {
      const ids = events.map((e) => e.id) as string[];
      const datas = events.map((e) => JSON.stringify(e));
      await sql`DELETE FROM events`;
      await sql`
        INSERT INTO events (id, data)
        SELECT * FROM UNNEST(${ids}::text[], ${datas}::jsonb[])
      `;
    }
    res.json({ ok: true, persisted: true });
  } catch (err) {
    console.error("PUT /api/events error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/diary
app.get("/api/diary", async (_req, res) => {
  if (!sql) return res.json([]);
  try {
    const rows = (await sql`SELECT data FROM diary_entries ORDER BY (data->>'timestamp') ASC`) as any[];
    res.json(rows.map((r: any) => r.data));
  } catch (err) {
    console.error("GET /api/diary error:", err);
    res.json([]);
  }
});

// PUT /api/diary — replaces all diary entries
app.put("/api/diary", async (req, res) => {
  if (!sql) return res.json({ ok: true, persisted: false });
  const { entries } = req.body as { entries: any[] };
  if (!Array.isArray(entries)) return res.status(400).json({ error: "entries must be array" });
  try {
    if (entries.length === 0) {
      await sql`DELETE FROM diary_entries`;
    } else {
      const ids = entries.map((e) => e.id) as string[];
      const datas = entries.map((e) => JSON.stringify(e));
      await sql`DELETE FROM diary_entries`;
      await sql`
        INSERT INTO diary_entries (id, data)
        SELECT * FROM UNNEST(${ids}::text[], ${datas}::jsonb[])
      `;
    }
    res.json({ ok: true, persisted: true });
  } catch (err) {
    console.error("PUT /api/diary error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/profile
app.get("/api/profile", async (_req, res) => {
  if (!sql) return res.json(null);
  try {
    const rows = (await sql`SELECT value FROM app_config WHERE key = 'profile'`) as any[];
    res.json(rows.length > 0 ? rows[0].value : null);
  } catch (err) {
    console.error("GET /api/profile error:", err);
    res.json(null);
  }
});

// PUT /api/profile
app.put("/api/profile", async (req, res) => {
  if (!sql) return res.json({ ok: true, persisted: false });
  const profile = req.body;
  try {
    await sql`
      INSERT INTO app_config (key, value) VALUES ('profile', ${JSON.stringify(profile)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(profile)}::jsonb, updated_at = NOW()
    `;
    res.json({ ok: true, persisted: true });
  } catch (err) {
    console.error("PUT /api/profile error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ─── Gemini AI ────────────────────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey && apiKey !== "MY_GEMINI_API_KEY") {
  try {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
    console.log("Gemini GenAI client initialized.");
  } catch (error) {
    console.error("Failed to initialize Gemini GenAI client:", error);
  }
} else {
  console.log("No valid GEMINI_API_KEY — AI will use fallback responses.");
}

// REST API for AI Summary Insights
app.post("/api/ai-summarize", async (req, res) => {
  const { type, items, language = "en", partner1 = "Sasa", partner2 = "Hao Hao", events: evts = [] } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({
      summary:
        language === "zh"
          ? "写下你们的第一条回忆吧！AI 会在这里总结你们的甜蜜瞬间。"
          : "Share your first memory! AI will summarize your intimate moments here.",
    });
  }

  const itemsString = items
    .map((it: any) => `[${it.author || partner1} / ${it.date || "Moment"}]: "${it.content}"`)
    .join("\n");

  const eventsString =
    evts.length > 0
      ? "\n=== ANNIVERSARY / EVENT DATA ===\n" +
        evts
          .map(
            (ev: any) =>
              `[${ev.eventType} on ${ev.date}]: "${ev.title}" — ${ev.description || ""}${ev.location ? ` @ ${ev.location}` : ""}`
          )
          .join("\n")
      : "";

  const systemInstruction = `You are a romantic and gentle scrapbooking assistant for couples.
Your task is to generate a beautiful, sentiment-rich summary based on the shared memories provided.
Focus on warmth, intimacy, tiny details, and emotional connection.
Keep your response short (25 to 50 words) and quote-worthy, using intimate first/second-person style.
Translate or output strictly in the requested language (either "zh" for Simplified Chinese, or "en" for English).
Do not output technical jargon, JSON markers, or metadata. Only output the plain text summary.`;

  const prompt = `Requested Language: ${language}
Partner 1: ${partner1}
Partner 2: ${partner2}
Summary Type: ${type}
${eventsString}

Here are the recent couple entries:
${itemsString}

Please output a beautiful ${type === "timeline" ? "intimate summary" : type === "diary" ? "diary essence note" : "anniversary retrospective highlight"} of these shared moments.`;

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
        config: { systemInstruction, temperature: 1.0 },
      });
      const txt = response.text ? response.text.trim() : "";
      if (txt) return res.json({ summary: txt });
    } catch (err) {
      console.error("Gemini ai-summarize error:", err);
    }
  }

  const fallbacks: Record<string, Record<string, string>> = {
    timeline: {
      zh: `"你们今天分享了关于清晨琐碎仪式的记录。早晨一起喝咖啡、分享阳台上的宁静，显然是你们近来维系亲密感的重要支柱。继续在微小的事物中寻找彼此吧。"`,
      en: `"You've shared moments focusing on small daily rituals today. Keep finding magic in the little things."`,
    },
    diary: {
      zh: `"一段充满欢笑与温馨宁静的篇章。你们正在把平凡的日子过成诗。"`,
      en: `"A beautiful chapter defined by laughter and playful messes. Every setback turns into a treasured wonder."`,
    },
    calendar: {
      zh: `"每一个誓之日，都载着你们的欢笑。那些珍贵的纪念日，见证了你们共同走过的浪漫光阴。"`,
      en: `"Each anniversary day carries your shared laughter and precious memories through the years."`,
    },
  };

  const choice = fallbacks[type] || fallbacks.timeline;
  return res.json({ summary: choice[language] || choice.en });
});

// REST API for AI Chat
app.post("/api/ai-chat", async (req, res) => {
  const {
    messages,
    language = "zh",
    partner1 = "Sasa",
    partner2 = "Hao Hao",
    posts = [],
    entries = [],
  } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.json({
      reply: language === "zh" ? "欢迎开启爱心问答 💖" : "Welcome to Memory Oracle 💖",
    });
  }

  const systemInstruction = `You are an incredibly loving, sentiment-rich relationship memories assistant named "Gemini 爱意回忆家" for the couple ${partner1} and ${partner2}.
They have been together for over 1945 days. You have complete context-awareness of their shared photos, mood changes, coffee sessions, pasta kitchen failures, lakehouse trips, and anniversary milestones.
Your absolute mission is to answer questions about their dates, stories, and inside jokes, summarizing their love patterns in a romantic, poetic, supportive, and emotionally warm tone.
Use cute emoji icons (🌸, 💖, ☕, 🍃, 🧸, 🍰) to create a scrapbooking vibe.
If they ask something that is NOT mentioned in their shared logs, do not hallucinate dates or events; instead, reply with something sweet and encouraging.
Always write in Simplified Chinese (zh) by default, or English (en) if requested.`;

  const postsContext = posts
    .slice(0, 15)
    .map(
      (p: any) =>
        `[${p.author} at ${p.timestamp?.slice(0, 10)} - Mood: ${p.mood || "None"}]: "${p.content}"`
    )
    .join("\n");
  const entriesContext = entries
    .slice(0, 10)
    .map(
      (e: any) =>
        `[Diary by ${e.author} with date ${e.dateStr}]: "${e.title} - ${e.subtitle}: ${e.content}"`
    )
    .join("\n");

  const lastUserMessage = messages[messages.length - 1]?.content || "";
  const prompt = `=== TIMELINE MOMENTS ===
${postsContext}

=== HANDWRITTEN DIARIES ===
${entriesContext}

=== RECENT CHAT HISTORY ===
${messages
  .slice(-4, -1)
  .map((m: any) => `${m.role === "user" ? "Couple" : "Gemini"}: ${m.content}`)
  .join("\n")}

Couple Question: "${lastUserMessage}"`;

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
        config: { systemInstruction, temperature: 0.7 },
      });
      const replyText = response.text ? response.text.trim() : "";
      if (replyText) return res.json({ reply: replyText });
    } catch (err) {
      console.error("Gemini ai-chat error:", err);
    }
  }

  const zhFallbacks = [
    "在你们并肩走过的 1945 天里，每一口 balcony 咖啡 ☕ 都是甜的，每一次 pasta night 🍝 虽然手忙脚乱，但有你在就全是幸福。💖",
    "浮世三千，吾有三喜，日、月与卿…… 你们把琐碎的生活过成了让人羡慕不己的童话日记。今天也是爱意满满的一天呢 🌸",
  ];
  const enFallbacks = [
    "Across your precious 1945 days, every morning coffee ☕ and shared giggle proves that your souls are synchronized. 💖",
  ];
  const fallbackArr = language === "zh" ? zhFallbacks : enFallbacks;
  const reply = fallbackArr[Math.floor(Math.random() * fallbackArr.length)];
  return res.json({ reply });
});

// ─── Start server ─────────────────────────────────────────────────
async function start() {
  await initDB();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development middleware integrated.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Serving built static assets in Production mode.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
});

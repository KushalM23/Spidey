import "dotenv/config";
import { Bot } from "grammy";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";
import express from "express";
import readline from "readline";

// ── Config ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "root";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const TOKEN_PATH = "token.json";
const CREDENTIALS_FILE = process.env.CREDENTIALS_FILE_PATH || "credentials.json";

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

// ── Google Drive auth ──────────────────────────────────────────────────────
function getOAuthClient() {
  const keys = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  const { client_id, client_secret } = keys.installed || keys.web;
  return new google.auth.OAuth2(client_id, client_secret, "urn:ietf:wg:oauth:2.0:oob");
}

async function loadSavedToken(oAuth2Client) {
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    return true;
  } catch {
    return false;
  }
}

async function authorizeManually(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  console.log("\nOpen this URL in your browser:");
  console.log(authUrl);
  console.log("\nAfter approving, Google will show you a code. Paste it below:");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => rl.question("Enter code: ", (ans) => { rl.close(); resolve(ans.trim()); }));

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log("\nAuthorized! Starting bot...\n");
}

async function getDriveService() {
  const oAuth2Client = getOAuthClient();
  const hasToken = await loadSavedToken(oAuth2Client);
  if (!hasToken) await authorizeManually(oAuth2Client);
  return google.drive({ version: "v3", auth: oAuth2Client });
}

// ── Upload to Drive ────────────────────────────────────────────────────────
async function uploadToDrive(drive, filePath, filename) {
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [GDRIVE_FOLDER_ID],
    },
    media: {
      body: fs.createReadStream(filePath),
    },
    fields: "id,webViewLink",
  });

  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { type: "anyone", role: "reader" },
  });

  return res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`;
}

// ── Download helper ────────────────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ── Bot ────────────────────────────────────────────────────────────────────
const bot = new Bot(TELEGRAM_TOKEN);

async function handleVideoUpload(ctx, file) {
  const filename = file.file_name || `video_${file.file_unique_id}.mp4`;
  const tmpPath = path.join(os.tmpdir(), filename);

  try {
    await ctx.reply("Downloading...");

    const fileInfo = await ctx.api.getFile(file.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

    await downloadFile(fileUrl, tmpPath);
    await ctx.reply("Uploading...");

    const drive = await getDriveService();
    const link = await uploadToDrive(drive, tmpPath, filename);

    await ctx.reply(`Uploaded!\n[Open](${link})`, {
      parse_mode: "Markdown",
    });

    console.log(`Uploaded: ${filename} -> ${link}`);
  } catch (err) {
    console.error("Upload failed:", err);
    await ctx.reply("Upload failed");
  } finally {
    fs.unlink(tmpPath, (err) => {
      if (err && err.code !== "ENOENT") console.error("Failed to delete temp file:", err);
    });
  }
}

bot.on(":video", async (ctx) => {
  await handleVideoUpload(ctx, ctx.message.video);
});

bot.on(":document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc) return;
  
  // Check if document is a video file
  const isVideoMime = doc.mime_type && doc.mime_type.startsWith("video/");
  const isVideoExt = doc.file_name && /\.(mp4|avi|mov|mkv|flv|wmv|webm)$/i.test(doc.file_name);
  
  if (isVideoMime || isVideoExt) {
    await handleVideoUpload(ctx, doc);
  }
});

bot.on("message", async (ctx) => {
  await ctx.reply("Hi, send the video");
});

bot.catch((err) => console.error("Bot error:", err));

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || `https://spidey.onrender.com`;
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;

const app = express();
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "Bot is running" });
});

// Telegram webhook endpoint
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    console.log("Webhook received:", req.body);
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error("Webhook error:", err);
  }
  res.sendStatus(200);
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize bot
  try {
    await bot.init();
    console.log("Bot initialized");
  } catch (err) {
    console.error("Failed to initialize bot:", err);
    return;
  }
  
  // Set webhook
  try {
    console.log(`Setting webhook to: ${WEBHOOK_URL}`);
    await bot.api.setWebhook(WEBHOOK_URL);
    console.log("Webhook set successfully");
  } catch (err) {
    console.error("Failed to set webhook:", err);
  }
});
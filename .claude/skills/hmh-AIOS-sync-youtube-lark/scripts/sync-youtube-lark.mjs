#!/usr/bin/env node
/**
 * hmh-AIOS-sync-youtube-lark
 * Lấy dữ liệu KÊNH + VIDEO từ YouTube Data API v3 rồi đồng bộ vào Lark Base.
 *
 * - Kênh  -> bảng channel  (upsert theo link kênh)
 * - Video -> bảng video    (upsert theo "video id")
 * - Thumbnail: tải ảnh YouTube -> upload lên Lark drive -> gắn attachment.
 *
 * Chạy: node sync-youtube-lark.mjs [--only channel|video|all] [--limit N] [--refresh-thumbs] [--config path]
 *
 * Node >= 18 (dùng fetch/FormData/Blob sẵn có). Không cần cài package.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YT = "https://www.googleapis.com/youtube/v3";

// ---------- args ----------
function parseArgs(argv) {
  const a = { only: "all", limit: 0, refreshThumbs: false, skipPreflight: false, config: path.join(__dirname, "config.local.json") };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--only") a.only = argv[++i];
    else if (k === "--limit") a.limit = parseInt(argv[++i], 10) || 0;
    else if (k === "--refresh-thumbs") a.refreshThumbs = true;
    else if (k === "--skip-preflight") a.skipPreflight = true;
    else if (k === "--config") a.config = argv[++i];
    else if (k === "--help") { console.log("Xem đầu file để biết cờ."); process.exit(0); }
  }
  return a;
}

const args = parseArgs(process.argv);
// Config: đọc file (nếu có) rồi cho ENV ghi đè (để chạy trên GitHub Actions không lộ secret).
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(args.config, "utf8")); } catch { /* CI: không có file, dùng env */ }
const E = process.env;
CFG.youtubeApiKey = E.YOUTUBE_API_KEY || CFG.youtubeApiKey;
CFG.larkAppId     = E.LARK_APP_ID     || CFG.larkAppId;
CFG.larkAppSecret = E.LARK_APP_SECRET || CFG.larkAppSecret;
CFG.larkDomain    = E.LARK_DOMAIN     || CFG.larkDomain || "https://open.larksuite.com";
CFG.appToken      = E.LARK_BASE_ID    || CFG.appToken;
CFG.tableChannel  = E.TABLE_CHANNEL   || CFG.tableChannel;
CFG.tableVideo    = E.TABLE_VIDEO     || CFG.tableVideo;
CFG.channel       = E.YT_CHANNEL      || CFG.channel;
CFG.larkNotifyWebhook = E.LARK_NOTIFY_WEBHOOK || CFG.larkNotifyWebhook; // TUỲ CHỌN: webhook bot Lark để gửi card báo cáo cuối job
for (const k of ["youtubeApiKey", "larkAppId", "larkAppSecret", "appToken", "tableChannel", "tableVideo", "channel"]) {
  if (!CFG[k]) { console.error(`Thiếu cấu hình "${k}" (điền config.local.json hoặc set biến môi trường tương ứng).`); process.exit(1); }
}

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === "" ? undefined : Number(v));
const log = (...m) => console.log(...m);

async function jget(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url);
    const body = await r.json();
    if (r.status === 200) return body;
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
    throw new Error(`YouTube ${r.status}: ${JSON.stringify(body.error || body)}`);
  }
  throw new Error("YouTube: hết lượt thử (rate limit).");
}

// ---------- Lark ----------
let TOKEN = null, TOKEN_EXP = 0;
async function larkToken() {
  if (TOKEN && Date.now() < TOKEN_EXP) return TOKEN;
  const r = await fetch(`${CFG.larkDomain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: CFG.larkAppId, app_secret: CFG.larkAppSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`Lark token lỗi: ${j.code} ${j.msg}`);
  TOKEN = j.tenant_access_token;
  TOKEN_EXP = Date.now() + (j.expire - 120) * 1000;
  return TOKEN;
}

async function larkApi(method, apiPath, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await larkToken();
    const r = await fetch(`${CFG.larkDomain}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (j.code === 0) return j.data;
    if (j.code === 99991663 || j.code === 99991661) { TOKEN = null; continue; } // token hết hạn
    if (r.status === 429 || j.code === 1254607 || j.code === 1254045) { await sleep(1200 * (attempt + 1)); continue; }
    throw new Error(`Lark ${apiPath} lỗi: ${j.code} ${j.msg}`);
  }
  throw new Error(`Lark ${apiPath}: hết lượt thử.`);
}

/** Revision của Base — cần cho "extra" khi Base bật quyền nâng cao. */
let APP_REV;
async function appRevision() {
  if (APP_REV !== undefined) return APP_REV;
  try {
    const d = await larkApi("GET", `/open-apis/bitable/v1/apps/${CFG.appToken}`);
    APP_REV = d.app?.revision ?? null;
  } catch { APP_REV = null; }
  return APP_REV;
}

/** Upload 1 buffer ảnh lên Lark drive (bitable_image) -> file_token.
 *  Base BẬT QUYỀN NÂNG CAO thì phải kèm "extra" (bitablePerm) mới được ghi media,
 *  nên thử cách thường trước, hỏng thì thử lại kèm extra. */
async function uploadMedia(buf, fileName, tableId) {
  const attempts = [null];
  const rev = await appRevision();
  if (tableId && rev != null) attempts.push(JSON.stringify({ bitablePerm: { tableId, rev } }));

  let last = "";
  for (const extra of attempts) {
    const token = await larkToken();
    const form = new FormData();
    form.append("file_name", fileName);
    form.append("parent_type", "bitable_image");
    form.append("parent_node", CFG.appToken);
    form.append("size", String(buf.length));
    if (extra) form.append("extra", extra);
    form.append("file", new Blob([buf]), fileName);
    const r = await fetch(`${CFG.larkDomain}/open-apis/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const j = await r.json();
    if (j.code === 0) {
      if (extra) log(`  (upload ảnh qua extra=bitablePerm — Base đang bật quyền nâng cao)`);
      return j.data.file_token;
    }
    last = `${j.code} ${j.msg}`;
  }
  throw new Error(`Upload media lỗi: ${last}`);
}

/** Tải ảnh từ URL rồi upload lên Lark drive -> file_token */
async function uploadThumb(imgUrl, fileName, tableId) {
  const ir = await fetch(imgUrl);
  if (!ir.ok) throw new Error(`Tải thumbnail lỗi ${ir.status}`);
  const buf = Buffer.from(await ir.arrayBuffer());
  return uploadMedia(buf, fileName, tableId);
}

async function listAllRecords(tableId) {
  const out = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({ page_size: "500" });
    if (pageToken) qs.set("page_token", pageToken);
    const data = await larkApi("GET", `/open-apis/bitable/v1/apps/${CFG.appToken}/tables/${tableId}/records?${qs}`);
    out.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return out;
}

const createRecord = (tableId, fields) =>
  larkApi("POST", `/open-apis/bitable/v1/apps/${CFG.appToken}/tables/${tableId}/records`, { fields });
const updateRecord = (tableId, recordId, fields) =>
  larkApi("PUT", `/open-apis/bitable/v1/apps/${CFG.appToken}/tables/${tableId}/records/${recordId}`, { fields });
const deleteRecord = (tableId, recordId) =>
  larkApi("DELETE", `/open-apis/bitable/v1/apps/${CFG.appToken}/tables/${tableId}/records/${recordId}`);

// ---------- PRE-FLIGHT (fail-fast quyền ghi trước khi kéo dữ liệu) ----------
// PNG 1x1 trong suốt để thử quyền upload media mà không cần tải ảnh ngoài.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
async function preflight() {
  log("\n== PRE-FLIGHT (kiểm tra quyền trước khi đồng bộ) ==");
  // 1) Quyền GHI Base — bắt lỗi 91403 sớm bằng cách tạo 1 record trống rồi xoá.
  let recId;
  try {
    const d = await createRecord(CFG.tableChannel, {});
    recId = d.record?.record_id;
    log("  ✓ Ghi Base OK");
  } catch (e) {
    throw new Error(
      `PRE-FLIGHT: GHI Base thất bại — ${e.message}\n` +
      `  → App (bot) chưa có quyền SỬA Base. Mở Base → Chia sẻ / Add collaborators → thêm app → chọn "Có thể chỉnh sửa". (lỗi 91403)`
    );
  }
  try { if (recId) await deleteRecord(CFG.tableChannel, recId); }
  catch { log("  ! không xoá được record thử — hãy xoá tay 1 dòng trống trong bảng kênh."); }
  // 2) Quyền UPLOAD ảnh — bắt lỗi 1061004 / thiếu scope drive:drive sớm.
  try {
    await uploadMedia(PIXEL_PNG, "_preflight.png");
    log("  ✓ Upload ảnh OK");
  } catch (e) {
    throw new Error(
      `PRE-FLIGHT: UPLOAD ảnh thất bại — ${e.message}\n` +
      `  → Thiếu scope drive:drive hoặc app không có quyền sửa Base. Thêm scope, phát hành lại app. (lỗi 1061004)`
    );
  }
  log("  → PRE-FLIGHT PASS. Bắt đầu đồng bộ.");
}

// ---------- YouTube ----------
async function getChannel(handleOrId) {
  const h = handleOrId.replace(/^@/, "");
  let url;
  if (/^UC[\w-]{22}$/.test(handleOrId)) url = `${YT}/channels?part=snippet,statistics,contentDetails&id=${handleOrId}&key=${CFG.youtubeApiKey}`;
  else url = `${YT}/channels?part=snippet,statistics,contentDetails&forHandle=${h}&key=${CFG.youtubeApiKey}`;
  const j = await jget(url);
  const ch = j.items?.[0];
  if (!ch) throw new Error(`Không tìm thấy kênh: ${handleOrId}`);
  return ch;
}

async function getAllUploadIds(uploadsPlaylist, limit) {
  const ids = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({ part: "contentDetails", playlistId: uploadsPlaylist, maxResults: "50", key: CFG.youtubeApiKey });
    if (pageToken) qs.set("pageToken", pageToken);
    const j = await jget(`${YT}/playlistItems?${qs}`);
    for (const it of j.items || []) ids.push(it.contentDetails.videoId);
    pageToken = j.nextPageToken || null;
    if (limit && ids.length >= limit) break;
  } while (pageToken);
  return limit ? ids.slice(0, limit) : ids;
}

async function getVideoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const j = await jget(`${YT}/videos?part=snippet,statistics&id=${batch.join(",")}&key=${CFG.youtubeApiKey}`);
    out.push(...(j.items || []));
  }
  return out;
}

function bestThumb(thumbs) {
  return (thumbs?.high || thumbs?.medium || thumbs?.default || {}).url;
}

// ---------- SYNC KÊNH ----------
async function syncChannel(ch) {
  log("\n== ĐỒNG BỘ KÊNH ==");
  const existing = await listAllRecords(CFG.tableChannel);
  const found = existing.find((r) => (r.fields["channel"]?.link || "").includes(ch.id) || r.fields["channel"]?.text === ch.snippet.title);

  const fields = {
    "channel": { link: `https://www.youtube.com/${ch.snippet.customUrl || "channel/" + ch.id}`, text: ch.snippet.title },
    "channel description": ch.snippet.description || "",
    "channel videoCount": num(ch.statistics.videoCount),
    "channel viewCount": num(ch.statistics.viewCount),
    "channel subscriberCount": num(ch.statistics.subscriberCount),
    "country": ch.snippet.country || undefined,
    "channel create time": Date.parse(ch.snippet.publishedAt),
  };

  let thumbError = false;
  const needThumb = args.refreshThumbs || !found || !(found.fields["thumbnails"]?.length);
  if (needThumb) {
    try {
      const ft = await uploadThumb(bestThumb(ch.snippet.thumbnails), `${ch.id}.jpg`, CFG.tableChannel);
      fields["thumbnails"] = [{ file_token: ft }];
    } catch (e) { log("  ! thumbnail kênh lỗi:", e.message); thumbError = true; }
  }

  if (found) { await updateRecord(CFG.tableChannel, found.record_id, fields); log(`  cập nhật kênh: ${ch.snippet.title}`); }
  else { await createRecord(CFG.tableChannel, fields); log(`  tạo mới kênh: ${ch.snippet.title}`); }
  return { action: found ? "cập nhật" : "tạo mới", thumbErrors: thumbError ? 1 : 0 };
}

// ---------- SYNC VIDEO ----------
async function syncVideos(ch) {
  log("\n== ĐỒNG BỘ VIDEO ==");
  const uploads = ch.contentDetails.relatedPlaylists.uploads;
  const ids = await getAllUploadIds(uploads, args.limit);
  log(`  YouTube: ${ids.length} video sẽ xử lý`);
  const details = await getVideoDetails(ids);
  log(`  Lấy chi tiết: ${details.length} video`);

  const existing = await listAllRecords(CFG.tableVideo);
  const byVid = new Map();
  for (const r of existing) {
    const vid = r.fields["video id"];
    if (vid) byVid.set(String(vid), r);
  }
  log(`  Lark hiện có: ${existing.length} record`);

  const channelLink = { link: `https://www.youtube.com/${ch.snippet.customUrl || "channel/" + ch.id}`, text: ch.snippet.title };
  let created = 0, updated = 0, thumbErrors = 0, writeErrors = 0, i = 0;
  for (const v of details) {
    i++;
    const cur = byVid.get(v.id);
    const st = v.statistics || {};
    const fields = {
      "video": { link: `https://www.youtube.com/watch?v=${v.id}`, text: v.snippet.title },
      "video description": v.snippet.description || "",
      "video id": v.id,
      "video tag": Array.isArray(v.snippet.tags) ? v.snippet.tags.slice(0, 100) : undefined,
      "publish time": Date.parse(v.snippet.publishedAt),
      "viewCount": num(st.viewCount),
      "likeCount": num(st.likeCount),
      "favoriteCount": num(st.favoriteCount),
      "commentCount": num(st.commentCount),
      "channel": channelLink,
    };

    const hasThumb = cur?.fields["thumbnails"]?.length;
    if (args.refreshThumbs || !hasThumb) {
      try {
        const ft = await uploadThumb(bestThumb(v.snippet.thumbnails), `${v.id}.jpg`, CFG.tableVideo);
        fields["thumbnails"] = [{ file_token: ft }];
      } catch (e) { log(`  ! thumb ${v.id} lỗi: ${e.message}`); thumbErrors++; }
    }

    try {
      if (cur) { await updateRecord(CFG.tableVideo, cur.record_id, fields); updated++; }
      else { await createRecord(CFG.tableVideo, fields); created++; }
    } catch (e) { log(`  ! ghi ${v.id} lỗi: ${e.message}`); writeErrors++; }

    if (i % 25 === 0) log(`  ... ${i}/${details.length} (tạo ${created}, cập nhật ${updated})`);
  }
  log(`  XONG video: tạo ${created}, cập nhật ${updated}, lỗi thumb ${thumbErrors}, lỗi ghi ${writeErrors}`);
  return { created, updated, thumbErrors, writeErrors };
}

// ---------- BÁO CÁO (đóng vòng monitor) ----------
async function sendReport(s) {
  if (!CFG.larkNotifyWebhook) return; // không cấu hình webhook -> bỏ qua im lặng
  const ok = s.status === "OK";
  const lines = [
    `**Kênh:** ${s.channel}`,
    `**Subs:** ${s.subs} · **Video (YouTube):** ${s.videos}`,
    `**Chế độ:** only=${s.only}${s.limit ? " · limit=" + s.limit : ""}`,
    "---",
    s.channelAction ? `**Kênh:** ${s.channelAction}` : null,
    s.videoCreated != null ? `**Video:** tạo ${s.videoCreated} · cập nhật ${s.videoUpdated}` : null,
    `**Lỗi:** thumbnail ${s.thumbErrors} · ghi ${s.writeErrors}`,
    `**Thời gian:** ${s.durationSec}s`,
    s.errorMsg ? `---\n**Chi tiết lỗi:** ${s.errorMsg}` : null,
  ].filter(Boolean);
  const card = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: ok ? "green" : "red",
        title: { tag: "plain_text", content: ok ? "✔ Sync YouTube → Lark hoàn tất" : "✖ Sync YouTube → Lark LỖI" },
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
    },
  };
  try {
    const r = await fetch(CFG.larkNotifyWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    const j = await r.json().catch(() => ({}));
    if (j.code === 0 || j.StatusCode === 0 || j.StatusMessage === "success") log("  ✓ Đã gửi card báo cáo Lark");
    else log(`  ! gửi card báo cáo lỗi: ${JSON.stringify(j)}`);
  } catch (e) { log(`  ! gửi card báo cáo lỗi: ${e.message}`); }
}

// ---------- MAIN ----------
async function main() {
  const t0 = Date.now();
  log(`Kênh nguồn: ${CFG.channel} | only=${args.only}${args.limit ? " limit=" + args.limit : ""}${args.refreshThumbs ? " refresh-thumbs" : ""}`);
  if (!args.skipPreflight) await preflight();
  const ch = await getChannel(CFG.channel);
  log(`Đã lấy kênh: ${ch.snippet.title} (${ch.id}) — subs ${ch.statistics.subscriberCount}, videos ${ch.statistics.videoCount}`);

  const summary = {
    channel: ch.snippet.title, subs: ch.statistics.subscriberCount, videos: ch.statistics.videoCount,
    only: args.only, limit: args.limit, thumbErrors: 0, writeErrors: 0, status: "OK",
  };
  if (args.only === "all" || args.only === "channel") {
    const r = await syncChannel(ch);
    summary.channelAction = r.action;
    summary.thumbErrors += r.thumbErrors;
  }
  if (args.only === "all" || args.only === "video") {
    const r = await syncVideos(ch);
    summary.videoCreated = r.created; summary.videoUpdated = r.updated;
    summary.thumbErrors += r.thumbErrors; summary.writeErrors += r.writeErrors;
  }
  summary.durationSec = Math.round((Date.now() - t0) / 1000);
  log("\n✔ Hoàn tất.");
  await sendReport(summary);
}
main().catch(async (e) => {
  console.error("LỖI:", e.message);
  try {
    await sendReport({
      channel: CFG.channel, subs: "?", videos: "?", only: args.only, limit: args.limit,
      thumbErrors: 0, writeErrors: 0, durationSec: 0, status: "FAIL", errorMsg: e.message,
    });
  } catch { /* báo cáo lỗi không được thì thôi */ }
  process.exit(1);
});

# 00 — PHIẾU INPUT (điền xong là chạy) — YouTube ⇄ Lark

> **Ô I của ITTO**: chuẩn bị TRƯỚC khi bấm chạy. Chi tiết trong `huong-dan/` (`README-CAI-DAT.md`,
> `SETUP-GITHUB.md`, `CHECKLIST-CAI-DAT-YOUTUBE.md`) và `TRIEN-KHAI.md`. Soát hợp đồng: `node check-itto.mjs`.

| # | Việc | Điền / xác nhận | Xong? |
|---|---|---|---|
| 1 | **App Lark** + quyền `bitable:app` + thêm app vào Base | LARK_APP_ID `cli_…`, LARK_BASE_ID `…` | ☐ |
| 2 | **3 bảng**: `setup-tables.mjs` (16.1+16.2) + `setup-table.mjs` (16.3) — hoặc `init-tables.yml` | TABLE_CHANNEL/​VIDEO/​POST (`tbl…`) | ☐ |
| 3 | **YouTube Data API key** (Google Cloud) — cho sync | YOUTUBE_API_KEY | ☐ |
| 4 | **OAuth đăng video**: client desktop → `get-oauth-token.mjs` lấy refresh token | YT_OAUTH_CLIENT_ID/​SECRET, YT_OAUTH_REFRESH_TOKEN | ☐ |
| 5 | **Nạp GitHub** — Secret + Variable — `huong-dan/SETUP-GITHUB.md` | ✅ / ❌ | ☐ |
| 6 | **Preflight**: `node check-itto.mjs` → XANH (đủ 4 mục + mọi script có mặt) | ✅ / ❌ | ☐ |
| 7 | **Nối nút/lịch** Lark (tick "Đăng ngay" cho 16.3) — `LARK-AUTOMATION.md` | ✅ / ❌ | ☐ |

**Secrets:** `YOUTUBE_API_KEY` · `LARK_APP_SECRET` · `YT_OAUTH_CLIENT_SECRET` · `YT_OAUTH_REFRESH_TOKEN` · `LARK_NOTIFY_WEBHOOK` (tuỳ chọn)
**Variables:** `LARK_APP_ID` · `LARK_DOMAIN` · `LARK_BASE_ID` · `TABLE_CHANNEL` · `TABLE_VIDEO` · `TABLE_POST` · `YT_OAUTH_CLIENT_ID` · `YT_CATEGORY_ID` · `YT_PRIVACY` · `YT_CHANNEL`

**event_type:** `sync-youtube` (kéo kênh+video) · `dang-video-youtube` (đăng, kèm `record_id`).

> Đăng cần **refresh token OAuth** (`get-oauth-token.mjs`, chạy 1 lần). Sync chỉ cần API key.
> 1 repo phục vụ nhiều kênh/base: truyền `channel`/`base_id`/`table_*` qua `client_payload`.

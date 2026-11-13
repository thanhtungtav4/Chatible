/**
 * Server-rendered Super Admin Control Deck UI (CSP nonce protected).
 */
export function renderAdminDashboardHtml(nonce: string): string {
    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chatible Super Admin — Control Deck (S11)</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #131b2e;
      --border: rgba(255, 255, 255, 0.08);
      --accent: #0066ff;
      --text: #f8fafc;
      --muted: #94a3b8;
      --danger: #ff3b30;
      --success: #10b981;
      --warning: #f59e0b;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 260px;
      background: var(--card);
      border-right: 1px solid var(--border);
      padding: 24px 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      flex-shrink: 0;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 800; }
    .brand-badge { background: rgba(0, 102, 255, 0.2); color: var(--accent); padding: 3px 8px; border-radius: 999px; font-size: 11px; }
    .nav-btn {
      display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 12px;
      border: none; background: transparent; color: var(--muted); font-size: 13px; font-weight: 700;
      cursor: pointer; text-align: left; transition: all 180ms ease;
    }
    .nav-btn.active, .nav-btn:hover { background: rgba(0, 102, 255, 0.15); color: #fff; }
    .main-content { flex: 1; padding: 32px 38px; overflow-y: auto; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 18px; margin-bottom: 28px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 18px; padding: 20px; }
    .stat-val { font-size: 28px; font-weight: 800; margin-top: 6px; letter-spacing: -0.02em; }
    .stat-lbl { font-size: 12px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .table-card { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 24px; margin-bottom: 24px; }
    .card-title { font-size: 17px; font-weight: 800; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    td { padding: 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); color: #e2e8f0; }
    .btn-action { background: var(--accent); color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer; transition: opacity 160ms; }
    .btn-action:hover { opacity: 0.85; }
    .btn-action:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-danger { background: var(--danger); }
    .btn-secondary { background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border); color: #fff; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; }
    .badge-open { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
    .badge-active { background: rgba(16, 185, 129, 0.15); color: var(--success); }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.82); display: none; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(8px); }
    .modal-box { background: var(--card); border: 1px solid var(--border); border-radius: 20px; width: 780px; max-width: 94%; max-height: 86vh; overflow-y: auto; padding: 28px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); }
    .transcript-bubble { background: rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; font-size: 13px; }
    .input-dark { background: rgba(0, 0, 0, 0.3); border: 1px solid var(--border); color: #fff; padding: 9px 12px; border-radius: 8px; font-size: 13px; box-sizing: border-box; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(255, 255, 255, 0.2); transition: .3s; border-radius: 24px; }
    .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .toggle-slider { background-color: var(--accent); }
    input:checked + .toggle-slider:before { transform: translateX(20px); }
  </style>
</head>
<body>

  <aside class="sidebar">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      <span>Chatible</span>
      <span class="brand-badge">ADMIN S11</span>
    </div>

    <nav style="display: flex; flex-direction: column; gap: 6px;">
      <button class="nav-btn active" data-tab="tab-stats">📊 Thống kê & Tổng quan</button>
      <button class="nav-btn" data-tab="tab-reports">🚨 Hàng Báo Cáo Vi Phạm</button>
      <button class="nav-btn" data-tab="tab-appeals">⚖️ Đơn Khiếu Nại (Appeals)</button>
      <button class="nav-btn" data-tab="tab-sessions">💬 Tra Cứu Phiên Chat</button>
      <button class="nav-btn" data-tab="tab-groups">📢 Nhóm & Kênh Cộng Đồng</button>
      <button class="nav-btn" data-tab="tab-audit">📜 Nhật Ký AuditLog</button>
      <button class="nav-btn" data-tab="tab-settings">⚙️ Cấu Hình Hệ Thống</button>
    </nav>

    <div style="margin-top: auto; padding: 14px; background: rgba(0, 102, 255, 0.08); border-radius: 14px; font-size: 11.5px; line-height: 1.5; color: var(--muted);">
      🔒 <strong>Bảo Mật Hiến Pháp:</strong> Mọi lượt giải mã tin nhắn, xem media hay thay đổi cấu hình đều ghi chuỗi băm <code>AuditLog</code> bất biến.
    </div>
  </aside>

  <main class="main-content">
    <header style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px;">
      <div>
        <h1 style="font-size: 24px; font-weight: 800; margin: 0;">Bảng Điều Hành & Quản Trị Tối Cao</h1>
        <p style="font-size: 13px; color: var(--muted); margin: 4px 0 0 0;">Giám sát hệ thống, phân xử vi phạm và tra cứu nội dung/media có kiểm toán.</p>
      </div>

      <div style="display: flex; align-items: center; gap: 10px;">
        <span class="badge badge-active">● Super Admin (15m Session)</span>
        <button class="btn-action" id="btn-refresh-data">Làm mới</button>
        <button class="btn-action btn-danger" id="btn-admin-logout">Đăng xuất</button>
      </div>
    </header>

    <!-- TAB 1: THỐNG KÊ -->
    <section id="tab-stats">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-lbl">Tổng Người Dùng</div><div class="stat-val" id="stat-total-users">--</div></div>
        <div class="stat-card"><div class="stat-lbl">Phiên Đang Chạy</div><div class="stat-val" style="color: var(--success);" id="stat-active-sessions">--</div></div>
        <div class="stat-card"><div class="stat-lbl">Tổng Tin Nhắn Mã Hóa</div><div class="stat-val" style="color: var(--accent);" id="stat-total-messages">--</div></div>
        <div class="stat-card"><div class="stat-lbl">Báo Cáo Chờ Xử Lý</div><div class="stat-val" style="color: var(--warning);" id="stat-pending-reports">--</div></div>
      </div>

      <div class="table-card">
        <div class="card-title">Phân Bổ Nhân Khẩu Học & Giới Tính</div>
        <div id="stat-gender-breakdown" style="font-size: 14px; color: var(--muted); display: flex; gap: 24px; margin-top: 10px;"></div>
      </div>
    </section>

    <!-- TAB 2: BÁO CÁO VI PHẠM -->
    <section id="tab-reports" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <span>Danh Sách Báo Cáo & Bằng Chứng Đóng Băng 90 Ngày</span>
          <span style="font-size: 12px; color: var(--muted);">KMS AuditLog tự động mỗi lần giải mã</span>
        </div>
        <table>
          <thead><tr><th>ID Báo Cáo</th><th>Lý Do</th><th>Mô Tả</th><th>Trạng Thái</th><th>Hết Hạn</th><th>Thao Tác</th></tr></thead>
          <tbody id="table-reports-body"><tr><td colspan="6" style="text-align:center;color:var(--muted);">Đang tải...</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- TAB 2B: KHIẾU NẠI -->
    <section id="tab-appeals" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <span>Quản Lý Đơn Khiếu Nại (Appeals)</span>
          <span style="font-size: 12px; color: var(--muted);">Phê duyệt sẽ tự động gỡ khóa tài khoản</span>
        </div>
        <table>
          <thead><tr><th>ID</th><th>User ID</th><th>Lý Do</th><th>Trạng Thái</th><th>Ngày Gửi</th><th>Xử Lý</th></tr></thead>
          <tbody id="table-appeals-body"><tr><td colspan="6" style="text-align:center;color:var(--muted);">Đang tải...</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- TAB 3: PHIÊN CHAT + TÌM KIẾM + PHÂN TRANG -->
    <section id="tab-sessions" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <span>Tra Cứu Phiên Chat (Có Phân Trang & Giải Mã Media)</span>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <input type="text" id="filter-session-search" class="input-dark" placeholder="Tìm ID hoặc biệt danh..." style="width: 210px;" />
            <select id="filter-session-type" class="input-dark">
              <option value="">Tất cả loại</option>
              <option value="RANDOM">RANDOM</option>
              <option value="FRIEND">FRIEND</option>
            </select>
            <select id="filter-session-status" class="input-dark">
              <option value="">Mọi trạng thái</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="ENDED">ENDED</option>
            </select>
            <button type="button" class="btn-action" id="btn-search-sessions">Lọc</button>
          </div>
        </div>
        <table>
          <thead><tr><th>Session ID</th><th>Loại</th><th>User A</th><th>User B</th><th>Trạng Thái</th><th>Tin Nhắn</th><th>Thao Tác</th></tr></thead>
          <tbody id="table-sessions-body"><tr><td colspan="7" style="text-align:center;color:var(--muted);">Đang tải...</td></tr></tbody>
        </table>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px; font-size: 12px; color: var(--muted);">
          <span id="sessions-pagination-info">Trang 1</span>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-action btn-secondary" id="btn-sessions-prev">← Trước</button>
            <button type="button" class="btn-action btn-secondary" id="btn-sessions-next">Sau →</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 3B: NHÓM & KÊNH CỘNG ĐỒNG -->
    <section id="tab-groups" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <span>Quản Lý Kênh Thông Báo & Nhóm Cộng Đồng</span>
        </div>
        <form id="admin-create-group-form" style="display: grid; grid-template-columns: 1.5fr 1fr 1fr auto; gap: 10px; margin-bottom: 20px; align-items: end;">
          <div>
            <label style="display:block;font-size:11px;margin-bottom:4px;color:var(--muted);">Tên Kênh / Nhóm</label>
            <input type="text" id="grp-name" class="input-dark" style="width:100%;" placeholder="VD: Thông báo bảo mật..." required />
          </div>
          <div>
            <label style="display:block;font-size:11px;margin-bottom:4px;color:var(--muted);">Loại phòng</label>
            <select id="grp-type" class="input-dark" style="width:100%;">
              <option value="BROADCAST">BROADCAST (Admin đăng)</option>
              <option value="PUBLIC">PUBLIC (Mở tự do)</option>
              <option value="PRIVATE_PASSCODE">PRIVATE (Cần mật khẩu)</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:11px;margin-bottom:4px;color:var(--muted);">Mật khẩu (nếu Private)</label>
            <input type="text" id="grp-passcode" class="input-dark" style="width:100%;" placeholder="Tối thiểu 4 ký tự" />
          </div>
          <button type="submit" class="btn-action" style="padding: 10px 18px;">+ Tạo Phòng</button>
        </form>
        <table>
          <thead><tr><th>Tên Phòng</th><th>Loại</th><th>Thành Viên</th><th>Đăng Thông Báo Nhanh</th></tr></thead>
          <tbody id="table-groups-body"><tr><td colspan="4" style="text-align:center;color:var(--muted);">Đang tải...</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- TAB 4: NHẬT KÝ AUDITLOG + XÁC MINH + EXPORT -->
    <section id="tab-audit" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <div>
            <span>Nhật Ký Kiểm Toán Bất Biến (Append-Only Hash Chain)</span>
            <div id="audit-chain-badge" style="font-size: 12px; color: var(--muted); margin-top: 4px;">Chưa kiểm tra chuỗi băm...</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-action btn-secondary" id="btn-verify-audit">🛡️ Kiểm Tra Chuỗi Băm</button>
            <button type="button" class="btn-action" id="btn-export-audit">📦 Xuất JSONL / WORM S3</button>
          </div>
        </div>
        <table>
          <thead><tr><th>Seq / Thời Gian</th><th>Actor</th><th>Hành Động</th><th>Tài Nguyên</th><th>Entry Hash</th><th>IP</th></tr></thead>
          <tbody id="table-audit-body"><tr><td colspan="6" style="text-align:center;color:var(--muted);">Đang tải...</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- TAB 5: CẤU HÌNH HỆ THỐNG -->
    <section id="tab-settings" style="display: none;">
      <div class="table-card">
        <div class="card-title">
          <span>⚙️ Cấu Hình Hệ Thống, Xác Thực, SMTP & Bảo Mật Admin</span>
        </div>

        <!-- Admin MFA 2FA Box -->
        <div style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 12px; padding: 18px; margin-bottom: 24px; max-width: 680px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong style="font-size:14px;">🔐 Xác Thực 2 Bước Quản Trị Viên (TOTP MFA)</strong>
              <div id="mfa-status-text" style="font-size:12px;color:var(--muted);margin-top:4px;">Đang kiểm tra trạng thái MFA...</div>
            </div>
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn-action" id="btn-mfa-setup">Thiết Lập 2FA</button>
            </div>
          </div>
          <div id="mfa-setup-box" style="display:none; margin-top:14px; border-top:1px solid var(--border); padding-top:14px;">
            <div style="font-size:12px;color:var(--text);">Secret Base32 (nhập vào Google Authenticator / 1Password):</div>
            <code id="mfa-secret-display" style="display:block;margin:8px 0;padding:8px;background:rgba(0,0,0,0.4);border-radius:6px;font-size:13px;word-break:break-all;"></code>
            <div style="display:flex;gap:8px;">
              <input type="text" id="mfa-confirm-code" class="input-dark" placeholder="Nhập mã 6 số để kích hoạt..." maxlength="6" />
              <button type="button" class="btn-action" id="btn-mfa-confirm">Xác Nhận Kích Hoạt</button>
            </div>
          </div>
        </div>

        <form id="settings-auth-form" style="display: flex; flex-direction: column; gap: 20px; max-width: 680px;">
          <!-- Tài khoản Quản trị Super Admin (/admin-auth) -->
          <div style="background: rgba(0, 102, 255, 0.05); border: 1px solid rgba(0, 102, 255, 0.25); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 14px; display: block; color: var(--accent);">👑 Tài Khoản & Quyền Quản Trị Super Admin (/admin-auth)</strong>
                <span style="font-size: 12px; color: var(--muted);">Cấu hình tài khoản đăng nhập và tài khoản Gmail liên kết quyền quản trị</span>
              </div>
              <span class="brand-badge">/admin-auth</span>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Tên đăng nhập Admin</label>
                <input type="text" id="cfg-admin-username" class="input-dark" style="width:100%;" placeholder="admin" />
              </div>
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Đổi Mật khẩu Admin</label>
                <input type="password" id="cfg-admin-password" class="input-dark" style="width:100%;" placeholder="•••••••• (để trống nếu không đổi)" />
              </div>
            </div>

            <div>
              <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Gmail Liên Kết Đăng Nhập Quản Trị (Google Sign-In)</label>
              <input type="email" id="cfg-admin-google-email" class="input-dark" style="width:100%;font-family:'JetBrains Mono',monospace;" placeholder="nguyenthanhtung74119@gmail.com" />
              <span style="font-size: 11.5px; color: var(--muted); margin-top: 4px; display: block;">Khi đăng nhập bằng Google tại <code>/admin-auth</code>, tài khoản Gmail này sẽ tự động được cấp quyền Super Admin.</span>
            </div>
          </div>

          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 18px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <div>
                <strong style="font-size: 14px; display: block;">Đăng nhập bằng tài khoản Google (OAuth 2.0)</strong>
                <span style="font-size: 12px; color: var(--muted);">Bật/tắt nút Google Sign-In trên giao diện người dùng</span>
              </div>
              <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
                <input type="checkbox" id="cfg-google-enabled" style="opacity: 0; width: 0; height: 0;" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Google Client ID</label>
            <input type="text" id="cfg-google-client-id" class="input-dark" style="width:100%;font-family:'JetBrains Mono',monospace;" placeholder="123456789-abcdef.apps.googleusercontent.com" />
          </div>

          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 14px; display: block;">Cho phép Đăng Ký Tài Khoản Mới</strong>
                <span style="font-size: 12px; color: var(--muted);">Tắt mục này khi hệ thống bảo trì</span>
              </div>
              <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
                <input type="checkbox" id="cfg-reg-enabled" style="opacity: 0; width: 0; height: 0;" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 12px;">
              <div>
                <strong style="font-size: 14px; display: block;">Bắt Buộc Xác Minh Email Trước Khi Tìm Bạn</strong>
                <span style="font-size: 12px; color: var(--muted);">Khi bật, tài khoản đăng ký bằng email phải nhập OTP xác minh mới được ghép đôi</span>
              </div>
              <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
                <input type="checkbox" id="cfg-email-verif-required" style="opacity: 0; width: 0; height: 0;" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="card-title" style="margin-top: 8px; margin-bottom: 0;">
            <span>📧 Cấu Hình Gửi Mail Tự Động (SMTP)</span>
          </div>
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="font-size: 14px; display: block;">Kích hoạt Gửi Email SMTP</strong>
                <span style="font-size: 12px; color: var(--muted);">Tự động gửi email mã OTP 6 số khi quên mật khẩu</span>
              </div>
              <label style="position: relative; display: inline-block; width: 44px; height: 24px;">
                <input type="checkbox" id="cfg-mail-enabled" style="opacity: 0; width: 0; height: 0;" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span style="font-size: 11px; color: var(--muted);">Mẫu nhanh:</span>
              <button type="button" class="btn-action btn-secondary" data-smtp-preset="gmail">Gmail (587)</button>
              <button type="button" class="btn-action btn-secondary" data-smtp-preset="resend">Resend (465)</button>
              <button type="button" class="btn-action btn-secondary" data-smtp-preset="sendgrid">SendGrid (587)</button>
            </div>
            <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">SMTP Host</label>
                <input type="text" id="cfg-mail-host" class="input-dark" style="width:100%;" placeholder="smtp.gmail.com" />
              </div>
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">SMTP Port</label>
                <input type="number" id="cfg-mail-port" min="1" max="65535" class="input-dark" style="width:100%;" placeholder="587" />
              </div>
            </div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
              <input type="checkbox" id="cfg-mail-secure" />
              <span>Sử dụng SSL/TLS trực tiếp (Port 465)</span>
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Username</label>
                <input type="text" id="cfg-mail-user" class="input-dark" style="width:100%;" />
              </div>
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Password / App Password</label>
                <input type="password" id="cfg-mail-password" class="input-dark" style="width:100%;" placeholder="********" />
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">From Name</label>
                <input type="text" id="cfg-mail-from-name" class="input-dark" style="width:100%;" />
              </div>
              <div>
                <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">From Address</label>
                <input type="email" id="cfg-mail-from-address" class="input-dark" style="width:100%;" />
              </div>
            </div>
            <div style="border-top: 1px solid var(--border); padding-top: 12px;">
              <div style="display: flex; gap: 10px;">
                <input type="email" id="cfg-mail-test-to" class="input-dark" style="flex: 1;" placeholder="Email nhận thử nghiệm..." />
                <button type="button" id="btn-test-mail" class="btn-action btn-secondary">✉️ Gửi Thử Nghiệm</button>
              </div>
              <div id="mail-test-status" style="font-size: 12px; margin-top: 8px; display: none;"></div>
            </div>
          </div>

          <div class="card-title" style="margin-top: 8px; margin-bottom: 0;">
            <span>📦 Cấu Hình Lưu Trữ Media & Tệp Tin (Object Storage / S3 / R2)</span>
          </div>
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px;">
            <div>
              <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Phương Thức Lưu Trữ (Storage Driver)</label>
              <select id="cfg-storage-driver" class="input-dark" style="width: 100%;">
                <option value="LOCAL">📁 Lưu Trực Tiếp Trên Máy Chủ VPS (data/media_uploads - Mặc định)</option>
                <option value="S3">☁️ Cloud Object Storage S3 / Cloudflare R2 / AWS S3 / MinIO</option>
              </select>
              <span style="font-size: 11.5px; color: var(--muted); margin-top: 4px; display: block;">Mặc định không cấu hình S3 thì tệp ảnh/audio được mã hóa AES-GCM và lưu an toàn trên ổ đĩa VPS cục bộ, không bao giờ báo lỗi thiếu lưu trữ.</span>
            </div>

            <div id="storage-s3-config-box" style="display: none; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); padding-top: 14px;">
              <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 12px;">
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">S3 / R2 Endpoint</label>
                  <input type="text" id="cfg-storage-endpoint" class="input-dark" style="width:100%;font-family:'JetBrains Mono',monospace;" placeholder="https://<account-id>.r2.cloudflarestorage.com" />
                </div>
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Bucket Name</label>
                  <input type="text" id="cfg-storage-bucket" class="input-dark" style="width:100%;" placeholder="chatible-media" />
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Access Key ID</label>
                  <input type="text" id="cfg-storage-access-key" class="input-dark" style="width:100%;font-family:'JetBrains Mono',monospace;" placeholder="AKIA..." />
                </div>
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Secret Access Key</label>
                  <input type="password" id="cfg-storage-secret-key" class="input-dark" style="width:100%;font-family:'JetBrains Mono',monospace;" placeholder="••••••••" />
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Region (Vùng)</label>
                  <input type="text" id="cfg-storage-region" class="input-dark" style="width:100%;" placeholder="auto (hoặc us-east-1)" />
                </div>
                <div style="display: flex; align-items: center; padding-top: 20px;">
                  <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                    <input type="checkbox" id="cfg-storage-force-path" checked />
                    <span>Force Path Style (khuyên dùng cho Cloudflare R2 / MinIO)</span>
                  </label>
                </div>
              </div>
            </div>

            <div style="border-top: 1px solid var(--border); padding-top: 12px;">
              <div style="display: flex; gap: 10px; align-items: center;">
                <button type="button" id="btn-test-storage" class="btn-action btn-secondary">⚡ Kiểm Tra Kết Nối Lưu Trữ</button>
                <span id="storage-test-status" style="font-size: 12px; display: none;"></span>
              </div>
            </div>
          </div>

          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 18px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;">
            <div>
              <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Chat Ngẫu Nhiên (Ngày)</label>
              <input type="number" id="cfg-retention-random" min="1" max="30" class="input-dark" style="width:100%;" />
            </div>
            <div>
              <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Chat Bạn Bè (Ngày)</label>
              <input type="number" id="cfg-retention-friend" min="1" max="365" class="input-dark" style="width:100%;" />
            </div>
            <div>
              <label style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px;">Bằng Chứng Báo Cáo (Ngày)</label>
              <input type="number" id="cfg-retention-report" min="30" max="365" class="input-dark" style="width:100%;" />
            </div>
          </div>

          <div style="display: flex; gap: 12px; align-items: center;">
            <button type="submit" class="btn-action" style="padding: 10px 24px; font-size: 13px;">💾 Lưu Cấu Hình Hệ Thống</button>
            <span id="settings-save-status" style="font-size: 12px; display: none;"></span>
          </div>
        </form>
      </div>
    </section>
  </main>

  <!-- Transcript / Evidence / Media Modal -->
  <div class="modal-overlay" id="transcript-modal">
    <div class="modal-box">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;">
        <h3 style="margin: 0; font-size: 18px;" id="modal-transcript-title">Chi Tiết</h3>
        <button type="button" class="btn-action btn-danger" id="btn-close-modal">Đóng</button>
      </div>
      <div style="background: rgba(245, 158, 11, 0.1); color: var(--warning); padding: 12px; border-radius: 10px; font-size: 12px; margin-bottom: 16px;">
        ⚠️ <strong>Thông báo kiểm toán:</strong> Mọi lượt giải mã tin nhắn hoặc media vừa được ghi vào <code>AuditLog</code>.
      </div>
      <div id="modal-transcript-content"></div>
    </div>
  </div>

  <!-- Admin Login Modal (Username + Password / Secret / Google Sign-In) -->
  <div class="modal-overlay" id="admin-login-modal" style="display: none;">
    <div class="modal-box" style="width: 440px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <h3 style="margin:0;font-size:18px;">🔒 Đăng Nhập Quản Trị Hệ Thống</h3>
        <span class="brand-badge">/admin-auth</span>
      </div>
      <p style="font-size:12.5px;color:var(--muted);margin-top:0;">Xác thực Super Admin để truy cập Bảng điều hành Chatible.</p>
      
      <!-- Google Sign-In Section for Admin -->
      <div id="admin-google-login-section" style="margin-top:16px;display:none;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;text-align:center;">Đăng nhập nhanh bằng tài khoản Google liên kết:</div>
        <div id="google-admin-btn" style="min-height:44px;display:flex;justify-content:center;"></div>
        <div id="admin-linked-gmail-hint" style="font-size:11.5px;color:#10b981;margin-top:6px;text-align:center;"></div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;text-align:center;line-height:1.4;">
          (Lưu ý: Nếu trình duyệt Brave bị kẹt màn hình trắng, hãy tắt khiên Brave Shields hoặc dùng tài khoản & mật khẩu bên dưới)
        </div>
        
        <div style="display:flex;align-items:center;gap:12px;margin:18px 0 14px;">
          <div style="flex:1;height:1px;background:var(--border);"></div>
          <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;">Hoặc dùng tài khoản Admin</span>
          <div style="flex:1;height:1px;background:var(--border);"></div>
        </div>
      </div>

      <form id="admin-login-form" style="display:flex;flex-direction:column;gap:12px;">
        <input type="hidden" id="admin-login-secret" />
        <div>
          <label style="display:block;font-size:12px;margin-bottom:4px;">Tên đăng nhập (Username)</label>
          <input type="text" id="admin-login-username" class="input-dark" style="width:100%;" placeholder="admin" value="admin" autocomplete="username" />
        </div>
        <div>
          <label style="display:block;font-size:12px;margin-bottom:4px;">Mật khẩu (Password)</label>
          <input type="password" id="admin-login-password" class="input-dark" style="width:100%;" placeholder="Nhập mật khẩu quản trị" autocomplete="current-password" />
        </div>
        <div id="admin-login-totp-group" style="display:none;">
          <label style="display:block;font-size:12px;margin-bottom:4px;">Mã xác thực TOTP 2 bước (6 chữ số)</label>
          <input type="text" id="admin-login-totp" class="input-dark" style="width:100%;" maxlength="6" placeholder="000000" />
        </div>
        <div id="admin-login-error" style="color:var(--danger);font-size:12px;display:none;background:rgba(255,59,48,0.1);padding:8px 12px;border-radius:8px;border:1px solid rgba(255,59,48,0.2);"></div>
        <button type="submit" class="btn-action" style="padding:11px;font-size:13.5px;font-weight:700;">Đăng Nhập Quản Trị</button>
      </form>
    </div>
  </div>

  <script nonce="${nonce}">
    function escapeHtml(value) {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(value ?? '').replace(/[&<>"']/g, c => entities[c]);
    }

    let isAdminAuthenticated = false;
    let sessionsPage = 1;
    let pendingLoginPromise = null;

    async function promptAdminLogin() {
      if (pendingLoginPromise) return pendingLoginPromise;

      pendingLoginPromise = (async () => {
        const modal = document.getElementById('admin-login-modal');
        const form = document.getElementById('admin-login-form');
        const errEl = document.getElementById('admin-login-error');
        errEl.style.display = 'none';
        modal.style.display = 'flex';

        return await new Promise((resolve) => {
          // 1. Fetch public status to configure MFA, username, and Google Sign-in
          fetch('/api/v1/admin/auth/status')
            .then(r => r.json())
            .then(statusData => {
              document.getElementById('admin-login-totp-group').style.display = statusData.mfaRequired ? 'block' : 'none';
              if (statusData.defaultUsername) {
                document.getElementById('admin-login-username').value = statusData.defaultUsername;
              }
              if (statusData.googleAuthEnabled && statusData.googleClientId) {
                document.getElementById('admin-google-login-section').style.display = 'block';
                if (statusData.linkedGoogleEmail) {
                  document.getElementById('admin-linked-gmail-hint').textContent = '✓ Gmail đã liên kết: ' + statusData.linkedGoogleEmail;
                }
                const initGsi = () => {
                  if (window.google?.accounts?.id) {
                    window.google.accounts.id.initialize({
                      client_id: statusData.googleClientId,
                      ux_mode: 'popup',
                      itp_support: true,
                      auto_select: false,
                      callback: async (resp) => {
                        errEl.style.display = 'none';
                        try {
                          const gRes = await fetch('/api/v1/admin/auth/google', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ idToken: resp.credential }),
                            credentials: 'include',
                          });
                          const gData = await gRes.json().catch(() => ({}));
                          if (!gRes.ok) {
                            errEl.textContent = gData.error || 'Đăng nhập Google thất bại.';
                            errEl.style.display = 'block';
                            return;
                          }
                          isAdminAuthenticated = true;
                          modal.style.display = 'none';
                          resolve(true);
                        } catch {
                          errEl.textContent = 'Lỗi kết nối máy chủ khi xác thực Google.';
                          errEl.style.display = 'block';
                        }
                      }
                    });
                    window.google.accounts.id.renderButton(
                      document.getElementById('google-admin-btn'),
                      { theme: 'outline', size: 'large', width: '380', text: 'signin_with', locale: 'vi' }
                    );
                  } else {
                    setTimeout(initGsi, 150);
                  }
                };
                initGsi();
              }
            })
            .catch(() => {});

          form.onsubmit = async (e) => {
            e.preventDefault();
            errEl.style.display = 'none';
            const secret = (document.getElementById('admin-login-secret')?.value || '').trim();
            const username = (document.getElementById('admin-login-username')?.value || 'admin').trim();
            const password = (document.getElementById('admin-login-password')?.value || secret || '').trim();
            const totpCode = document.getElementById('admin-login-totp').value.trim();

            if (!password && !secret) {
              errEl.textContent = 'Vui lòng nhập mật khẩu quản trị.';
              errEl.style.display = 'block';
              return;
            }

            const res = await fetch('/api/v1/admin/auth', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ username, password, secret, totpCode }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              errEl.textContent = data.error || 'Xác thực thất bại.';
              errEl.style.display = 'block';
              return;
            }
            isAdminAuthenticated = true;
            modal.style.display = 'none';
            document.getElementById('admin-login-password').value = '';
            document.getElementById('admin-login-totp').value = '';
            resolve(true);
          };
        });
      })().finally(() => {
        pendingLoginPromise = null;
      });

      return pendingLoginPromise;
    }

    function getCookieValue(name) {
      const prefix = name + '=';
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
          return decodeURIComponent(trimmed.slice(prefix.length));
        }
      }
      return '';
    }

    function withAdminHeaders(options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      const headers = new Headers(options.headers || {});
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const csrfToken = getCookieValue('chatible_admin_csrf');
        if (csrfToken && !headers.has('X-CSRF-Token')) {
          headers.set('X-CSRF-Token', csrfToken);
        }
      }
      return { ...options, credentials: 'include', headers };
    }

    async function adminFetch(url, options = {}) {
      const res = await fetch(url, withAdminHeaders(options));
      if (res.status === 401) {
        isAdminAuthenticated = false;
        await promptAdminLogin();
        return fetch(url, withAdminHeaders(options));
      }
      isAdminAuthenticated = true;
      return res;
    }

    function switchTab(tabId) {
      ['tab-stats', 'tab-reports', 'tab-appeals', 'tab-sessions', 'tab-groups', 'tab-audit', 'tab-settings'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === tabId ? 'block' : 'none';
      });
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      if (tabId === 'tab-settings') { loadSettings(); loadMfaStatus(); }
      if (tabId === 'tab-appeals') loadAppeals();
      if (tabId === 'tab-groups') loadAdminGroups();
    }

    async function loadStats() {
      try {
        const res = await adminFetch('/api/v1/admin/stats');
        if (!res.ok) throw new Error();
        const data = await res.json();
        document.getElementById('stat-total-users').textContent = data.totalUsers.toLocaleString();
        document.getElementById('stat-active-sessions').textContent = data.activeSessions.toLocaleString();
        document.getElementById('stat-total-messages').textContent = data.totalMessages.toLocaleString();
        document.getElementById('stat-pending-reports').textContent = data.pendingReports.toLocaleString();
        document.getElementById('stat-gender-breakdown').innerHTML =
          '<div>Nam: <strong>' + escapeHtml(data.genderBreakdown.male) + '</strong></div>' +
          '<div>Nữ: <strong>' + escapeHtml(data.genderBreakdown.female) + '</strong></div>' +
          '<div>Khác: <strong>' + escapeHtml(data.genderBreakdown.other) + '</strong></div>';
      } catch {}
    }

    async function loadReports() {
      const tbody = document.getElementById('table-reports-body');
      try {
        const res = await adminFetch('/api/v1/admin/reports');
        const list = await res.json();
        if (!list.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);">Không có báo cáo nào.</td></tr>';
          return;
        }
        tbody.innerHTML = list.map(r => \`
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;">\${escapeHtml(r.id)}</td>
            <td><span class="badge" style="background:rgba(255,59,48,0.15);color:var(--danger);">\${escapeHtml(r.reason)}</span>\${r.roomId ? ' <span class="badge" style="background:rgba(168,85,247,0.18);color:#c084fc;">Nhóm</span>' : ''}</td>
            <td>\${escapeHtml(r.description || 'Không có mô tả')}</td>
            <td><span class="badge badge-open">\${escapeHtml(r.status)}</span></td>
            <td>\${escapeHtml(r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('vi-VN') : '90 ngày sau đóng')}</td>
            <td><button class="btn-action" data-report-id="\${escapeHtml(r.id)}">👁 Mở Bằng Chứng</button></td>
          </tr>\`).join('');
        tbody.querySelectorAll('[data-report-id]').forEach(b => b.addEventListener('click', () => openReportEvidence(b.dataset.reportId)));
      } catch {}
    }

    async function loadSessions() {
      const tbody = document.getElementById('table-sessions-body');
      try {
        const params = new URLSearchParams({
          page: String(sessionsPage),
          limit: '20',
          search: document.getElementById('filter-session-search').value.trim(),
          type: document.getElementById('filter-session-type').value,
          status: document.getElementById('filter-session-status').value,
        });
        const res = await adminFetch('/api/v1/admin/sessions?' + params.toString());
        const data = await res.json();
        const list = data.sessions || [];
        const p = data.pagination || { page: 1, totalPages: 1, total: 0 };
        document.getElementById('sessions-pagination-info').textContent = 'Trang ' + p.page + ' / ' + p.totalPages + ' (' + p.total + ' phiên)';
        document.getElementById('btn-sessions-prev').disabled = p.page <= 1;
        document.getElementById('btn-sessions-next').disabled = p.page >= p.totalPages;

        if (!list.length) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);">Không có phiên phù hợp.</td></tr>';
          return;
        }
        tbody.innerHTML = list.map(s => \`
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;font-size:12px;">\${escapeHtml(s.id)}</td>
            <td><span class="badge" style="background:rgba(0,102,255,0.15);color:var(--accent);">\${escapeHtml(s.sessionType)}</span></td>
            <td><strong>\${escapeHtml(s.userANickname)}</strong></td>
            <td><strong>\${escapeHtml(s.userBNickname)}</strong></td>
            <td><span class="badge \${s.status === 'ACTIVE' ? 'badge-active' : ''}">\${escapeHtml(s.status)}</span></td>
            <td><strong>\${escapeHtml(s.messagesCount || 0)}</strong> tin</td>
            <td><button class="btn-action" data-session-id="\${escapeHtml(s.id)}">💬 Transcript & Media</button></td>
          </tr>\`).join('');
        tbody.querySelectorAll('[data-session-id]').forEach(b => b.addEventListener('click', () => openTranscript(b.dataset.sessionId)));
      } catch {}
    }

    async function renderAdminMediaPreview(mediaId, mediaType, containerEl) {
      try {
        containerEl.innerHTML = '<span style="font-size:11px;color:var(--muted);">Đang giải mã media (ghi AuditLog)...</span>';
        const res = await adminFetch('/api/v1/admin/media/' + encodeURIComponent(mediaId) + '/content');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          containerEl.innerHTML = '<span style="font-size:11px;color:var(--danger);">❌ ' + escapeHtml(err.error || 'Không thể tải media') + '</span>';
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const typeUpper = (mediaType || '').toUpperCase();
        if (typeUpper === 'IMAGE' || blob.type.startsWith('image/')) {
          containerEl.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:260px;border-radius:8px;margin-top:6px;" />';
        } else if (typeUpper === 'VIDEO' || blob.type.startsWith('video/')) {
          containerEl.innerHTML = '<video controls src="' + url + '" style="max-width:100%;max-height:260px;border-radius:8px;margin-top:6px;"></video>';
        } else {
          containerEl.innerHTML = '<audio controls src="' + url + '" style="margin-top:6px;"></audio>';
        }
        loadAuditLogs();
      } catch (e) {
        containerEl.innerHTML = '<span style="color:var(--danger);">Lỗi tải media</span>';
      }
    }

    function attachMediaPreviewButtons(rootEl) {
      rootEl.querySelectorAll('[data-admin-media-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetBox = btn.nextElementSibling;
          renderAdminMediaPreview(btn.dataset.adminMediaId, btn.dataset.adminMediaType, targetBox);
        });
      });
    }

    async function openTranscript(sessionId) {
      try {
        const res = await adminFetch('/api/v1/admin/sessions/' + encodeURIComponent(sessionId) + '/transcript');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Không thể mở transcript');
        document.getElementById('modal-transcript-title').textContent = 'Phiên Chat: ' + (data.userA?.nickname || 'A') + ' ⚡ ' + (data.userB?.nickname || 'B');
        const container = document.getElementById('modal-transcript-content');
        if (!data.messages.length) {
          container.innerHTML = '<p style="color:var(--muted);text-align:center;">Chưa có tin nhắn.</p>';
        } else {
          container.innerHTML = data.messages.map(m => \`
            <div class="transcript-bubble">
              <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">
                <strong>\${escapeHtml(m.senderNickname)}</strong> • \${escapeHtml(new Date(m.sentAt).toLocaleString('vi-VN'))}
                \${m.isAdult ? '<span class="badge" style="background:var(--danger);color:#fff;">18+</span>' : ''}
              </div>
              <div style="font-size:13px;">\${escapeHtml(m.content)}</div>
              \${m.mediaId ? \`<div style="margin-top:8px;">
                <button type="button" class="btn-action btn-secondary" data-admin-media-id="\${escapeHtml(m.mediaId)}" data-admin-media-type="\${escapeHtml(m.messageType)}">🔓 Giải Mã & Xem \${escapeHtml(m.messageType)} \${m.mediaInfo?.revokedAt ? '(Đã thu hồi)' : ''}</button>
                <div></div>
              </div>\` : ''}
            </div>\`).join('');
          attachMediaPreviewButtons(container);
        }
        document.getElementById('transcript-modal').style.display = 'flex';
        loadAuditLogs();
      } catch (e) { alert(e.message); }
    }

    async function openReportEvidence(reportId) {
      try {
        const res = await adminFetch('/api/v1/admin/reports/' + encodeURIComponent(reportId) + '/adjudicate');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Không thể xem bằng chứng');
        document.getElementById('modal-transcript-title').textContent = 'Hồ Sơ Báo Cáo: ' + reportId;
        const container = document.getElementById('modal-transcript-content');
        const evidenceItems = data.evidence || [];
        container.innerHTML = \`
          <div style="margin-bottom:14px;"><strong>Đối tượng bị tố cáo:</strong> \${escapeHtml(data.reportedUser?.nickname)} (\${escapeHtml(data.reportedUser?.status)})</div>
          \${data.roomName ? \`<div style="margin-bottom:14px;"><strong>Kênh / Nhóm cộng đồng:</strong> \${escapeHtml(data.roomName)}</div>\` : ''}
          <div style="margin-bottom:14px;"><strong>Lý do:</strong> \${escapeHtml(data.report?.reason)} — \${escapeHtml(data.report?.description || '')}</div>
          <div>\${evidenceItems.map(m => \`
            <div class="transcript-bubble" style="border-left:3px solid var(--danger);">
              <div style="font-size:11px;color:var(--muted);">\${escapeHtml(m.messageType)} • \${escapeHtml(new Date(m.frozenAt).toLocaleString('vi-VN'))}</div>
              <div>\${escapeHtml(m.content)}</div>
              \${m.mediaId ? \`<div style="margin-top:8px;"><button type="button" class="btn-action btn-secondary" data-admin-media-id="\${escapeHtml(m.mediaId)}" data-admin-media-type="\${escapeHtml(m.messageType)}">🔓 Giải Mã Bằng Chứng \${escapeHtml(m.messageType)}</button><div></div></div>\` : ''}
              \${m.groupMessageId ? \`<div style="margin-top:8px;"><button type="button" class="btn-action btn-danger" data-delete-group-msg-id="\${escapeHtml(m.groupMessageId)}">🗑 Gỡ Tin Nhắn Nhóm</button></div>\` : ''}
            </div>\`).join('')}
          </div>
          <div style="margin-top:14px;">
            <label style="display:block;font-size:11.5px;color:var(--muted);margin-bottom:4px;">Ghi chú / Lý do xử lý:</label>
            <input type="text" id="modal-moderation-note" class="input-dark" style="width:100%;" placeholder="Nhập lý do xử lý hoặc ghi chú kết luận..." />
          </div>
          <div id="modal-moderation-status" style="margin-top:10px;font-size:12px;display:none;"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">
            \${data.report?.status === 'OPEN' ? '<button type="button" class="btn-action btn-secondary" id="modal-review-btn">🔎 Đánh Dấu Đang Xem Xét</button>' : ''}
            <button type="button" class="btn-action btn-danger" id="modal-restrict-btn">🚫 Đình Chỉ Tài Khoản</button>
            <button type="button" class="btn-action" style="background:var(--success);" id="modal-resolve-btn">✅ Đóng Báo Cáo</button>
          </div>
        \`;
        attachMediaPreviewButtons(container);
        container.querySelectorAll('[data-delete-group-msg-id]').forEach(btn => {
          btn.addEventListener('click', () => deleteGroupMessageAdmin(btn.dataset.deleteGroupMsgId, btn));
        });
        const reviewBtn = document.getElementById('modal-review-btn');
        if (reviewBtn) {
          reviewBtn.addEventListener('click', () => markReportInReviewAdmin(data.report.id, reviewBtn));
        }
        document.getElementById('modal-restrict-btn').addEventListener('click', () => restrictAccusedUser(data.reportedUser.id));
        document.getElementById('modal-resolve-btn').addEventListener('click', () => resolveReport(data.report.id));
        document.getElementById('transcript-modal').style.display = 'flex';
        loadAuditLogs();
      } catch (e) { alert(e.message); }
    }

    async function markReportInReviewAdmin(reportId, btnEl) {
      const res = await adminFetch('/api/v1/admin/reports/' + encodeURIComponent(reportId) + '/review', {
        method: 'POST',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModalModerationStatus('❌ ' + (payload.error || 'Không thể chuyển trạng thái'), true);
        return;
      }
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '✓ Đang xem xét (IN_REVIEW)';
      }
      setModalModerationStatus('✓ Đã tiếp nhận xử lý báo cáo (IN_REVIEW).', false);
      refreshData();
    }

    function setModalModerationStatus(msg, isError) {
      const el = document.getElementById('modal-moderation-status');
      if (!el) return;
      el.textContent = msg;
      el.style.color = isError ? 'var(--danger)' : 'var(--success)';
      el.style.display = 'block';
    }

    async function deleteGroupMessageAdmin(groupMessageId, btnEl) {
      const res = await adminFetch('/api/v1/admin/groups/messages/' + encodeURIComponent(groupMessageId) + '/delete', {
        method: 'POST',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModalModerationStatus('❌ ' + (payload.error || 'Không thể gỡ tin nhắn nhóm'), true);
        return;
      }
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '✓ Đã gỡ khỏi nhóm';
      }
      setModalModerationStatus('✓ Đã gỡ tin nhắn vi phạm khỏi phòng nhóm.', false);
      loadAuditLogs();
    }

    async function restrictAccusedUser(userId) {
      const noteInput = document.getElementById('modal-moderation-note');
      const reason = (noteInput && noteInput.value.trim()) || 'Vi phạm chính sách cộng đồng';
      const res = await adminFetch('/api/v1/admin/users/' + encodeURIComponent(userId) + '/restrict', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModalModerationStatus('❌ ' + (payload.error || 'Đình chỉ thất bại'), true);
        return;
      }
      setModalModerationStatus('✓ Đã đình chỉ tài khoản và thu hồi phiên đăng nhập.', false);
      refreshData();
    }

    async function resolveReport(reportId) {
      const noteInput = document.getElementById('modal-moderation-note');
      const adminNote = (noteInput && noteInput.value.trim()) || undefined;
      const res = await adminFetch('/api/v1/admin/reports/' + encodeURIComponent(reportId) + '/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conclusion: 'ACTION_TAKEN', adminNote }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModalModerationStatus('❌ ' + (payload.error || 'Đóng báo cáo thất bại'), true);
        return;
      }
      document.getElementById('transcript-modal').style.display = 'none';
      refreshData();
    }

    async function loadAppeals() {
      const tbody = document.getElementById('table-appeals-body');
      try {
        const res = await adminFetch('/api/v1/admin/appeals');
        const list = await res.json();
        if (!list.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);">Không có đơn khiếu nại.</td></tr>';
          return;
        }
        tbody.innerHTML = list.map(a => \`
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;">\${escapeHtml(a.id)}</td>
            <td style="font-family:'JetBrains Mono',monospace;">\${escapeHtml(a.userId)}</td>
            <td>\${escapeHtml(a.reason)}</td>
            <td><span class="badge">\${escapeHtml(a.status)}</span></td>
            <td>\${escapeHtml(new Date(a.createdAt).toLocaleString('vi-VN'))}</td>
            <td>\${a.status === 'PENDING'
              ? '<button class="btn-action" style="background:var(--success);margin-right:6px;" data-appeal-id="' + escapeHtml(a.id) + '" data-decision="APPROVE">✓ Duyệt</button>' +
                '<button class="btn-action btn-danger" data-appeal-id="' + escapeHtml(a.id) + '" data-decision="REJECT">✕ Bác</button>'
              : 'Đã xử lý'}</td>
          </tr>\`).join('');
        tbody.querySelectorAll('[data-appeal-id]').forEach(btn => {
          btn.addEventListener('click', () => resolveAppeal(btn.dataset.appealId, btn.dataset.decision));
        });
      } catch {}
    }

    async function resolveAppeal(appealId, decision) {
      const note = prompt(decision === 'APPROVE' ? 'Ghi chú duyệt mở khóa:' : 'Lý do bác bỏ:');
      if (note === null) return;
      const res = await adminFetch('/api/v1/admin/appeals/' + encodeURIComponent(appealId) + '/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, adminNote: note.trim() || undefined }),
      });
      if (!res.ok) { alert('Lỗi xử lý khiếu nại'); return; }
      loadAppeals();
      loadStats();
    }

    async function loadAdminGroups() {
      const tbody = document.getElementById('table-groups-body');
      try {
        const res = await adminFetch('/api/v1/admin/groups');
        const data = await res.json();
        const rooms = data.rooms || [];
        tbody.innerHTML = rooms.map(r => \`
          <tr>
            <td><strong>\${escapeHtml(r.name)}</strong><div style="font-size:11px;color:var(--muted);">\${escapeHtml(r.description || '')}</div></td>
            <td><span class="badge">\${escapeHtml(r.type)}</span></td>
            <td>\${escapeHtml(r.memberCount)}</td>
            <td>
              <div style="display:flex;gap:6px;">
                <input type="text" class="input-dark" placeholder="Nhập thông báo..." style="flex:1;padding:6px 10px;" />
                <button type="button" class="btn-action" data-post-room-id="\${escapeHtml(r.id)}">Gửi</button>
              </div>
            </td>
          </tr>\`).join('');
        tbody.querySelectorAll('[data-post-room-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const input = btn.previousElementSibling;
            const content = input.value.trim();
            if (!content) return;
            const res = await adminFetch('/api/v1/admin/groups/' + encodeURIComponent(btn.dataset.postRoomId) + '/messages', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
            });
            if (res.ok) { input.value = ''; alert('Đã gửi thông báo vào phòng.'); }
            else { alert('Gửi thất bại'); }
          });
        });
      } catch {}
    }

    async function loadAuditLogs() {
      const tbody = document.getElementById('table-audit-body');
      try {
        const res = await adminFetch('/api/v1/admin/audit-logs');
        const list = await res.json();
        tbody.innerHTML = list.map(l => \`
          <tr>
            <td style="font-size:11.5px;color:var(--muted);">#\${escapeHtml(l.seq)} • \${escapeHtml(new Date(l.timestamp).toLocaleString('vi-VN'))}</td>
            <td><code>\${escapeHtml(l.actorId)}</code></td>
            <td><span class="badge" style="background:rgba(0,102,255,0.15);color:var(--accent);">\${escapeHtml(l.action)}</span></td>
            <td><code>\${escapeHtml(l.targetResourceId)}</code></td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:11px;">\${escapeHtml((l.entryHash || 'legacy').slice(0, 14))}…</td>
            <td style="color:var(--muted);">\${escapeHtml(l.ipAddress || '127.0.0.1')}</td>
          </tr>\`).join('');
      } catch {}
    }

    async function loadMfaStatus() {
      try {
        const res = await adminFetch('/api/v1/admin/mfa/status');
        const data = await res.json();
        const text = document.getElementById('mfa-status-text');
        const btnSetup = document.getElementById('btn-mfa-setup');
        if (data.enabled) {
          text.textContent = '✅ Đã bật 2FA (' + data.source.toUpperCase() + ') — Bắt buộc bảo vệ Super Admin';
          text.style.color = 'var(--success)';
          btnSetup.style.display = 'none';
        } else {
          text.textContent = '⚠️ Chưa bật 2FA — Bắt buộc thiết lập trước khi chạy Production';
          text.style.color = 'var(--warning)';
          btnSetup.style.display = 'inline-block';
        }
      } catch {}
    }

    async function loadSettings() {
      try {
        const res = await adminFetch('/api/v1/admin/settings');
        const list = await res.json();
        const map = {};
        list.forEach(item => { map[item.key] = item.value; });
        document.getElementById('cfg-admin-username').value = map['admin.auth.username'] || 'admin';
        document.getElementById('cfg-admin-password').value = '';
        document.getElementById('cfg-admin-google-email').value = map['admin.google.email'] || 'nguyenthanhtung74119@gmail.com';
        document.getElementById('cfg-google-enabled').checked = map['auth.google.enabled'] !== 'false';
        document.getElementById('cfg-google-client-id').value = map['auth.google.client_id'] || '';
        document.getElementById('cfg-reg-enabled').checked = map['auth.registration.enabled'] !== 'false';
        document.getElementById('cfg-email-verif-required').checked = map['auth.email_verification.required'] === 'true';
        document.getElementById('cfg-retention-random').value = map['retention.random_chat_days'] || '7';
        document.getElementById('cfg-retention-friend').value = map['retention.friend_chat_days'] || '30';
        document.getElementById('cfg-retention-report').value = map['retention.report_evidence_days'] || '90';
        document.getElementById('cfg-mail-enabled').checked = map['mail.smtp.enabled'] === 'true';
        document.getElementById('cfg-mail-host').value = map['mail.smtp.host'] || '';
        document.getElementById('cfg-mail-port').value = map['mail.smtp.port'] || '587';
        document.getElementById('cfg-mail-secure').checked = map['mail.smtp.secure'] === 'true';
        document.getElementById('cfg-mail-user').value = map['mail.smtp.user'] || '';
        document.getElementById('cfg-mail-password').value = map['mail.smtp.password'] || '';
        document.getElementById('cfg-mail-from-name').value = map['mail.smtp.from_name'] || 'Chatible Support';
        document.getElementById('cfg-mail-from-address').value = map['mail.smtp.from_address'] || 'no-reply@chatible.app';

        const storageDriver = map['storage.driver'] || (map['storage.s3.endpoint'] ? 'S3' : 'LOCAL');
        document.getElementById('cfg-storage-driver').value = storageDriver;
        document.getElementById('storage-s3-config-box').style.display = storageDriver === 'S3' ? 'flex' : 'none';
        document.getElementById('cfg-storage-endpoint').value = map['storage.s3.endpoint'] || '';
        document.getElementById('cfg-storage-bucket').value = map['storage.s3.bucket'] || '';
        document.getElementById('cfg-storage-access-key').value = map['storage.s3.access_key_id'] || '';
        document.getElementById('cfg-storage-secret-key').value = map['storage.s3.secret_access_key'] || '';
        document.getElementById('cfg-storage-region').value = map['storage.s3.region'] || 'auto';
        document.getElementById('cfg-storage-force-path').checked = map['storage.s3.force_path_style'] !== 'false';
      } catch {}
    }

    function refreshData() {
      loadStats();
      loadReports();
      loadSessions();
      loadAuditLogs();
    }

    // Bind CSP-safe listeners
    document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    document.getElementById('btn-refresh-data').addEventListener('click', refreshData);
    document.getElementById('btn-admin-logout').addEventListener('click', async () => {
      await adminFetch('/api/v1/admin/logout', { method: 'POST' });
      window.location.reload();
    });
    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('transcript-modal').style.display = 'none';
    });
    document.getElementById('btn-search-sessions').addEventListener('click', () => { sessionsPage = 1; loadSessions(); });
    document.getElementById('btn-sessions-prev').addEventListener('click', () => { if (sessionsPage > 1) { sessionsPage--; loadSessions(); } });
    document.getElementById('btn-sessions-next').addEventListener('click', () => { sessionsPage++; loadSessions(); });

    document.getElementById('admin-create-group-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await adminFetch('/api/v1/admin/groups', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('grp-name').value.trim(),
          type: document.getElementById('grp-type').value,
          passcode: document.getElementById('grp-passcode').value.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Tạo phòng thất bại'); return; }
      document.getElementById('grp-name').value = '';
      document.getElementById('grp-passcode').value = '';
      loadAdminGroups();
    });

    document.getElementById('btn-verify-audit').addEventListener('click', async () => {
      const badge = document.getElementById('audit-chain-badge');
      const res = await adminFetch('/api/v1/admin/audit-logs/verify');
      const data = await res.json();
      badge.textContent = data.valid
        ? '✅ Toàn vẹn 100% (' + data.verifiedHashedEntries + '/' + data.totalEntries + ' bản ghi • Hash: ' + data.latestHash.slice(0, 14) + '…)'
        : '❌ PHÁT HIỆN BẤT THƯỜNG tại Seq #' + data.brokenAtSeq;
      badge.style.color = data.valid ? 'var(--success)' : 'var(--danger)';
    });

    document.getElementById('btn-export-audit').addEventListener('click', async () => {
      const res = await adminFetch('/api/v1/admin/audit-logs/export');
      const text = await res.text();
      const sha = res.headers.get('X-Audit-Sha256');
      const s3Key = res.headers.get('X-Audit-Uploaded-Key');
      const blob = new Blob([text], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chatible-audit-' + Date.now() + '.jsonl';
      a.click();
      alert('Đã xuất JSONL (SHA-256: ' + sha + ')' + (s3Key ? '\\nĐã sao lưu lên S3: ' + s3Key : ''));
    });

    document.querySelectorAll('[data-smtp-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.smtpPreset;
        if (p === 'gmail') {
          document.getElementById('cfg-mail-host').value = 'smtp.gmail.com';
          document.getElementById('cfg-mail-port').value = '587';
          document.getElementById('cfg-mail-secure').checked = false;
        } else if (p === 'resend') {
          document.getElementById('cfg-mail-host').value = 'smtp.resend.com';
          document.getElementById('cfg-mail-port').value = '465';
          document.getElementById('cfg-mail-secure').checked = true;
          document.getElementById('cfg-mail-user').value = 'resend';
        } else if (p === 'sendgrid') {
          document.getElementById('cfg-mail-host').value = 'smtp.sendgrid.net';
          document.getElementById('cfg-mail-port').value = '587';
          document.getElementById('cfg-mail-secure').checked = false;
          document.getElementById('cfg-mail-user').value = 'apikey';
        }
      });
    });

    document.getElementById('settings-auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById('settings-save-status');
      const adminPass = document.getElementById('cfg-admin-password').value;
      const settingsPayload = {
        'admin.auth.username': document.getElementById('cfg-admin-username').value.trim() || 'admin',
        'admin.google.email': document.getElementById('cfg-admin-google-email').value.trim().toLowerCase(),
        'auth.google.enabled': document.getElementById('cfg-google-enabled').checked ? 'true' : 'false',
        'auth.google.client_id': document.getElementById('cfg-google-client-id').value.trim(),
        'auth.registration.enabled': document.getElementById('cfg-reg-enabled').checked ? 'true' : 'false',
        'auth.email_verification.required': document.getElementById('cfg-email-verif-required').checked ? 'true' : 'false',
        'retention.random_chat_days': document.getElementById('cfg-retention-random').value.trim() || '7',
        'retention.friend_chat_days': document.getElementById('cfg-retention-friend').value.trim() || '30',
        'retention.report_evidence_days': document.getElementById('cfg-retention-report').value.trim() || '90',
        'mail.smtp.enabled': document.getElementById('cfg-mail-enabled').checked ? 'true' : 'false',
        'mail.smtp.host': document.getElementById('cfg-mail-host').value.trim(),
        'mail.smtp.port': document.getElementById('cfg-mail-port').value.trim() || '587',
        'mail.smtp.secure': document.getElementById('cfg-mail-secure').checked ? 'true' : 'false',
        'mail.smtp.user': document.getElementById('cfg-mail-user').value.trim(),
        'mail.smtp.password': document.getElementById('cfg-mail-password').value,
        'mail.smtp.from_name': document.getElementById('cfg-mail-from-name').value.trim() || 'Chatible Support',
        'mail.smtp.from_address': document.getElementById('cfg-mail-from-address').value.trim() || 'no-reply@chatible.app',
        'storage.driver': document.getElementById('cfg-storage-driver').value,
        'storage.s3.endpoint': document.getElementById('cfg-storage-endpoint').value.trim(),
        'storage.s3.bucket': document.getElementById('cfg-storage-bucket').value.trim(),
        'storage.s3.access_key_id': document.getElementById('cfg-storage-access-key').value.trim(),
        'storage.s3.region': document.getElementById('cfg-storage-region').value.trim() || 'auto',
        'storage.s3.force_path_style': document.getElementById('cfg-storage-force-path').checked ? 'true' : 'false',
      };
      if (adminPass.trim()) {
        settingsPayload['admin.auth.password'] = adminPass;
      }
      const storageSecret = document.getElementById('cfg-storage-secret-key').value;
      if (storageSecret && storageSecret !== '••••••••••••••••') {
        settingsPayload['storage.s3.secret_access_key'] = storageSecret;
      }
      const res = await adminFetch('/api/v1/admin/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: settingsPayload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusEl.textContent = '❌ ' + (data.error || 'Lỗi lưu cấu hình');
        statusEl.style.color = 'var(--danger)';
        statusEl.style.display = 'inline';
        return;
      }
      await loadSettings();
      statusEl.textContent = '✓ Đã lưu cấu hình hệ thống!';
      statusEl.style.color = 'var(--success)';
      statusEl.style.display = 'inline';
    });

    document.getElementById('btn-test-mail').addEventListener('click', async () => {
      const btn = document.getElementById('btn-test-mail');
      const statusEl = document.getElementById('mail-test-status');
      const toEmail = document.getElementById('cfg-mail-test-to').value.trim();
      btn.disabled = true;
      const res = await adminFetch('/api/v1/admin/settings/test-email', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toEmail,
          smtpConfig: {
            host: document.getElementById('cfg-mail-host').value.trim(),
            port: document.getElementById('cfg-mail-port').value.trim() || '587',
            secure: document.getElementById('cfg-mail-secure').checked ? 'true' : 'false',
            user: document.getElementById('cfg-mail-user').value.trim(),
            password: document.getElementById('cfg-mail-password').value,
            fromName: document.getElementById('cfg-mail-from-name').value.trim(),
            fromAddress: document.getElementById('cfg-mail-from-address').value.trim(),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      btn.disabled = false;
      statusEl.textContent = res.ok ? '✓ ' + data.message : '❌ ' + (data.error || 'Thất bại');
      statusEl.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
      statusEl.style.display = 'block';
    });

    document.getElementById('cfg-storage-driver').addEventListener('change', (e) => {
      document.getElementById('storage-s3-config-box').style.display = e.target.value === 'S3' ? 'flex' : 'none';
    });

    document.getElementById('btn-test-storage').addEventListener('click', async () => {
      const btn = document.getElementById('btn-test-storage');
      const statusEl = document.getElementById('storage-test-status');
      btn.disabled = true;
      statusEl.textContent = '⏳ Đang kiểm tra kết nối...';
      statusEl.style.color = 'var(--text)';
      statusEl.style.display = 'inline';

      const driver = document.getElementById('cfg-storage-driver').value;
      const payload = {
        driver,
        endpoint: document.getElementById('cfg-storage-endpoint').value.trim(),
        bucket: document.getElementById('cfg-storage-bucket').value.trim(),
        accessKeyId: document.getElementById('cfg-storage-access-key').value.trim(),
        secretAccessKey: document.getElementById('cfg-storage-secret-key').value,
        region: document.getElementById('cfg-storage-region').value.trim() || 'auto',
        forcePathStyle: document.getElementById('cfg-storage-force-path').checked,
      };

      try {
        const res = await adminFetch('/api/v1/admin/settings/test-storage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        btn.disabled = false;
        if (!res.ok || !data.success) {
          statusEl.textContent = '❌ ' + (data.message || data.error || 'Kiểm tra thất bại');
          statusEl.style.color = 'var(--danger)';
        } else {
          statusEl.textContent = '✓ ' + (data.message || 'Kết nối thành công!');
          statusEl.style.color = 'var(--success)';
        }
      } catch {
        btn.disabled = false;
        statusEl.textContent = '❌ Lỗi kết nối tới máy chủ';
        statusEl.style.color = 'var(--danger)';
      }
    });

    let pendingMfaSecret = '';
    document.getElementById('btn-mfa-setup').addEventListener('click', async () => {
      const res = await adminFetch('/api/v1/admin/mfa/setup', { method: 'POST' });
      const data = await res.json();
      pendingMfaSecret = data.secretBase32;
      document.getElementById('mfa-secret-display').textContent = data.secretBase32 + '  (URI: ' + data.otpauthUri + ')';
      document.getElementById('mfa-setup-box').style.display = 'block';
    });

    document.getElementById('btn-mfa-confirm').addEventListener('click', async () => {
      const code = document.getElementById('mfa-confirm-code').value.trim();
      const res = await adminFetch('/api/v1/admin/mfa/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secretBase32: pendingMfaSecret, code }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Mã OTP sai'); return; }
      document.getElementById('mfa-setup-box').style.display = 'none';
      loadMfaStatus();
    });

    refreshData();
  </script>
</body>
</html>`;
  }

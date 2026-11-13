import React from 'react';
import { ArrowLeft, CheckCircle, Database, EyeOff, Lock, Mail, Shield, Trash2, UserCheck } from 'lucide-react';

interface LegalPageProps {
  onBack?: () => void;
}

export function PrivacyPolicyView({ onBack }: LegalPageProps) {
  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 py-10 px-4 sm:px-6 lg:px-8 selection:bg-indigo-500/30 selection:text-indigo-200">
      <div className="max-w-4xl mx-auto">
        {/* Header navigation */}
        <div className="mb-8 flex items-center justify-between border-b border-slate-800/80 pb-5">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Quay lại Chatible</span>
          </button>
          <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-900/60 px-3 py-1.5 rounded-lg border border-slate-800">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Hiệu lực: Tháng 11/2026</span>
          </div>
        </div>

        {/* Hero banner */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950/40 via-slate-900/80 to-slate-900 border border-indigo-500/20 p-6 sm:p-10 mb-10 shadow-2xl backdrop-blur-xl">
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 mb-4">
              <Shield className="w-3.5 h-3.5" />
              <span>Chính sách Bảo mật & Quyền Riêng Tư</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Chính Sách Quyền Riêng Tư Chatible
            </h1>
            <p className="mt-3 text-base sm:text-lg text-slate-300 max-w-2xl leading-relaxed">
              Cam kết bảo vệ quyền riêng tư, an toàn dữ liệu và bảo mật tối đa cho người dùng trong nền tảng chat ngẫu nhiên 1-1 và kết bạn riêng tư.
            </p>
          </div>
        </div>

        {/* Content sections */}
        <div className="space-y-8 text-slate-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-indigo-400 font-bold text-lg mb-4">
              <UserCheck className="w-5 h-5 text-indigo-400 shrink-0" />
              <h2>1. Giới thiệu & Nguyên tắc Cốt lõi</h2>
            </div>
            <p className="mb-3">
              Chào mừng bạn đến với <strong>Chatible</strong> (<a href="https://chat.nttung.dev" className="text-indigo-400 hover:underline">https://chat.nttung.dev</a>). Chúng tôi hiểu rằng quyền riêng tư là yếu tố quan trọng nhất khi tham gia trò chuyện trực tuyến.
            </p>
            <p>
              Chính sách này giải thích minh bạch cách chúng tôi xử lý dữ liệu của bạn theo nguyên tắc: <strong>Thu thập dữ liệu tối thiểu, mã hóa dữ liệu nhạy cảm, không theo dõi định danh cá nhân ngoài mục đích bảo vệ an toàn dịch vụ, và tự động dọn dẹp dữ liệu trò chuyện tạm thời.</strong>
            </p>
          </section>

          {/* Section 2 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-amber-400 font-bold text-lg mb-4">
              <Shield className="w-5 h-5 text-amber-400 shrink-0" />
              <h2>2. Quy định Độ tuổi 18+ Bắt buộc</h2>
            </div>
            <p className="mb-3">
              Chatible là nền tảng dành riêng cho người trưởng thành (<strong>từ đủ 18 tuổi trở lên</strong>). Chúng tôi áp dụng quy tắc kiểm tra ngày sinh khi đăng ký:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-slate-300">
              <li>Hệ thống từ chối đăng ký và tạo tài khoản đối với bất kỳ người dùng nào dưới 18 tuổi.</li>
              <li>Chúng tôi tuyệt đối không thu thập hoặc lưu trữ thông tin của trẻ vị thành niên. Bất kỳ tài khoản nào bị phát hiện chưa đủ 18 tuổi sẽ bị chấm dứt hoạt động ngay lập tức.</li>
            </ul>
          </section>

          {/* Section 3 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-cyan-400 font-bold text-lg mb-4">
              <Database className="w-5 h-5 text-cyan-400 shrink-0" />
              <h2>3. Dữ liệu Thu thập và Mục đích Sử dụng</h2>
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-white mb-1">a. Thông tin tài khoản:</h3>
                <p>Email, mật khẩu đã được băm an toàn (Argon2id/Scrypt/Bcrypt), biệt danh hiển thị (nickname), giới tính và ngày sinh (để xác nhận đủ 18+ và thuật toán ghép đôi theo độ tuổi).</p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">b. Đăng nhập bằng Google (Google OAuth):</h3>
                <p>Khi bạn chọn đăng nhập bằng Google, chúng tôi chỉ nhận mã định danh tài khoản (`sub`) và địa chỉ email đã xác minh từ Google để phục vụ việc đăng nhập. <strong>Chúng tôi không yêu cầu, không truy cập và không lưu trữ danh bạ, Google Drive, email cá nhân hay bất kỳ dữ liệu nào khác ngoài phạm vi xác thực danh tính.</strong></p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-1">c. Thông tin kỹ thuật:</h3>
                <p>Địa chỉ IP, thông tin thiết bị (User Agent) và cookie xác thực (HttpOnly Strict) để duy trì phiên làm việc, ngăn chặn tấn công DDoS, bảo vệ CSRF và ngăn chặn hành vi quấy rối/spam lặp lại.</p>
              </div>
            </div>
          </section>

          {/* Section 4 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-emerald-400 font-bold text-lg mb-4">
              <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
              <h2>4. Cơ chế Mã hóa & Bảo mật Tin nhắn</h2>
            </div>
            <p className="mb-3">
              Tin nhắn trò chuyện trên Chatible được bảo vệ bằng các lớp phòng thủ kỹ thuật nghiêm ngặt:
            </p>
            <div className="grid sm:grid-cols-2 gap-4 my-4">
              <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <h4 className="font-semibold text-white flex items-center gap-2 mb-1.5">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  Mã hóa Envelope (DEK + KEK)
                </h4>
                <p className="text-xs sm:text-sm text-slate-300">
                  Mỗi tin nhắn được mã hóa bằng khóa riêng biệt (Data Encryption Key) và bọc bởi Master KEK / Cloud KMS. Dữ liệu trong cơ sở dữ liệu ở dạng ciphertext, không thể đọc trộm kể cả khi rò rỉ cơ sở dữ liệu.
                </p>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <h4 className="font-semibold text-white flex items-center gap-2 mb-1.5">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  Tin nhắn tự hủy (Ephemeral)
                </h4>
                <p className="text-xs sm:text-sm text-slate-300">
                  Các phiên trò chuyện ngẫu nhiên (Random Chat) tự động xóa hoàn toàn dữ liệu sau khi phiên kết thúc hoặc hết thời hạn lưu trữ. Chatible không lưu vĩnh viễn nội dung trò chuyện ngẫu nhiên.
                </p>
              </div>
            </div>
          </section>

          {/* Section 5 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-violet-400 font-bold text-lg mb-4">
              <EyeOff className="w-5 h-5 text-violet-400 shrink-0" />
              <h2>5. Chính sách Hình ảnh, Âm thanh & Watermark Bảo vệ</h2>
            </div>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Đồng thuận 2 chiều:</strong> Người gửi chỉ có thể chia sẻ hình ảnh/âm thanh khi cả hai bên tham gia cuộc trò chuyện đã kích hoạt sự đồng ý nhận phương tiện.</li>
              <li><strong>Đóng dấu bản quyền (Watermark chống phát tán):</strong> Mọi hình ảnh và video xem trên nền tảng được tự động đóng dấu chìm (watermark) chứa thông tin phiên và định danh người xem để ngăn chặn hành vi chụp lén hoặc chia sẻ trái phép mà không có sự đồng thuận.</li>
              <li><strong>Thời hạn xem & Thu hồi:</strong> Phương tiện có giới hạn thời gian mở và người gửi có quyền thu hồi (revoke) ngay lập tức khỏi hệ thống lưu trữ.</li>
            </ul>
          </section>

          {/* Section 6 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-rose-400 font-bold text-lg mb-4">
              <Trash2 className="w-5 h-5 text-rose-400 shrink-0" />
              <h2>6. Quyền của Bạn & Xóa Dữ liệu</h2>
            </div>
            <p className="mb-3">
              Bạn toàn quyền kiểm soát dữ liệu cá nhân của mình tại Chatible:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Xóa tài khoản vĩnh viễn:</strong> Bạn có thể yêu cầu xóa tài khoản bất cứ lúc nào trong trang Hồ sơ cá nhân. Khi xóa tài khoản, mọi thông tin hồ sơ, danh sách bạn bè và dữ liệu liên quan sẽ bị hủy vĩnh viễn.</li>
              <li><strong>Chặn và Báo cáo vi phạm:</strong> Bạn có thể báo cáo người dùng có hành vi quấy rối hoặc vi phạm điều khoản. Khi đó, bản chụp bằng chứng tin nhắn sẽ chỉ được giữ lại tạm thời để Ban quản trị đối soát, sau đó tự động hủy theo chu kỳ.</li>
            </ul>
          </section>

          {/* Section 7 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-indigo-400 font-bold text-lg mb-4">
              <Mail className="w-5 h-5 text-indigo-400 shrink-0" />
              <h2>7. Thông tin Liên hệ</h2>
            </div>
            <p className="mb-3">
              Nếu bạn có bất kỳ câu hỏi nào về Chính sách Quyền riêng tư hoặc yêu cầu xử lý dữ liệu, vui lòng liên hệ với chúng tôi:
            </p>
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/60 inline-block">
              <p className="font-semibold text-white">Ban Quản trị Chatible</p>
              <p className="text-sm text-slate-300">Website: <a href="https://chat.nttung.dev" className="text-indigo-400 hover:underline">https://chat.nttung.dev</a></p>
              <p className="text-sm text-slate-300">Email hỗ trợ: <a href="mailto:admin@nttung.dev" className="text-indigo-400 hover:underline">admin@nttung.dev</a></p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <p>© 2026 Chatible. Bảo lưu mọi quyền.</p>
          <div className="flex gap-4">
            <a href="/terms" onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/terms'); window.dispatchEvent(new PopStateEvent('popstate')); }} className="hover:text-slate-300 transition-colors">Điều khoản Sử dụng</a>
            <a href="/" onClick={(e) => { e.preventDefault(); handleBack(); }} className="hover:text-slate-300 transition-colors">Trang chủ Chatible</a>
          </div>
        </div>
      </div>
    </div>
  );
}

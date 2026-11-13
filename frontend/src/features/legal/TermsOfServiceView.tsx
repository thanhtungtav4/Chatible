import React from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle, FileText, Gavel, Mail, Scale, ShieldAlert, UserX } from 'lucide-react';

interface LegalPageProps {
  onBack?: () => void;
}

export function TermsOfServiceView({ onBack }: LegalPageProps) {
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
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-indigo-950/40 border border-slate-700/60 p-6 sm:p-10 mb-10 shadow-2xl backdrop-blur-xl">
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-4">
              <FileText className="w-3.5 h-3.5" />
              <span>Quy định & Thỏa thuận Người dùng</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Điều Khoản Dịch Vụ Chatible
            </h1>
            <p className="mt-3 text-base sm:text-lg text-slate-300 max-w-2xl leading-relaxed">
              Vui lòng đọc kỹ các điều khoản dưới đây trước khi đăng ký hoặc sử dụng nền tảng trò chuyện ngẫu nhiên 1-1 và cộng đồng riêng tư Chatible.
            </p>
          </div>
        </div>

        {/* Content sections */}
        <div className="space-y-8 text-slate-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-indigo-400 font-bold text-lg mb-4">
              <CheckCircle className="w-5 h-5 text-indigo-400 shrink-0" />
              <h2>1. Chấp thuận Điều khoản</h2>
            </div>
            <p className="mb-3">
              Bằng việc truy cập, đăng ký tài khoản hoặc sử dụng dịch vụ tại <strong>https://chat.nttung.dev</strong> (gọi tắt là "Chatible"), bạn xác nhận đã đọc, hiểu và đồng ý chịu sự ràng buộc của Điều khoản Dịch vụ này cũng như <a href="/privacy" onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/privacy'); window.dispatchEvent(new PopStateEvent('popstate')); }} className="text-indigo-400 hover:underline">Chính sách Quyền riêng tư</a> của chúng tôi.
            </p>
            <p>
              Nếu bạn không đồng ý với bất kỳ điều khoản nào, vui lòng ngừng sử dụng dịch vụ ngay lập tức.
            </p>
          </section>

          {/* Section 2 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-amber-400 font-bold text-lg mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              <h2>2. Yêu cầu Bắt buộc về Độ tuổi (18+)</h2>
            </div>
            <p className="mb-3">
              <strong>Chatible CHỈ DÀNH CHO CÁC CÁ NHÂN TỪ ĐỦ 18 TUỔI TRỞ LÊN.</strong>
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Bạn phải cam kết khai báo ngày sinh chính xác khi đăng ký tài khoản. Mọi hành vi gian lận độ tuổi sẽ dẫn đến việc đình chỉ hoặc xóa tài khoản vĩnh viễn không cần báo trước.</li>
              <li>Chúng tôi áp dụng chính sách <strong>Không khoan nhượng (Zero Tolerance)</strong> đối với sự hiện diện hoặc bất kỳ nội dung nào liên quan đến người dưới 18 tuổi trên nền tảng.</li>
            </ul>
          </section>

          {/* Section 3 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-rose-400 font-bold text-lg mb-4">
              <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
              <h2>3. Hành vi Nghiêm cấm Tuyệt đối</h2>
            </div>
            <p className="mb-3">Khi sử dụng Chatible, bạn cam kết KHÔNG thực hiện các hành vi sau:</p>
            <div className="grid sm:grid-cols-2 gap-4 my-3 text-xs sm:text-sm">
              <div className="p-4 rounded-xl bg-rose-950/20 border border-rose-900/40">
                <h4 className="font-semibold text-rose-300 mb-1">Nội dung Xâm hại Trẻ em (CSAM/CSAE)</h4>
                <p>Nghiêm cấm tuyệt đối mọi hình thức phát tán, đề cập, trao đổi hoặc lưu trữ hình ảnh/văn bản xâm hại trẻ em. Hệ thống sẽ báo cáo ngay cho cơ quan chức năng.</p>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <h4 className="font-semibold text-white mb-1">Phát tán Phương tiện Bất hợp pháp</h4>
                <p>Nghiêm cấm chia sẻ hình ảnh/video nhạy cảm khi chưa có sự đồng thuận rõ ràng của đối phương; tống tiền tình dục (sextortion) hoặc phát tán thông tin riêng tư (doxxing).</p>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <h4 className="font-semibold text-white mb-1">Lừa đảo, Đe dọa & Quấy rối</h4>
                <p>Nghiêm cấm hành vi đe dọa vũ lực, phân biệt chủng tộc, kích động thù địch, mạo danh cá nhân/tổ chức, hoặc gửi tin nhắn rác (spam) lừa đảo thương mại.</p>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50">
                <h4 className="font-semibold text-white mb-1">Can thiệp Trái phép Hệ thống</h4>
                <p>Nghiêm cấm tấn công DDoS, khai thác lỗ hổng bảo mật, bot tự động hóa quấy phá hàng đợi ghép đôi hoặc cố tình vượt qua cơ chế giới hạn tần suất (rate limits).</p>
              </div>
            </div>
          </section>

          {/* Section 4 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-cyan-400 font-bold text-lg mb-4">
              <Scale className="w-5 h-5 text-cyan-400 shrink-0" />
              <h2>4. Quy tắc Ghép đôi & Trao đổi Phương tiện (18+)</h2>
            </div>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Hàng đợi công bằng (FIFO):</strong> Thuật toán ghép đôi phục vụ người dùng theo thứ tự chờ công bằng, dựa trên tiêu chí giới tính và độ tuổi lựa chọn.</li>
              <li><strong>Đồng thuận nhận phương tiện:</strong> Người dùng có toàn quyền tắt hoặc bật tùy chọn đồng thuận nhận hình ảnh/âm thanh người lớn (18+). Chỉ khi cả 2 bên cùng đồng thuận thì tính năng chia sẻ media mới được mở khóa.</li>
              <li><strong>Tính riêng tư của phiên chat:</strong> Tin nhắn chat ngẫu nhiên được mã hóa và sẽ bị tiêu hủy khi phiên kết thúc. Người dùng chịu trách nhiệm về nội dung trao đổi của chính mình.</li>
            </ul>
          </section>

          {/* Section 5 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-amber-400 font-bold text-lg mb-4">
              <UserX className="w-5 h-5 text-amber-400 shrink-0" />
              <h2>5. Cơ chế Xử lý Vi phạm & Quyền Khiếu nại (Appeals)</h2>
            </div>
            <p className="mb-3">
              Để bảo vệ cộng đồng lành mạnh và an toàn:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Người dùng có thể bấm nút <strong>Báo cáo (Report)</strong> kèm bằng chứng vi phạm bất cứ lúc nào.</li>
              <li>Ban quản trị có quyền tạm đình chỉ (Suspension) hoặc khóa vĩnh viễn (Permanent Ban) đối với các tài khoản vi phạm.</li>
              <li>Người dùng bị hạn chế có quyền gửi đơn <strong>Khiếu nại (Appeal)</strong> kèm lý do giải trình. Quyết định của Ban quản trị sau khi xem xét khiếu nại là quyết định cuối cùng.</li>
            </ul>
          </section>

          {/* Section 6 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-slate-300 font-bold text-lg mb-4">
              <Gavel className="w-5 h-5 text-slate-400 shrink-0" />
              <h2>6. Giới hạn Trách nhiệm</h2>
            </div>
            <p className="mb-3">
              Dịch vụ được cung cấp trên nguyên tắc "nguyên trạng" (as is). Chúng tôi nỗ lực tối đa để duy trì tính liên tục và an toàn của hệ thống, nhưng không chịu trách nhiệm đối với các gián đoạn đường truyền mạng bên ngoài, hành vi vi phạm đạo đức cá nhân của người dùng tham gia chat, hoặc những tổn thất phát sinh do người dùng tự ý chia sẻ thông tin tài chính/định danh bí mật cho đối tượng lạ.
            </p>
          </section>

          {/* Section 7 */}
          <section className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 sm:p-8 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-indigo-400 font-bold text-lg mb-4">
              <Mail className="w-5 h-5 text-indigo-400 shrink-0" />
              <h2>7. Kênh Hỗ trợ & Liên hệ</h2>
            </div>
            <p className="mb-3">
              Mọi thắc mắc, đề xuất hoặc phản hồi về Điều khoản Dịch vụ, vui lòng liên hệ:
            </p>
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/60 inline-block">
              <p className="font-semibold text-white">Ban Điều hành Chatible</p>
              <p className="text-sm text-slate-300">Email: <a href="mailto:admin@nttung.dev" className="text-indigo-400 hover:underline">admin@nttung.dev</a></p>
              <p className="text-sm text-slate-300">Website: <a href="https://chat.nttung.dev" className="text-indigo-400 hover:underline">https://chat.nttung.dev</a></p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <p>© 2026 Chatible. Bảo lưu mọi quyền.</p>
          <div className="flex gap-4">
            <a href="/privacy" onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/privacy'); window.dispatchEvent(new PopStateEvent('popstate')); }} className="hover:text-slate-300 transition-colors">Chính sách Quyền riêng tư</a>
            <a href="/" onClick={(e) => { e.preventDefault(); handleBack(); }} className="hover:text-slate-300 transition-colors">Trang chủ Chatible</a>
          </div>
        </div>
      </div>
    </div>
  );
}

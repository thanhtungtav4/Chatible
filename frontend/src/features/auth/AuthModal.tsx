import React, { useState, useEffect } from 'react';
import type { Gender, AuthResponse } from '@chatible/shared';
import { Lock, Mail, User, Calendar, ShieldCheck, AlertCircle, X, ArrowLeft, KeyRound, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '../../api.js';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (profile: AuthResponse['profile']) => void;
}

type AuthMode = 'REGISTER' | 'LOGIN' | 'FORGOT' | 'RESET' | 'GOOGLE_ONBOARD';

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>('REGISTER');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [gender, setGender] = useState<Gender>('MALE');
  const [birthDate, setBirthDate] = useState('');
  const [policyAccepted, setPolicyAccepted] = useState(false);

  // Forgot & Reset Password states
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Google OAuth flow state
  const [googleIdToken, setGoogleIdToken] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<{ googleAuthEnabled: boolean; registrationEnabled: boolean } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    apiFetch('/api/v1/auth/config')
      .then((res) => res.json())
      .then((data: { googleAuthEnabled?: boolean; registrationEnabled?: boolean }) => {
        setAuthConfig({
          googleAuthEnabled: data.googleAuthEnabled !== false,
          registrationEnabled: data.registrationEnabled !== false,
        });
        if (data.registrationEnabled === false && mode === 'REGISTER') {
          setMode('LOGIN');
        }
      })
      .catch(() => {
        setAuthConfig({ googleAuthEnabled: true, registrationEnabled: true });
      });
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  if (!isOpen) return null;

  // Calculate age client-side for immediate visual feedback
  const computeAge = (dob: string): number => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
    if (!match) return 0;
    const [, yearPart, monthPart, dayPart] = match;
    const year = Number(yearPart);
    const month = Number(monthPart);
    const day = Number(dayPart);
    const birth = new Date(Date.UTC(year, month - 1, day));
    if (
      birth.getUTCFullYear() !== year ||
      birth.getUTCMonth() !== month - 1 ||
      birth.getUTCDate() !== day
    ) {
      return 0;
    }

    const today = new Date();
    let age = today.getUTCFullYear() - year;
    if (today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)) {
      age--;
    }
    return age;
  };

  const currentAge = birthDate ? computeAge(birthDate) : 0;
  const isAdult = currentAge >= 18;

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      const response = await apiFetch('/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = (await response.json()) as { message?: string; resetCode?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Gửi yêu cầu thất bại');

      if (data.resetCode) {
        setResetCode(data.resetCode);
      }
      setSuccessMsg(data.message || 'Mã xác thực đã được gửi.');
      setResendCooldown(60);
      setMode('RESET');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      if (newPassword.length < 8) {
        throw new Error('Mật khẩu mới phải có tối thiểu 8 ký tự.');
      }

      const response = await apiFetch('/api/v1/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: resetCode.trim(),
          newPassword,
        }),
      });

      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Đặt lại mật khẩu thất bại');

      setSuccessMsg(data.message || 'Đặt lại mật khẩu thành công!');
      setPassword(newPassword);
      setMode('LOGIN');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleClick = async () => {
    setError(null);
    // In browser environment without external Google OAuth SDK script loaded,
    // prompt user for simulated testing or prompt ID Token
    const simulatedSub = 'google-user-' + Math.random().toString(36).substring(2, 9);
    const mockEmail = `google.${simulatedSub}@gmail.com`;

    // Attempt direct Google auth or open onboarding for birthDate
    setGoogleIdToken(simulatedSub);
    if (!email) setEmail(mockEmail);
    if (!nickname) setNickname('Google User');
    setMode('GOOGLE_ONBOARD');
  };

  const handleGoogleOnboardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      if (!isAdult) {
        throw new Error('Người dùng phải từ đủ 18 tuổi trở lên để tham gia.');
      }
      if (!policyAccepted) {
        throw new Error('Bạn cần đồng ý với chính sách 18+ và điều khoản sử dụng.');
      }

      const response = await apiFetch('/api/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: googleIdToken || 'simulated-token',
          nickname: nickname.trim() || 'Người dùng Google',
          gender,
          birthDate,
        }),
      });

      const data = (await response.json()) as AuthResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Đăng nhập Google thất bại');

      onSuccess(data.profile);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra khi xác thực Google');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setIsLoading(true);

    try {
      if (mode === 'REGISTER') {
        if (!isAdult) {
          throw new Error('Người dùng phải từ đủ 18 tuổi trở lên để tham gia Chatible.');
        }
        if (!policyAccepted) {
          throw new Error('Bạn cần đồng ý với chính sách 18+ và điều khoản sử dụng.');
        }
        if (password.length < 8) {
          throw new Error('Mật khẩu tối thiểu 8 ký tự.');
        }

        const response = await apiFetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            nickname: nickname.trim(),
            gender,
            birthDate,
            policyAccepted,
          }),
        });

        const data = (await response.json()) as AuthResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Đăng ký thất bại');

          onSuccess(data.profile);
        onClose();
      } else if (mode === 'LOGIN') {
        const response = await apiFetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const data = (await response.json()) as AuthResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || 'Đăng nhập thất bại');

          onSuccess(data.profile);
        onClose();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-[32px] bg-white p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
        >
          <X size={16} />
        </button>

        {/* Back navigation when in forgot or reset mode */}
        {(mode === 'FORGOT' || mode === 'RESET' || mode === 'GOOGLE_ONBOARD') && (
          <button
            type="button"
            onClick={() => {
              setMode('LOGIN');
              setError(null);
            }}
            className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft size={14} /> Quay lại đăng nhập
          </button>
        )}

        {/* Header Tabs for REGISTER & LOGIN */}
        {(mode === 'REGISTER' || mode === 'LOGIN') && (
          <div className="mb-5 flex rounded-full bg-slate-100 p-1">
            <button
              onClick={() => {
                if (authConfig?.registrationEnabled === false) {
                  setError('Đăng ký tài khoản mới hiện đang tạm đóng để bảo trì.');
                  return;
                }
                setMode('REGISTER');
                setError(null);
              }}
              className={`flex-1 rounded-full py-2 text-xs font-bold transition ${
                mode === 'REGISTER' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'
              }`}
            >
              Đăng ký (18+)
            </button>
            <button
              onClick={() => {
                setMode('LOGIN');
                setError(null);
              }}
              className={`flex-1 rounded-full py-2 text-xs font-bold transition ${
                mode === 'LOGIN' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'
              }`}
            >
              Đăng nhập
            </button>
          </div>
        )}

        {mode === 'FORGOT' && (
          <div className="mb-4 text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600">
              <KeyRound size={20} />
            </div>
            <h2 className="text-base font-bold text-slate-900">Quên mật khẩu?</h2>
            <p className="mt-1 text-xs text-slate-500">
              Nhập email tài khoản của bạn để nhận mã xác nhận đặt lại mật khẩu.
            </p>
          </div>
        )}

        {mode === 'RESET' && (
          <div className="mb-4 text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <KeyRound size={20} />
            </div>
            <h2 className="text-base font-bold text-slate-900">Đặt lại mật khẩu</h2>
            <p className="mt-1 text-xs text-slate-500">
              Nhập mã 6 chữ số và mật khẩu mới cho tài khoản của bạn.
            </p>
          </div>
        )}

        {mode === 'GOOGLE_ONBOARD' && (
          <div className="mb-4 text-center">
            <h2 className="text-base font-bold text-slate-900">Hoàn tất đăng ký Google</h2>
            <p className="mt-1 text-xs text-slate-500">
              Chatible chỉ dành cho người từ đủ 18 tuổi. Vui lòng xác nhận ngày sinh của bạn.
            </p>
          </div>
        )}

        {successMsg && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs font-medium text-emerald-700">
            <CheckCircle2 size={16} className="shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-rose-50 p-3 text-xs font-medium text-rose-600">
            <AlertCircle size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* FORGOT PASSWORD FORM */}
        {mode === 'FORGOT' && (
          <form onSubmit={handleForgotPassword} className="flex flex-col gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-500">EMAIL TÀI KHOẢN</label>
              <div className="relative mt-1 flex items-center">
                <Mail size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="email"
                  required
                  placeholder="tenban@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={isLoading || !email.trim()}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 py-3 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
            >
              <span>{isLoading ? 'Đang gửi...' : 'Gửi mã xác nhận'}</span>
            </button>
          </form>
        )}

        {/* RESET PASSWORD FORM */}
        {mode === 'RESET' && (
          <form onSubmit={handleResetPassword} className="flex flex-col gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-500">EMAIL</label>
              <div className="relative mt-1 flex items-center">
                <Mail size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-500">MÃ XÁC THỰC 6 SỐ</label>
                {resendCooldown > 0 ? (
                  <span className="text-[10px] text-slate-400">Gửi lại sau {resendCooldown}s</span>
                ) : (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-[10px] font-bold text-blue-600 hover:underline"
                  >
                    Gửi lại mã
                  </button>
                )}
              </div>
              <div className="relative mt-1 flex items-center">
                <KeyRound size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="text"
                  required
                  maxLength={6}
                  placeholder="VD: 123456"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs font-mono font-bold tracking-widest outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-500">MẬT KHẨU MỚI</label>
              <div className="relative mt-1 flex items-center">
                <Lock size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="password"
                  required
                  placeholder="Tối thiểu 8 ký tự"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || !resetCode.trim() || newPassword.length < 8}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 py-3 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
            >
              <span>{isLoading ? 'Đang cập nhật...' : 'Cập nhật mật khẩu mới'}</span>
            </button>
          </form>
        )}

        {/* GOOGLE ONBOARDING FORM */}
        {mode === 'GOOGLE_ONBOARD' && (
          <form onSubmit={handleGoogleOnboardSubmit} className="flex flex-col gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-500">BIỆT DANH</label>
              <div className="relative mt-1 flex items-center">
                <User size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="text"
                  required
                  placeholder="Tên hiển thị (vd: Minh Thư)"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-500">GIỚI TÍNH CỦA BẠN</label>
              <div className="mt-1 flex gap-2">
                {(['MALE', 'FEMALE', 'OTHER'] as Gender[]).map((g) => (
                  <button
                    type="button"
                    key={g}
                    onClick={() => setGender(g)}
                    className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${
                      gender === g
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'border border-slate-200 bg-slate-50 text-slate-600'
                    }`}
                  >
                    {g === 'MALE' ? 'Nam' : g === 'FEMALE' ? 'Nữ' : 'Khác'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-500">NGÀY SINH (TỰ KHAI BẢO MẬT)</label>
                {birthDate && (
                  <span
                    className={`text-[10px] font-bold ${
                      isAdult ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {currentAge} tuổi {isAdult ? '• Đủ 18+' : '• Chưa đủ 18'}
                  </span>
                )}
              </div>
              <div className="relative mt-1 flex items-center">
                <Calendar size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="date"
                  required
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <label className="mt-1 flex items-start gap-2 cursor-pointer text-[11px] text-slate-600">
              <input
                type="checkbox"
                checked={policyAccepted}
                onChange={(e) => setPolicyAccepted(e.target.checked)}
                className="mt-0.5 rounded text-blue-600 focus:ring-blue-500"
              />
              <span>Tôi xác nhận đủ 18 tuổi và đồng ý với Điều khoản sử dụng của Chatible.</span>
            </label>

            <button
              type="submit"
              disabled={isLoading || !isAdult || !policyAccepted}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 py-3 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
            >
              <span>{isLoading ? 'Đang xác thực...' : 'Hoàn tất Đăng ký 18+'}</span>
            </button>
          </form>
        )}

        {/* STANDARD REGISTER OR LOGIN FORM */}
        {(mode === 'REGISTER' || mode === 'LOGIN') && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {mode === 'REGISTER' && (
              <>
                <div>
                  <label className="text-[11px] font-bold text-slate-500">BIỆT DANH</label>
                  <div className="relative mt-1 flex items-center">
                    <User size={16} className="absolute left-3 text-slate-400" />
                    <input
                      type="text"
                      required
                      placeholder="Tên hiển thị (vd: Minh Thư)"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-500">GIỚI TÍNH CỦA BẠN</label>
                  <div className="mt-1 flex gap-2">
                    {(['MALE', 'FEMALE', 'OTHER'] as Gender[]).map((g) => (
                      <button
                        type="button"
                        key={g}
                        onClick={() => setGender(g)}
                        className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${
                          gender === g
                            ? 'bg-blue-600 text-white shadow-md'
                            : 'border border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                      >
                        {g === 'MALE' ? 'Nam' : g === 'FEMALE' ? 'Nữ' : 'Khác'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-bold text-slate-500">NGÀY SINH (TỰ KHAI BẢO MẬT)</label>
                    {birthDate && (
                      <span
                        className={`text-[10px] font-bold ${
                          isAdult ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {currentAge} tuổi {isAdult ? '• Đủ 18+' : '• Chưa đủ 18'}
                      </span>
                    )}
                  </div>
                  <div className="relative mt-1 flex items-center">
                    <Calendar size={16} className="absolute left-3 text-slate-400" />
                    <input
                      type="date"
                      required
                      value={birthDate}
                      onChange={(e) => setBirthDate(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">
                    Ngày sinh được giữ kín tuyệt đối; đối phương chỉ thấy số tuổi.
                  </p>
                </div>
              </>
            )}

            <div>
              <label className="text-[11px] font-bold text-slate-500">EMAIL</label>
              <div className="relative mt-1 flex items-center">
                <Mail size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="email"
                  required
                  placeholder="tenban@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-slate-500">MẬT KHẨU</label>
                {mode === 'LOGIN' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('FORGOT');
                      setError(null);
                    }}
                    className="text-[10px] font-bold text-blue-600 hover:underline"
                  >
                    Quên mật khẩu?
                  </button>
                )}
              </div>
              <div className="relative mt-1 flex items-center">
                <Lock size={16} className="absolute left-3 text-slate-400" />
                <input
                  type="password"
                  required
                  placeholder="Tối thiểu 8 ký tự"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {mode === 'REGISTER' && (
              <label className="mt-1 flex items-start gap-2 cursor-pointer text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={policyAccepted}
                  onChange={(e) => setPolicyAccepted(e.target.checked)}
                  className="mt-0.5 rounded text-blue-600 focus:ring-blue-500"
                />
                <span>Tôi xác nhận đủ 18 tuổi và đồng ý với Điều khoản sử dụng của Chatible.</span>
              </label>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 py-3 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
            >
              <ShieldCheck size={16} />
              <span>{mode === 'REGISTER' ? 'Hoàn tất Đăng ký 18+' : 'Đăng nhập'}</span>
            </button>

            {/* Google Sign-In Divider & Button (only if Google Auth is enabled by Admin) */}
            {authConfig?.googleAuthEnabled !== false && (
              <>
                <div className="relative my-2 flex items-center justify-center">
                  <div className="w-full border-t border-slate-200" />
                  <span className="absolute bg-white px-3 text-[10px] font-semibold text-slate-400">
                    HOẶC
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleClick}
                  className="flex w-full items-center justify-center gap-2.5 rounded-full border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span>Đăng nhập bằng Google</span>
                </button>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AuthResponse, TargetGender, UpdateProfileDto } from '@chatible/shared';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  EyeOff,
  FileText,
  KeyRound,
  Lock,
  LogOut,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserX,
} from 'lucide-react';
import { apiFetch } from '../../api.js';

type UserProfile = AuthResponse['profile'];

type BlockedUser = {
  userId: string;
  nickname: string;
  gender: string;
  age: number;
  blockedAt: string;
};

type ProfileViewProps = {
  profile: UserProfile;
  onProfileUpdate: (updated: UserProfile) => void;
  onLogout: () => void;
};

export function ProfileView({ profile, onProfileUpdate, onLogout }: ProfileViewProps) {
  // Profile & Matching Form State
  const [nickname, setNickname] = useState(profile.nickname);
  const [preferredGender, setPreferredGender] = useState<TargetGender>(
    (profile.preferredGender as TargetGender) || 'ALL'
  );
  const [preferredAgeMin, setPreferredAgeMin] = useState<number>(profile.preferredAgeMin ?? 18);
  const [preferredAgeMax, setPreferredAgeMax] = useState<number>(profile.preferredAgeMax ?? 30);
  const [mediaConsentDefault, setMediaConsentDefault] = useState<boolean>(
    profile.mediaConsentDefault ?? false
  );
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSuccessMsg, setProfileSuccessMsg] = useState<string | null>(null);
  const [profileErrorMsg, setProfileErrorMsg] = useState<string | null>(null);

  // Blocked Users State
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [isBlockedLoading, setIsBlockedLoading] = useState(false);
  const [isBlockedOpen, setIsBlockedOpen] = useState(false);
  const [unblockingUserId, setUnblockingUserId] = useState<string | null>(null);

  // Appeals State
  const [isAppealOpen, setIsAppealOpen] = useState(false);
  const [appealReason, setAppealReason] = useState('');
  const [isSubmittingAppeal, setIsSubmittingAppeal] = useState(false);
  const [appealSuccessMsg, setAppealSuccessMsg] = useState<string | null>(null);
  const [appealErrorMsg, setAppealErrorMsg] = useState<string | null>(null);

  // Privacy Terms & Stealth State
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false);
  const [isStealthEnabled, setIsStealthEnabled] = useState(false);
  const [isStealthLoading, setIsStealthLoading] = useState(true);
  const [isStealthSetupOpen, setIsStealthSetupOpen] = useState(false);
  const [stealthPin, setStealthPin] = useState('');
  const [stealthConfirmPin, setStealthConfirmPin] = useState('');
  const [stealthCurrentPin, setStealthCurrentPin] = useState('');
  const [stealthErrorMsg, setStealthErrorMsg] = useState<string | null>(null);
  const [stealthSuccessMsg, setStealthSuccessMsg] = useState<string | null>(null);
  const [isSavingStealth, setIsSavingStealth] = useState(false);

  // Change Password State
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordSuccessMsg, setPasswordSuccessMsg] = useState<string | null>(null);
  const [passwordErrorMsg, setPasswordErrorMsg] = useState<string | null>(null);

  // Delete Account State
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Load private profile preferences from /api/v1/users/me
  useEffect(() => {
    let isCurrent = true;
    void apiFetch('/api/v1/users/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UserProfile | null) => {
        if (!isCurrent || !data) return;
        setNickname(data.nickname);
        if (data.preferredGender) setPreferredGender(data.preferredGender as TargetGender);
        if (data.preferredAgeMin !== undefined) setPreferredAgeMin(data.preferredAgeMin);
        if (data.preferredAgeMax !== undefined) setPreferredAgeMax(data.preferredAgeMax);
        if (data.mediaConsentDefault !== undefined) setMediaConsentDefault(data.mediaConsentDefault);
      })
      .catch(() => {});
    return () => {
      isCurrent = false;
    };
  }, []);

  // Remove the former client-side plaintext PIN and load only server-side state.
  useEffect(() => {
    let isCurrent = true;
    void apiFetch('/api/v1/users/me/stealth-vault')
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
        if (!res.ok) throw new Error(data.error || 'Không thể tải trạng thái Kho riêng tư.');
        return data;
      })
      .then((data) => {
        if (isCurrent) setIsStealthEnabled(data.enabled === true);
      })
      .catch((err) => {
        if (isCurrent) setStealthErrorMsg(err instanceof Error ? err.message : 'Không thể tải Kho riêng tư.');
      })
      .finally(() => {
        if (isCurrent) setIsStealthLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  // Fetch Blocked Users
  const loadBlockedUsers = useCallback(async () => {
    setIsBlockedLoading(true);
    try {
      const response = await apiFetch('/api/v1/blocks');
      const data = (await response.json()) as { blockedUsers?: BlockedUser[]; error?: string };
      if (response.ok && Array.isArray(data.blockedUsers)) {
        setBlockedUsers(data.blockedUsers);
      }
    } catch {
      // ignore
    } finally {
      setIsBlockedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isBlockedOpen) {
      void loadBlockedUsers();
    }
  }, [isBlockedOpen, loadBlockedUsers]);

  // Handle Profile Update
  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setIsSavingProfile(true);
    setProfileSuccessMsg(null);
    setProfileErrorMsg(null);

    const dto: UpdateProfileDto = {
      nickname: nickname.trim(),
      preferredGender,
      preferredAgeMin,
      preferredAgeMax,
      mediaConsentDefault,
    };

    try {
      const response = await apiFetch('/api/v1/users/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
      });
      const data = (await response.json()) as UserProfile & { error?: string };
      if (!response.ok) throw new Error(data.error || 'Cập nhật hồ sơ thất bại.');

      setProfileSuccessMsg('Cập nhật hồ sơ & bộ lọc thành công!');
      onProfileUpdate(data);
      setTimeout(() => setProfileSuccessMsg(null), 3000);
    } catch (err) {
      setProfileErrorMsg(err instanceof Error ? err.message : 'Cập nhật thất bại.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Handle Unblock User
  const handleUnblock = async (targetUserId: string) => {
    setUnblockingUserId(targetUserId);
    try {
      const response = await apiFetch(`/api/v1/blocks/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Bỏ chặn thất bại.');
      setBlockedUsers((prev) => prev.filter((u) => u.userId !== targetUserId));
      setProfileSuccessMsg('Đã bỏ chặn người dùng.');
      setTimeout(() => setProfileSuccessMsg(null), 3000);
    } catch (err) {
      setProfileErrorMsg(err instanceof Error ? err.message : 'Bỏ chặn thất bại.');
      setTimeout(() => setProfileErrorMsg(null), 3000);
    } finally {
      setUnblockingUserId(null);
    }
  };

  // Handle Submit Appeal
  const handleSubmitAppeal = async (e: FormEvent) => {
    e.preventDefault();
    if (appealReason.trim().length < 10) {
      setAppealErrorMsg('Lý do khiếu nại phải có ít nhất 10 ký tự.');
      return;
    }

    setIsSubmittingAppeal(true);
    setAppealSuccessMsg(null);
    setAppealErrorMsg(null);

    try {
      const response = await apiFetch('/api/v1/appeals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: appealReason.trim() }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Gửi khiếu nại thất bại.');

      setAppealSuccessMsg('Đã gửi khiếu nại! Quản trị viên sẽ xem xét trong vòng 7 ngày.');
      setAppealReason('');
    } catch (err) {
      setAppealErrorMsg(err instanceof Error ? err.message : 'Gửi khiếu nại thất bại.');
    } finally {
      setIsSubmittingAppeal(false);
    }
  };

  // Handle Change Password
  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentPassword) {
      setPasswordErrorMsg('Vui lòng nhập mật khẩu hiện tại.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordErrorMsg('Mật khẩu mới phải có tối thiểu 8 ký tự.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordErrorMsg('Mật khẩu xác nhận không khớp.');
      return;
    }

    setIsChangingPassword(true);
    setPasswordSuccessMsg(null);
    setPasswordErrorMsg(null);

    try {
      const response = await apiFetch('/api/v1/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Đổi mật khẩu thất bại.');

      setPasswordSuccessMsg('Đổi mật khẩu thành công! Vui lòng đăng nhập lại.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onLogout();
    } catch (err) {
      setPasswordErrorMsg(err instanceof Error ? err.message : 'Đổi mật khẩu thất bại.');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const cleanStealthPin = (value: string) => value.replace(/\D/g, '').slice(0, 4);

  const handleToggleStealth = async () => {
    setStealthErrorMsg(null);
    setStealthSuccessMsg(null);
    if (!isStealthEnabled) {
      setIsStealthSetupOpen(true);
      return;
    }

    setIsSavingStealth(true);
    try {
      const response = await apiFetch('/api/v1/users/me/stealth-vault', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const data = (await response.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || 'Không thể tắt Kho riêng tư.');
      setIsStealthEnabled(false);
      setIsStealthSetupOpen(false);
      setStealthPin('');
      setStealthConfirmPin('');
      setStealthCurrentPin('');
      setStealthSuccessMsg('Đã tắt Kho riêng tư và xóa mã PIN trên máy chủ.');
    } catch (err) {
      setStealthErrorMsg(err instanceof Error ? err.message : 'Không thể tắt Kho riêng tư.');
    } finally {
      setIsSavingStealth(false);
    }
  };

  const handleSaveStealthPin = async (e: FormEvent, changingExistingPin: boolean) => {
    e.preventDefault();
    setStealthErrorMsg(null);
    setStealthSuccessMsg(null);
    if (stealthPin.length !== 4 || stealthConfirmPin.length !== 4) {
      setStealthErrorMsg('Mã PIN phải gồm đúng 4 chữ số.');
      return;
    }
    if (stealthPin !== stealthConfirmPin) {
      setStealthErrorMsg('Xác nhận mã PIN không khớp.');
      return;
    }
    if (changingExistingPin && stealthCurrentPin.length !== 4) {
      setStealthErrorMsg('Nhập mã PIN hiện tại gồm 4 chữ số.');
      return;
    }

    setIsSavingStealth(true);
    try {
      const response = await apiFetch('/api/v1/users/me/stealth-vault', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          pin: stealthPin,
          ...(changingExistingPin ? { currentPin: stealthCurrentPin } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || 'Không thể lưu mã PIN.');
      setIsStealthEnabled(data.enabled === true);
      setIsStealthSetupOpen(false);
      setStealthPin('');
      setStealthConfirmPin('');
      setStealthCurrentPin('');
      setStealthSuccessMsg(changingExistingPin ? 'Đã đổi mã PIN Kho riêng tư.' : 'Đã bật Kho riêng tư.');
    } catch (err) {
      setStealthErrorMsg(err instanceof Error ? err.message : 'Không thể lưu mã PIN.');
    } finally {
      setIsSavingStealth(false);
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    setDeleteError(null);
    try {
      const response = await apiFetch('/api/v1/users/me', {
        method: 'DELETE',
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Xóa tài khoản thất bại');
      onLogout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Có lỗi xảy ra khi xóa tài khoản');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <div className="space-y-4 py-3">
      {/* 1. Profile Hero Card */}
      <section className="rounded-2xl border border-slate-100 bg-gradient-to-br from-blue-50 to-indigo-50/40 p-4 shadow-sm">
        <div className="flex items-center gap-3.5">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-blue-600 font-extrabold text-white text-xl shadow-md">
            {profile.nickname.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-slate-900">{profile.nickname}</h1>
            <p className="text-xs text-slate-600 font-medium">
              {profile.gender === 'FEMALE' ? 'Nữ' : profile.gender === 'MALE' ? 'Nam' : 'Khác'} · {profile.age} tuổi
            </p>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
              <ShieldCheck size={14} className="text-emerald-600" />
              <span title="Dựa trên ngày sinh tự khai báo, chưa xác thực bằng CCCD/Hộ chiếu">
                Tự khai 18+ (Dựa trên ngày sinh)
              </span>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-xl bg-white/70 p-2.5 text-[11px] leading-relaxed text-slate-600">
          <Lock size={13} className="mt-0.5 shrink-0 text-blue-600" />
          <span>
            <strong>Bảo vệ riêng tư:</strong> Ngày sinh chỉ dùng để tính tuổi tự động, không bao giờ công khai cho người khác.
          </span>
        </div>
      </section>

      {/* 2. Matching & Profile Settings Form */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
          <SlidersHorizontal size={17} className="text-blue-600" />
          <h2>Ghép đôi & Thông tin hiển thị</h2>
        </div>

        <form onSubmit={handleSaveProfile} className="mt-3.5 space-y-3.5">
          <div>
            <label htmlFor="nickname" className="block text-xs font-semibold text-slate-700">
              Biệt danh hiển thị
            </label>
            <input
              id="nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={30}
              required
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">
              Ưu tiên ghép đôi theo giới tính
            </label>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {(
                [
                  { key: 'ALL', label: 'Tất cả' },
                  { key: 'FEMALE', label: 'Nữ' },
                  { key: 'MALE', label: 'Nam' },
                  { key: 'OTHER', label: 'Khác' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setPreferredGender(opt.key)}
                  className={`rounded-lg py-1.5 text-xs font-bold transition ${
                    preferredGender === opt.key
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ageMin" className="block text-xs font-semibold text-slate-700">
                Tuổi tối thiểu (≥ 18)
              </label>
              <input
                id="ageMin"
                type="number"
                min={18}
                max={99}
                value={preferredAgeMin}
                onChange={(e) => setPreferredAgeMin(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="ageMax" className="block text-xs font-semibold text-slate-700">
                Tuổi tối đa (≤ 99)
              </label>
              <input
                id="ageMax"
                type="number"
                min={18}
                max={99}
                value={preferredAgeMax}
                onChange={(e) => setPreferredAgeMax(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="min-w-0 pr-2">
              <span className="block text-xs font-semibold text-slate-800">Mặc định nhận ảnh / media</span>
              <span className="text-[11px] text-slate-500 leading-tight">
                Tự động cho phép nhận ảnh/âm thanh trong cuộc trò chuyện bạn bè
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={mediaConsentDefault}
              onClick={() => setMediaConsentDefault(!mediaConsentDefault)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                mediaConsentDefault ? 'bg-blue-600' : 'bg-slate-300'
              }`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  mediaConsentDefault ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {profileSuccessMsg && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
              <Check size={14} />
              {profileSuccessMsg}
            </p>
          )}

          {profileErrorMsg && (
            <p className="text-xs text-rose-600">{profileErrorMsg}</p>
          )}

          <button
            type="submit"
            disabled={isSavingProfile}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            <Save size={15} />
            {isSavingProfile ? 'Đang lưu…' : 'Lưu thay đổi'}
          </button>
        </form>
      </section>

      {/* 3. Blocked Users Management */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setIsBlockedOpen((prev) => !prev)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <UserX size={17} className="text-rose-500" />
            <span>Danh sách chặn</span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <span className="text-xs text-slate-500 font-medium">
              {blockedUsers.length > 0 ? `${blockedUsers.length} người` : 'Quản lý'}
            </span>
            {isBlockedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isBlockedOpen && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            {isBlockedLoading ? (
              <p className="py-2 text-center text-xs text-slate-400">Đang tải danh sách chặn…</p>
            ) : blockedUsers.length === 0 ? (
              <p className="py-2 text-center text-xs text-slate-500">Bạn chưa chặn tài khoản nào.</p>
            ) : (
              <div className="space-y-2">
                {blockedUsers.map((user) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between rounded-xl bg-slate-50 p-2.5 text-xs"
                  >
                    <div>
                      <p className="font-bold text-slate-800">{user.nickname}</p>
                      <p className="text-[11px] text-slate-500">
                        {user.gender === 'FEMALE' ? 'Nữ' : 'Nam'} · {user.age} tuổi
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleUnblock(user.userId)}
                      disabled={unblockingUserId === user.userId}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {unblockingUserId === user.userId ? 'Đang bỏ…' : 'Bỏ chặn'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 4. Security: Change Password */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setIsPasswordOpen((prev) => !prev)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <KeyRound size={17} className="text-blue-600" />
            <span>Đổi mật khẩu</span>
          </div>
          <div className="flex items-center gap-1 text-slate-400">
            <span className="text-xs text-slate-500 font-medium">Bảo mật</span>
            {isPasswordOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isPasswordOpen && (
          <form onSubmit={handleChangePassword} className="mt-3 border-t border-slate-100 pt-3 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Mật khẩu hiện tại</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="Nhập mật khẩu đang dùng…"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Mật khẩu mới (tối thiểu 8 ký tự)</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="Tối thiểu 8 ký tự…"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Xác nhận mật khẩu mới</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="Nhập lại mật khẩu mới…"
              />
            </div>

            {passwordSuccessMsg && (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                <Check size={14} />
                {passwordSuccessMsg}
              </p>
            )}

            {passwordErrorMsg && (
              <p className="text-xs text-rose-600">{passwordErrorMsg}</p>
            )}

            <button
              type="submit"
              disabled={isChangingPassword || !currentPassword || newPassword.length < 8}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              <Save size={14} />
              {isChangingPassword ? 'Đang cập nhật…' : 'Cập nhật mật khẩu'}
            </button>
          </form>
        )}
      </section>

      {/* 5. Account Status & Restriction Appeals (PRO-05) */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setIsAppealOpen((prev) => !prev)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <ShieldAlert size={17} className="text-amber-500" />
            <span>Trạng thái tài khoản & Khiếu nại</span>
          </div>
          <div className="flex items-center gap-1 text-slate-400">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              Bình thường
            </span>
            {isAppealOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isAppealOpen && (
          <form onSubmit={handleSubmitAppeal} className="mt-3 border-t border-slate-100 pt-3 space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed">
              Theo chính sách <strong>PRO-05</strong>, nếu tài khoản của bạn bị hạn chế hoặc bạn cần khiếu nại quyết định điều hành, bạn có thể nộp đơn giải trình để Quản trị viên tối cao xem xét lại bằng chứng.
            </p>

            <div>
              <label htmlFor="appealReason" className="block text-xs font-semibold text-slate-700">
                Lý do khiếu nại (tối thiểu 10 ký tự)
              </label>
              <textarea
                id="appealReason"
                rows={3}
                value={appealReason}
                onChange={(e) => setAppealReason(e.target.value)}
                placeholder="Trình bày rõ lý do hoặc bằng chứng giải trình…"
                className="mt-1 w-full rounded-xl border border-slate-200 p-2.5 text-xs text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {appealSuccessMsg && (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                <Check size={14} />
                {appealSuccessMsg}
              </p>
            )}

            {appealErrorMsg && (
              <p className="text-xs text-rose-600">{appealErrorMsg}</p>
            )}

            <button
              type="submit"
              disabled={isSubmittingAppeal || appealReason.trim().length < 10}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition hover:bg-amber-600 disabled:opacity-50"
            >
              <Send size={14} />
              {isSubmittingAppeal ? 'Đang gửi…' : 'Gửi đơn khiếu nại'}
            </button>
          </form>
        )}
      </section>

      {/* 6. Realistic Privacy, Terms & Data Policy */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setIsPrivacyOpen((prev) => !prev)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
            <FileText size={17} className="text-blue-600" />
            <span>Quy tắc, Điều khoản & Quyền riêng tư</span>
          </div>
          <div className="text-slate-400">
            {isPrivacyOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </button>

        {isPrivacyOpen && (
          <div className="mt-3 border-t border-slate-100 pt-3 space-y-3 text-xs text-slate-600 leading-relaxed">
            <div className="rounded-xl bg-slate-50 p-3">
              <h4 className="font-bold text-slate-800">1. Dữ liệu hiển thị công khai</h4>
              <p className="mt-1 text-slate-500 text-[11px]">
                Đối tác trò chuyện chỉ nhìn thấy <strong>biệt danh</strong>, <strong>giới tính tự khai</strong> và <strong>tuổi tính toán</strong> của bạn. Email và ngày sinh chính xác luôn được giữ bí mật.
              </p>
            </div>

            <div className="rounded-xl bg-slate-50 p-3">
              <h4 className="font-bold text-slate-800">2. Mã hóa & Quyền hạn vận hành</h4>
              <p className="mt-1 text-slate-500 text-[11px]">
                Tin nhắn và media được mã hóa phong bì AES-256-GCM và quản lý khóa qua hệ thống KMS của máy chủ. Đơn vị vận hành chỉ giải mã nội dung khi tiếp nhận báo cáo vi phạm có bằng chứng hoặc yêu cầu pháp lý theo quy định an toàn mạng.
              </p>
            </div>

            <div className="rounded-xl bg-slate-50 p-3">
              <h4 className="font-bold text-slate-800">3. Thời hạn lưu trữ dữ liệu</h4>
              <ul className="mt-1 list-disc pl-4 text-slate-500 text-[11px] space-y-0.5">
                <li>Phiên chat ngẫu nhiên: Tối đa đúng <strong>7 ngày</strong> sau khi phiên kết thúc.</li>
                <li>Tin nhắn bạn bè 1-1: Tối đa <strong>30 ngày</strong>.</li>
                <li>Bằng chứng báo cáo vi phạm: Đóng băng bảo mật <strong>90 ngày</strong> sau khi giải quyết để phục vụ điều tra và khiếu nại.</li>
              </ul>
            </div>

            <div className="rounded-xl bg-amber-50/70 p-3 border border-amber-200/50">
              <h4 className="font-bold text-amber-900">4. Giới hạn bảo vệ chống chụp màn hình</h4>
              <p className="mt-1 text-amber-800 text-[11px]">
                Watermark động kèm token định danh và quyền xem media 5 phút là biện pháp răn đe kỹ thuật. Hệ thống không thể ngăn chặn tuyệt đối trường hợp đối phương sử dụng thiết bị ghi hình ngoại vi chụp lại màn hình.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 7. Stealth Vault / Camouflage Settings */}
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <EyeOff size={17} className="text-indigo-600" />
            <div>
              <h2 className="text-xs font-bold text-slate-800">Chế độ Ngụy trang (Stealth Vault)</h2>
              <p className="text-[11px] text-slate-500">Khóa lịch sử phiên gần đây bằng mã PIN</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isStealthEnabled}
            onClick={() => void handleToggleStealth()}
            disabled={isStealthLoading || isSavingStealth}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              isStealthEnabled ? 'bg-indigo-600' : 'bg-slate-200'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                isStealthEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {isStealthLoading && <p className="mt-3 text-[11px] text-slate-500">Đang tải trạng thái…</p>}

        {!isStealthEnabled && isStealthSetupOpen && (
          <div className="mt-3.5 border-t border-slate-100 pt-3">
            <p className="text-[11px] leading-relaxed text-slate-500">
              Tạo mã PIN riêng gồm 4 số. Mã được băm trên máy chủ, không lưu trong trình duyệt và không có mã mặc định.
            </p>
            <form onSubmit={(e) => void handleSaveStealthPin(e, false)} className="mt-2.5 space-y-2">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={stealthPin}
                onChange={(e) => setStealthPin(cleanStealthPin(e.target.value))}
                placeholder="Mã PIN mới"
                aria-label="Mã PIN mới gồm 4 số"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-mono font-bold tracking-widest text-slate-900 outline-none focus:border-indigo-500"
              />
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={stealthConfirmPin}
                onChange={(e) => setStealthConfirmPin(cleanStealthPin(e.target.value))}
                placeholder="Nhập lại mã PIN"
                aria-label="Xác nhận mã PIN gồm 4 số"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-mono font-bold tracking-widest text-slate-900 outline-none focus:border-indigo-500"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setIsStealthSetupOpen(false)} className="flex-1 rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600">Hủy</button>
                <button type="submit" disabled={isSavingStealth} className="flex-1 rounded-xl bg-indigo-600 py-2 text-xs font-bold text-white disabled:opacity-50">{isSavingStealth ? 'Đang lưu…' : 'Bật Kho riêng tư'}</button>
              </div>
            </form>
          </div>
        )}

        {isStealthEnabled && (
          <form onSubmit={(e) => void handleSaveStealthPin(e, true)} className="mt-3.5 space-y-2 border-t border-slate-100 pt-3">
            <p className="text-[11px] leading-relaxed text-slate-500">Đổi PIN cần xác nhận bằng mã hiện tại. PIN không bao giờ được lưu trong trình duyệt.</p>
            <input type="password" inputMode="numeric" maxLength={4} value={stealthCurrentPin} onChange={(e) => setStealthCurrentPin(cleanStealthPin(e.target.value))} placeholder="Mã PIN hiện tại" aria-label="Mã PIN hiện tại" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-mono font-bold tracking-widest text-slate-900 outline-none focus:border-indigo-500" />
            <input type="password" inputMode="numeric" maxLength={4} value={stealthPin} onChange={(e) => setStealthPin(cleanStealthPin(e.target.value))} placeholder="Mã PIN mới" aria-label="Mã PIN mới" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-mono font-bold tracking-widest text-slate-900 outline-none focus:border-indigo-500" />
            <input type="password" inputMode="numeric" maxLength={4} value={stealthConfirmPin} onChange={(e) => setStealthConfirmPin(cleanStealthPin(e.target.value))} placeholder="Nhập lại mã PIN mới" aria-label="Xác nhận mã PIN mới" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-mono font-bold tracking-widest text-slate-900 outline-none focus:border-indigo-500" />
            <button type="submit" disabled={isSavingStealth} className="w-full rounded-xl border border-indigo-200 bg-indigo-50 py-2 text-xs font-bold text-indigo-700 disabled:opacity-50">{isSavingStealth ? 'Đang lưu…' : 'Đổi mã PIN'}</button>
          </form>
        )}

        {stealthSuccessMsg && <p className="mt-3 text-xs font-semibold text-emerald-600">{stealthSuccessMsg}</p>}
        {stealthErrorMsg && <p className="mt-3 text-xs font-semibold text-rose-600">{stealthErrorMsg}</p>}
      </section>

      {/* 8. Danger Zone: Delete Account */}
      <section className="rounded-2xl border border-rose-100 bg-rose-50/20 p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-bold text-rose-900">Xóa tài khoản</h2>
            <p className="text-[11px] text-slate-500">Hủy kích hoạt vĩnh viễn và ẩn thông tin</p>
          </div>
          <button
            type="button"
            onClick={() => setIsDeleteConfirmOpen(true)}
            className="flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-bold text-rose-600 shadow-sm transition hover:bg-rose-50"
          >
            <Trash2 size={13} />
            <span>Xóa</span>
          </button>
        </div>
      </section>

      {/* 9. Logout */}
      <button
        type="button"
        onClick={onLogout}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
      >
        <LogOut size={16} />
        Đăng xuất
      </button>

      {/* Delete Account Confirmation Modal */}
      {isDeleteConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <AlertTriangle size={24} />
            </div>
            <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
              Xác nhận xóa tài khoản vĩnh viễn?
            </h3>
            <div className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed text-slate-600">
              <p>• Tài khoản sẽ bị hủy kích hoạt và không thể đăng nhập lại.</p>
              <p>• Toàn bộ bạn bè và lời mời kết bạn sẽ bị xóa ngay lập tức.</p>
              <p>• Lịch sử trò chuyện chưa hết hạn sẽ tự hủy theo chính sách 7 ngày.</p>
              <p>• Bằng chứng báo cáo vi phạm (nếu có) được đóng băng tối đa 90 ngày theo luật an toàn trước khi hủy hoàn toàn.</p>
            </div>

            {deleteError && (
              <p className="mt-2 text-center text-xs font-semibold text-rose-600">{deleteError}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isDeletingAccount}
                onClick={handleDeleteAccount}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white shadow-md shadow-rose-600/30 hover:bg-rose-700 disabled:opacity-50"
              >
                {isDeletingAccount ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AuthResponse } from '@chatible/shared';
import { Clock3, MessageSquare, MessagesSquare, ShieldAlert, User, UsersRound } from 'lucide-react';
import { apiFetch } from './api.js';
import { AuthModal } from './features/auth/AuthModal.js';
import { ChatEngine } from './features/chat/ChatEngine.js';
import { FriendsView } from './features/friends/FriendsView.js';
import { GroupsView } from './features/groups/GroupsView.js';
import { RecentSessionsView } from './features/sessions/RecentSessionsView.js';
import { ProfileView } from './features/profile/ProfileView.js';
import { ReportModal } from './features/safety/ReportModal.js';

type UserProfile = AuthResponse['profile'];
type ReportRequest = {
  sessionId: string;
  reportedUserId: string;
  evidenceMessageIds: string[];
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'friends' | 'groups' | 'recent' | 'profile'>('chat');
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [pendingReport, setPendingReport] = useState<ReportRequest | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);

  useEffect(() => {
    // Remove any legacy insecure storage keys
    localStorage.removeItem('chatible_token');
    localStorage.removeItem('chatible_user_profile');

    let isCurrent = true;
    void apiFetch('/api/v1/users/me')
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as UserProfile;
      })
      .then((profile) => {
        if (!isCurrent) return;
        setUserProfile(profile && typeof profile.id === 'string' ? profile : null);
      })
      .catch(() => {
        if (isCurrent) setUserProfile(null);
      })
      .finally(() => {
        if (isCurrent) setIsAuthChecking(false);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  const isAuthenticated = Boolean(userProfile);

  const handleAuthSuccess = (profile: UserProfile) => {
    setUserProfile(profile);
    setActiveTab('chat');
  };

  const handleProfileUpdate = (updated: UserProfile) => {
    setUserProfile(updated);
  };

  const handleLogout = () => {
    void apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setUserProfile(null);
    setActiveTab('chat');
  };

  const handleReport = (request: ReportRequest) => {
    setPendingReport(request);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#e2e8f0] p-0 md:p-6">
      <div className="relative flex h-[100dvh] w-full max-w-[420px] flex-col overflow-hidden bg-white shadow-2xl md:h-[860px] md:rounded-[48px] md:border-[10px] md:border-[#1e293b]">
        <div className="absolute left-1/2 top-3 z-50 h-7 w-28 -translate-x-1/2 rounded-full bg-black" />
        <header className="flex h-16 shrink-0 items-center justify-between px-5 pt-7">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 font-bold text-white shadow-md">C</div>
            <span className="font-extrabold tracking-tight text-slate-900">Chatible</span>
          </div>
          {userProfile && isAuthenticated ? (
            <button
              onClick={() => setActiveTab('profile')}
              className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
            >
              {userProfile.nickname} · {userProfile.age}t
            </button>
          ) : (
            <button
              onClick={() => setIsAuthOpen(true)}
              className="rounded-full bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Đăng nhập
            </button>
          )}
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-2">
          {isAuthChecking ? (
            <section className="flex h-full items-center justify-center text-xs text-slate-400">
              Đang kiểm tra phiên đăng nhập bảo mật…
            </section>
          ) : (
            <>
              {isAuthenticated && userProfile ? (
                <div className={activeTab === 'chat' ? 'h-full' : 'hidden'}>
                  <ChatEngine
                    currentUser={{
                      id: userProfile.id,
                      nickname: userProfile.nickname,
                      age: userProfile.age,
                      gender: userProfile.gender,
                      preferredGender: userProfile.preferredGender,
                      preferredAgeMax: userProfile.preferredAgeMax,
                    }}
                    onOpenReport={handleReport}
                  />
                </div>
              ) : activeTab === 'chat' ? (
                <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <ShieldAlert className="mb-3 text-blue-600" size={36} />
                  <h1 className="text-lg font-bold text-slate-900">Chat riêng tư, an toàn</h1>
                  <p className="mt-2 text-sm text-slate-500">Đăng nhập để bắt đầu ghép đôi và nhắn tin. Dịch vụ chỉ dành cho người từ 18 tuổi.</p>
                  <button
                    onClick={() => setIsAuthOpen(true)}
                    className="mt-5 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white"
                  >
                    Đăng nhập hoặc đăng ký
                  </button>
                </section>
              ) : null}

              {activeTab === 'friends' && (isAuthenticated && userProfile ? (
                <FriendsView currentUserId={userProfile.id} />
              ) : (
                <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <UsersRound className="mb-3 text-blue-600" size={36} />
                  <h1 className="text-lg font-bold text-slate-900">Bạn bè của bạn</h1>
                  <p className="mt-2 text-sm text-slate-500">Đăng nhập để xem danh sách bạn bè và nhắn tin riêng.</p>
                  <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                </section>
              ))}

              {activeTab === 'groups' && (isAuthenticated && userProfile ? (
                <GroupsView currentUserId={userProfile.id} />
              ) : (
                <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <MessagesSquare className="mb-3 text-blue-600" size={36} />
                  <h1 className="text-lg font-bold text-slate-900">Kênh & Nhóm Cộng Đồng</h1>
                  <p className="mt-2 text-sm text-slate-500">Đăng nhập để tham gia kênh thông báo và nhóm chat cộng đồng.</p>
                  <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                </section>
              ))}

              {activeTab === 'recent' && (isAuthenticated ? (
                <RecentSessionsView onOpenChat={() => setActiveTab('chat')} onOpenReport={handleReport} />
              ) : (
                <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <Clock3 className="mb-3 text-blue-600" size={36} />
                  <h1 className="text-lg font-bold text-slate-900">Phiên gần đây</h1>
                  <p className="mt-2 text-sm text-slate-500">Đăng nhập để xem lại các cuộc trò chuyện còn trong thời hạn.</p>
                  <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                </section>
              ))}

              {activeTab === 'profile' && (isAuthenticated && userProfile ? (
                <ProfileView
                  profile={userProfile}
                  onProfileUpdate={handleProfileUpdate}
                  onLogout={handleLogout}
                />
              ) : (
                <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                  <User className="mb-3 text-blue-600" size={36} />
                  <h1 className="text-lg font-bold text-slate-900">Hồ sơ & Cài đặt</h1>
                  <p className="mt-2 text-sm text-slate-500">Đăng nhập để xem và quản lý thông tin hồ sơ, bộ lọc ghép đôi và an toàn.</p>
                  <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                </section>
              ))}
            </>
          )}
        </main>

        <nav className="flex h-16 shrink-0 items-center justify-around border-t border-slate-100 bg-white/90 px-1 backdrop-blur-md" aria-label="Điều hướng chính">
          <button type="button" onClick={() => setActiveTab('chat')} aria-current={activeTab === 'chat' ? 'page' : undefined} className={`flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'chat' ? 'text-blue-600' : 'text-slate-400'}`}>
            <MessageSquare size={18} /><span>Chat</span>
          </button>
          <button type="button" onClick={() => setActiveTab('friends')} aria-current={activeTab === 'friends' ? 'page' : undefined} className={`flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'friends' ? 'text-blue-600' : 'text-slate-400'}`}>
            <UsersRound size={18} /><span>Bạn bè</span>
          </button>
          <button type="button" onClick={() => setActiveTab('groups')} aria-current={activeTab === 'groups' ? 'page' : undefined} className={`flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'groups' ? 'text-blue-600' : 'text-slate-400'}`}>
            <MessagesSquare size={18} /><span>Nhóm</span>
          </button>
          <button type="button" onClick={() => setActiveTab('recent')} aria-current={activeTab === 'recent' ? 'page' : undefined} className={`flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'recent' ? 'text-blue-600' : 'text-slate-400'}`}>
            <Clock3 size={18} /><span>Gần đây</span>
          </button>
          <button type="button" onClick={() => setActiveTab('profile')} aria-current={activeTab === 'profile' ? 'page' : undefined} className={`flex min-w-0 flex-1 flex-col items-center gap-1 text-[10px] font-semibold ${activeTab === 'profile' ? 'text-blue-600' : 'text-slate-400'}`}>
            <User size={18} /><span>Hồ sơ</span>
          </button>
        </nav>

        <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} onSuccess={handleAuthSuccess} />
        {pendingReport && (
          <ReportModal
            isOpen={Boolean(pendingReport)}
            sessionId={pendingReport.sessionId}
            reportedUserId={pendingReport.reportedUserId}
            evidenceMessageIds={pendingReport.evidenceMessageIds}
            onClose={() => setPendingReport(null)}
          />
        )}
      </div>
    </div>
  );
}

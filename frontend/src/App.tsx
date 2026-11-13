import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AuthResponse, UserNotificationDto } from '@chatible/shared';
import { Bell, CheckCheck, Clock3, Download, MessageSquare, MessagesSquare, ShieldAlert, Smartphone, User, UsersRound, X } from 'lucide-react';
import { apiFetch } from './api.js';
import { AuthModal } from './features/auth/AuthModal.js';
import { ChatEngine } from './features/chat/ChatEngine.js';
import { syncStealthState, triggerPushNotification } from './features/notifications/pushNotification.js';
import { usePwaInstall } from './features/pwa/usePwaInstall.js';
import { PwaInstallModal } from './features/pwa/PwaInstallModal.js';
import { triggerHaptic } from './features/mobile/haptic.js';

const FriendsView = lazy(() => import('./features/friends/FriendsView.js').then((m) => ({ default: m.FriendsView })));
const GroupsView = lazy(() => import('./features/groups/GroupsView.js').then((m) => ({ default: m.GroupsView })));
const RecentSessionsView = lazy(() => import('./features/sessions/RecentSessionsView.js').then((m) => ({ default: m.RecentSessionsView })));
const ProfileView = lazy(() => import('./features/profile/ProfileView.js').then((m) => ({ default: m.ProfileView })));
const ReportModal = lazy(() => import('./features/safety/ReportModal.js').then((m) => ({ default: m.ReportModal })));
const PrivacyPolicyView = lazy(() => import('./features/legal/PrivacyPolicyView.js').then((m) => ({ default: m.PrivacyPolicyView })));
const TermsOfServiceView = lazy(() => import('./features/legal/TermsOfServiceView.js').then((m) => ({ default: m.TermsOfServiceView })));

type UserProfile = AuthResponse['profile'];
type ReportRequest = {
  sessionId: string;
  reportedUserId: string;
  evidenceMessageIds: string[];
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'chat' | 'friends' | 'groups' | 'recent' | 'profile'>('chat');
  const [currentPath, setCurrentPath] = useState(() => (typeof window !== 'undefined' ? window.location.pathname : '/'));
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [pendingReport, setPendingReport] = useState<ReportRequest | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [notifications, setNotifications] = useState<UserNotificationDto[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const notifDialogRef = useRef<HTMLDialogElement>(null);
  const notifHeadingId = useId();
  const knownNotifIdsRef = useRef<Set<string> | null>(null);
  const pwa = usePwaInstall();

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  const navigateTo = (path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  useEffect(() => {
    const dialog = notifDialogRef.current;
    if (!dialog) return;
    const authenticated = Boolean(userProfile);
    if (isNotifOpen && authenticated && !dialog.open) {
      dialog.showModal();
    } else if ((!isNotifOpen || !authenticated) && dialog.open) {
      dialog.close();
    }
  }, [isNotifOpen, userProfile]);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/notifications');
      if (!res.ok) return;
      const data = (await res.json()) as {
        notifications?: UserNotificationDto[];
        unreadCount?: number;
      };
      if (Array.isArray(data.notifications)) {
        setNotifications(data.notifications);
        setUnreadNotifications(data.unreadCount ?? 0);

        // Notify for new unread system notifications (avoid alerting initial existing backlog)
        if (knownNotifIdsRef.current === null) {
          knownNotifIdsRef.current = new Set(data.notifications.map((n) => n.id));
        } else {
          for (const item of data.notifications) {
            if (!item.isRead && !knownNotifIdsRef.current.has(item.id)) {
              knownNotifIdsRef.current.add(item.id);
              void triggerPushNotification({
                type: 'SYSTEM',
                title: item.title,
                content: item.content,
                tag: `system-${item.id}`,
              });
            }
          }
        }
      }
    } catch {
      // ignore non-critical notification fetch errors
    }
  }, []);

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
        const resolved = profile && typeof profile.id === 'string' ? profile : null;
        setUserProfile(resolved);
        if (resolved) {
          void syncStealthState();
          void loadNotifications();
        }
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
  }, [loadNotifications]);

  const isAuthenticated = Boolean(userProfile);

  const handleAuthSuccess = (profile: UserProfile) => {
    setUserProfile(profile);
    setActiveTab('chat');
    void syncStealthState();
    void loadNotifications();
  };

  const handleProfileUpdate = (updated: UserProfile) => {
    setUserProfile(updated);
  };

  const handleLogout = () => {
    void apiFetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setUserProfile(null);
    setNotifications([]);
    setUnreadNotifications(0);
    setIsNotifOpen(false);
    setActiveTab('chat');
  };

  const handleMarkNotificationsRead = async (notificationId?: string) => {
    try {
      const res = await apiFetch('/api/v1/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notificationId ? { notificationId } : {}),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount?: number };
      setNotifications((prev) =>
        prev.map((n) => (!notificationId || n.id === notificationId ? { ...n, isRead: true } : n))
      );
      setUnreadNotifications(data.unreadCount ?? 0);
    } catch {
      // ignore
    }
  };

  const handleReport = (request: ReportRequest) => {
    setPendingReport(request);
  };

  if (currentPath === '/privacy') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#0B0F19] text-slate-400 flex items-center justify-center text-sm">Đang tải...</div>}>
        <PrivacyPolicyView onBack={() => navigateTo('/')} />
      </Suspense>
    );
  }

  if (currentPath === '/terms') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#0B0F19] text-slate-400 flex items-center justify-center text-sm">Đang tải...</div>}>
        <TermsOfServiceView onBack={() => navigateTo('/')} />
      </Suspense>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#e2e8f0] p-0 md:p-6">
      <div className="relative flex h-[100dvh] w-full max-w-[420px] flex-col overflow-hidden bg-white shadow-2xl md:h-[860px] md:rounded-[48px] md:border-[10px] md:border-[#1e293b]">
        <div aria-hidden="true" className="pointer-events-none hidden md:block absolute left-1/2 top-3 z-50 h-7 w-28 -translate-x-1/2 rounded-full bg-black" />
        <header
          className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3 md:px-5 md:pt-7"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0.75rem))' }}
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 font-bold text-white shadow-md overflow-hidden">
              <img src="/favicon.svg" alt="Chatible" className="h-full w-full object-cover" />
            </div>
            <span className="font-extrabold tracking-tight text-slate-900">Chatible</span>
          </div>
          {userProfile && isAuthenticated ? (
            <div className="flex items-center gap-2">
              {!pwa.isStandalone && (
                <button
                  type="button"
                  aria-label="Cài đặt Shortapp"
                  onClick={() => {
                    triggerHaptic('light');
                    void pwa.triggerInstall();
                  }}
                  title="Cài đặt Chatible ra màn hình chính (Shortapp)"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition active:scale-95"
                >
                  <Download size={18} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                aria-label="Thông báo an toàn"
                onClick={() => {
                  setIsNotifOpen(true);
                  void loadNotifications();
                }}
                className="relative flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <Bell size={18} aria-hidden="true" />
                {unreadNotifications > 0 && (
                  <span className="absolute right-0.5 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold text-white">
                    {unreadNotifications > 9 ? '9+' : unreadNotifications}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className="inline-flex min-h-[44px] items-center rounded-full bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-700"
              >
                {userProfile.nickname} · {userProfile.age}t
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {!pwa.isStandalone && (
                <button
                  type="button"
                  aria-label="Cài đặt Shortapp"
                  onClick={() => {
                    triggerHaptic('light');
                    void pwa.triggerInstall();
                  }}
                  title="Cài đặt Chatible ra màn hình chính (Shortapp)"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition active:scale-95"
                >
                  <Download size={18} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsAuthOpen(true)}
                className="inline-flex min-h-[44px] items-center rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Đăng nhập
              </button>
            </div>
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
                    type="button"
                    onClick={() => setIsAuthOpen(true)}
                    className="mt-5 min-h-[44px] rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white"
                  >
                    Đăng nhập hoặc đăng ký
                  </button>
                </section>
              ) : null}

              <Suspense
                fallback={
                  <section className="flex h-full items-center justify-center text-xs text-slate-400">
                    Đang tải…
                  </section>
                }
              >
                {activeTab === 'friends' && (isAuthenticated && userProfile ? (
                  <FriendsView currentUserId={userProfile.id} />
                ) : (
                  <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                    <UsersRound className="mb-3 text-blue-600" size={36} />
                    <h1 className="text-lg font-bold text-slate-900">Bạn bè của bạn</h1>
                    <p className="mt-2 text-sm text-slate-500">Đăng nhập để xem danh sách bạn bè và nhắn tin riêng.</p>
                    <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 min-h-[44px] rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                  </section>
                ))}

                {activeTab === 'groups' && (isAuthenticated && userProfile ? (
                  <GroupsView currentUserId={userProfile.id} />
                ) : (
                  <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                    <MessagesSquare className="mb-3 text-blue-600" size={36} />
                    <h1 className="text-lg font-bold text-slate-900">Kênh & Nhóm Cộng Đồng</h1>
                    <p className="mt-2 text-sm text-slate-500">Đăng nhập để tham gia kênh thông báo và nhóm chat cộng đồng.</p>
                    <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 min-h-[44px] rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                  </section>
                ))}

                {activeTab === 'recent' && (isAuthenticated ? (
                  <RecentSessionsView onOpenChat={() => setActiveTab('chat')} onOpenReport={handleReport} />
                ) : (
                  <section className="flex h-full flex-col items-center justify-center px-5 text-center">
                    <Clock3 className="mb-3 text-blue-600" size={36} />
                    <h1 className="text-lg font-bold text-slate-900">Phiên gần đây</h1>
                    <p className="mt-2 text-sm text-slate-500">Đăng nhập để xem lại các cuộc trò chuyện còn trong thời hạn.</p>
                    <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 min-h-[44px] rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
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
                    <button type="button" onClick={() => setIsAuthOpen(true)} className="mt-5 min-h-[44px] rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white">Đăng nhập hoặc đăng ký</button>
                  </section>
                ))}
              </Suspense>
            </>
          )}
        </main>

        <nav
          className="flex shrink-0 items-stretch justify-around border-t border-slate-100 bg-white/95 px-1 backdrop-blur-md"
          style={{
            paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom, 0.375rem))',
            minHeight: 'calc(3.75rem + env(safe-area-inset-bottom, 0px))',
          }}
          aria-label="Điều hướng chính"
        >
          <button type="button" onClick={() => { triggerHaptic('light'); setActiveTab('chat'); }} aria-current={activeTab === 'chat' ? 'page' : undefined} className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition active:scale-95 ${activeTab === 'chat' ? 'text-blue-600' : 'text-slate-400'}`}>
            <MessageSquare size={18} aria-hidden="true" /><span>Chat</span>
          </button>
          <button type="button" onClick={() => { triggerHaptic('light'); setActiveTab('friends'); }} aria-current={activeTab === 'friends' ? 'page' : undefined} className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition active:scale-95 ${activeTab === 'friends' ? 'text-blue-600' : 'text-slate-400'}`}>
            <UsersRound size={18} aria-hidden="true" /><span>Bạn bè</span>
          </button>
          <button type="button" onClick={() => { triggerHaptic('light'); setActiveTab('groups'); }} aria-current={activeTab === 'groups' ? 'page' : undefined} className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition active:scale-95 ${activeTab === 'groups' ? 'text-blue-600' : 'text-slate-400'}`}>
            <MessagesSquare size={18} aria-hidden="true" /><span>Nhóm</span>
          </button>
          <button type="button" onClick={() => { triggerHaptic('light'); setActiveTab('recent'); }} aria-current={activeTab === 'recent' ? 'page' : undefined} className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition active:scale-95 ${activeTab === 'recent' ? 'text-blue-600' : 'text-slate-400'}`}>
            <Clock3 size={18} aria-hidden="true" /><span>Gần đây</span>
          </button>
          <button type="button" onClick={() => { triggerHaptic('light'); setActiveTab('profile'); }} aria-current={activeTab === 'profile' ? 'page' : undefined} className={`flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-semibold transition active:scale-95 ${activeTab === 'profile' ? 'text-blue-600' : 'text-slate-400'}`}>
            <User size={18} aria-hidden="true" /><span>Hồ sơ</span>
          </button>
        </nav>

        <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} onSuccess={handleAuthSuccess} />
        {pendingReport && (
          <Suspense fallback={null}>
            <ReportModal
              isOpen={Boolean(pendingReport)}
              sessionId={pendingReport.sessionId}
              reportedUserId={pendingReport.reportedUserId}
              evidenceMessageIds={pendingReport.evidenceMessageIds}
              onClose={() => setPendingReport(null)}
            />
          </Suspense>
        )}

        <dialog
          ref={notifDialogRef}
          aria-labelledby={notifHeadingId}
          onCancel={(e) => {
            e.preventDefault();
            setIsNotifOpen(false);
          }}
          onClick={(e) => {
            if (e.target === notifDialogRef.current) setIsNotifOpen(false);
          }}
          className="mb-0 mt-auto w-full max-w-sm h-auto max-h-[85dvh] overflow-hidden rounded-t-3xl border-none bg-white p-0 shadow-2xl open:flex open:flex-col md:m-auto md:w-[calc(100%-2rem)] md:rounded-3xl backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        >
          {isNotifOpen && isAuthenticated && (
            <>
              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
                <div className="flex items-center gap-2">
                  <Bell size={18} className="text-blue-600" aria-hidden="true" />
                  <h2 id={notifHeadingId} className="text-sm font-bold text-slate-900">Thông báo an toàn</h2>
                </div>
                <div className="flex items-center gap-2">
                  {unreadNotifications > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleMarkNotificationsRead()}
                      className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
                    >
                      <CheckCheck size={13} aria-hidden="true" /> Đọc hết
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Đóng thông báo"
                    onClick={() => setIsNotifOpen(false)}
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto overscroll-contain max-h-[calc(85dvh-64px)] w-full space-y-2.5 px-5 pb-5 pt-3 flex-1">
                {notifications.length === 0 ? (
                  <p className="py-8 text-center text-xs text-slate-400">
                    Chưa có thông báo xử lý báo cáo hoặc khiếu nại nào.
                  </p>
                ) : (
                  notifications.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => { if (!n.isRead) void handleMarkNotificationsRead(n.id); }}
                      className={`w-full rounded-2xl border p-3 text-left transition ${
                        n.isRead ? 'border-slate-100 bg-slate-50/70' : 'border-blue-200 bg-blue-50/60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900">{n.title}</span>
                        {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-600" />}
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-slate-600">{n.body}</p>
                      <p className="mt-1.5 text-[10px] text-slate-400">
                        {new Date(n.createdAt).toLocaleString('vi-VN')}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </dialog>

        <PwaInstallModal
          isOpen={pwa.showGuideModal}
          onClose={() => pwa.setShowGuideModal(false)}
          isIOS={pwa.isIOS}
          canPromptNative={pwa.canPromptNative}
          onPromptNative={() => void pwa.triggerInstall()}
        />
      </div>

      <footer className="mt-3 hidden md:flex items-center gap-4 text-xs text-slate-500">
        <span>© 2026 Chatible</span>
        <span>•</span>
        <a
          href="/terms"
          onClick={(e) => {
            e.preventDefault();
            navigateTo('/terms');
          }}
          className="hover:text-slate-800 underline transition-colors"
        >
          Điều khoản sử dụng
        </a>
        <span>•</span>
        <a
          href="/privacy"
          onClick={(e) => {
            e.preventDefault();
            navigateTo('/privacy');
          }}
          className="hover:text-slate-800 underline transition-colors"
        >
          Chính sách quyền riêng tư
        </a>
      </footer>
    </div>
  );
}

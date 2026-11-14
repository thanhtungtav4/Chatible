import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AuthResponse, UserNotificationDto } from '@chatible/shared';
import { Bell, CheckCheck, Clock3, Download, EyeOff, MessageSquare, MessagesSquare, ShieldAlert, Smartphone, User, UsersRound, X } from 'lucide-react';
import { apiFetch } from './api.js';
import { AuthModal } from './features/auth/AuthModal.js';
import { ChatEngine } from './features/chat/ChatEngine.js';
import { getLocalStealthMode, syncStealthState, triggerPushNotification } from './features/notifications/pushNotification.js';
import { usePwaInstall } from './features/pwa/usePwaInstall.js';
import { PwaInstallModal } from './features/pwa/PwaInstallModal.js';
import { triggerHaptic } from './features/mobile/haptic.js';
import { StealthCamouflageScreen } from './features/security/StealthCamouflageScreen.js';

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
  const [isStealthLocked, setIsStealthLocked] = useState(false);
  const [chatResetTrigger, setChatResetTrigger] = useState(0);
  const [incomingRequestsCount, setIncomingRequestsCount] = useState(0);
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

  // Bảo vệ riêng tư Stealth Vault: Khi tắt màn hình, chuyển tab hoặc rời ứng dụng -> Tự động kích hoạt Ngụy trang an toàn
  useEffect(() => {
    const lockStealthSafety = () => {
      if (getLocalStealthMode() && userProfile) {
        setIsStealthLocked(true);
        void apiFetch('/api/v1/users/me/stealth-vault/lock', {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lockStealthSafety();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', lockStealthSafety);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', lockStealthSafety);
    };
  }, [userProfile]);

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

  const loadIncomingRequestsCount = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/friends/requests');
      if (!res.ok) return;
      const data = (await res.json()) as { requests?: unknown[] };
      if (Array.isArray(data.requests)) {
        setIncomingRequestsCount(data.requests.length);
      }
    } catch {
      // ignore
    }
  }, []);

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
          void loadIncomingRequestsCount();
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
  }, [loadIncomingRequestsCount, loadNotifications]);

  const isAuthenticated = Boolean(userProfile);

  const handleAuthSuccess = (profile: UserProfile) => {
    setUserProfile(profile);
    setActiveTab('chat');
    void syncStealthState();
    void loadNotifications();
    void loadIncomingRequestsCount();
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
        {/* Sleek punch-hole camera dot for desktop preview frame */}
        <div aria-hidden="true" className="pointer-events-none hidden md:block absolute left-1/2 top-3 z-50 h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-slate-900 ring-2 ring-slate-800/80 shadow-inner" />

        {/* Màn hình Ngụy trang Toàn diện (Ghi chú an toàn) khi bật Stealth Mode & tắt màn hình / chuyển tab */}
        {isStealthLocked && getLocalStealthMode() && userProfile && (
          <StealthCamouflageScreen
            onUnlock={() => {
              setIsStealthLocked(false);
            }}
          />
        )}
        <header
          className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3 md:px-5 md:pt-7"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0.75rem))' }}
        >
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setActiveTab('chat');
              setChatResetTrigger((v) => v + 1);
            }}
            title="Trở về trang tìm bạn mới"
            aria-label="Trở về trang tìm bạn mới"
            className="flex items-center gap-2 rounded-2xl p-1 -ml-1 transition hover:bg-slate-100 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 font-bold text-white shadow-md overflow-hidden">
              <img src="/favicon.svg" alt="Chatible" className="h-full w-full object-cover" />
            </div>
            <span className="font-extrabold tracking-tight text-slate-900">Chatible</span>
          </button>
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
              {getLocalStealthMode() && (
                <button
                  type="button"
                  aria-label="Khóa ngụy trang ngay"
                  onClick={() => {
                    triggerHaptic('selection');
                    setIsStealthLocked(true);
                    void apiFetch('/api/v1/users/me/stealth-vault/lock', {
                      method: 'POST',
                      keepalive: true,
                    }).catch(() => {});
                  }}
                  title="Kích hoạt ngụy trang ngay lập tức (Ghi chú an toàn)"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100 transition active:scale-95"
                >
                  <EyeOff size={18} aria-hidden="true" />
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
                className="inline-flex min-h-[44px] max-w-[125px] items-center gap-1 rounded-full bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 active:scale-95"
              >
                <span className="truncate">{userProfile.nickname}</span>
                <span className="shrink-0 text-emerald-600/80">· {userProfile.age}t</span>
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
                className="inline-flex min-h-[44px] items-center rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 active:scale-95 shadow-sm"
              >
                Đăng nhập
              </button>
            </div>
          )}
        </header>

        <main className={`flex-1 min-h-0 flex flex-col ${activeTab === 'chat' ? 'overflow-hidden p-0' : 'overflow-y-auto px-4 py-2'}`}>
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
                    resetTrigger={chatResetTrigger}
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
                  <RecentSessionsView
                    onOpenChat={() => {
                      setActiveTab('chat');
                      setChatResetTrigger((v) => v + 1);
                    }}
                    onOpenReport={handleReport}
                  />
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
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              if (activeTab === 'chat') {
                setChatResetTrigger((v) => v + 1);
              } else {
                setActiveTab('chat');
              }
            }}
            aria-current={activeTab === 'chat' ? 'page' : undefined}
            className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] transition active:scale-95"
          >
            <div className={`flex items-center justify-center rounded-full px-3 py-1 transition ${activeTab === 'chat' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
              <MessageSquare size={18} aria-hidden="true" className={activeTab === 'chat' ? 'stroke-[2.3]' : 'stroke-[1.8]'} />
            </div>
            <span className={`tracking-tight ${activeTab === 'chat' ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}>Chat</span>
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setActiveTab('friends');
              void loadIncomingRequestsCount();
            }}
            aria-current={activeTab === 'friends' ? 'page' : undefined}
            className="relative flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] transition active:scale-95"
          >
            <div className={`relative flex items-center justify-center rounded-full px-3 py-1 transition ${activeTab === 'friends' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
              <UsersRound size={18} aria-hidden="true" className={activeTab === 'friends' ? 'stroke-[2.3]' : 'stroke-[1.8]'} />
              {incomingRequestsCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold text-white shadow-xs animate-in zoom-in-75">
                  {incomingRequestsCount > 9 ? '9+' : incomingRequestsCount}
                </span>
              )}
            </div>
            <span className={`tracking-tight ${activeTab === 'friends' ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}>Bạn bè</span>
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setActiveTab('groups');
            }}
            aria-current={activeTab === 'groups' ? 'page' : undefined}
            className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] transition active:scale-95"
          >
            <div className={`flex items-center justify-center rounded-full px-3 py-1 transition ${activeTab === 'groups' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
              <MessagesSquare size={18} aria-hidden="true" className={activeTab === 'groups' ? 'stroke-[2.3]' : 'stroke-[1.8]'} />
            </div>
            <span className={`tracking-tight ${activeTab === 'groups' ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}>Nhóm</span>
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setActiveTab('recent');
            }}
            aria-current={activeTab === 'recent' ? 'page' : undefined}
            className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] transition active:scale-95"
          >
            <div className={`flex items-center justify-center rounded-full px-3 py-1 transition ${activeTab === 'recent' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
              <Clock3 size={18} aria-hidden="true" className={activeTab === 'recent' ? 'stroke-[2.3]' : 'stroke-[1.8]'} />
            </div>
            <span className={`tracking-tight ${activeTab === 'recent' ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}>Gần đây</span>
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setActiveTab('profile');
            }}
            aria-current={activeTab === 'profile' ? 'page' : undefined}
            className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] transition active:scale-95"
          >
            <div className={`flex items-center justify-center rounded-full px-3 py-1 transition ${activeTab === 'profile' ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>
              <User size={18} aria-hidden="true" className={activeTab === 'profile' ? 'stroke-[2.3]' : 'stroke-[1.8]'} />
            </div>
            <span className={`tracking-tight ${activeTab === 'profile' ? 'font-bold text-blue-600' : 'font-medium text-slate-400'}`}>Hồ sơ</span>
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

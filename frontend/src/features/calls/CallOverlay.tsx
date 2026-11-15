import { useEffect, useRef } from 'react';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  Video,
  VideoOff,
  Wifi,
} from 'lucide-react';
import { useCall } from './CallContext.js';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function CallOverlay() {
  const {
    callState,
    callType,
    callerInfo,
    partnerInfo,
    callDuration,
    isMicMuted,
    isCameraOff,
    isMinimized,
    isReconnecting,
    networkQuality,
    callError,
    localStream,
    remoteStream,
    acceptCall,
    rejectCall,
    endCall,
    toggleMic,
    toggleCamera,
    toggleMinimize,
  } = useCall();

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Bind media streams to video & audio elements
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, callState, isMinimized]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      if (remoteStream) {
        remoteAudioRef.current.play().catch(() => undefined);
      } else {
        remoteAudioRef.current.pause();
      }
    }
  }, [remoteStream, callState, isMinimized]);

  const activePartner = partnerInfo || callerInfo;

  return (
    <>
      {/* Hidden Remote Audio Fallback */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Error / Status Toast */}
      {callError && (
        <div
          role="alert"
          className="fixed top-5 left-1/2 z-[100] -translate-x-1/2 rounded-2xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xl animate-in fade-in slide-in-from-top-2"
        >
          {callError}
        </div>
      )}

      {/* 1. Incoming Call Dialog */}
      {callState === 'incoming' && callerInfo && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md animate-in fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Cuộc gọi đến"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-700/60 bg-slate-900/95 p-6 text-center text-white shadow-2xl backdrop-blur-xl">
            <div className="relative mx-auto mb-4 flex h-24 w-24 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping" />
              <span className="absolute inset-2 rounded-full bg-emerald-500/30 animate-pulse" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-2xl font-black text-white shadow-lg">
                {initials(callerInfo.nickname)}
              </div>
            </div>

            <h2 className="text-xl font-bold tracking-tight text-white">{callerInfo.nickname}</h2>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400">
              {callType === 'video' ? <Video size={13} /> : <PhoneIncoming size={13} />}
              <span>{callType === 'video' ? 'Cuộc gọi video đến…' : 'Cuộc gọi thoại đến…'}</span>
            </div>

            <p className="mt-3 text-xs text-slate-400">Kết nối trực tiếp bảo mật ngang hàng WebRTC</p>

            <div className="mt-8 flex items-center justify-center gap-6">
              <button
                type="button"
                onClick={() => rejectCall('Người dùng đã từ chối.')}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-600/30 transition hover:bg-rose-700 hover:scale-105 active:scale-95"
                title="Từ chối cuộc gọi"
                aria-label="Từ chối"
              >
                <PhoneOff size={24} />
              </button>

              <button
                type="button"
                onClick={() => void acceptCall()}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-600 hover:scale-105 active:scale-95 animate-pulse"
                title="Nhấc máy"
                aria-label="Nhấc máy"
              >
                {callType === 'video' ? <Video size={24} /> : <PhoneCall size={24} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Outgoing Call Dialog */}
      {callState === 'outgoing' && partnerInfo && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md animate-in fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Đang gọi"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-700/60 bg-slate-900/95 p-6 text-center text-white shadow-2xl backdrop-blur-xl">
            <div className="relative mx-auto mb-4 flex h-24 w-24 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-blue-500/20 animate-ping" />
              <span className="absolute inset-2 rounded-full bg-blue-500/30 animate-pulse" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-2xl font-black text-white shadow-lg">
                {initials(partnerInfo.nickname)}
              </div>
            </div>

            <h2 className="text-xl font-bold tracking-tight text-white">{partnerInfo.nickname}</h2>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400">
              {callType === 'video' ? <Video size={13} /> : <PhoneCall size={13} />}
              <span>Đang đổ chuông…</span>
            </div>

            <p className="mt-3 text-xs text-slate-400">Đang chờ đối phương nhấc máy</p>

            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={endCall}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-600/30 transition hover:bg-rose-700 hover:scale-105 active:scale-95"
                title="Hủy cuộc gọi"
                aria-label="Hủy cuộc gọi"
              >
                <PhoneOff size={24} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Active Call - Minimized Floating Pill */}
      {callState === 'active' && isMinimized && activePartner && (
        <div className="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-[95] flex items-center gap-2.5 rounded-full border border-slate-700/60 bg-slate-900/95 px-4 py-2.5 text-white shadow-2xl backdrop-blur-xl animate-in slide-in-from-bottom-2">
          <span
            className={`h-2.5 w-2.5 rounded-full animate-pulse ${
              isReconnecting ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
          />
          <div className="text-left">
            <p className="max-w-[110px] truncate text-xs font-bold">{activePartner.nickname}</p>
            <p
              className={`text-[10px] ${
                isReconnecting ? 'text-amber-400 font-semibold' : 'text-emerald-400'
              }`}
            >
              {isReconnecting ? 'Đang kết nối lại…' : formatDuration(callDuration)}
            </p>
          </div>

          <div className="ml-1 flex items-center gap-1 border-l border-slate-700 pl-2">
            <button
              type="button"
              onClick={toggleMic}
              className={`rounded-full p-1.5 transition ${
                isMicMuted ? 'bg-rose-600/80 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
              title={isMicMuted ? 'Bật Mic' : 'Tắt Mic'}
            >
              {isMicMuted ? <MicOff size={14} /> : <Mic size={14} />}
            </button>

            <button
              type="button"
              onClick={toggleMinimize}
              className="rounded-full p-1.5 text-slate-300 hover:bg-slate-800 transition"
              title="Phóng to cuộc gọi"
            >
              <Maximize2 size={14} />
            </button>

            <button
              type="button"
              onClick={endCall}
              className="rounded-full bg-rose-600 p-1.5 text-white hover:bg-rose-700 transition"
              title="Kết thúc cuộc gọi"
            >
              <PhoneOff size={14} />
            </button>
          </div>
        </div>
      )}

      {/* 4. Active Call - Full Screen / Modal View */}
      {callState === 'active' && !isMinimized && activePartner && (
        <div
          className="fixed inset-0 z-[90] flex flex-col bg-slate-950/95 backdrop-blur-2xl animate-in fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Cuộc gọi đang diễn ra"
        >
          {/* Top Bar */}
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <span
                className={`h-2.5 w-2.5 rounded-full animate-pulse ${
                  isReconnecting ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
              />
              <div>
                <h2 className="text-sm font-bold text-white sm:text-base">{activePartner.nickname}</h2>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>
                    {callType === 'video' ? 'Gọi Video P2P' : 'Gọi Thoại P2P'} •{' '}
                    <span className="font-semibold text-emerald-400">
                      {formatDuration(callDuration)}
                    </span>
                  </span>

                  {/* Network Quality Badge */}
                  {networkQuality && !isReconnecting && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                        networkQuality === 'good'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : networkQuality === 'fair'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-rose-500/20 text-rose-400 animate-pulse'
                      }`}
                      title={
                        networkQuality === 'good'
                          ? 'Chất lượng mạng tốt'
                          : networkQuality === 'fair'
                          ? 'Chất lượng mạng trung bình'
                          : 'Chất lượng mạng yếu'
                      }
                    >
                      <Wifi size={10} />
                      <span>
                        {networkQuality === 'good'
                          ? 'Mạng tốt'
                          : networkQuality === 'fair'
                          ? 'Mạng vừa'
                          : 'Mạng yếu'}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={toggleMinimize}
              className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
              title="Thu nhỏ để tiếp tục trò chuyện"
            >
              <Minimize2 size={14} />
              <span className="hidden sm:inline">Thu nhỏ</span>
            </button>
          </div>

          {/* Reconnecting Alert Banner */}
          {isReconnecting && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full bg-amber-500/20 px-4 py-1.5 text-xs font-semibold text-amber-300 border border-amber-500/40 backdrop-blur-md shadow-xl animate-pulse">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
              <span>Mạng chập chờn, đang tự động kết nối lại…</span>
            </div>
          )}

          {/* Main Content Area */}
          <div className="relative flex flex-1 items-center justify-center p-4 overflow-hidden">
            {callType === 'video' ? (
              <div className="relative h-full w-full max-w-4xl overflow-hidden rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                {/* Remote Video (Audio handled by root audio element to prevent echo & preserve sound when minimized) */}
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover sm:object-contain bg-black"
                />

                {/* Local Video PIP */}
                <div className="absolute bottom-4 right-4 h-32 w-24 sm:h-44 sm:w-32 overflow-hidden rounded-2xl border-2 border-slate-700/80 bg-slate-950 shadow-2xl">
                  {isCameraOff ? (
                    <div className="flex h-full w-full flex-col items-center justify-center bg-slate-900 text-slate-400">
                      <VideoOff size={20} />
                      <span className="mt-1 text-[10px]">Đã tắt cam</span>
                    </div>
                  ) : (
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="h-full w-full object-cover scale-x-[-1]"
                    />
                  )}
                </div>
              </div>
            ) : (
              /* Voice Call Visualizer */
              <div className="flex flex-col items-center justify-center text-center">
                <div className="relative mb-6 flex h-36 w-36 items-center justify-center sm:h-44 sm:w-44">
                  <span className="absolute inset-0 rounded-full bg-emerald-500/10 animate-ping" />
                  <span className="absolute inset-4 rounded-full bg-emerald-500/20 animate-pulse" />
                  <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-4xl font-extrabold text-white shadow-2xl sm:h-36 sm:w-36 sm:text-5xl">
                    {initials(activePartner.nickname)}
                  </div>
                </div>

                <h3 className="text-2xl font-extrabold tracking-tight text-white">{activePartner.nickname}</h3>
                <p className="mt-2 text-sm text-emerald-400 font-medium">Đang đàm thoại • {formatDuration(callDuration)}</p>

                {/* Audio wave simulation bars */}
                <div className="mt-6 flex items-center justify-center gap-1.5 h-8">
                  {[40, 75, 100, 60, 90, 45, 80, 50, 95, 65, 30].map((h, i) => (
                    <span
                      key={i}
                      className="w-1 rounded-full bg-emerald-400/80 transition-all duration-300 animate-pulse"
                      style={{ height: `${h}%`, animationDelay: `${i * 100}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Bottom Controls Bar */}
          <div
            className="flex items-center justify-center gap-6 border-t border-slate-800/80 bg-slate-900/95 px-6 pt-4 pb-8 sm:gap-9 sm:pb-8 backdrop-blur-xl"
            style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 2rem))' }}
          >
            {/* Toggle Mic */}
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={toggleMic}
                className={`flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-full text-white shadow-xl transition active:scale-95 ${
                  isMicMuted
                    ? 'bg-rose-500/20 text-rose-400 border-2 border-rose-500/50 hover:bg-rose-500/30'
                    : 'bg-slate-800 border border-slate-700 text-white hover:bg-slate-700'
                }`}
                title={isMicMuted ? 'Bật Micro' : 'Tắt Micro'}
                aria-label={isMicMuted ? 'Bật Micro' : 'Tắt Micro'}
              >
                {isMicMuted ? <MicOff size={24} /> : <Mic size={24} />}
              </button>
              <span className="text-[11px] font-medium text-slate-400 select-none">
                {isMicMuted ? 'Bật Mic' : 'Tắt Mic'}
              </span>
            </div>

            {/* Toggle Camera (If video call) */}
            {callType === 'video' && (
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleCamera}
                  className={`flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-full text-white shadow-xl transition active:scale-95 ${
                    isCameraOff
                      ? 'bg-rose-500/20 text-rose-400 border-2 border-rose-500/50 hover:bg-rose-500/30'
                      : 'bg-slate-800 border border-slate-700 text-white hover:bg-slate-700'
                  }`}
                  title={isCameraOff ? 'Bật Camera' : 'Tắt Camera'}
                  aria-label={isCameraOff ? 'Bật Camera' : 'Tắt Camera'}
                >
                  {isCameraOff ? <VideoOff size={24} /> : <Video size={24} />}
                </button>
                <span className="text-[11px] font-medium text-slate-400 select-none">
                  {isCameraOff ? 'Bật Cam' : 'Tắt Cam'}
                </span>
              </div>
            )}

            {/* End Call */}
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={endCall}
                className="flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-full bg-rose-600 text-white shadow-xl shadow-rose-600/40 transition hover:bg-rose-700 hover:scale-105 active:scale-95"
                title="Kết thúc cuộc gọi"
                aria-label="Kết thúc cuộc gọi"
              >
                <PhoneOff size={26} />
              </button>
              <span className="text-[11px] font-medium text-rose-400 select-none">
                Kết thúc
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

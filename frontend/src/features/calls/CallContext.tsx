import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketEvents } from '@chatible/shared';
import { API_BASE_URL } from '../../api.js';
import { playCallEndedSound, startCallRingtone, stopCallRingtone } from '../audio/soundEffects.js';
import { triggerHaptic } from '../mobile/haptic.js';

export type CallType = 'voice' | 'video';
export type CallState = 'idle' | 'outgoing' | 'incoming' | 'active';
export type NetworkQuality = 'good' | 'fair' | 'poor';

export interface CallPartner {
  id: string;
  nickname: string;
}

interface CallContextType {
  callState: CallState;
  callType: CallType;
  callerInfo: CallPartner | null;
  partnerInfo: CallPartner | null;
  callDuration: number;
  isMicMuted: boolean;
  isCameraOff: boolean;
  isMinimized: boolean;
  isReconnecting: boolean;
  networkQuality: NetworkQuality | null;
  callError: string | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startCall: (target: CallPartner, type: CallType) => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: (reason?: string) => void;
  endCall: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleMinimize: () => void;
}

const CallContext = createContext<CallContextType | null>(null);

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceCandidatePoolSize: 10,
};

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: 48000,
  channelCount: 1,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};

/**
 * Optimizes Opus codec parameters in SDP: enables Forward Error Correction (FEC)
 * and Discontinuous Transmission (DTX) for smooth voice over packet loss.
 */
function optimizeOpusSdp(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!match) return sdp;
  const pt = match[1];
  const fmtpRegex = new RegExp(`a=fmtp:${pt}\\s+(.+)`, 'i');
  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, (line) => {
      let updated = line;
      if (!updated.includes('useinbandfec=1')) updated += ';useinbandfec=1';
      if (!updated.includes('usedtx=1')) updated += ';usedtx=1';
      if (!updated.includes('maxaveragebitrate=')) updated += ';maxaveragebitrate=32000';
      return updated;
    });
  } else {
    return sdp.replace(
      new RegExp(`(a=rtpmap:${pt}\\s+opus\/48000\/2\r?\n)`, 'i'),
      `$1a=fmtp:${pt} useinbandfec=1;usedtx=1;maxaveragebitrate=32000\r\n`
    );
  }
}

export function CallProvider({
  children,
  currentUserId,
}: {
  children: ReactNode;
  currentUserId?: string;
}) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<CallType>('voice');
  const [callerInfo, setCallerInfo] = useState<CallPartner | null>(null);
  const [partnerInfo, setPartnerInfo] = useState<CallPartner | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const incomingSdpRef = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const callStateRef = useRef(callState);
  callStateRef.current = callState;
  const callerInfoRef = useRef(callerInfo);
  callerInfoRef.current = callerInfo;
  const partnerInfoRef = useRef(partnerInfo);
  partnerInfoRef.current = partnerInfo;

  const cleanupCall = useCallback(() => {
    stopCallRingtone();
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);

    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
    }
    setRemoteStream(null);

    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    incomingSdpRef.current = null;
    pendingIceCandidatesRef.current = [];
    setCallState('idle');
    setCallDuration(0);
    setIsMicMuted(false);
    setIsCameraOff(false);
    setIsMinimized(false);
    setIsReconnecting(false);
    setNetworkQuality(null);
    setCallerInfo(null);
    setPartnerInfo(null);
  }, []);

  const startStatsMonitoring = useCallback((pc: RTCPeerConnection) => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    let prevPacketsLost = 0;
    let prevPacketsReceived = 0;

    statsIntervalRef.current = setInterval(async () => {
      if (pc.connectionState !== 'connected') return;
      try {
        const stats = await pc.getStats();
        let rttMs = 0;
        let lossPercent = 0;

        stats.forEach((report) => {
          if (
            report.type === 'candidate-pair' &&
            report.state === 'succeeded' &&
            typeof report.currentRoundTripTime === 'number'
          ) {
            rttMs = report.currentRoundTripTime * 1000;
          }
          if (
            report.type === 'inbound-rtp' &&
            (report.kind === 'audio' || report.kind === 'video')
          ) {
            const lost = (report.packetsLost as number) || 0;
            const recv = (report.packetsReceived as number) || 0;
            const deltaLost = Math.max(0, lost - prevPacketsLost);
            const deltaRecv = Math.max(0, recv - prevPacketsReceived);
            prevPacketsLost = lost;
            prevPacketsReceived = recv;
            const total = deltaLost + deltaRecv;
            if (total > 0) {
              lossPercent = (deltaLost / total) * 100;
            }
          }
        });

        if (rttMs > 350 || lossPercent > 8) {
          setNetworkQuality('poor');
        } else if (rttMs > 180 || lossPercent > 3) {
          setNetworkQuality('fair');
        } else if (rttMs > 0) {
          setNetworkQuality('good');
        }
      } catch {
        // ignore stats errors
      }
    }, 2500);
  }, []);

  const setupConnectionMonitoring = useCallback(
    (pc: RTCPeerConnection) => {
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          setIsReconnecting(false);
          startStatsMonitoring(pc);
        } else if (state === 'disconnected') {
          // Network fluctuation: do not disconnect immediately!
          // Allow up to 6 seconds for ICE reconnection / candidate switching.
          setIsReconnecting(true);
          if (!reconnectTimeoutRef.current) {
            reconnectTimeoutRef.current = setTimeout(() => {
              if (
                peerConnectionRef.current?.connectionState === 'disconnected' ||
                peerConnectionRef.current?.connectionState === 'failed'
              ) {
                playCallEndedSound();
                cleanupCall();
                setCallError('Mất kết nối với đối phương do mạng chập chờn.');
                setTimeout(() => setCallError(null), 4000);
              }
            }, 6000);
          }
        } else if (state === 'failed' || state === 'closed') {
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          setIsReconnecting(false);
          playCallEndedSound();
          cleanupCall();
        }
      };
    },
    [cleanupCall, startStatsMonitoring]
  );

  const endCall = useCallback(() => {
    const activeTarget = partnerInfoRef.current?.id || callerInfoRef.current?.id;
    if (activeTarget && socketRef.current?.connected) {
      socketRef.current.emit(SocketEvents.CALL_END, { targetUserId: activeTarget });
    }
    playCallEndedSound();
    cleanupCall();
  }, [cleanupCall]);

  const rejectCall = useCallback(
    (reason?: string) => {
      const callerId = callerInfoRef.current?.id;
      if (callerId && socketRef.current?.connected) {
        socketRef.current.emit(SocketEvents.CALL_REJECT, {
          targetUserId: callerId,
          reason: reason || 'Cuộc gọi đã bị từ chối.',
        });
      }
      playCallEndedSound();
      cleanupCall();
    },
    [cleanupCall]
  );

  const startCall = useCallback(
    async (target: CallPartner, type: CallType) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        setCallError('Trình duyệt không hỗ trợ cuộc gọi WebRTC.');
        setTimeout(() => setCallError(null), 4000);
        return;
      }

      cleanupCall();
      setCallType(type);
      setCallState('outgoing');
      setPartnerInfo(target);
      startCallRingtone();
      triggerHaptic('medium');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
          video: type === 'video' ? VIDEO_CONSTRAINTS : false,
        });
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnectionRef.current = pc;

        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        pc.onicecandidate = (event) => {
          if (event.candidate && socketRef.current?.connected) {
            socketRef.current.emit(SocketEvents.CALL_ICE_CANDIDATE, {
              targetUserId: target.id,
              candidate: event.candidate,
            });
          }
        };

        pc.ontrack = (event) => {
          if (event.streams[0]) {
            remoteStreamRef.current = event.streams[0];
            setRemoteStream(event.streams[0]);
          }
        };

        setupConnectionMonitoring(pc);

        const offer = await pc.createOffer();
        const optimizedOffer: RTCSessionDescriptionInit = {
          type: offer.type,
          sdp: optimizeOpusSdp(offer.sdp || ''),
        };
        await pc.setLocalDescription(optimizedOffer);

        socketRef.current?.emit(SocketEvents.CALL_OFFER, {
          targetUserId: target.id,
          sdp: optimizedOffer,
          callType: type,
        });

        if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
        ringTimeoutRef.current = setTimeout(() => {
          if (callStateRef.current === 'outgoing') {
            endCall();
            setCallError('Đối phương không trả lời hoặc đang ngoại tuyến.');
            setTimeout(() => setCallError(null), 4000);
          }
        }, 45_000);
      } catch (err) {
        cleanupCall();
        const msg = err instanceof Error ? err.message : 'Không thể truy cập Microphone/Camera.';
        setCallError(msg);
        setTimeout(() => setCallError(null), 4000);
      }
    },
    [cleanupCall, endCall, setupConnectionMonitoring]
  );

  const acceptCall = useCallback(async () => {
    const sdp = incomingSdpRef.current;
    const caller = callerInfoRef.current;
    if (!sdp || !caller) return;
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    stopCallRingtone();
    triggerHaptic('success');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: callType === 'video' ? VIDEO_CONSTRAINTS : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection(ICE_SERVERS);
      peerConnectionRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current?.connected) {
          socketRef.current.emit(SocketEvents.CALL_ICE_CANDIDATE, {
            targetUserId: caller.id,
            candidate: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        if (event.streams[0]) {
          remoteStreamRef.current = event.streams[0];
          setRemoteStream(event.streams[0]);
        }
      };

      setupConnectionMonitoring(pc);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (pendingIceCandidatesRef.current.length > 0) {
        for (const candidate of pendingIceCandidatesRef.current) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch {
            // ignore malformed candidate
          }
        }
        pendingIceCandidatesRef.current = [];
      }

      const answer = await pc.createAnswer();
      const optimizedAnswer: RTCSessionDescriptionInit = {
        type: answer.type,
        sdp: optimizeOpusSdp(answer.sdp || ''),
      };
      await pc.setLocalDescription(optimizedAnswer);

      socketRef.current?.emit(SocketEvents.CALL_ANSWER, {
        targetUserId: caller.id,
        sdp: optimizedAnswer,
      });

      setPartnerInfo(caller);
      setCallState('active');
      setCallDuration(0);
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      callTimerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      cleanupCall();
      const msg = err instanceof Error ? err.message : 'Không thể kết nối cuộc gọi.';
      setCallError(msg);
      setTimeout(() => setCallError(null), 4000);
    }
  }, [callType, cleanupCall, setupConnectionMonitoring]);

  const toggleMic = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
        triggerHaptic('selection');
      }
    }
  }, []);

  const toggleCamera = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCameraOff(!videoTrack.enabled);
        triggerHaptic('selection');
      }
    }
  }, []);

  const toggleMinimize = useCallback(() => {
    setIsMinimized((prev) => !prev);
    triggerHaptic('selection');
  }, []);

  // Connect socket for Call Signaling whenever user is authenticated
  useEffect(() => {
    if (!currentUserId) return;

    const socket = io(API_BASE_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on(
      SocketEvents.CALL_OFFER,
      (data: {
        callerId: string;
        callerNickname: string;
        callType?: CallType;
        sdp: RTCSessionDescriptionInit;
      }) => {
        if (callStateRef.current !== 'idle') {
          socket.emit(SocketEvents.CALL_REJECT, {
            targetUserId: data.callerId,
            reason: 'Người dùng đang bận trong cuộc gọi khác.',
          });
          return;
        }

        incomingSdpRef.current = data.sdp;
        setCallType(data.callType || 'voice');
        setCallerInfo({ id: data.callerId, nickname: data.callerNickname || 'Bạn bè' });
        setCallState('incoming');
        startCallRingtone();
        triggerHaptic('warning');

        if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
        ringTimeoutRef.current = setTimeout(() => {
          if (callStateRef.current === 'incoming') {
            rejectCall('Cuộc gọi nhỡ.');
          }
        }, 45_000);
      }
    );

    socket.on(
      SocketEvents.CALL_ANSWER,
      async (data: { responderId: string; sdp: RTCSessionDescriptionInit }) => {
        if (ringTimeoutRef.current) {
          clearTimeout(ringTimeoutRef.current);
          ringTimeoutRef.current = null;
        }
        stopCallRingtone();
        if (peerConnectionRef.current) {
          try {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (pendingIceCandidatesRef.current.length > 0) {
              for (const candidate of pendingIceCandidatesRef.current) {
                try {
                  await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
                } catch {
                  // ignore candidate error
                }
              }
              pendingIceCandidatesRef.current = [];
            }
            setCallState('active');
            setCallDuration(0);
            if (callTimerRef.current) clearInterval(callTimerRef.current);
            callTimerRef.current = setInterval(() => {
              setCallDuration((prev) => prev + 1);
            }, 1000);
            startStatsMonitoring(peerConnectionRef.current);
            triggerHaptic('success');
          } catch {
            cleanupCall();
          }
        }
      }
    );

    socket.on(
      SocketEvents.CALL_ICE_CANDIDATE,
      async (data: { senderId: string; candidate: RTCIceCandidateInit }) => {
        const pc = peerConnectionRef.current;
        if (pc && pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch {
            // ignore candidate error
          }
        } else {
          pendingIceCandidatesRef.current.push(data.candidate);
        }
      }
    );

    socket.on(SocketEvents.CALL_END, () => {
      playCallEndedSound();
      cleanupCall();
      setCallError('Cuộc gọi đã kết thúc.');
      setTimeout(() => setCallError(null), 3000);
    });

    socket.on(SocketEvents.CALL_REJECT, (data: { senderId: string; reason?: string }) => {
      playCallEndedSound();
      cleanupCall();
      setCallError(data.reason || 'Đối phương đã từ chối hoặc đang bận.');
      setTimeout(() => setCallError(null), 4000);
    });

    const handleBeforeUnload = () => {
      const activeCaller = callerInfoRef.current?.id || partnerInfoRef.current?.id;
      if (callStateRef.current !== 'idle' && activeCaller && socket.connected) {
        socket.emit(SocketEvents.CALL_END, { targetUserId: activeCaller });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      const activeCaller = callerInfoRef.current?.id || partnerInfoRef.current?.id;
      if (callStateRef.current !== 'idle' && activeCaller && socket.connected) {
        socket.emit(SocketEvents.CALL_END, { targetUserId: activeCaller });
      }
      cleanupCall();
      socket.disconnect();
    };
  }, [currentUserId, cleanupCall]);

  return (
    <CallContext.Provider
      value={{
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
        startCall,
        acceptCall,
        rejectCall,
        endCall,
        toggleMic,
        toggleCamera,
        toggleMinimize,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
}

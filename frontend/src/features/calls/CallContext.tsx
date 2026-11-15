import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketEvents } from '@chatible/shared';
import { API_BASE_URL } from '../../api.js';
import { playCallEndedSound, startCallRingtone, stopCallRingtone } from '../audio/soundEffects.js';
import { triggerHaptic } from '../mobile/haptic.js';

export type CallType = 'voice' | 'video';
export type CallState = 'idle' | 'outgoing' | 'incoming' | 'active';

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
  ],
};

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
    setCallerInfo(null);
    setPartnerInfo(null);
  }, []);

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
          audio: true,
          video: type === 'video',
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

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            playCallEndedSound();
            cleanupCall();
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socketRef.current?.emit(SocketEvents.CALL_OFFER, {
          targetUserId: target.id,
          sdp: offer,
          callType: type,
        });
      } catch (err) {
        cleanupCall();
        const msg = err instanceof Error ? err.message : 'Không thể truy cập Microphone/Camera.';
        setCallError(msg);
        setTimeout(() => setCallError(null), 4000);
      }
    },
    [cleanupCall]
  );

  const acceptCall = useCallback(async () => {
    const sdp = incomingSdpRef.current;
    const caller = callerInfoRef.current;
    if (!sdp || !caller) return;
    stopCallRingtone();
    triggerHaptic('success');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video',
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

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          playCallEndedSound();
          cleanupCall();
        }
      };

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
      await pc.setLocalDescription(answer);

      socketRef.current?.emit(SocketEvents.CALL_ANSWER, {
        targetUserId: caller.id,
        sdp: answer,
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
  }, [callType, cleanupCall]);

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
      }
    );

    socket.on(
      SocketEvents.CALL_ANSWER,
      async (data: { responderId: string; sdp: RTCSessionDescriptionInit }) => {
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

    return () => {
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

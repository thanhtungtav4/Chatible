/**
 * Chatible Mobile App Mockup - Interactive Prototype Engine
 * Strictly follows docs/dac-ta-nghiep-vu-v1.1.md & Mobile UI Design Best Practices
 */

document.addEventListener('DOMContentLoaded', () => {
  // App State Store
  const state = {
    currentScreen: 'screen-chat',
    chatState: 'IDLE', // 'IDLE' | 'WAITING' | 'MATCHING' | 'CHATTING' | 'RECONNECTING' | 'ENDED'
    userProfile: {
      nickname: 'Hoàng Long',
      gender: 'MALE',
      birthDate: '2004-03-15',
      age: 22,
      targetGender: 'ALL', // 'MALE', 'FEMALE', 'OTHER', 'ALL'
      ageMin: 18,
      ageMax: 30,
      mediaConsentRandom: false,
    },
    currentPartner: {
      nickname: 'Minh Thư',
      gender: 'FEMALE',
      age: 21,
      isOnline: true,
      partnerConsentMedia: false,
      isAdultConsentActive: false,
    },
    timerInterval: null,
    secondsWaiting: 0,
    reconnectInterval: null,
    reconnectSeconds: 30,
    chatMessages: [],
    recentSessions: [
      { id: 'RC-9941', partner: 'Bảo Ngọc', gender: 'Nữ', age: 20, time: '2 giờ trước', expiry: 'Còn 6 ngày 22 giờ', messages: 18 },
      { id: 'RC-9830', partner: 'Quang Huy', gender: 'Nam', age: 24, time: '1 ngày trước', expiry: 'Còn 5 ngày 14 giờ', messages: 42 },
      { id: 'RC-9712', partner: 'Thanh Hằng', gender: 'Nữ', age: 22, time: '3 ngày trước', expiry: 'Còn 3 ngày 08 giờ', messages: 7 }
    ],
    friends: [
      { id: 'F01', name: 'Hải Yến', gender: 'Nữ', age: 21, online: true, lastMsg: 'Hẹn mai cafe nhé!', unread: 2 },
      { id: 'F02', name: 'Tuấn Kiệt', gender: 'Nam', age: 23, online: false, lastMsg: 'Oke bạn ơi, nhận được ảnh rồi', unread: 0 },
      { id: 'F03', name: 'Mai Linh', gender: 'Nữ', age: 22, online: false, lastMsg: 'Tin nhắn gửi khi offline...', unread: 0 }
    ],
    activeFriendChat: null
  };

  // Cache DOM elements
  const screens = document.querySelectorAll('.screen-view');
  const navItems = document.querySelectorAll('.nav-item');
  const chatStateViews = {
    IDLE: document.getElementById('chat-state-idle'),
    WAITING: document.getElementById('chat-state-waiting'),
    CHATTING: document.getElementById('chat-state-chatting'),
  };
  const phoneShell = document.querySelector('.phone-shell');
  const toastEl = document.getElementById('app-toast');

  // Simulator Toolbar Controls
  const toggleShellBtn = document.getElementById('btn-toggle-shell');
  if (toggleShellBtn) {
    toggleShellBtn.addEventListener('click', () => {
      phoneShell.classList.toggle('fullscreen');
      toggleShellBtn.classList.toggle('active');
    });
  }

  // Theme Mode Switcher (Chatx Light <-> Chatx Dark)
  const btnToggleThemeMode = document.getElementById('btn-toggle-theme-mode');
  if (btnToggleThemeMode) {
    btnToggleThemeMode.addEventListener('click', () => {
      const isDark = phoneShell.dataset.theme === 'dark';
      const newTheme = isDark ? 'light' : 'dark';
      phoneShell.dataset.theme = newTheme;
      btnToggleThemeMode.textContent = isDark ? '🌙 Chế độ Tối' : '☀️ Sáng (Figma)';
      document.querySelector('.simulator-workspace').classList.toggle('dark-bg', !isDark);
      showToast(isDark ? '☀️ Đã đổi sang Chatx Sáng (Chuẩn Figma)' : '🌙 Đã đổi sang Chatx Tối (Web3 Privacy Dark)');
    });
  }
  // Quick State Switcher Buttons (for instant QA & presentation)
  document.querySelectorAll('[data-set-state]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetState = btn.dataset.setState;
      setChatState(targetState);
    });
  });

  // Bottom Navigation Switching
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetScreenId = item.dataset.screen;
      switchScreen(targetScreenId);
      
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');
    });
  });

  function switchScreen(screenId) {
    state.currentScreen = screenId;
    screens.forEach(screen => {
      screen.classList.toggle('active', screen.id === screenId);
    });
  }

  // Toast Helper
  function showToast(message, duration = 2800) {
    if (!toastEl) return;
    toastEl.querySelector('.toast-text').textContent = message;
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, duration);
  }

  // =========================================================================
  // Screen S07: Random Chat State Machine
  // =========================================================================
  function setChatState(newState) {
    state.chatState = newState;
    clearInterval(state.timerInterval);
    clearInterval(state.reconnectInterval);

    // Hide all state views first
    Object.values(chatStateViews).forEach(v => {
      if (v) v.style.display = 'none';
    });

    // Reset banners & header visibility
    const reconnectBar = document.getElementById('reconnecting-banner');
    const endedBar = document.getElementById('ended-action-bar');
    const chatInputBar = document.getElementById('chat-input-bar');
    const globalHeader = document.getElementById('chat-global-header');
    const segmentedBar = document.getElementById('chat-segmented-bar');

    if (reconnectBar) reconnectBar.style.display = 'none';
    if (endedBar) endedBar.style.display = 'none';
    if (chatInputBar) {
      chatInputBar.style.display = 'flex';
      chatInputBar.querySelector('.chat-input-field').disabled = false;
    }

    const isInConversation = (newState === 'CHATTING' || newState === 'RECONNECTING' || newState === 'ENDED');
    if (globalHeader) globalHeader.style.display = isInConversation ? 'none' : 'flex';
    if (segmentedBar) segmentedBar.style.display = isInConversation ? 'none' : 'flex';
    switch (newState) {
      case 'IDLE':
        if (chatStateViews.IDLE) chatStateViews.IDLE.style.display = 'flex';
        break;

      case 'WAITING':
        if (chatStateViews.WAITING) chatStateViews.WAITING.style.display = 'flex';
        startWaitingCounter();
        break;

      case 'MATCHING':
        if (chatStateViews.WAITING) chatStateViews.WAITING.style.display = 'flex';
        showToast('🎉 Đã tìm thấy đối tác phù hợp! Đang thiết lập kết nối mã hóa...', 2000);
        setTimeout(() => {
          setChatState('CHATTING');
          seedInitialMessages();
        }, 1200);
        break;

      case 'CHATTING':
        if (chatStateViews.CHATTING) chatStateViews.CHATTING.style.display = 'flex';
        updatePartnerBarInfo();
        const msgStream = document.getElementById('random-messages-stream');
        if (msgStream && msgStream.children.length === 0) {
          seedInitialMessages();
        }
        break;

      case 'RECONNECTING':
        if (chatStateViews.CHATTING) chatStateViews.CHATTING.style.display = 'flex';
        if (reconnectBar) {
          reconnectBar.style.display = 'flex';
          startReconnectCounter();
        }
        break;

      case 'ENDED':
        if (chatStateViews.CHATTING) chatStateViews.CHATTING.style.display = 'flex';
        if (endedBar) endedBar.style.display = 'flex';
        if (chatInputBar) {
          chatInputBar.querySelector('.chat-input-field').disabled = true;
          chatInputBar.querySelector('.chat-input-field').placeholder = 'Cuộc trò chuyện đã kết thúc';
        }
        break;
    }
  }

  // Waiting Counter & Expansion Suggestion Simulation
  function startWaitingCounter() {
    state.secondsWaiting = 0;
    const timerDisplay = document.getElementById('waiting-timer-display');
    const expansionCard = document.getElementById('expansion-suggestion-card');
    if (expansionCard) expansionCard.style.display = 'none';

    state.timerInterval = setInterval(() => {
      state.secondsWaiting++;
      const mins = String(Math.floor(state.secondsWaiting / 60)).padStart(2, '0');
      const secs = String(state.secondsWaiting % 60).padStart(2, '0');
      if (timerDisplay) timerDisplay.textContent = `${mins}:${secs}`;

      // Simulate prompt for filter expansion after 6 seconds of waiting
      if (state.secondsWaiting === 6 && expansionCard) {
        expansionCard.style.display = 'block';
      }

      // Auto match simulate after 9s for slick demo experience
      if (state.secondsWaiting === 10) {
        setChatState('MATCHING');
      }
    }, 1000);
  }

  // Reconnection Countdown Simulation
  function startReconnectCounter() {
    state.reconnectSeconds = 30;
    const reconnectTimer = document.getElementById('reconnect-timer-sec');
    state.reconnectInterval = setInterval(() => {
      state.reconnectSeconds--;
      if (reconnectTimer) reconnectTimer.textContent = `${state.reconnectSeconds}s`;
      if (state.reconnectSeconds <= 0) {
        clearInterval(state.reconnectInterval);
        showToast('Quá thời gian chờ kết nối lại (30s). Phiên đã kết thúc.');
        setChatState('ENDED');
      }
    }, 1000);
  }

  // Partner Info in Chat Bar
  function updatePartnerBarInfo() {
    const nameEl = document.getElementById('partner-display-name');
    const badgeEl = document.getElementById('partner-display-badge');
    const consentChip = document.getElementById('consent-media-toggle-chip');

    if (nameEl) nameEl.textContent = state.currentPartner.nickname;
    if (badgeEl) badgeEl.textContent = `${state.currentPartner.gender === 'FEMALE' ? 'Nữ' : 'Nam'} • ${state.currentPartner.age} tuổi`;
    
    // Check consent state
    if (consentChip) {
      consentChip.classList.toggle('enabled', state.userProfile.mediaConsentRandom);
      consentChip.querySelector('.consent-label').textContent = state.userProfile.mediaConsentRandom ? 'Đã bật nhận Media' : 'Media: Tắt';
    }
  }

  // Seed Messages for CHATTING state
  function seedInitialMessages() {
    const stream = document.getElementById('random-messages-stream');
    if (!stream) return;
    stream.innerHTML = '';

    addSystemNotice('Cuộc trò chuyện ngẫu nhiên đã bắt đầu. Lưu giữ an toàn trong 7 ngày.');
    addSystemNotice('⚠️ Lưu ý an toàn: Đối phương chỉ thấy Biệt danh, Giới tính tự khai và Tuổi.');

    // Simulated Partner Greeting after 1 second
    setTimeout(() => {
      addIncomingMessage('Chào bạn! Rất vui được ghép đôi nhé 👋');
    }, 800);
  }

  // Add Message Helpers
  function addOutgoingMessage(text) {
    const stream = document.getElementById('random-messages-stream');
    if (!stream) return;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble outgoing';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div class="bubble-content">${escapeHtml(text)}</div>
      <div class="bubble-time">${time} • Đã gửi</div>
    `;
    stream.appendChild(bubble);
    stream.scrollTop = stream.scrollHeight;

    // Simulate smart auto-reply from partner
    simulatePartnerReply(text);
  }

  function addIncomingMessage(text) {
    const stream = document.getElementById('random-messages-stream');
    if (!stream) return;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble incoming';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div class="bubble-content">${escapeHtml(text)}</div>
      <div class="bubble-time">${time}</div>
    `;
    stream.appendChild(bubble);
    stream.scrollTop = stream.scrollHeight;
  }

  function addSystemNotice(text) {
    const stream = document.getElementById('random-messages-stream');
    if (!stream) return;
    const notice = document.createElement('div');
    notice.className = 'system-notice';
    notice.textContent = text;
    stream.appendChild(notice);
    stream.scrollTop = stream.scrollHeight;
  }

  function simulatePartnerReply(userText) {
    setTimeout(() => {
      if (state.chatState !== 'CHATTING') return;

      const responses = [
        'Haha đúng rồi đó bạn ơi! Bạn đang ở khu vực nào thế?',
        'Nghe hay đấy! Mình cũng hay lướt web vào giờ này.',
        'Bạn thích nghe nhạc hay xem phim gì không?',
        'Giao diện web này vuốt mượt như app thật nhỉ!'
      ];
      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
      addIncomingMessage(randomResponse);
    }, 1200);
  }

  function escapeHtml(string) {
    const div = document.createElement('div');
    div.textContent = string;
    return div.innerHTML;
  }

  // =========================================================================
  // Event Listeners for Chat Interaction
  // =========================================================================

  // Start Matching Button
  const btnStartMatch = document.getElementById('btn-start-matching');
  if (btnStartMatch) {
    btnStartMatch.addEventListener('click', () => {
      setChatState('WAITING');
    });
  }

  // Cancel Waiting Button
  const btnCancelWaiting = document.getElementById('btn-cancel-waiting');
  if (btnCancelWaiting) {
    btnCancelWaiting.addEventListener('click', () => {
      setChatState('IDLE');
      showToast('Đã hủy tìm kiếm bạn mới.');
    });
  }

  // Expansion Agreement in Waiting Card
  const btnAcceptExpansion = document.getElementById('btn-accept-expansion');
  if (btnAcceptExpansion) {
    btnAcceptExpansion.addEventListener('click', () => {
      showToast('Đã mở rộng bộ lọc tìm kiếm cho lần này.');
      const expansionCard = document.getElementById('expansion-suggestion-card');
      if (expansionCard) expansionCard.style.display = 'none';
      setTimeout(() => setChatState('MATCHING'), 1000);
    });
  }

  // Text Input & Send Button Handling (Vietnamese IME safe)
  const chatInputField = document.getElementById('chat-input-text');
  const btnSendMsg = document.getElementById('btn-send-message');

  function handleSendMessage() {
    if (!chatInputField) return;
    const text = chatInputField.value.trim();
    if (!text) return;

    addOutgoingMessage(text);
    chatInputField.value = '';
    chatInputField.focus();
  }

  if (btnSendMsg) {
    btnSendMsg.addEventListener('click', handleSendMessage);
  }

  if (chatInputField) {
    let isComposing = false;
    // Vietnamese IME support: don't submit while user is completing Telex/VNI accents
    chatInputField.addEventListener('compositionstart', () => { isComposing = true; });
    chatInputField.addEventListener('compositionend', () => { isComposing = false; });
    
    chatInputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  }

  // Media Consent Chip Toggle (in partner bar)
  const consentChip = document.getElementById('consent-media-toggle-chip');
  if (consentChip) {
    consentChip.addEventListener('click', () => {
      state.userProfile.mediaConsentRandom = !state.userProfile.mediaConsentRandom;
      updatePartnerBarInfo();
      showToast(state.userProfile.mediaConsentRandom ? 'Bạn đã BẬT quyền nhận media từ người lạ' : 'Bạn đã TẮT quyền nhận media');
    });
  }

  // End / Skip Buttons
  const btnNextPartner = document.getElementById('btn-next-partner');
  if (btnNextPartner) {
    btnNextPartner.addEventListener('click', () => {
      showToast('Đang chuyển sang đối tác mới...');
      setChatState('WAITING');
    });
  }

  const btnEndChat = document.getElementById('btn-end-chat');
  if (btnEndChat) {
    btnEndChat.addEventListener('click', () => {
      setChatState('ENDED');
    });
  }

  // ENDED action buttons
  const btnEndedFindNew = document.getElementById('btn-ended-find-new');
  if (btnEndedFindNew) {
    btnEndedFindNew.addEventListener('click', () => {
      setChatState('WAITING');
    });
  }

  const btnSendFriendReq = document.getElementById('btn-send-friend-request');
  if (btnSendFriendReq) {
    btnSendFriendReq.addEventListener('click', () => {
      btnSendFriendReq.disabled = true;
      btnSendFriendReq.textContent = 'Đã gửi lời mời kết bạn ✓';
      showToast('Đã gửi lời mời kết bạn. Chờ đối phương đồng ý!');
    });
  }

  // =========================================================================
  // Bottom Sheets & Modals: Safety, Report, Media Upload
  // =========================================================================
  const safetySheet = document.getElementById('sheet-safety-menu');
  const reportSheet = document.getElementById('sheet-report-form');
  const mediaSheet = document.getElementById('sheet-media-upload');

  function openSheet(sheetEl) {
    if (sheetEl) sheetEl.classList.add('open');
  }

  function closeSheet(sheetEl) {
    if (sheetEl) sheetEl.classList.remove('open');
  }

  // Close backdrops on click
  document.querySelectorAll('.bottom-sheet-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        closeSheet(backdrop);
      }
    });
  });

  // Open Safety Sheet
  const btnOpenSafety = document.getElementById('btn-open-safety-sheet');
  if (btnOpenSafety) {
    btnOpenSafety.addEventListener('click', () => {
      openSheet(safetySheet);
    });
  }

  // Instant Block
  const btnInstantBlock = document.getElementById('btn-action-instant-block');
  if (btnInstantBlock) {
    btnInstantBlock.addEventListener('click', () => {
      closeSheet(safetySheet);
      showToast('Đã chặn đối tác ngay lập tức phía máy chủ.');
      setChatState('ENDED');
    });
  }

  // Open Report Sheet
  const btnOpenReport = document.getElementById('btn-action-open-report');
  if (btnOpenReport) {
    btnOpenReport.addEventListener('click', () => {
      closeSheet(safetySheet);
      openSheet(reportSheet);
    });
  }

  // Submit Report
  const btnSubmitReport = document.getElementById('btn-submit-report');
  if (btnSubmitReport) {
    btnSubmitReport.addEventListener('click', () => {
      closeSheet(reportSheet);
      showToast('Báo cáo và bằng chứng đã được ghi nhận. Đang xử lý!');
      setChatState('ENDED');
    });
  }

  // Open Media Sheet
  const btnOpenMediaUpload = document.getElementById('btn-open-media-sheet');
  if (btnOpenMediaUpload) {
    btnOpenMediaUpload.addEventListener('click', () => {
      openSheet(mediaSheet);
    });
  }

  // Adult Content Toggle inside Media Upload Sheet
  const switchAdultContent = document.getElementById('switch-adult-content');
  const adultNoticeBanner = document.getElementById('adult-consent-notice');
  if (switchAdultContent) {
    switchAdultContent.addEventListener('click', () => {
      switchAdultContent.classList.toggle('checked');
      const isAdult = switchAdultContent.classList.contains('checked');
      if (adultNoticeBanner) {
        adultNoticeBanner.style.display = isAdult ? 'block' : 'none';
      }
    });
  }

  // Send Mock Media Message with Dynamic Watermark
  const btnConfirmSendMedia = document.getElementById('btn-confirm-send-media');
  if (btnConfirmSendMedia) {
    btnConfirmSendMedia.addEventListener('click', () => {
      const isAdult = switchAdultContent && switchAdultContent.classList.contains('checked');
      closeSheet(mediaSheet);

      const stream = document.getElementById('random-messages-stream');
      if (!stream) return;

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble outgoing';
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const mediaId = 'MED-' + Math.floor(Math.random() * 9000 + 1000);

      bubble.innerHTML = `
        <div class="bubble-content" style="padding: 6px;">
          <div class="media-card-preview" id="${mediaId}">
            <img src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80" class="media-thumbnail" alt="Media" />
            <div class="watermark-overlay">
              <span class="watermark-text">Chatible • [MinhThư_A21 #TR-8841-X9]</span>
              ${isAdult ? '<span class="sensitive-tag">🔞 Nội dung người lớn</span>' : ''}
              <span class="watermark-text" style="align-self: flex-end;">${new Date().toLocaleDateString()}</span>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 6px;">
            <span style="font-size: 11px; color: var(--text-inverse); font-weight: 600;">Ảnh đã mã hóa KMS</span>
            <button class="btn-revoke-media" data-media="${mediaId}" style="font-size: 10.5px; background: rgba(0,0,0,0.3); color: #fff; padding: 2px 6px; border-radius: 4px;">Thu hồi quyền xem</button>
          </div>
        </div>
        <div class="bubble-time">${time} • Đã gửi</div>
      `;
      stream.appendChild(bubble);
      stream.scrollTop = stream.scrollHeight;
      showToast('Đã gửi ảnh thành công qua kênh mã hóa Envelope.');

      // Hook up revocation action (ADULT-15 & ADULT-16)
      bubble.querySelector('.btn-revoke-media').addEventListener('click', (e) => {
        const card = document.getElementById(mediaId);
        if (card) {
          card.innerHTML = `<div style="padding: 24px 12px; text-align: center; color: var(--text-muted); font-size: 12px; background: #12141c;">🔒 Nội dung không còn khả dụng (Đã bị người gửi thu hồi)</div>`;
          e.target.remove();
          showToast('Đã thu hồi quyền xem media thành công.');
        }
      });
    });
  }

  // Audio Recording Simulator Button
  const btnRecordAudio = document.getElementById('btn-record-audio');
  if (btnRecordAudio) {
    let recording = false;
    btnRecordAudio.addEventListener('click', () => {
      recording = !recording;
      if (recording) {
        btnRecordAudio.style.color = 'var(--danger)';
        showToast('🎙️ Đang ghi âm... Nhấn lại để gửi');
      } else {
        btnRecordAudio.style.color = 'inherit';
        sendMockAudioMessage();
      }
    });
  }

  function sendMockAudioMessage() {
    const stream = document.getElementById('random-messages-stream');
    if (!stream) return;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble outgoing';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div class="bubble-content" style="padding: 6px 12px;">
        <div class="audio-player-bubble">
          <button class="audio-play-btn">▶</button>
          <div class="audio-waveform">
            <span class="wave-bar" style="height: 12px;"></span>
            <span class="wave-bar" style="height: 18px;"></span>
            <span class="wave-bar" style="height: 8px;"></span>
            <span class="wave-bar" style="height: 16px;"></span>
            <span class="wave-bar" style="height: 14px;"></span>
            <span class="wave-bar" style="height: 10px;"></span>
          </div>
          <span style="font-size: 11px; font-family: var(--font-mono);">0:14</span>
        </div>
      </div>
      <div class="bubble-time">${time} • Đã gửi</div>
    `;
    stream.appendChild(bubble);
    stream.scrollTop = stream.scrollHeight;
    showToast('Đã gửi tin nhắn ghi âm.');
  }

  // =========================================================================
  // Preference Chips Selection
  // =========================================================================
  document.querySelectorAll('.pref-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.parentElement.querySelectorAll('.pref-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  // Range Slider Age Label Update
  const ageRangeSlider = document.getElementById('pref-age-range');
  const ageRangeVal = document.getElementById('pref-age-display');
  if (ageRangeSlider && ageRangeVal) {
    ageRangeSlider.addEventListener('input', (e) => {
      ageRangeVal.textContent = `18 - ${e.target.value} tuổi`;
    });
  }

  // Initial State: Launch into IDLE
  setChatState('IDLE');
});

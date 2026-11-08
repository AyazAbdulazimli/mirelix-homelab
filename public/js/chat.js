// Real-time Chat & Messaging Controller
class ChatManager {
  constructor(socket, roomId, myUsername) {
    this.socket = socket;
    this.roomId = roomId;
    this.myUsername = myUsername;

    this.messagesContainer = document.getElementById('chatMessages');
    this.chatForm = document.getElementById('chatForm');
    this.chatInput = document.getElementById('chatInput');
    this.typingIndicator = document.getElementById('typingIndicator');
    this.typingName = document.getElementById('typingName');
    this.emojiButtons = document.querySelectorAll('.emoji-btn');
    this.unreadBadge = document.getElementById('unreadBadge');
    this.sidebar = document.getElementById('roomSidebar');

    this.unreadCount = 0;
    this.typingTimeout = null;

    this.init();
  }

  init() {
    // Form submit
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      if (text) {
        this.socket.emit('chat-message', {
          roomId: this.roomId,
          text
        });
        this.chatInput.value = '';
        this.emitTyping(false);
      }
    });

    // Typing detection
    this.chatInput.addEventListener('input', () => {
      this.emitTyping(true);
      clearTimeout(this.typingTimeout);
      this.typingTimeout = setTimeout(() => {
        this.emitTyping(false);
      }, 1500);
    });

    // Quick emoji buttons
    this.emojiButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.chatInput.value += btn.textContent;
        this.chatInput.focus();
      });
    });

    // Listen for incoming messages
    this.socket.on('chat-message', (data) => {
      this.appendMessage(data);

      // Play audio notification
      if (data.sender !== this.myUsername && !data.isSystem) {
        window.sounds.playMessage();

        // Increment unread badge if sidebar is hidden or user pane is active
        if (this.sidebar.classList.contains('closed') || !document.getElementById('paneChat').classList.contains('active')) {
          this.unreadCount++;
          if (this.unreadBadge) {
            this.unreadBadge.textContent = this.unreadCount;
            this.unreadBadge.style.display = 'flex';
          }
          const dockBadge = document.getElementById('dockUnreadBadge');
          if (dockBadge) {
            dockBadge.textContent = this.unreadCount;
            dockBadge.style.display = 'flex';
          }
        }
      }
    });

    // Typing indicator from others
    this.socket.on('user-typing', ({ username, isTyping }) => {
      if (isTyping) {
        this.typingName.textContent = username;
        this.typingIndicator.style.display = 'block';
      } else {
        this.typingIndicator.style.display = 'none';
      }
    });
  }

  emitTyping(isTyping) {
    this.socket.emit('typing', {
      roomId: this.roomId,
      isTyping
    });
  }

  appendMessage({ sender, text, time, isSystem, action, username }) {
    if (isSystem) {
      const bubble = document.createElement('div');
      bubble.className = 'system-bubble';
      if (action === 'joined' || action === 'left') {
        window.I18n.bindText(bubble, action === 'joined' ? '{name} otağa qoşuldu 👋' : '{name} otaqdan ayrıldı.', { name: username });
      } else {
        bubble.setAttribute('data-i18n-skip', '');
        bubble.textContent = text;
      }
      this.messagesContainer.appendChild(bubble);
    } else {
      const welcome = document.getElementById('chatWelcome');
      if (welcome) welcome.hidden = true;
      const isMine = sender === this.myUsername;
      const msgItem = document.createElement('div');
      msgItem.className = `message-item ${isMine ? 'mine' : 'theirs'}`;

      msgItem.innerHTML = `
        <div class="msg-header">
          <span class="msg-sender" ${isMine ? 'data-i18n=""' : ''}>${isMine ? 'Siz' : this.escapeHtml(sender)}</span>
          <span class="msg-time">${this.escapeHtml(time || '')}</span>
        </div>
        <div class="msg-body">${this.escapeHtml(text)}</div>
      `;

      this.messagesContainer.appendChild(msgItem);
    }

    // Scroll to bottom
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  clearUnread() {
    this.unreadCount = 0;
    if (this.unreadBadge) {
      this.unreadBadge.style.display = 'none';
    }
    const dockBadge = document.getElementById('dockUnreadBadge');
    if (dockBadge) {
      dockBadge.style.display = 'none';
    }
  }
}

window.ChatManager = ChatManager;

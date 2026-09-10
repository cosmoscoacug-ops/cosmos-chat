# Cosmos Chat

Cosmos Chat is a WhatsApp-inspired, independently designed real-time messaging web app with its own identity and styling.

## Included
- Account creation and login
- Real-time 1-to-1 and group messaging using WebSockets
- Text messages
- Image/file attachments
- Message reactions
- Reply-to-message
- Edit and delete your own messages
- Read receipts
- Typing indicators
- Online/offline presence
- Chat search
- Message search
- Pinned chats
- Archived chats
- Muted chats
- Starred messages
- Group creation
- Group member management
- User profile editing
- Light / dark / system themes
- Custom chat wallpaper / background
- Accent color selection
- Compact / comfortable density
- Notification sounds
- Browser notifications
- PWA manifest + service worker
- Local SQLite database
- Responsive phone/desktop layout
- Basic WebRTC voice/video call signaling UI

## Quick start on Windows PowerShell

```powershell
cd "$HOME\Desktop\Cosmos_Chat"

py -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
python run.py
```

Then open:

http://127.0.0.1:8000

## Let friends use it on the same Wi-Fi / LAN

Run:

```powershell
python run.py --host 0.0.0.0 --port 8000
```

Find your PC IPv4 address:

```powershell
ipconfig
```

Friends on the same network can open:

```text
http://YOUR-PC-IP:8000
```

Example:

```text
http://192.168.1.20:8000
```

For use over the public internet, deploy the app behind HTTPS with a reverse proxy or cloud host.

## Default data

No default users are created. Register your own account from the login screen.

## Important production notes

This project is a fully working local/LAN implementation, but if you deploy it publicly you should additionally add:
- HTTPS
- A production database such as PostgreSQL
- Object storage for uploads
- Rate limiting
- Email/phone verification
- Backups
- Malware scanning for uploaded files
- TURN server for reliable WebRTC calls
- Stronger moderation/admin controls
- Secure production secret management

## Project structure

```text
Cosmos_Chat/
  app/
    main.py
    db.py
    auth.py
    models.py
    realtime.py
    static/
      app.js
      styles.css
      manifest.webmanifest
      sw.js
    templates/
      index.html
  data/
  uploads/
  requirements.txt
  run.py
  .env.example
```

## Internet use

This build supports accounts identified by username or Gmail/email, saved contacts, and forwarding messages. For friends outside your Wi-Fi, deploy behind HTTPS on a public server with WebSocket support. Use PostgreSQL and object storage for production, plus email verification, password reset, rate limiting, backups, and moderation.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {
  token: localStorage.getItem("cosmos_token") || "",
  me: null,
  chats: [],
  current: null,
  messages: [],
  users: [],
  ws: null,
  replyTo: null,
  filter: "all",
  settings: JSON.parse(localStorage.getItem("cosmos_settings") || "{}"),
  peer: null,
  localStream: null,
  callType: null
};

function toast(text){
  const el=document.createElement("div"); el.className="toast"; el.textContent=text;
  $("#toastHost").append(el); setTimeout(()=>el.remove(),2500);
}
async function api(path, opts={}){
  const headers = {...(opts.headers||{})};
  if(state.token) headers.Authorization = `Bearer ${state.token}`;
  if(opts.body && !(opts.body instanceof FormData)) headers["Content-Type"]="application/json";
  const res = await fetch(path,{...opts,headers});
  if(!res.ok){
    let msg=`Request failed (${res.status})`;
    try{ const j=await res.json(); msg=j.detail||msg; }catch{}
    if(res.status===401){ logout(false); }
    throw new Error(msg);
  }
  const type=res.headers.get("content-type")||"";
  return type.includes("application/json") ? res.json() : res.text();
}
function initials(name="C"){ return name.trim().split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()).join("") || "C"; }
function avatar(el, userOrChat){
  const url=userOrChat?.avatar_url;
  el.textContent = url ? "" : initials(userOrChat?.display_name || userOrChat?.title || "C");
  el.style.backgroundImage = url ? `url("${url.replaceAll('"','')}")` : "";
}
function fmtTime(s){
  if(!s) return "";
  const d=new Date(s); return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
}
function preview(m){
  if(!m) return "No messages yet";
  if(m.deleted) return "Message deleted";
  if(m.body) return m.body;
  if(m.attachment_name) return "📎 "+m.attachment_name;
  return "Message";
}
function escapeHtml(s=""){
  return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function applySettings(){
  const st=state.settings;
  const theme = st.theme || "dark";
  let real = theme;
  if(theme==="system") real = matchMedia("(prefers-color-scheme: light)").matches ? "light":"dark";
  document.documentElement.dataset.theme=real;
  document.documentElement.dataset.density=st.density||"comfortable";
  if(st.accent) document.documentElement.style.setProperty("--accent",st.accent);
}
applySettings();

$$("[data-auth-tab]").forEach(btn=>btn.onclick=()=>{
  $$("[data-auth-tab]").forEach(b=>b.classList.toggle("active",b===btn));
  $("#loginForm").classList.toggle("hidden",btn.dataset.authTab!=="login");
  $("#registerForm").classList.toggle("hidden",btn.dataset.authTab!=="register");
  $("#authError").textContent="";
});

$("#loginForm").onsubmit=async e=>{
  e.preventDefault(); $("#authError").textContent="";
  try{
    const r=await api("/api/auth/login",{method:"POST",body:JSON.stringify({
      username:$("#loginUsername").value,password:$("#loginPassword").value
    })});
    state.token=r.token; localStorage.setItem("cosmos_token",r.token); await boot();
  }catch(err){$("#authError").textContent=err.message}
};
$("#registerForm").onsubmit=async e=>{
  e.preventDefault(); $("#authError").textContent="";
  try{
    const r=await api("/api/auth/register",{method:"POST",body:JSON.stringify({
      display_name:$("#registerName").value,
      username:$("#registerUsername").value,
      email:$("#registerEmail").value,
      password:$("#registerPassword").value
    })});
    state.token=r.token; localStorage.setItem("cosmos_token",r.token); await boot();
  }catch(err){$("#authError").textContent=err.message}
};

async function boot(){
  if(!state.token){ showAuth(); return; }
  try{
    state.me=await api("/api/me");
    $("#authScreen").classList.add("hidden"); $("#appShell").classList.remove("hidden");
    avatar($("#meAvatar"),state.me);
    connectWS();
    await loadChats();
    if("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(()=>{});
  }catch{ showAuth(); }
}
function showAuth(){
  $("#appShell").classList.add("hidden"); $("#authScreen").classList.remove("hidden");
}
function logout(reload=true){
  state.token=""; state.me=null; localStorage.removeItem("cosmos_token");
  if(state.ws) state.ws.close();
  showAuth(); if(reload) location.reload();
}

async function loadChats(){
  state.chats=await api("/api/chats");
  renderChats();
  if(state.current){
    const fresh=state.chats.find(c=>c.id===state.current.id);
    if(fresh){ state.current=fresh; renderHeader(); }
  }
}
function renderChats(){
  const q=$("#chatSearch").value.trim().toLowerCase();
  const list=state.chats.filter(c=>{
    if(q && !c.title.toLowerCase().includes(q) && !preview(c.last_message).toLowerCase().includes(q)) return false;
    if(state.filter==="unread" && !c.unread) return false;
    if(state.filter==="groups" && c.kind!=="group") return false;
    if(state.filter==="archived" && !c.archived) return false;
    if(state.filter!=="archived" && c.archived) return false;
    return true;
  });
  $("#chatList").innerHTML=list.map(c=>`
    <div class="chat-item ${state.current?.id===c.id?"active":""}" data-chat="${c.id}">
      <div class="avatar chat-av" data-id="${c.id}">${initials(c.title)}</div>
      <div class="chat-main">
        <div class="chat-top"><span class="chat-name">${escapeHtml(c.title)}</span><span class="chat-time">${fmtTime(c.last_message?.created_at)}</span></div>
        <div class="chat-bottom"><span class="chat-preview">${escapeHtml(preview(c.last_message))}</span>${c.pinned?'<span class="pin">📌</span>':""}</div>
      </div>
      <div>${c.unread?`<span class="badge">${c.unread}</span>`:""}</div>
    </div>`).join("") || `<div style="padding:30px;color:var(--muted);text-align:center">No chats here.</div>`;
  list.forEach(c=>{ const el=$(`.chat-av[data-id="${c.id}"]`); if(el) avatar(el,c); });
  $$("[data-chat]").forEach(el=>el.onclick=()=>openChat(Number(el.dataset.chat)));
}
$("#chatSearch").oninput=renderChats;
$$(".filter").forEach(b=>b.onclick=()=>{
  $$(".filter").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  state.filter=b.dataset.filter; renderChats();
});

async function openChat(id){
  const c=state.chats.find(x=>x.id===id); if(!c) return;
  state.current=c; state.replyTo=null; renderChats(); renderHeader();
  $("#emptyState").classList.add("hidden"); $("#chatView").classList.remove("hidden");
  $(".conversation").classList.add("mobile-open");
  setWallpaper(c.wallpaper);
  state.messages=await api(`/api/chats/${id}/messages`);
  renderMessages();
  markVisibleRead();
}
function renderHeader(){
  const c=state.current;if(!c)return;
  $("#chatTitle").textContent=c.title; avatar($("#chatAvatar"),c);
  if(c.kind==="group"){
    $("#chatStatus").textContent=`${c.members.length} members`;
  }else{
    const o=c.members.find(m=>m.id!==state.me.id);
    $("#chatStatus").textContent=o?.online?"online":o?.last_seen?`last seen ${new Date(o.last_seen).toLocaleString()}`:"offline";
  }
}
function setWallpaper(value){
  const el=$("#wallpaperLayer");
  if(!value){el.style.backgroundImage="";return}
  if(value.startsWith("#") || value.startsWith("rgb")) el.style.background=value;
  else el.style.backgroundImage=`linear-gradient(rgba(0,0,0,.08),rgba(0,0,0,.08)),url("${value.replaceAll('"','')}")`;
}

function renderMessages(){
  const q=$("#messageSearchInput").value.trim().toLowerCase();
  const msgs=state.messages.filter(m=>!q || m.body.toLowerCase().includes(q) || m.attachment_name.toLowerCase().includes(q));
  $("#messages").innerHTML=msgs.map(m=>{
    const mine=m.sender_id===state.me.id;
    const reacts=m.reactions.map(r=>`<button class="react-chip" data-react="${m.id}" data-emoji="${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} ${r.count}</button>`).join("");
    let att="";
    if(m.attachment_url){
      if(m.attachment_type.startsWith("image/")) att=`<a href="${m.attachment_url}" target="_blank"><img class="attachment" src="${m.attachment_url}" alt=""></a>`;
      else att=`<a class="file-card" href="${m.attachment_url}" target="_blank">📎 <span>${escapeHtml(m.attachment_name)}</span></a>`;
    }
    return `<div class="msg ${mine?"mine":"theirs"}" data-mid="${m.id}">
      ${state.current.kind==="group"&&!mine?`<div class="sender">${escapeHtml(m.sender_name)}</div>`:""}
      ${m.reply?`<div class="reply-quote">${m.reply.deleted?"Deleted message":escapeHtml(m.reply.body||"Attachment")}</div>`:""}
      ${m.deleted?`<div class="body"><i>Message deleted</i></div>`:`<div class="body">${escapeHtml(m.body)}</div>${att}`}
      <div class="reactions">${reacts}</div>
      <div class="meta"><span>${m.edited?"edited":""}</span><span>${fmtTime(m.created_at)}</span>${mine?`<span>${m.read_count>1?"✓✓":"✓"}</span>`:""}</div>
      <div class="msg-actions">
        <button data-action="reply" data-id="${m.id}" title="Reply">↩</button>
        <button data-action="react" data-id="${m.id}" title="React">☺</button>
        <button data-action="star" data-id="${m.id}" title="Star">${m.starred?"★":"☆"}</button>
        <button data-action="forward" data-id="${m.id}" title="Forward">↗</button>
        ${mine&&!m.deleted?`<button data-action="edit" data-id="${m.id}" title="Edit">✎</button><button data-action="delete" data-id="${m.id}" title="Delete">🗑</button>`:""}
      </div>
    </div>`;
  }).join("");
  bindMessageActions();
  requestAnimationFrame(()=>{$("#messages").scrollTop=$("#messages").scrollHeight});
}
function bindMessageActions(){
  $$("[data-action]").forEach(b=>b.onclick=async e=>{
    e.stopPropagation(); const id=Number(b.dataset.id), m=state.messages.find(x=>x.id===id);
    const act=b.dataset.action;
    if(act==="reply"){state.replyTo=id;$("#replyBar").classList.remove("hidden");$("#replyText").textContent=m.body||m.attachment_name||"Message";$("#messageInput").focus()}
    if(act==="react"){ reactPicker(id,b); }
    if(act==="star"){await api(`/api/messages/${id}/star`,{method:"POST"});m.starred=!m.starred;renderMessages()}
    if(act==="forward"){await forwardMessage(m)}
    if(act==="edit"){
      const body=prompt("Edit message",m.body); if(body&&body.trim()){ await api(`/api/messages/${id}`,{method:"PUT",body:JSON.stringify({body})});}
    }
    if(act==="delete" && confirm("Delete this message?")) await api(`/api/messages/${id}`,{method:"DELETE"});
  });
  $$("[data-react]").forEach(b=>b.onclick=()=>toggleReaction(Number(b.dataset.react),b.dataset.emoji));
}
function reactPicker(id,anchor){
  const options=["👍","❤️","😂","😮","😢","🙏"];
  const old=document.querySelector(".quick-react"); if(old)old.remove();
  const p=document.createElement("div"); p.className="quick-react";
  p.style.cssText="position:fixed;z-index:80;background:var(--panel);border:1px solid var(--border);padding:6px;border-radius:999px;box-shadow:var(--shadow)";
  const r=anchor.getBoundingClientRect();p.style.left=Math.max(8,r.left-120)+"px";p.style.top=Math.max(8,r.top-50)+"px";
  p.innerHTML=options.map(x=>`<button style="font-size:20px;padding:5px">${x}</button>`).join("");
  [...p.children].forEach((b,i)=>b.onclick=()=>{toggleReaction(id,options[i]);p.remove()});
  document.body.append(p);
}
async function toggleReaction(id,emoji){await api(`/api/messages/${id}/reaction`,{method:"POST",body:JSON.stringify({emoji})})}
async function markVisibleRead(){
  for(const m of state.messages){
    if(m.sender_id!==state.me.id) api(`/api/messages/${m.id}/read`,{method:"POST"}).catch(()=>{});
  }
}
$("#cancelReply").onclick=()=>{state.replyTo=null;$("#replyBar").classList.add("hidden")};
$("#backBtn").onclick=()=>$(".conversation").classList.remove("mobile-open");

async function sendText(){
  const body=$("#messageInput").value.trim();
  if(!body||!state.current)return;
  $("#messageInput").value=""; autoSize();
  await api(`/api/chats/${state.current.id}/messages`,{method:"POST",body:JSON.stringify({body,reply_to:state.replyTo})});
  state.replyTo=null;$("#replyBar").classList.add("hidden");
}
$("#sendBtn").onclick=sendText;
$("#messageInput").onkeydown=e=>{
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendText()}
};
$("#messageInput").oninput=()=>{
  autoSize();
  if(state.ws?.readyState===1 && state.current) state.ws.send(JSON.stringify({type:"typing",chat_id:state.current.id}));
};
function autoSize(){const x=$("#messageInput");x.style.height="auto";x.style.height=Math.min(x.scrollHeight,160)+"px"}

$("#attachBtn").onclick=()=>$("#fileInput").click();
$("#fileInput").onchange=async()=>{
  const f=$("#fileInput").files[0]; if(!f||!state.current)return;
  const fd=new FormData();fd.append("file",f);
  try{await api(`/api/chats/${state.current.id}/upload`,{method:"POST",body:fd});}
  catch(e){toast(e.message)}
  $("#fileInput").value="";
};

$("#emojiBtn").onclick=e=>{$("#emojiPanel").classList.toggle("hidden");e.stopPropagation()};
$$("#emojiPanel button").forEach(b=>b.onclick=()=>{$("#messageInput").value+=b.textContent;$("#emojiPanel").classList.add("hidden");$("#messageInput").focus()});
document.addEventListener("click",e=>{if(!$("#emojiPanel").contains(e.target)&&e.target!==$("#emojiBtn"))$("#emojiPanel").classList.add("hidden")});

$("#messageSearchBtn").onclick=()=>{$("#messageSearchBar").classList.toggle("hidden");$("#messageSearchInput").focus()};
$("#messageSearchClose").onclick=()=>{$("#messageSearchInput").value="";$("#messageSearchBar").classList.add("hidden");renderMessages()};
$("#messageSearchInput").oninput=renderMessages;

function modal(html){$("#modal").innerHTML=html;$("#modalBackdrop").classList.remove("hidden")}
function closeModal(){$("#modalBackdrop").classList.add("hidden")}
$("#modalBackdrop").onclick=e=>{if(e.target===$("#modalBackdrop"))closeModal()};

$("#newChatBtn").onclick=async()=>{
  const users=await api("/api/users"); state.users=users;
  modal(`<h2>New chat</h2>
    <div class="field"><input id="userFind" placeholder="Search people"></div>
    <div id="userRows">${userRows(users)}</div>`);
  $("#userFind").oninput=async()=>{$("#userRows").innerHTML=userRows(await api("/api/users?q="+encodeURIComponent($("#userFind").value)));bindUserRows()};
  bindUserRows();
};
function userRows(users){
  return users.map(u=>`<div class="user-row"><div class="avatar">${initials(u.display_name)}</div><div class="grow"><strong>${escapeHtml(u.display_name)}</strong><br><small>@${escapeHtml(u.username)}</small></div><button class="primary choose-user" data-id="${u.id}">Chat</button></div>`).join("")||"<p>No users found.</p>";
}
function bindUserRows(){
  $$(".choose-user").forEach(b=>b.onclick=async()=>{
    const c=await api("/api/chats/direct",{method:"POST",body:JSON.stringify({user_id:Number(b.dataset.id)})});
    closeModal(); await loadChats(); openChat(c.id);
  });
}

$("#newGroupBtn").onclick=async()=>{
  const users=await api("/api/users");
  modal(`<h2>Create group</h2>
    <div class="field"><label>Group name</label><input id="groupName" maxlength="80" placeholder="Friends"></div>
    <p>Select members</p>
    <div>${users.map(u=>`<label class="user-row"><input type="checkbox" class="group-check" value="${u.id}"><div><strong>${escapeHtml(u.display_name)}</strong><br><small>@${escapeHtml(u.username)}</small></div></label>`).join("")}</div>
    <button id="createGroupGo" class="primary wide">Create group</button>`);
  $("#createGroupGo").onclick=async()=>{
    const title=$("#groupName").value.trim(); if(!title)return toast("Enter a group name");
    const member_ids=$$(".group-check:checked").map(x=>Number(x.value));
    const c=await api("/api/chats/group",{method:"POST",body:JSON.stringify({title,member_ids})});
    closeModal();await loadChats();openChat(c.id);
  };
};

$("#contactsBtn").onclick=async()=>{
  const contacts=await api("/api/contacts");
  modal(`<h2>Contacts</h2><p style="color:var(--muted)">Save friends by Cosmos username or Gmail address.</p><div class="field"><label>Username or email</label><input id="contactValue" placeholder="friend@gmail.com"></div><div class="field"><label>Nickname</label><input id="contactNickname" placeholder="Best friend"></div><button id="addContactGo" class="primary wide">Save contact</button><h3>Saved contacts</h3><div>${contacts.map(u=>`<div class="user-row"><div class="avatar">${initials(u.display_name)}</div><div class="grow"><strong>${escapeHtml(u.nickname||u.display_name)}</strong><br><small>${escapeHtml(u.email)}</small></div><button class="primary contact-chat" data-id="${u.id}">Chat</button></div>`).join("")||"<p>No contacts yet.</p>"}</div>`);
  $("#addContactGo").onclick=async()=>{try{await api("/api/contacts",{method:"POST",body:JSON.stringify({contact:$("#contactValue").value,nickname:$("#contactNickname").value})});closeModal();toast("Contact saved")}catch(e){toast(e.message)}};
  $$(".contact-chat").forEach(b=>b.onclick=async()=>{const c=await api("/api/chats/direct",{method:"POST",body:JSON.stringify({user_id:Number(b.dataset.id)})});closeModal();await loadChats();openChat(c.id)});
};
async function forwardMessage(m){const choices=state.chats.filter(c=>c.id!==m.chat_id);modal(`<h2>Forward message</h2>${choices.map(c=>`<label class="user-row"><input type="checkbox" class="forward-check" value="${c.id}"><div>${escapeHtml(c.title)}</div></label>`).join("")}<button id="forwardGo" class="primary wide">Forward</button>`);$("#forwardGo").onclick=async()=>{const target_chat_ids=$$(".forward-check:checked").map(x=>Number(x.value));if(!target_chat_ids.length)return toast("Choose a chat");await api(`/api/messages/${m.id}/forward`,{method:"POST",body:JSON.stringify({target_chat_ids})});closeModal();toast("Message forwarded")}}

$("#profileBtn").onclick=()=>{
  modal(`<h2>Your profile</h2>
    <div class="field"><label>Display name</label><input id="pName" value="${escapeHtml(state.me.display_name)}"></div>
    <div class="field"><label>Bio</label><textarea id="pBio">${escapeHtml(state.me.bio||"")}</textarea></div>
    <div class="field"><label>Avatar image URL</label><input id="pAvatar" value="${escapeHtml(state.me.avatar_url||"")}" placeholder="https://..."></div>
    <button id="saveProfile" class="primary wide">Save profile</button>`);
  $("#saveProfile").onclick=async()=>{
    state.me=await api("/api/me",{method:"PUT",body:JSON.stringify({
      display_name:$("#pName").value,bio:$("#pBio").value,avatar_url:$("#pAvatar").value
    })});avatar($("#meAvatar"),state.me);closeModal();toast("Profile saved");
  };
};

$("#settingsBtn").onclick=()=>{
  const s=state.settings;
  modal(`<h2>Cosmos Chat settings</h2>
    <div class="field"><label>Theme</label><select id="sTheme">
      <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
    </select></div>
    <div class="field"><label>Accent color</label><input id="sAccent" type="color" value="${s.accent||"#7c5cff"}"></div>
    <div class="field"><label>Chat density</label><select id="sDensity"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div>
    <label class="user-row"><input id="sSound" type="checkbox" ${s.sound!==false?"checked":""}> Message sounds</label>
    <label class="user-row"><input id="sNotify" type="checkbox" ${s.notify?"checked":""}> Browser notifications</label>
    <button id="saveSettings" class="primary wide">Save</button>
    <button id="logoutBtn" class="danger wide" style="margin-top:10px">Sign out</button>`);
  $("#sTheme").value=s.theme||"dark";$("#sDensity").value=s.density||"comfortable";
  $("#saveSettings").onclick=async()=>{
    state.settings={theme:$("#sTheme").value,accent:$("#sAccent").value,density:$("#sDensity").value,sound:$("#sSound").checked,notify:$("#sNotify").checked};
    localStorage.setItem("cosmos_settings",JSON.stringify(state.settings));applySettings();closeModal();
    if(state.settings.notify && Notification.permission==="default") Notification.requestPermission();
  };
  $("#logoutBtn").onclick=()=>logout();
};

$("#chatMenuBtn").onclick=()=>{
  const c=state.current;if(!c)return;
  modal(`<h2>${escapeHtml(c.title)}</h2>
    <button id="pinChat" class="primary wide">${c.pinned?"Unpin":"Pin"} chat</button>
    <button id="archiveChat" class="primary wide" style="margin-top:8px">${c.archived?"Unarchive":"Archive"} chat</button>
    <button id="muteChat" class="primary wide" style="margin-top:8px">${c.muted?"Unmute":"Mute"} chat</button>
    <div class="field"><label>Conversation background</label><input id="wallpaperInput" value="${escapeHtml(c.wallpaper||"")}" placeholder="Image URL or #202938"></div>
    <button id="wallpaperSave" class="primary wide">Apply background</button>
    ${c.kind==="group"?`<h3>Members</h3>${c.members.map(m=>`<div class="user-row"><div class="grow">${escapeHtml(m.display_name)}</div>${m.id!==state.me.id&&c.role==="admin"?`<button class="removeMember" data-id="${m.id}">Remove</button>`:""}</div>`).join("")}<button id="addMembersBtn" class="primary wide">Add members</button>`:""}`);
  $("#pinChat").onclick=()=>setPrefs({pinned:!c.pinned});
  $("#archiveChat").onclick=()=>setPrefs({archived:!c.archived});
  $("#muteChat").onclick=()=>setPrefs({muted:!c.muted});
  $("#wallpaperSave").onclick=()=>setPrefs({wallpaper:$("#wallpaperInput").value.trim()});
  $$(".removeMember").forEach(b=>b.onclick=async()=>{await api(`/api/chats/${c.id}/members/${b.dataset.id}`,{method:"DELETE"});closeModal();await loadChats()});
  if($("#addMembersBtn")) $("#addMembersBtn").onclick=async()=>{
    const users=await api("/api/users");
    const existing=new Set(c.members.map(m=>m.id));
    const avail=users.filter(u=>!existing.has(u.id));
    modal(`<h2>Add members</h2>${avail.map(u=>`<label class="user-row"><input class="add-check" type="checkbox" value="${u.id}"><div>${escapeHtml(u.display_name)}</div></label>`).join("")}<button id="addGo" class="primary wide">Add</button>`);
    $("#addGo").onclick=async()=>{const user_ids=$$(".add-check:checked").map(x=>Number(x.value));await api(`/api/chats/${c.id}/members`,{method:"POST",body:JSON.stringify({user_ids})});closeModal();await loadChats()}
  };
};
async function setPrefs(p){
  await api(`/api/chats/${state.current.id}/prefs`,{method:"PUT",body:JSON.stringify(p)});
  closeModal();await loadChats();if(p.wallpaper!==undefined){state.current.wallpaper=p.wallpaper;setWallpaper(p.wallpaper)}
}

function connectWS(){
  if(state.ws) try{state.ws.close()}catch{}
  const proto=location.protocol==="https:"?"wss":"ws";
  const ws=new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws=ws;
  ws.onmessage=async e=>{
    const d=JSON.parse(e.data);
    if(d.type==="message"){
      if(state.current?.id===d.message.chat_id){
        if(!state.messages.some(m=>m.id===d.message.id)) state.messages.push(d.message);
        renderMessages(); if(d.message.sender_id!==state.me.id) api(`/api/messages/${d.message.id}/read`,{method:"POST"}).catch(()=>{});
      }
      await loadChats();
      if(d.message.sender_id!==state.me.id) notifyMessage(d.message);
    }
    if(d.type==="message_updated"){
      const i=state.messages.findIndex(m=>m.id===d.message.id);if(i>=0){state.messages[i]={...state.messages[i],...d.message};renderMessages()}
      loadChats();
    }
    if(d.type==="chat_created"||d.type==="chat_updated") loadChats();
    if(d.type==="typing"&&state.current?.id===d.chat_id){
      const u=state.current.members.find(x=>x.id===d.user_id);$("#chatStatus").textContent=`${u?.display_name||"Someone"} is typing…`;
      clearTimeout(window.__typingTimer);window.__typingTimer=setTimeout(renderHeader,1200);
    }
    if(d.type==="presence"){
      for(const c of state.chats){const m=c.members.find(x=>x.id===d.user_id);if(m){m.online=d.online;m.last_seen=d.last_seen||m.last_seen}}
      renderHeader();
    }
    if(["call_offer","call_answer","ice","call_end"].includes(d.type)) handleCallSignal(d);
  };
  ws.onclose=()=>{if(state.token)setTimeout(connectWS,1800)};
}
function notifyMessage(m){
  if(state.settings.sound!==false){
    try{const ac=new AudioContext();const o=ac.createOscillator();const g=ac.createGain();o.connect(g);g.connect(ac.destination);o.frequency.value=520;g.gain.value=.025;o.start();o.stop(ac.currentTime+.08)}catch{}
  }
  if(state.settings.notify && Notification.permission==="granted" && document.hidden){
    new Notification(m.sender_name,{body:m.body||m.attachment_name||"New message"});
  }
}

$("#voiceCallBtn").onclick=()=>startCall(false);
$("#videoCallBtn").onclick=()=>startCall(true);
$("#hangupBtn").onclick=()=>endCall(true);
$("#muteBtn").onclick=()=>{
  if(!state.localStream)return;state.localStream.getAudioTracks().forEach(t=>t.enabled=!t.enabled);
};
$("#cameraBtn").onclick=()=>{
  if(!state.localStream)return;state.localStream.getVideoTracks().forEach(t=>t.enabled=!t.enabled);
};
async function startCall(video){
  if(!state.current || state.current.kind!=="direct") return toast("Calls are currently available for direct chats");
  try{
    state.callType=video?"video":"voice";
    state.localStream=await navigator.mediaDevices.getUserMedia({audio:true,video});
    $("#localVideo").srcObject=state.localStream;$("#localVideo").style.display=video?"block":"none";
    showCall("Calling "+state.current.title,"Connecting…");
    const pc=createPeer();
    state.peer=pc;
    state.localStream.getTracks().forEach(t=>pc.addTrack(t,state.localStream));
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    state.ws.send(JSON.stringify({type:"call_offer",chat_id:state.current.id,sdp:offer,video}));
  }catch(e){toast("Call could not start: "+e.message);endCall(false)}
}
function createPeer(){
  const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pc.onicecandidate=e=>{if(e.candidate&&state.current)state.ws.send(JSON.stringify({type:"ice",chat_id:state.current.id,candidate:e.candidate}))};
  pc.ontrack=e=>{$("#remoteVideo").srcObject=e.streams[0]};
  return pc;
}
async function handleCallSignal(d){
  if(!state.current || state.current.id!==d.chat_id){
    const c=state.chats.find(x=>x.id===d.chat_id); if(c) await openChat(c.id);
  }
  if(d.type==="call_offer"){
    const accept=confirm(`${state.current?.title||"Someone"} is calling. Accept?`);
    if(!accept){state.ws.send(JSON.stringify({type:"call_end",chat_id:d.chat_id}));return}
    try{
      state.localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:!!d.video});
      $("#localVideo").srcObject=state.localStream;$("#localVideo").style.display=d.video?"block":"none";
      showCall(state.current.title,"Connected");
      const pc=createPeer();state.peer=pc;state.localStream.getTracks().forEach(t=>pc.addTrack(t,state.localStream));
      await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
      state.ws.send(JSON.stringify({type:"call_answer",chat_id:d.chat_id,sdp:ans}));
    }catch(e){toast("Could not accept call");endCall(true)}
  }
  if(d.type==="call_answer"&&state.peer){await state.peer.setRemoteDescription(new RTCSessionDescription(d.sdp));$("#callStatus").textContent="Connected"}
  if(d.type==="ice"&&state.peer){try{await state.peer.addIceCandidate(d.candidate)}catch{}}
  if(d.type==="call_end") endCall(false);
}
function showCall(title,status){$("#callTitle").textContent=title;$("#callStatus").textContent=status;$("#callAvatar").textContent=initials(state.current?.title||"C");$("#callOverlay").classList.remove("hidden")}
function endCall(signal){
  if(signal&&state.current&&state.ws?.readyState===1)state.ws.send(JSON.stringify({type:"call_end",chat_id:state.current.id}));
  try{state.peer?.close()}catch{};state.peer=null;
  state.localStream?.getTracks().forEach(t=>t.stop());state.localStream=null;
  $("#remoteVideo").srcObject=null;$("#localVideo").srcObject=null;$("#callOverlay").classList.add("hidden");
}

boot();

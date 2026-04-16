let currentStaff = '';
let currentRole = '';
let activePhone = '';
let activeCustomerStatus = '';
let activeCustomerOwner = '';
let previousOpenCount = 0;
let previousMsgCount = 0;
let currentAlertId = null;

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sine'; osc.frequency.setValueAtTime(880, ctx.currentTime); 
        osc.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.1);
    } catch(e) {}
}
function sendPushNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body: body });
}

window.onload = () => {
    const savedUser = localStorage.getItem('akhanet_user');
    const savedRole = localStorage.getItem('akhanet_role');
    if (savedUser && savedRole) { currentStaff = savedUser; currentRole = savedRole; enterWorkspace(); }
};

async function attemptLogin() {
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('passcode').value;
    try {
        const res = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username: user, passcode: pass }) });
        const data = await res.json();
        if (data.success) {
            currentStaff = data.username; currentRole = data.role;
            localStorage.setItem('akhanet_user', currentStaff); localStorage.setItem('akhanet_role', currentRole);
            enterWorkspace();
        } else { document.getElementById('loginError').style.display = 'block'; }
    } catch (err) { alert("Server error."); }
}

function enterWorkspace() {
    document.getElementById('loggedInUser').innerText = `${currentRole.toUpperCase()}: ${currentStaff}`;
    if (currentRole === 'admin') document.getElementById('adminBtn').style.display = 'block';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboardScreen').style.display = 'flex';
    if ("Notification" in window && Notification.permission !== "granted") Notification.requestPermission();
    loadLobby();
}

function logout() { localStorage.removeItem('akhanet_user'); localStorage.removeItem('akhanet_role'); location.reload(); }

async function checkSecurityAlerts() {
    if (currentRole !== 'admin') return;
    try {
        const res = await fetch('/api/admin/alerts');
        const alerts = await res.json();
        if (alerts.length > 0) {
            const latest = alerts[0];
            currentAlertId = latest.id;
            document.getElementById('adminAlertBanner').style.display = 'flex';
            document.getElementById('alertText').innerText = `🚨 SECURITY BREACH: ${latest.culprit_type} [${latest.culprit_name}] attempted to poach. MSG: "${latest.attempted_message}"`;
            playBeep();
            sendPushNotification("SECURITY ALERT", "A poaching attempt was just blocked.");
        }
    } catch(e) {}
}

async function clearAlert() {
    if(!currentAlertId) return;
    await fetch('/api/admin/alerts/clear', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id: currentAlertId }) });
    document.getElementById('adminAlertBanner').style.display = 'none';
    currentAlertId = null;
}

function openAdminPanel() { document.getElementById('adminPanel').style.display = 'block'; loadPayroll(); }
function closeAdminPanel() { document.getElementById('adminPanel').style.display = 'none'; }

function resetAdminTabs() {
    document.getElementById('tabPayroll').classList.remove('active');
    document.getElementById('tabArchive').classList.remove('active');
    document.getElementById('tabSecurity').classList.remove('active');
}

async function loadPayroll() {
    resetAdminTabs(); document.getElementById('tabPayroll').classList.add('active');
    const res = await fetch('/api/admin/staff'); const staffStats = await res.json();
    let html = `<table class="payroll-table"><thead><tr><th>Username</th><th>Role</th><th>Deals Closed</th></tr></thead><tbody>`;
    staffStats.forEach(staff => { html += `<tr><td>${staff.username}</td><td>${staff.role}</td><td style="font-weight: bold; color: #1E7C98;">${staff.deals_closed}</td></tr>`; });
    document.getElementById('adminContent').innerHTML = html + `</tbody></table>`;
}

async function loadArchive() {
    resetAdminTabs(); document.getElementById('tabArchive').classList.add('active');
    const res = await fetch('/api/admin/archive'); const closedChats = await res.json();
    let html = `<div class="archive-list">`;
    closedChats.forEach(cust => { 
        const nameDisplay = cust.customer_name ? `${cust.customer_name} (${cust.phone_number})` : cust.phone_number;
        html += `<div class="archive-item" onclick="openArchivedChat('${cust.phone_number}', '${cust.assigned_to}', '${cust.customer_name || ''}')"><div><strong>${nameDisplay}</strong></div><span class="status-badge">${cust.assigned_to}</span></div>`; 
    });
    document.getElementById('adminContent').innerHTML = html + `</div>`;
}

async function loadSecurityLog() {
    resetAdminTabs(); document.getElementById('tabSecurity').classList.add('active');
    const res = await fetch('/api/admin/alerts/all'); 
    const logs = await res.json();
    
    let html = `<div class="archive-list">`;
    if (logs.length === 0) html += `<p>No security breaches recorded.</p>`;
    
    logs.forEach(log => {
        const date = new Date(log.created_at).toLocaleString();
        const badgeColor = log.culprit_type === 'Staff' ? '#d32f2f' : '#FF9800';
        html += `
            <div class="archive-item" style="border-left: 4px solid ${badgeColor}; flex-direction: column; align-items: flex-start; gap: 5px; cursor: default;">
                <div style="display: flex; justify-content: space-between; width: 100%;">
                    <strong style="color: ${badgeColor};">${log.culprit_type} Breach: ${log.culprit_name}</strong>
                    <span class="status-badge" style="background: ${log.status === 'unread' ? '#ffebee' : '#eee'}; color: #333;">${log.status.toUpperCase()}</span>
                </div>
                <div style="font-size: 0.95rem; background: white; padding: 10px; border-radius: 4px; border: 1px solid #ddd; width: 100%;">"${log.attempted_message}"</div>
                <span style="font-size: 0.8rem; color: #888;">${date}</span>
            </div>
        `;
    });
    document.getElementById('adminContent').innerHTML = html + `</div>`;
}

function openArchivedChat(phone, owner, custName) { 
    closeAdminPanel(); 
    const finalDisplay = custName ? custName : phone;
    selectCustomer(phone, finalDisplay, 'closed', owner); 
}

async function loadLobby() {
    if(!currentStaff) return;
    try {
        const res = await fetch('/api/customers');
        const customers = await res.json();
        const list = document.getElementById('lobbyList');
        list.innerHTML = '';
        let currentOpenCount = 0;

        customers.forEach(cust => {
            if(cust.status === 'closed') return; 
            if(cust.status === 'open') currentOpenCount++;

            let displayPhone = cust.phone_number;
            if (currentRole !== 'admin' && cust.phone_number.length > 4) {
                displayPhone = 'Client-****' + cust.phone_number.slice(-4);
            }
            let finalDisplayName = cust.customer_name ? cust.customer_name : displayPhone;

            const div = document.createElement('div');
            div.className = `customer-item ${cust.phone_number === activePhone ? 'active' : ''}`;
            let statusHtml = cust.status === 'open' ? `<span class="status-badge"><span class="status-dot open"></span>Waiting</span>` : `<span class="status-badge"><span class="status-dot assigned"></span>${cust.assigned_to === currentStaff ? 'My Chat' : cust.assigned_to}</span>`;
            div.innerHTML = `<div><strong>${finalDisplayName}</strong></div> ${statusHtml}`;
            
            div.onclick = () => selectCustomer(cust.phone_number, finalDisplayName, cust.status, cust.assigned_to);
            list.appendChild(div);
        });

        if (currentOpenCount > previousOpenCount && previousOpenCount !== 0) { playBeep(); sendPushNotification("Akhanet Alert", "New customer waiting."); }
        previousOpenCount = currentOpenCount;
    } catch (err) {}
}

function selectCustomer(phone, displayPhone, status, owner) {
    activePhone = phone; activeCustomerStatus = status; activeCustomerOwner = owner; previousMsgCount = 0; 
    document.getElementById('lockOverlay').style.display = 'none';
    document.getElementById('chatHeader').style.display = 'flex';
    document.getElementById('activeChatTitle').innerText = displayPhone;
    
    // NEW: Trigger the Mobile Slide Animation
    document.body.classList.add('mobile-chat-active');
    
    updateChatControls(); loadMessages(); loadLobby(); 
}

// NEW: Function to slide back to the Lobby on Mobile
function closeMobileChat() {
    document.body.classList.remove('mobile-chat-active');
    activePhone = ''; 
    document.getElementById('chatHeader').style.display = 'none';
    document.getElementById('inputArea').style.display = 'none';
    document.getElementById('lockOverlay').style.display = 'flex';
    loadLobby();
}

async function editCustomerName() {
    if(!activePhone) return;
    const currentName = document.getElementById('activeChatTitle').innerText;
    const newName = prompt("Enter customer's real name (e.g., John Doe - CAC):", currentName.includes("Client") ? "" : currentName);
    
    if(newName && newName.trim() !== "") {
        await fetch('/api/customers/name', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ phone: activePhone, name: newName.trim() })
        });
        document.getElementById('activeChatTitle').innerText = newName.trim();
        loadLobby();
    }
}

function updateChatControls() {
    const controls = document.getElementById('chatControls'); 
    const inputArea = document.getElementById('inputArea');
    
    // The Template Override Button (Visible whenever we own the chat)
    const overrideBtnHTML = `<button class="action-btn" style="background: #FF9800; color: white;" onclick="sendTemplateOverride()" title="Send 24h Template Alert">🔔 Alert</button>`;

    if (activeCustomerStatus === 'closed') { 
        controls.innerHTML = `<span style="color: #666; font-size: 0.9rem; background: #eee; padding: 4px 8px; border-radius: 4px;">📁 Archived</span>`; 
        inputArea.style.display = 'none'; 
    } 
    else if (activeCustomerStatus === 'open') { 
        controls.innerHTML = `<button class="action-btn claim-btn" onclick="updateCustomerStatus('assigned', '${currentStaff}')">✋ Attend</button>`; 
        inputArea.style.display = 'none'; 
    } 
    else if (activeCustomerStatus === 'assigned' && activeCustomerOwner === currentStaff) { 
        controls.innerHTML = `${overrideBtnHTML} <button class="action-btn close-btn" onclick="updateCustomerStatus('closed', '${currentStaff}')">✅ Complete</button>`; 
        inputArea.style.display = 'flex'; 
    } 
    else if (activeCustomerStatus === 'assigned' && activeCustomerOwner !== currentStaff) {
        if (currentRole === 'admin') { 
            controls.innerHTML = `<span style="color: #d32f2f; font-weight: bold; background: white; padding: 4px 8px; border-radius: 4px;">👀 Spy Mode</span>`; 
            inputArea.style.display = 'flex'; 
        } 
        else { 
            controls.innerHTML = `<span style="color: #666; font-size: 0.9rem;">🔒 Handled by ${activeCustomerOwner}</span>`; 
            inputArea.style.display = 'none'; 
        }
    }
}

// NEW: The function that fires the template
async function sendTemplateOverride() {
    if(!activePhone) return;
    
    // We ask the staff which template they want to send. 
    // "hello_world" is a default template Meta gives every business to test with.
    const templateName = prompt("Enter the official Meta Template Name to send (e.g., hello_world):", "hello_world");
    
    if(templateName && templateName.trim() !== "") {
        try {
            await fetch('/api/send-template', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    to: activePhone, 
                    staff_username: currentStaff,
                    template_name: templateName.trim()
                })
            });
            alert("Official Alert Sent!");
            loadMessages(); // Refresh chat to show the log
        } catch (e) {
            alert("Failed to send alert. Check server logs.");
        }
    }
}

async function updateCustomerStatus(newStatus, assignedTo) {
    await fetch('/api/customers/update', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ phone: activePhone, status: newStatus, assigned_to: assignedTo }) });
    activeCustomerStatus = newStatus; activeCustomerOwner = assignedTo;
    
    if (newStatus === 'closed') { 
        // If closed on mobile, automatically slide back to the lobby
        if (window.innerWidth <= 768) {
            closeMobileChat();
        } else {
            activePhone = ''; document.getElementById('lockOverlay').style.display = 'flex'; document.getElementById('chatHeader').style.display = 'none'; document.getElementById('inputArea').style.display = 'none'; document.getElementById('chatBox').innerHTML = ''; 
        }
    } else { updateChatControls(); }
    loadLobby();
}

async function loadMessages() {
    if(!activePhone) return;
    try {
        const res = await fetch(`/api/messages/${activePhone}`); const messages = await res.json();
        const box = document.getElementById('chatBox'); box.innerHTML = '';
        messages.forEach(msg => {
            const div = document.createElement('div'); div.className = 'msg ' + msg.direction;
            let content = msg.message_body || '';
            if (msg.media_type === 'image') {
                content = `<img src="/api/media/${msg.media_id}"> <br> ${content}`;
            } else if (msg.media_type === 'document') {
                content = `<div style="background: rgba(0,0,0,0.05); padding: 10px; border-radius: 6px; margin-bottom: 5px;">📄 <a href="/api/media/${msg.media_id}" target="_blank" style="color: #1E7C98; text-decoration: none; font-weight: bold;">Download Attached Document</a></div> ${content}`;
            }
            
            let senderInfo = msg.direction === 'outgoing' ? `<div style="font-size: 0.7rem; color: #888; text-align: right; margin-top: 5px;">Sent by: ${msg.staff_username || 'System'}</div>` : '';
            div.innerHTML = `${content} ${senderInfo}`; box.appendChild(div);
        });
        box.scrollTop = box.scrollHeight;
        if (messages.length > previousMsgCount && previousMsgCount !== 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.direction === 'incoming') { playBeep(); sendPushNotification("New Message", lastMsg.message_body || "New file received"); }
        }
        previousMsgCount = messages.length;
    } catch (error) {}
}

function insertQuickReply() {
    const select = document.getElementById('quickReplies');
    const input = document.getElementById('msgInput');
    if (select.value) {
        input.value = select.value;
        select.value = ''; 
        input.focus(); 
    }
}

function updateFileInputUI() {
    const file = document.getElementById('fileInput').files[0];
    const input = document.getElementById('msgInput');
    if (file) {
        input.placeholder = `📎 ${file.name} selected. Type a caption...`;
    } else {
        input.placeholder = "Type a message...";
    }
}

async function sendMessage() {
    const text = document.getElementById('msgInput').value.trim(); const fileInput = document.getElementById('fileInput'); const file = fileInput.files[0];
    if(!activePhone) return; if(!text && !file) return;

    document.getElementById('msgInput').value = 'Sending...';
    const formData = new FormData();
    formData.append('to', activePhone); formData.append('message', text); formData.append('staff_username', currentStaff);
    if (file) formData.append('file', file);

    await fetch('/send-reply', { method: 'POST', body: formData });
    
    document.getElementById('msgInput').value = ''; 
    fileInput.value = '';
    updateFileInputUI(); 
    loadMessages();
}

setInterval(() => {
    if (document.getElementById('dashboardScreen').style.display === 'flex') {
        checkSecurityAlerts();
        if (document.getElementById('adminPanel').style.display !== 'block') { loadLobby(); if (activePhone) loadMessages(); }
    }
}, 4000);

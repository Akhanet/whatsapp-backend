require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Serve Dashboard
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 2. NEW: Secure Login API
app.post('/api/login', async (req, res) => {
    const { username, passcode } = req.body;
    const { data, error } = await supabase
        .from('staff')
        .select('*')
        .eq('username', username)
        .eq('passcode', passcode)
        .single();
        
    if (data) {
        res.json({ success: true, role: data.role, username: data.username });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// 3. Fetch Messages (Filtered by Customer)
app.get('/api/messages/:phone', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('sender_phone', req.params.phone)
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// 4. Secure Media Downloader
app.get('/api/media/:mediaId', async (req, res) => {
    try {
        const metaResponse = await axios.get(`https://graph.facebook.com/v18.0/${req.params.mediaId}`, { headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        const mediaStream = await axios.get(metaResponse.data.url, { responseType: 'stream', headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        res.setHeader('Content-Type', metaResponse.data.mime_type);
        mediaStream.data.pipe(res);
    } catch (error) { res.status(404).send('Media not found'); }
});

// 5. Webhook Verification
app.get('/webhook', (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

// 6. UPDATED: Catch Messages & Manage the Lobby
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const msgData = body.entry[0].changes[0].value.messages[0];
            let from = msgData.from;
            let msg_body = '', media_id = null, media_type = null;

            if (msgData.type === 'text') { msg_body = msgData.text.body; } 
            else if (msgData.type === 'image') { media_id = msgData.image.id; media_type = 'image'; } 
            else if (msgData.type === 'document') { media_id = msgData.document.id; media_type = 'document'; msg_body = msgData.document.filename || 'Document'; }

            // Save the actual message
            await supabase.from('messages').insert([{ sender_phone: from, message_body: msg_body, direction: 'incoming', media_id, media_type }]);

            // Customer Lobby Logic
            const { data: existingCustomer } = await supabase.from('customers').select('*').eq('phone_number', from).single();
            if (!existingCustomer) {
                // Brand new customer -> put in open lobby
                await supabase.from('customers').insert([{ phone_number: from, status: 'open' }]);
            } else if (existingCustomer.status === 'closed') {
                // Returning customer -> reopen chat and send back to lobby
                await supabase.from('customers').update({ status: 'open', assigned_to: null, last_messaged_at: new Date() }).eq('phone_number', from);
            } else {
                // Active chat -> just update the timestamp so it jumps to top
                await supabase.from('customers').update({ last_messaged_at: new Date() }).eq('phone_number', from);
            }
        }
        res.sendStatus(200);
    } else { res.sendStatus(404); }
});

// 7. Send Replies (Includes tracking the staff member)
app.post('/send-reply', upload.single('file'), async (req, res) => {
    const { to, message, staff_username } = req.body;
    const file = req.file;

    try {
        let mediaId = null;
        let mediaType = null;
        let payload = { messaging_product: "whatsapp", to: to };

        if (file) {
            const form = new FormData();
            form.append('messaging_product', 'whatsapp');
            form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });

            const uploadRes = await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/media`, form, {
                headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` }
            });
            
            mediaId = uploadRes.data.id;
            mediaType = file.mimetype.startsWith('image/') ? 'image' : 'document';
            payload.type = mediaType;
            payload[mediaType] = { id: mediaId };
            if (message && message.trim() !== '') payload[mediaType].caption = message;
        } else {
            payload.type = "text";
            payload.text = { body: message };
        }

        await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, payload, {
            headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`, 'Content-Type': 'application/json' }
        });

        await supabase.from('messages').insert([{ 
            sender_phone: to, message_body: message || file.originalname, direction: 'outgoing', media_id: mediaId, media_type: mediaType, staff_username: staff_username 
        }]);

        res.status(200).json({ success: true });
    } catch (error) { res.status(500).json({ error: 'Failed to send' }); }
});
// 8. Fetch the Lobby List (Sorted by newest message)
app.get('/api/customers', async (req, res) => {
    const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('last_messaged_at', { ascending: false });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// 9. Claim a Chat or Close a Deal
app.post('/api/customers/update', async (req, res) => {
    const { phone, status, assigned_to } = req.body;
    
    // Update the customer's status in the database
    const updateData = { status: status };
    if (assigned_to !== undefined) updateData.assigned_to = assigned_to;
    await supabase.from('customers').update(updateData).eq('phone_number', phone);

    // If a staff member clicks "Close Deal", add +1 to their payroll tracker
    if (status === 'closed' && assigned_to) {
        const { data: staffData } = await supabase.from('staff').select('deals_closed').eq('username', assigned_to).single();
        if (staffData) {
            await supabase.from('staff').update({ deals_closed: staffData.deals_closed + 1 }).eq('username', assigned_to);
        }
    }
    res.json({ success: true });
});
// 10. Admin Only: Fetch Payroll & Performance Stats
app.get('/api/admin/staff', async (req, res) => {
    const { data, error } = await supabase
        .from('staff')
        .select('username, role, deals_closed')
        .order('deals_closed', { ascending: false });
    if (error) return res.status(500).json(error);
    res.json(data);
});
// 11. Admin Only: Fetch Closed Chats (Archive)
app.get('/api/admin/archive', async (req, res) => {
    const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('status', 'closed')
        .order('last_messaged_at', { ascending: false });
    if (error) return res.status(500).json(error);
    res.json(data);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });

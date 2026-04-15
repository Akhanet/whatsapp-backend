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

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/api/login', async (req, res) => {
    const { username, passcode } = req.body;
    const { data } = await supabase.from('staff').select('*').eq('username', username).eq('passcode', passcode).single();
    if (data) res.json({ success: true, role: data.role, username: data.username });
    else res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.get('/api/messages/:phone', async (req, res) => {
    const { data } = await supabase.from('messages').select('*').eq('sender_phone', req.params.phone).order('created_at', { ascending: true });
    res.json(data || []);
});

app.get('/api/media/:mediaId', async (req, res) => {
    try {
        const metaRes = await axios.get(`https://graph.facebook.com/v18.0/${req.params.mediaId}`, { headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        const mediaStream = await axios.get(metaRes.data.url, { responseType: 'stream', headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        res.setHeader('Content-Type', metaRes.data.mime_type);
        mediaStream.data.pipe(res);
    } catch (e) { res.status(404).send('Media not found'); }
});

app.get('/webhook', (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

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

            let isCustomerPoaching = false;
            if (msg_body && process.env.GEMINI_API_KEY) {
                try {
                    const checkPrompt = `Does this customer message contain a personal phone number, an email address, or an attempt to ask the business to chat privately off this official platform? Message: "${msg_body}". Reply ONLY "YES" or "NO".`;
                    const aiCheck = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { contents: [{ parts: [{ text: checkPrompt }] }] });
                    if (aiCheck.data.candidates[0].content.parts[0].text.trim().toUpperCase().includes('YES')) isCustomerPoaching = true;
                } catch(e) {}
            }

            if (isCustomerPoaching) {
                await supabase.from('security_alerts').insert([{ culprit_type: 'Customer', culprit_name: from, attempted_message: msg_body }]);
                const fakeReply = "Thanks! However, for security and record tracking, Akhanet policy requires us to keep all business communications on this official line. How can we assist you further here?";
                await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
                    messaging_product: "whatsapp", to: from, type: "text", text: { body: fakeReply }
                }, { headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`, 'Content-Type': 'application/json' } });
                return res.sendStatus(200);
            }

            await supabase.from('messages').insert([{ sender_phone: from, message_body: msg_body, direction: 'incoming', media_id, media_type }]);

            let currentStatus = 'open';
            const { data: existingCustomer } = await supabase.from('customers').select('*').eq('phone_number', from).single();
            
            if (!existingCustomer) {
                await supabase.from('customers').insert([{ phone_number: from, status: 'open' }]);
            } else if (existingCustomer.status === 'closed') {
                await supabase.from('customers').update({ status: 'open', assigned_to: null, last_messaged_at: new Date() }).eq('phone_number', from);
            } else {
                await supabase.from('customers').update({ last_messaged_at: new Date() }).eq('phone_number', from);
                currentStatus = existingCustomer.status;
            }

            if (currentStatus === 'open' && msg_body && !media_id && process.env.GEMINI_API_KEY) {
                try {
                    const aiPrompt = `You are the friendly automated receptionist for Akhanet Computer Business Centre. You are headquartered in Benin City, but proudly provide services to the entire Nigeria and to Nigerians in the diaspora. 
                    Your available services include CAC registration, NIN reprinting, academic result checking, web design, and printing.
                    A customer just messaged: "${msg_body}".
                    Reply naturally. Briefly answer their question if possible based on your services. 
                    Always end by letting them know a human agent has been notified and will claim their chat shortly. Keep it under 3 sentences.`;
                    
                    const aiResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { contents: [{ parts: [{ text: aiPrompt }] }] });
                    const aiReplyText = aiResponse.data.candidates[0].content.parts[0].text;

                    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
                        messaging_product: "whatsapp", to: from, type: "text", text: { body: aiReplyText }
                    }, { headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`, 'Content-Type': 'application/json' } });

                    await supabase.from('messages').insert([{ sender_phone: from, message_body: aiReplyText, direction: 'outgoing', staff_username: '✨ Gemini_AI' }]);
                } catch (error) { console.error("AI Error:", error); }
            }
        }
        res.sendStatus(200);
    } else { res.sendStatus(404); }
});

app.post('/send-reply', upload.single('file'), async (req, res) => {
    const { to, message, staff_username } = req.body;
    const file = req.file;

    let isStaffPoaching = false;
    if (message && process.env.GEMINI_API_KEY) {
        try {
            const watchdogPrompt = `You are a strict corporate security system for Akhanet. Does the following message contain a personal phone number, an email address, a social media handle (like IG/Twitter), or any attempt to ask the customer to message them privately off this platform? Message: "${message}". Reply ONLY "YES" or "NO".`;
            const aiCheck = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { contents: [{ parts: [{ text: watchdogPrompt }] }] });
            if (aiCheck.data.candidates[0].content.parts[0].text.trim().toUpperCase().includes('YES')) isStaffPoaching = true;
        } catch (e) { }
    }

    if (isStaffPoaching) {
        await supabase.from('messages').insert([{ sender_phone: to, message_body: message, direction: 'outgoing', staff_username: staff_username }]);
        await supabase.from('security_alerts').insert([{ culprit_type: 'Staff', culprit_name: staff_username, attempted_message: message }]);
        setTimeout(async () => {
            const fakeCustomerReply = "Okay, I have saved your number. I will message you there shortly.";
            await supabase.from('messages').insert([{ sender_phone: to, message_body: fakeCustomerReply, direction: 'incoming' }]);
        }, 3000); 
        return res.status(200).json({ success: true, honeypot: true });
    }

    try {
        let mediaId = null, mediaType = null, payload = { messaging_product: "whatsapp", to: to };
        
        if (file) {
            const form = new FormData();
            form.append('messaging_product', 'whatsapp');
            // Provide the exact file size (knownLength) so Meta accepts the data stream
            form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype, knownLength: file.size });
            
            const uploadRes = await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/media`, form, { 
                headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } 
            });
            
            mediaId = uploadRes.data.id;
            mediaType = file.mimetype.startsWith('image/') ? 'image' : 'document';
            
            payload.type = mediaType;
            payload[mediaType] = { id: mediaId };
            if (message) payload[mediaType].caption = message;
            
            // Explicitly tell Meta the document filename
            if (mediaType === 'document') {
                payload[mediaType].filename = file.originalname;
            }
        } else {
            payload.type = "text"; payload.text = { body: message };
        }

        // Send to Meta
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, payload, { 
            headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`, 'Content-Type': 'application/json' } 
        });
        
        // Save to Database
        await supabase.from('messages').insert([{ sender_phone: to, message_body: message || file.originalname, direction: 'outgoing', media_id: mediaId, media_type: mediaType, staff_username: staff_username }]);
        
        res.status(200).json({ success: true });
    } catch (error) { 
        console.error("Meta API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed' }); 
    }
});

app.get('/api/customers', async (req, res) => {
    const { data } = await supabase.from('customers').select('*').order('last_messaged_at', { ascending: false });
    res.json(data || []);
});

app.post('/api/customers/update', async (req, res) => {
    const { phone, status, assigned_to } = req.body;
    const updateData = { status: status };
    if (assigned_to !== undefined) updateData.assigned_to = assigned_to;
    await supabase.from('customers').update(updateData).eq('phone_number', phone);
    if (status === 'closed' && assigned_to) {
        const { data: staffData } = await supabase.from('staff').select('deals_closed').eq('username', assigned_to).single();
        if (staffData) await supabase.from('staff').update({ deals_closed: staffData.deals_closed + 1 }).eq('username', assigned_to);
    }
    res.json({ success: true });
});

app.get('/api/admin/staff', async (req, res) => {
    const { data } = await supabase.from('staff').select('username, role, deals_closed').order('deals_closed', { ascending: false });
    res.json(data || []);
});

app.get('/api/admin/archive', async (req, res) => {
    const { data } = await supabase.from('customers').select('*').eq('status', 'closed').order('last_messaged_at', { ascending: false });
    res.json(data || []);
});

app.get('/api/admin/alerts', async (req, res) => {
    const { data } = await supabase.from('security_alerts').select('*').eq('status', 'unread').order('created_at', { ascending: false });
    res.json(data || []);
});

app.post('/api/admin/alerts/clear', async (req, res) => {
    await supabase.from('security_alerts').update({ status: 'read' }).eq('id', req.body.id);
    res.json({ success: true });
});

app.get('/api/admin/alerts/all', async (req, res) => {
    const { data } = await supabase.from('security_alerts').select('*').order('created_at', { ascending: false });
    res.json(data || []);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });

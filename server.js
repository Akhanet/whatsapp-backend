require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
app.use(express.json());

// Set up memory storage for incoming file uploads from your staff
const upload = multer({ storage: multer.memoryStorage() });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Security Checkpoint
app.use((req, res, next) => {
    if (req.path === '/webhook') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Akhanet Workspace"');
        return res.status(401).send('Access Denied');
    }
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (auth[0] === 'akhanet' && auth[1] === process.env.TEAM_PASSWORD) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Akhanet Workspace"');
        return res.status(401).send('Access Denied');
    }
});

// 1. Serve Dashboard
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 2. Fetch Chat History
app.get('/api/messages', async (req, res) => {
    const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: true });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// 3. Secure Media Downloader (Incoming from customers)
app.get('/api/media/:mediaId', async (req, res) => {
    try {
        const metaResponse = await axios.get(`https://graph.facebook.com/v18.0/${req.params.mediaId}`, { headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        const mediaStream = await axios.get(metaResponse.data.url, { responseType: 'stream', headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` } });
        res.setHeader('Content-Type', metaResponse.data.mime_type);
        mediaStream.data.pipe(res);
    } catch (error) { res.status(404).send('Media not found'); }
});

// 4. Webhook Verification
app.get('/webhook', (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query["hub.challenge"]);
    } else { res.sendStatus(403); }
});

// 5. Catch Incoming Messages
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const msgData = body.entry[0].changes[0].value.messages[0];
            let from = msgData.from;
            let msg_body = '', media_id = null, media_type = null;

            if (msgData.type === 'text') { msg_body = msgData.text.body; } 
            else if (msgData.type === 'image') { media_id = msgData.image.id; media_type = 'image'; } 
            else if (msgData.type === 'document') { media_id = msgData.document.id; media_type = 'document'; msg_body = msgData.document.filename; }

            await supabase.from('messages').insert([{ sender_phone: from, message_body: msg_body, direction: 'incoming', media_id, media_type }]);
        }
        res.sendStatus(200);
    } else { res.sendStatus(404); }
});

// 6. NEW: Send Replies AND Media
app.post('/send-reply', upload.single('file'), async (req, res) => {
    const { to, message } = req.body;
    const file = req.file;

    try {
        let mediaId = null;
        let mediaType = null;
        let payload = { messaging_product: "whatsapp", to: to };

        // If a staff member attached a file, upload it to Meta first
        if (file) {
            const form = new FormData();
            form.append('messaging_product', 'whatsapp');
            form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });

            const uploadRes = await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/media`, form, {
                headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` }
            });
            
            mediaId = uploadRes.data.id;
            mediaType = file.mimetype.startsWith('image/') ? 'image' : 'document';

            // Attach the file ID and use the text message as a caption
            payload.type = mediaType;
            payload[mediaType] = { id: mediaId };
            if (message && message.trim() !== '') {
                payload[mediaType].caption = message;
            }
        } else {
            // Just a standard text message
            payload.type = "text";
            payload.text = { body: message };
        }

        // Send to WhatsApp API
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, payload, {
            headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`, 'Content-Type': 'application/json' }
        });

        // Save record to database
        await supabase.from('messages').insert([{ 
            sender_phone: to, 
            message_body: message || file.originalname, 
            direction: 'outgoing',
            media_id: mediaId,
            media_type: mediaType
        }]);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Send error:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });

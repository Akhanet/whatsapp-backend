require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Serve Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Fetch Chat History
app.get('/api/messages', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// 3. NEW: Secure Media Downloader
app.get('/api/media/:mediaId', async (req, res) => {
    try {
        // Ask Meta for the temporary download URL
        const metaResponse = await axios.get(`https://graph.facebook.com/v18.0/${req.params.mediaId}`, {
            headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` }
        });
        
        // Download the actual file bytes
        const mediaStream = await axios.get(metaResponse.data.url, {
            responseType: 'stream',
            headers: { Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}` }
        });
        
        // Stream the file directly to your team's dashboard
        res.setHeader('Content-Type', metaResponse.data.mime_type);
        mediaStream.data.pipe(res);
    } catch (error) {
        console.error('Media fetch error:', error);
        res.status(404).send('Media not found');
    }
});

// 4. Webhook Verification
app.get('/webhook', (req, res) => {
    const verify_token = process.env.VERIFY_TOKEN;
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verify_token) {
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
});

// 5. UPDATED: Catch Texts, Images, and Documents
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const messageData = body.entry[0].changes[0].value.messages[0];
            let from = messageData.from;
            
            let msg_body = '';
            let media_id = null;
            let media_type = null;

            if (messageData.type === 'text') {
                msg_body = messageData.text.body;
            } else if (messageData.type === 'image') {
                media_id = messageData.image.id;
                media_type = 'image';
            } else if (messageData.type === 'document') {
                media_id = messageData.document.id;
                media_type = 'document';
                msg_body = messageData.document.filename || 'Document';
            } else {
                msg_body = `[Received file type: ${messageData.type}]`;
            }

            await supabase.from('messages').insert([
                { 
                    sender_phone: from, 
                    message_body: msg_body, 
                    direction: 'incoming',
                    media_id: media_id,
                    media_type: media_type
                }
            ]);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// 6. Send Replies
app.post('/send-reply', async (req, res) => {
    const { to, message } = req.body;
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
            headers: {
                Authorization: `Bearer ${process.env.META_PERMANENT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: "whatsapp",
                to: to,
                type: "text",
                text: { body: message }
            }
        });

        await supabase.from('messages').insert([
            { sender_phone: to, message_body: message, direction: 'outgoing' }
        ]);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('API Error:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

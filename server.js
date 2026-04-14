require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());

// Connect to your Database
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Serve the Visual Dashboard to your team
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. API to feed chat history to the Dashboard
app.get('/api/messages', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json(error);
    res.json(data);
});

// 3. Webhook Verification (Keep Meta happy)
app.get('/webhook', (req, res) => {
    const verify_token = process.env.VERIFY_TOKEN;
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verify_token) {
        res.status(200).send(req.query["hub.challenge"]);
    } else {
        res.sendStatus(403);
    }
});

// 4. Catch Incoming Messages from Customers
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            let from = body.entry[0].changes[0].value.messages[0].from;
            let msg_body = body.entry[0].changes[0].value.messages[0].text.body;

            await supabase.from('messages').insert([
                { sender_phone: from, message_body: msg_body, direction: 'incoming' }
            ]);
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// 5. Send Team Replies back to the Customer
app.post('/send-reply', async (req, res) => {
    const { to, message } = req.body;
    try {
        // Push the text to the WhatsApp API
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

        // Save the team's reply in the database
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

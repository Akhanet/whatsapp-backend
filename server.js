require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// 1. Connect to your Supabase Database
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Webhook Verification (Meta requires this to connect)
app.get('/webhook', (req, res) => {
    const verify_token = process.env.VERIFY_TOKEN;

    let mode = req.query["hub.mode"];
    let token = req.query["hub.verify_token"];
    let challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === verify_token) {
            console.log("WEBHOOK_VERIFIED");
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 3. Receive Incoming WhatsApp Messages
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        if (
            body.entry && 
            body.entry[0].changes && 
            body.entry[0].changes[0].value.messages && 
            body.entry[0].changes[0].value.messages[0]
        ) {
            let from = body.entry[0].changes[0].value.messages[0].from; // The customer's phone number
            let msg_body = body.entry[0].changes[0].value.messages[0].text.body; // What they typed

            console.log(`New message from ${from}: ${msg_body}`);

            // 4. Save the message directly to Supabase
            const { data, error } = await supabase
                .from('messages')
                .insert([
                    { sender_phone: from, message_body: msg_body, direction: 'incoming' }
                ]);

            if (error) {
                console.error('Error saving to database:', error);
            } else {
                console.log('Message saved to Supabase!');
            }
        }
        res.sendStatus(200); // Always tell Meta you received it, otherwise they keep sending it
    } else {
        res.sendStatus(404);
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running and listening on port ${PORT}`);
});

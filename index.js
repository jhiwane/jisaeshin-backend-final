const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');

// Import Handler
const notifyHandler = require('./api/notify');
const midtransWebhookHandler = require('./api/midtrans-webhook');
const telegramHandler = require('./api/telegram-webhook');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // PENTING untuk Midtrans

// Konfigurasi Midtrans SNAP
const snap = new midtransClient.Snap({
    isProduction: true,
    serverKey: process.env.MIDTRANS_SERVER_KEY
});

app.get('/', (req, res) => res.send('Jisaeshin Backend Online ✅'));

// ENDPOINT TOKEN MIDTRANS
app.post('/api/token', async (req, res) => {
    try {
        const { order_id, total, items } = req.body;
        
        const parameter = {
            transaction_details: {
                order_id: order_id || "TRX-" + Date.now(),
                gross_amount: parseInt(total)
            },
            item_details: items.map(item => ({
                id: item.id || Math.random().toString(36).substring(7),
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name ? item.name.substring(0, 50) : "Item"
            }))
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) {
        console.error("Midtrans Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- RUTE WEBHOOK (DIPERBAIKI) ---
// 1. Jalur untuk Frontend (Manual/Saldo)
app.post('/api/notify', notifyHandler);

// 2. Jalur untuk Midtrans (Perbaikan URL Not Found)
app.post('/api/notification', midtransWebhookHandler);

// 3. Jalur untuk Bot Telegram (Reply Button)
app.post('/api/telegram-webhook', telegramHandler);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

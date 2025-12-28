const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');

// Import handler modular
const notifyHandler = require('./api/notify');
const midtransWebhookHandler = require('./api/midtrans-webhook');
const telegramHandler = require('./api/telegram-webhook');

const app = express();
// Railway biasanya menggunakan port yang diberikan secara dinamis
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(bodyParser.json());

// Middleware sederhana untuk melihat log request di Railway
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] ${req.method} ${req.url}`);
    next();
});

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
                name: item.name.substring(0, 50)
            }))
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) {
        console.error("Midtrans Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Jalur Webhook & Notify (Disederhanakan)
app.post('/api/notify', notifyHandler);
app.post('/api/midtrans-webhook', midtransWebhookHandler);
app.post('/api/telegram-webhook', telegramHandler);

// '0.0.0.0' sangat penting agar Railway bisa menghubungkan traffic luar ke dalam container
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server Jisaeshin running on port ${PORT}`);
});

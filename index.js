const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');

// Import handler dari folder api
const notifyHandler = require('./api/notify');
const midtransWebhookHandler = require('./api/midtrans-webhook');
const telegramHandler = require('./api/telegram-webhook');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(bodyParser.json());

// --- RUTE TEST (UNTUK MEMASTIKAN SERVER UPDATE) ---
app.get('/test-midtrans', async (req, res) => {
    res.json({ status: "SERVER SUDAH TERUPDATE!", message: "Jika kamu melihat ini, rute sudah aktif kawan!" });
});

app.get('/', (req, res) => {
    res.send('Jisaeshin Backend Utama Aktif!');
});

// --- RUTE API TOKEN (KUNCI PEMBAYARAN) ---
app.post('/api/token', async (req, res) => {
    // Logika pembuatan token Midtrans (Copy dari kode sebelumnya)
    try {
        const snap = new midtransClient.Snap({
            isProduction: true,
            serverKey: 'Mid-client-TayUBwSvTzcr6nwS'
        });
        const parameter = {
            transaction_details: { order_id: "T-" + Date.now(), gross_amount: req.body.total },
            item_details: req.body.items
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MENERUSKAN KE FOLDER API ---
app.post('/api/notify', (req, res) => notifyHandler(req, res));
app.post('/api/midtrans-webhook', (req, res) => midtransWebhookHandler(req, res));
app.post('/api/telegram-webhook', (req, res) => telegramHandler(req, res));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

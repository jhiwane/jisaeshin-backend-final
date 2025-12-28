const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const midtransClient = require('midtrans-client');

// --- INISIALISASI APP ---
const app = express();
// PENTING: Gunakan PORT dari Environment Variable Koyeb
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- HEALTH CHECK (Agar Koyeb Tahu Server Hidup) ---
app.get('/', (req, res) => {
    res.status(200).send('Jisaeshin Backend is Running! 🚀');
});

// --- IMPORT MODULES DENGAN AMAN ---
try {
    // Pastikan folder 'api' ada dan nama file BENAR (huruf kecil/besar berpengaruh!)
    const notifyHandler = require('./api/notify');
    const midtransWebhookHandler = require('./api/midtrans-webhook');
    // Jika telegram-webhook belum ada, jangan di-require dulu atau comment saja
    // const telegramHandler = require('./api/telegram-webhook'); 

    // ROUTE
    app.post('/api/notify', notifyHandler);
    app.post('/api/notification', midtransWebhookHandler);
    // app.post('/api/telegram-webhook', telegramHandler);

    console.log("✅ Modules Loaded Successfully");
} catch (error) {
    console.error("❌ CRITICAL ERROR LOADING MODULES:", error.message);
    // Jangan crash, biarkan server tetap nyala supaya bisa cek log
}

// --- MIDTRANS TOKEN ---
const snap = new midtransClient.Snap({
    isProduction: true,
    serverKey: process.env.MIDTRANS_SERVER_KEY || "MASUKKAN-KEY-DI-ENV-KOYEB"
});

app.post('/api/token', async (req, res) => {
    try {
        const { order_id, total, items } = req.body;
        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            item_details: items
        };
        const transaction = await snap.createTransaction(parameter);
        res.json({ token: transaction.token });
    } catch (e) {
        console.error("Midtrans Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- JALANKAN SERVER ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

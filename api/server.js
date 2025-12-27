const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');

// Import file logic kamu yang sudah ada
const notifyRoute = require('./notify');
const midtransWebhook = require('./midtrans-webhook');
const telegramWebhook = require('./telegram-webhook');

const app = express();
app.use(cors());
app.use(express.json());

// --- KONFIGURASI MIDTRANS PRODUCTION ---
// Pastikan Server Key di sini adalah "Mid-server-..." (bukan SB-Mid-...)
const snap = new midtransClient.Snap({
    isProduction: true, // <--- WAJIB TRUE UNTUK PRODUCTION
    serverKey: process.env.MIDTRANS_SERVER_KEY || 'Mid-server-KUNCI_RAHASIA_KAMU'
});

// --- ROUTE 1: BUAT TOKEN (Dipanggil App.jsx saat Checkout Auto) ---
app.post('/api/token', async (req, res) => {
    try {
        const { order_id, total, items, customer } = req.body;

        // Parameter standar Midtrans
        let parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            item_details: items, // Item dikirim agar muncul di email Midtrans user
            customer_details: {
                first_name: customer?.name || "Guest",
                phone: customer?.phone || "08123456789"
            }
        };

        const token = await snap.createTransaction(parameter);
        res.json({ token: token.token });
    } catch (e) {
        console.error("Midtrans Token Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTE 2: NOTIFIKASI DARI FRONTEND (Manual & Saldo) ---
app.post('/api/notify', notifyRoute);

// --- ROUTE 3: WEBHOOK DARI MIDTRANS (Saat user bayar QRIS/VA) ---
app.post('/api/midtrans-webhook', midtransWebhook);

// --- ROUTE 4: WEBHOOK DARI TELEGRAM (Saat Admin klik ACC/Tolak) ---
// Pastikan kamu sudah set webhook di Telegram API ke url ini
app.post('/api/telegram-webhook', telegramWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; 

// --- HELPER: HITUNG JUMLAH PENDING ---
async function getPendingStats() {
    try {
        // Hitung semua status yang 'gantung'
        const snap = await db.collection('orders')
            .where('status', 'in', ['pending', 'manual_verification', 'process', 'manual_pending'])
            .get();
        return snap.size;
    } catch (e) { return 0; }
}

function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 20; 
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        displayItems.forEach((i, index) => {
            const safeName = (i.name || 'Item').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? ` <i>(${i.note})</i>` : '';
            itemsDetail += `${index+1}. <b>${safeName}</b> (x${i.qty})${safeNote}\n`;
        });
        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\n📦 <i>...dan ${items.length - MAX_DISPLAY} item lainnya</i>\n`;
        }
    }
    return itemsDetail;
}

module.exports = async function(req, res) {
    const payload = req.body;
    const orderId = payload.order_id || payload.orderId;
    const type = payload.type; 
    const statusMidtrans = payload.transaction_status; 
    const statusPayload = payload.status; 

    try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) return res.status(200).send('Order not found yet');

        const orderFromDb = orderSnap.data();
        const finalItems = orderFromDb.items || payload.items || [];
        const itemsDetail = buildItemsListSafe(finalItems);
        const totalHarga = parseInt(payload.total || orderFromDb.total || 0).toLocaleString();

        // --- AMBIL KONTAK DARI DATABASE (AGAR AKURAT) ---
        // Prioritas: Database > Payload > Default
        const displayContact = orderFromDb.buyerContact || payload.buyerContact || "Guest (No Data)";

        // --- HITUNG PENDING UNTUK FOOTER ---
        const pendingCount = await getPendingStats();
        const pendingIcon = pendingCount > 0 ? `⭕ ${pendingCount} Pending` : `✅ 0 Pending`;
        
        // --- BUTTON COMMON (TOMBOL STANDAR) ---
        // Tombol ini akan muncul di bawah semua notifikasi untuk cek pendingan
        const commonKeyboard = [
            [{ text: `📂 Cek Antrian (${pendingIcon})`, callback_data: 'CHECK_PENDING' }]
        ];

        // 1. PEMBAYARAN MANUAL
        if (type === 'manual') {
            const text = `💸 <b>PEMBAYARAN MANUAL</b>\n` +
                         `🆔 <code>${orderId}</code>\n` +
                         `👤 ${displayContact}\n` +
                         `💰 Rp ${totalHarga}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n` +
                         `👇 <i>Cek mutasi, lalu klik ACC:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ ACC TERIMA", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }],
                        ...commonKeyboard // Sertakan info pending di bawah
                    ]
                }
            });
        } 
        
        // 2. SUKSES (OTOMATIS / SALDO / MIDTRANS)
        else if (statusMidtrans === 'settlement' || statusMidtrans === 'capture' || type === 'otomatis' || type === 'saldo' || statusPayload === 'success') {
            // Coba proses stok
            const result = await processOrderStock(orderId);
            
            // Jika stok aman, kirim notif sukses simpel
            if (result.success) {
                const text = `✅ <b>ORDER SUKSES (${type === 'saldo' ? 'SALDO' : 'MIDTRANS'})</b>\n` +
                             `🆔 <code>${orderId}</code>\n` +
                             `👤 ${displayContact}\n` +
                             `💰 Rp ${totalHarga}\n\n` +
                             `<i>Stok otomatis terkirim ke web user.</i>\n\n` +
                             `----------------\nSTATUS TOKO: ${pendingIcon}`;
                
                await sendMessage(ADMIN_CHAT_ID, text); // Tidak perlu tombol jika sukses, cukup info text
            } 
            // Jika stok kosong, lapor admin
            else {
                const alertMsg = `⚠️ <b>STOK KOSONG (BUTUH MANUAL)</b>\n` +
                                 `🆔 <code>${orderId}</code>\n` +
                                 `👤 ${displayContact}\n` +
                                 `<i>Status Paid, tapi stok habis. Input manual sekarang.</i>`;
                
                await sendMessage(ADMIN_CHAT_ID, alertMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🛠 Isi Data Manual", callback_data: `RESOLVE_${orderId}` }],
                            ...commonKeyboard
                        ]
                    }
                });
            }
        }

        // 3. MANUAL VERIFICATION (ERROR/MACET)
        else if (type === 'manual_verification' || orderFromDb.status === 'manual_verification') {
             const alertMsg = `🔴 <b>BUTUH VERIFIKASI MANUAL!</b>\nOrder ID: <code>${orderId}</code>\nAda masalah sistem/stok. Cek segera.`;
             await sendMessage(ADMIN_CHAT_ID, alertMsg, { reply_markup: { inline_keyboard: commonKeyboard } });
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        res.status(200).send('Error handled');
    }
};

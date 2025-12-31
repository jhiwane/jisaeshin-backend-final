const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { sendRealtimeDashboard } = require('./adminRealtime');

const ADMIN_CHAT_ID = '1383656187'; 

// --- FUNGSI PEMOTONG TEKS PINTAR (AGAR TIDAK ERROR SAAT ORDER BANYAK) ---
function buildItemsListSafe(items) {
    let itemsDetail = "";
    // Kita batasi tampilan detail maksimal 20 item agar tidak kena limit Telegram
    // Sisa item akan diringkas.
    const MAX_DISPLAY = 20; 
    
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        
        displayItems.forEach((i, index) => {
            // Bersihkan karakter aneh yg bikin error HTML Telegram
            const safeName = (i.name || 'Item').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? ` <i>(${i.note})</i>` : '';
            
            // Format lebih ringkas: [1] Nama Barang (Qty)
            itemsDetail += `${index+1}. <b>${safeName}</b> (x${i.qty})${safeNote}\n`;
        });

        if (items.length > MAX_DISPLAY) {
            const sisa = items.length - MAX_DISPLAY;
            itemsDetail += `\n📦 <i>...dan <b>${sisa} item lainnya</b> (Cek Web Admin untuk detail penuh)</i>\n`;
        }
    }
    return itemsDetail;
}

// --- FUNGSI KIRIM PESAN AMAN (ANTI ERROR 400) ---
async function safeTelegramSend(chatId, text, options = {}) {
    try {
        await sendMessage(chatId, text, options);
    } catch (error) {
        console.error("GAGAL KIRIM TELEGRAM (Mungkin teks kepanjangan):", error.message);
        // Jika gagal karena kepanjangan, kirim pesan pendek
        try {
            await sendMessage(chatId, "⚠️ <b>NOTIFIKASI ORDER BANYAK</b>\n\nData terlalu panjang untuk Telegram.\nSilakan cek langsung di Website/Aplikasi Admin.");
        } catch (e) {}
    }
}

module.exports = async function(req, res) {
    const payload = req.body;
    
    // Log di Railway agar ketahuan kalau ada request masuk
    console.log(`[NOTIFY] Masuk: Order ${payload.order_id || payload.orderId} | Type: ${payload.type}`);

    // Normalisasi Data
    const orderId = payload.order_id || payload.orderId;
    const type = payload.type; // manual, otomatis, saldo, complaint
    const statusMidtrans = payload.transaction_status; 
    const statusPayload = payload.status; 

    try {
        // 1. CEK DATABASE (SUMBER KEBENARAN)
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        // Jika order belum masuk DB, tetap respon OK agar frontend tidak error
        if (!orderSnap.exists) {
            console.log(`[NOTIFY] Order ${orderId} tidak ditemukan di DB.`);
            return res.status(200).send('Order not found yet');
        }

        const orderFromDb = orderSnap.data();
        // Gabungkan item dari payload atau DB
        const finalItems = orderFromDb.items || payload.items || [];
        const itemsDetail = buildItemsListSafe(finalItems);
        const totalHarga = parseInt(payload.total || orderFromDb.total || 0).toLocaleString();

        // =================================================================
        // LOGIKA PENANGANAN STATUS
        // =================================================================

        // KASUS A: PEMBAYARAN MANUAL (Tamu/Member Klik "Saya Sudah Bayar")
        if (type === 'manual') {
            const displayContact = payload.buyerContact ? `<code>${payload.buyerContact}</code>` : 'Guest';
            const text = `💸 <b>PEMBAYARAN MANUAL (TRANSFER)</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Rp ${totalHarga}\n` +
                         `👤 ${displayContact}\n` +
                         `📦 Total Item: ${finalItems.length} pcs\n\n` +
                         `📝 <b>Daftar Barang:</b>\n${itemsDetail}`;

            await safeTelegramSend(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
            await sendRealtimeDashboard(ADMIN_CHAT_ID, "🔔 <i>Segera cek mutasi rekening!</i>");
        } 
        
        // KASUS B: KOMPLAIN
        else if (type === 'complaint') {
             const complaintMsg = (payload.message || "-").replace(/&/g, '&amp;').replace(/</g, '&lt;');
             const text = `⚠️ <b>KOMPLAIN BARU</b>\n🆔 <code>${orderId}</code>\n💬 <pre>${complaintMsg}</pre>\n\n🛒 ${itemsDetail}`;
            
             await safeTelegramSend(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "📩 BALAS PESAN", callback_data: `REPLY_CS_${orderId}` }]]
                }
             });
             await sendRealtimeDashboard(ADMIN_CHAT_ID, "ℹ️ <i>Status dashboard:</i>");
        }

        // KASUS C: SUKSES / LUNAS 
        // Mencakup: Midtrans Settlement, Pembayaran SALDO, atau Type Otomatis
        else if (
            statusMidtrans === 'settlement' || 
            statusMidtrans === 'capture' || 
            type === 'otomatis' || 
            type === 'saldo' ||   // <--- PENTING: Bayar pakai saldo masuk sini
            statusPayload === 'success'
        ) {
            console.log(`[NOTIFY] Memproses Stok untuk ${orderId}`);
            
            // Proses Stok Otomatis
            const result = await processOrderStock(orderId);
            
            // Kirim Notif Sukses
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, type === 'saldo' ? "SALDO MEMBER" : "OTOMATIS");

            // Cek apakah stok lengkap atau ada yang kosong
            if (!result.success) {
                const alertMsg = `⚠️ <b>STOK KURANG (BUTUH MANUAL)</b>\nOrder ID: <code>${orderId}</code>\nItem banyak/stok habis.`;
                await sendRealtimeDashboard(ADMIN_CHAT_ID, alertMsg);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // KASUS D: PENDING / PROCESS (Midtrans Pending / Checkout Baru)
        else if (
            statusMidtrans === 'pending' || 
            statusMidtrans === 'authorize' || 
            type === 'pending' || 
            type === 'process' || 
            statusPayload === 'pending'
        ) {
            // Update DB jadi pending
            await orderRef.update({ status: 'pending' });

            // Deteksi label pembayaran
            let via = "Midtrans/VA";
            if (type === 'manual') via = "Transfer Manual";
            if (type === 'saldo') via = "Saldo";

            const pendingMsg = `⏳ <b>ORDER PENDING (${via})</b>\n\n` +
                               `🆔 ID: <code>${orderId}</code>\n` +
                               `💰 Total: Rp ${totalHarga}\n` +
                               `📦 Jumlah Item: ${finalItems.length} pcs\n\n` +
                               `<i>Bot menunggu pembayaran lunas...</i>`;
            
            await sendRealtimeDashboard(ADMIN_CHAT_ID, pendingMsg);
        }

        // KASUS E: MANUAL VERIFICATION (Prioritas Tinggi)
        else if (type === 'manual_verification' || orderFromDb.status === 'manual_verification') {
             const alertMsg = `🔴 <b>BUTUH VERIFIKASI MANUAL!</b>\nOrder ID: <code>${orderId}</code>\nAda masalah stok/sistem pada order ini.`;
             await sendRealtimeDashboard(ADMIN_CHAT_ID, alertMsg);
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        // Tetap kirim 200 agar frontend/midtrans tidak retry terus menerus
        res.status(200).send('Error handled');
        
        // Coba lapor error ke bot jika memungkinkan
        try {
            await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>SYSTEM ERROR (Notify)</b>\nOrder: ${orderId}\nError: ${e.message}`);
        } catch(err) {}
    }
};

const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');
const { sendRealtimeDashboard } = require('./adminRealtime');

const ADMIN_CHAT_ID = '1383656187'; 

// Fungsi Helper Item List
function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 50; 
    
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        displayItems.forEach(i => {
            const safeName = (i.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? `\n    📝 <i>Input: ${(i.note).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</i>` : '';
            itemsDetail += `📦 <b>${safeName}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${safeNote}\n`;
        });
        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\n... <i>➕ Dan ${items.length - MAX_DISPLAY} item lainnya</i>\n`;
        }
    }
    return itemsDetail;
}

module.exports = async function(req, res) {
    const payload = req.body;
    
    // Ambil Order ID & Status dari berbagai kemungkinan sumber
    const orderId = payload.order_id || payload.orderId;
    const type = payload.type; // manual, otomatis, complaint, pending, dll
    const statusMidtrans = payload.transaction_status; // settlement, pending, expire
    const statusPayload = payload.status; // process, pending (dari backend sendiri)

    try {
        // --- 1. CEK DATABASE DULU (Wajib ada) ---
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) {
            return res.status(200).send('Order not found');
        }

        const orderFromDb = orderSnap.data();
        const finalItems = orderFromDb.items || payload.items;
        const itemsDetail = buildItemsListSafe(finalItems);
        const totalHarga = parseInt(payload.total || orderFromDb.total || 0).toLocaleString();

        // =================================================================
        // LOGIKA NOTIFIKASI (DIBUAT LEBIH "PEKA")
        // =================================================================

        // KASUS A: PEMBAYARAN MANUAL (TRANSFER)
        if (type === 'manual') {
            const displayContact = payload.buyerContact ? `<code>${payload.buyerContact}</code>` : 'Guest';
            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n🆔 ID: <code>${orderId}</code>\n💰 Rp ${totalHarga}\n👤 ${displayContact}\n\n🛒 <b>Items:</b>\n${itemsDetail}`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
            await sendRealtimeDashboard(ADMIN_CHAT_ID, "🔔 <i>Cek mutasi bank sekarang:</i>");
        } 
        
        // KASUS B: KOMPLAIN USER
        else if (type === 'complaint') {
             const complaintMsg = (payload.message || "-").replace(/&/g, '&amp;').replace(/</g, '&lt;');
             const text = `⚠️ <b>KOMPLAIN BARU</b>\n🆔 <code>${orderId}</code>\n💬 <pre>${complaintMsg}</pre>\n\n🛒 ${itemsDetail}`;
            
             await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "📩 BALAS PESAN", callback_data: `REPLY_CS_${orderId}` }]]
                }
             });
             await sendRealtimeDashboard(ADMIN_CHAT_ID, "ℹ️ <i>Status dashboard:</i>");
        }

        // KASUS C: SUKSES / LUNAS (Midtrans Settlement / Saldo Otomatis)
        else if (statusMidtrans === 'settlement' || statusMidtrans === 'capture' || type === 'otomatis' || statusPayload === 'success') {
            // Coba ambil stok & kirim otomatis
            const result = await processOrderStock(orderId);
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");

            if (!result.success) {
                // Jika stok kosong, Bot Lapor "BUTUH MANUAL"
                const alertMsg = `⚠️ <b>STOK KOSONG (BUTUH MANUAL)</b>\nOrder ID: <code>${orderId}</code>\nStatus: Paid (Lunas), tapi stok di gudang kurang.`;
                await sendRealtimeDashboard(ADMIN_CHAT_ID, alertMsg);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // KASUS D: PENDING / PROCESS / MENUNGGU BAYAR (SEMUA METODE)
        // Ini jaring pengaman agar bot selalu lapor status gantung
        else if (
            statusMidtrans === 'pending' || 
            statusMidtrans === 'authorize' || 
            type === 'pending' || 
            type === 'process' || 
            statusPayload === 'pending' || 
            statusPayload === 'process'
        ) {
            // Update status DB agar sinkron
            await orderRef.update({ status: 'pending' });

            // Tentukan Label Status
            let labelStatus = "PENDING";
            if (statusMidtrans) labelStatus = statusMidtrans.toUpperCase();
            else if (type) labelStatus = type.toUpperCase();

            const pendingMsg = `⏳ <b>ORDER STATUS: ${labelStatus}</b>\n\n` +
                               `🆔 ID: <code>${orderId}</code>\n` +
                               `💰 Total: Rp ${totalHarga}\n` +
                               `📦 Item: ${finalItems.length} pcs\n\n` +
                               `<i>Bot memantau... Notifikasi akan muncul lagi saat status berubah Lunas/Gagal.</i>`;
            
            // KIRIM NOTIFIKASI DASHBOARD
            await sendRealtimeDashboard(ADMIN_CHAT_ID, pendingMsg);
        }

        // KASUS E: MANUAL VERIFICATION / MACET (SEMUA METODE)
        // Ini prioritas tinggi, biasanya stok habis atau error sistem
        else if (type === 'manual_verification' || statusPayload === 'manual_verification' || orderFromDb.status === 'manual_verification') {
             const alertMsg = `🔴 <b>BUTUH VERIFIKASI MANUAL!</b>\nOrder ID: <code>${orderId}</code>\n\nSistem menahan order ini (Stok habis / Error). Segera cek via tombol di bawah!`;
             
             // Pakai dashboard agar tombol RESOLVE muncul
             await sendRealtimeDashboard(ADMIN_CHAT_ID, alertMsg);
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        res.status(200).send('Error handeled');
    }
};

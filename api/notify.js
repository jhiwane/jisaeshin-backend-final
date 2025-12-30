const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

// Fungsi helper aman dari karakter khusus
function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 50; 
    
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        
        displayItems.forEach(i => {
            // Perbaikan Karakter & (Ampersand) agar tidak error di Telegram
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
    // Penyesuaian untuk Midtrans (order_id) atau Saldo (orderId)
    const payload = req.body;
    const orderId = payload.order_id || payload.orderId;
    const type = payload.type;
    const statusMidtrans = payload.transaction_status;

    try {
        // --- AMBIL DATA DARI DB (PENTING AGAR MIDTRANS TIDAK ERROR) ---
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) {
            // Jika ID tidak ada di DB, kita beri respon 200 agar Midtrans berhenti kirim email error
            return res.status(200).send('Order not found');
        }

        const orderFromDb = orderSnap.data();
        const finalItems = orderFromDb.items || payload.items;
        const itemsDetail = buildItemsListSafe(finalItems);

        // ALUR 1: PEMBAYARAN MANUAL
        if (type === 'manual') {
            const displayContact = payload.buyerContact && payload.buyerContact.includes('|') 
                ? `\n<pre>${payload.buyerContact.replace(/ \| /g, '\n')}</pre>` 
                : `<code>${payload.buyerContact}</code>`;

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(payload.total)||0).toLocaleString()}\n` +
                         `👤 User: ${displayContact}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n` +
                         `👇 <b>TINDAKAN:</b>\nCek mutasi bank/e-wallet. Jika dana masuk, klik ACC.`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
        } 
        // ALUR 2: PEMBAYARAN OTOMATIS (SALDO / MIDTRANS SETTLEMENT)
        else if (statusMidtrans === 'settlement' || statusMidtrans === 'capture' || type === 'otomatis') {
            
            const result = await processOrderStock(orderId);
            
            // Kirim notifikasi hasil tarik stok (Produk Utama akan muncul di sini)
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");

            if (!result.success) {
                // Jika stok kosong, munculkan menu revisi seperti manual
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK PERLU INPUT MANUAL</b>\nOrder ID: <code>${orderId}</code>`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // SELALU KIRIM STATUS 200 OK KE MIDTRANS
        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        // Tetap kirim 200 agar Midtrans tidak mengirim email error terus menerus
        res.status(200).send('Error handeled');
        
        try {
             await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>SYSTEM ERROR</b>\nGagal memproses notifikasi Order ID: ${orderId || 'Unknown'}.\nError: ${e.message}`);
        } catch (errInner) {}
    }
};

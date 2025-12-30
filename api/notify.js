const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

// Fungsi helper aman dari karakter khusus
function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 15; 
    
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        
        displayItems.forEach(i => {
            // Perbaikan Karakter & (Ampersand) agar tidak error di Telegram
            const safeName = (i.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? `\n    📝 <i>Input: ${(i.note).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</i>` : '';
            
            itemsDetail += `📦 <b>${safeName}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${safeNote}\\n`;
        });

        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\\n... <i>➕ Dan ${items.length - MAX_DISPLAY} item lainnya</i>\n`;
        }
    }
    return itemsDetail;
}

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // --- AMBIL DATA DARI DB (SOLUSI MULTI-ITEM) ---
        const orderSnap = await db.collection('orders').doc(orderId).get();
        const orderFromDb = orderSnap.exists ? orderSnap.data() : null;
        
        // Gunakan items dari DB agar strukturnya lengkap dan terjamin
        const finalItems = (orderFromDb && orderFromDb.items) ? orderFromDb.items : items;
        const itemsDetail = buildItemsListSafe(finalItems);

        if (type === 'manual') {
            const displayContact = buyerContact && buyerContact.includes('|') 
                ? `\n<pre>${buyerContact.replace(/ \| /g, '\n')}</pre>` 
                : `<code>${buyerContact}</code>`;

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
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
        } else {
            // --- PEMBAYARAN OTOMATIS (SALDO / MIDTRANS) ---
            const result = await processOrderStock(orderId);
            
            // Selalu kirim notifikasi data otomatis yang berhasil ditarik
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");

            if (!result.success) {
                // Tampilkan menu manual jika ada item sisa (Multi-item support)
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        try {
             await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>SYSTEM ERROR</b>\nGagal memproses notifikasi Order ID: ${orderId || 'Unknown'}.\nError: ${e.message}`);
        } catch (errInner) {}
    }
};

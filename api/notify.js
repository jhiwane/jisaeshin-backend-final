const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

// Fungsi helper untuk membatasi panjang teks item (KODE LAMA ANDA - TETAP)
function buildItemsListSafe(items) {
    let itemsDetail = "";
    const MAX_DISPLAY = 15; 
    
    if (items && Array.isArray(items)) {
        const displayItems = items.slice(0, MAX_DISPLAY);
        
        displayItems.forEach(i => {
            const safeName = (i.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? `\n    📝 <i>Input: ${(i.note).replace(/</g, '&lt;')}</i>` : '';
            
            itemsDetail += `📦 <b>${safeName}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${safeNote}\n`;
        });

        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\n... <i>➕ Dan ${items.length - MAX_DISPLAY} item lainnya</i>\n`;
        }
    }
    return itemsDetail;
}

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB)
        // ==========================================
        if (type === 'auto') {
            const itemsDetail = buildItemsListSafe(items);
            const msg = `⚡️ <b>PESANAN OTOMATIS (WEB)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem sedang mengecek stok database...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                const limitedLogs = result.logs.slice(0, 10).join('\n'); 
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK OTOMATIS GAGAL/KOSONG</b>\n${limitedLogs}\n${result.logs.length > 10 ? '...(logs terpotong)' : ''}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // 2. PEMBAYARAN SALDO (MEMBER) 💎
        // ==========================================
        else if (type === 'saldo') {
            const itemsDetail = buildItemsListSafe(items);
            // REVISI: Tampilkan buyerContact (allNotes) dengan lebih rapi jika panjang
            const displayContact = buyerContact && buyerContact.length > 50 ? `\n<pre>${buyerContact}</pre>` : `<code>${buyerContact}</code>`;

            const msg = `💎 <b>PESANAN VIA SALDO (MEMBER)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${displayContact}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Memproses pemotongan stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            const result = await processOrderStock(orderId);

            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "SALDO/MEMBER");
            } else {
                const limitedLogs = result.logs.slice(0, 10).join('\n');
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK SALDO GAGAL</b>\n${limitedLogs}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // ==========================================
        // 3. KOMPLAIN DARI USER
        // ==========================================
        else if (type === 'complaint') {
             const safeMessage = (message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
             const text = `⚠️ <b>LAPORAN MASALAH (KOMPLAIN)</b>\n\n` +
                          `🆔 ID: <code>${orderId}</code>\n` +
                          `👤 User: ${buyerContact || 'Guest'}\n` +
                          `💬 Pesan: "${safeMessage}"\n\n` +
                          `👇 <i>Klik tombol di bawah untuk membalas:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]]
                }
            });
        }
        
        // ==========================================
        // 4. KONFIRMASI PEMBAYARAN MANUAL
        // ==========================================
        else if (type === 'manual') {
            // REVISI: Menggunakan buildItemsListSafe agar tampilan manual konsisten dengan Auto/Saldo
            const itemsDetail = buildItemsListSafe(items);
            
            // REVISI: Format tampilan kontak agar jika isinya gabungan banyak note tetap enak dibaca
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
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("NOTIFY ERROR:", e.message); 
        try {
             await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>SYSTEM ERROR</b>\nGagal memproses notifikasi Order ID: ${orderId || 'Unknown'}.\nError: ${e.message}`);
        } catch (errInner) {}
        return res.status(500).json({ error: e.message });
    }
};

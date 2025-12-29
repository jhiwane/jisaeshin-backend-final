const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

// Fungsi helper untuk membatasi panjang teks item
function buildItemsListSafe(items) {
    let itemsDetail = "";
    // Batasi hanya menampilkan 15 item pertama agar tidak kena limit 4096 karakter Telegram
    const MAX_DISPLAY = 15; 
    
    if (items && Array.isArray(items)) {
        // Ambil hanya item yang diizinkan untuk ditampilkan
        const displayItems = items.slice(0, MAX_DISPLAY);
        
        displayItems.forEach(i => {
            // Escape HTML characters untuk mencegah error parsing mode HTML
            const safeName = (i.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeNote = i.note ? `\n    📝 <i>Input: ${(i.note).replace(/</g, '&lt;')}</i>` : '';
            
            itemsDetail += `📦 <b>${safeName}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${safeNote}\n`;
        });

        // Jika jumlah asli lebih banyak dari yang ditampilkan, beri info tambahan
        if (items.length > MAX_DISPLAY) {
            itemsDetail += `\n... <i>➕ Dan ${items.length - MAX_DISPLAY} item lainnya (Cek Web/DB untuk detail lengkap)</i>\n`;
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
            // PANGGIL FUNGSI SAFE BUILDER DI SINI
            const itemsDetail = buildItemsListSafe(items);

            const msg = `⚡️ <b>PESANAN OTOMATIS (WEB)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem sedang mengecek stok database...</i>`;

            // Kirim pesan, jika gagal karena limit, script akan masuk catch
            await sendMessage(ADMIN_CHAT_ID, msg);
            
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                // Log array juga dibatasi jika terlalu panjang
                const limitedLogs = result.logs.slice(0, 10).join('\n'); 
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK OTOMATIS GAGAL/KOSONG</b>\n${limitedLogs}\n${result.logs.length > 10 ? '...(logs terpotong)' : ''}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // 2. PEMBAYARAN SALDO (MEMBER) 💎 [BARU]
        // ==========================================
        else if (type === 'saldo') {
            // PANGGIL FUNGSI SAFE BUILDER DI SINI
            const itemsDetail = buildItemsListSafe(items);

            const msg = `💎 <b>PESANAN VIA SALDO (MEMBER)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${buyerContact || 'Member'}\n` +
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
             // Bersihkan pesan user dari karakter HTML berbahaya
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
            // Untuk manual juga gunakan safe builder agar aman
            let itemsDetail = "";
            const MAX_DISPLAY = 15;
            
            if (items && Array.isArray(items)) {
                const displayItems = items.slice(0, MAX_DISPLAY);
                displayItems.forEach(i => {
                    const note = i.note ? ` (Input: ${i.note})` : '';
                    itemsDetail += `- ${i.name} x${i.qty}${note}\n`;
                });
                if (items.length > MAX_DISPLAY) {
                    itemsDetail += `- ... dan ${items.length - MAX_DISPLAY} item lainnya\n`;
                }
            }

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                         `👤 User: ${buyerContact}\n\n` +
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
        // Log error ke console server agar bisa dicek di dashboard hosting
        console.error("NOTIFY ERROR:", e.message); 
        
        // Opsional: Kirim pesan "Panic" ke admin jika notifikasi utama gagal total
        // (Hanya teks pendek tanpa detail order untuk menghindari error berulang)
        try {
             await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>SYSTEM ERROR</b>\nGagal memproses notifikasi Order ID: ${orderId || 'Unknown'}.\nError: ${e.message}`);
        } catch (errInner) {
             console.error("Failed to send error alert:", errInner.message);
        }

        return res.status(500).json({ error: e.message });
    }
};

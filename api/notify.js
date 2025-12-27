const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Telegram Anda

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // ==========================================
        // 1. AUTO ORDER (MIDTRANS) & SALDO MEMBER
        // ==========================================
        if (type === 'auto' || type === 'saldo') {
            
            // A. Tentukan Judul Header Berdasarkan Tipe
            let headerMsg = "";
            let notifLabel = "";

            if (type === 'saldo') {
                headerMsg = `💎 <b>PEMBAYARAN SALDO (MEMBER)</b>`;
                notifLabel = "SALDO";
            } else {
                headerMsg = `⚡️ <b>PESANAN OTOMATIS (MIDTRANS)</b>`;
                notifLabel = "OTOMATIS";
            }

            // B. Susun Info Detail Produk
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `📦 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }

            const msg = `${headerMsg}\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                        `👤 User: ${buyerContact || 'Guest'}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem sedang memproses stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            
            // C. Eksekusi Stok (Sama untuk Saldo & Midtrans)
            // Karena di Frontend Saldo sudah dipotong via Transaction, di sini kita tinggal potong stok & kirim barang.
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                // Jika stok ada, kirim notif sukses + link WA
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, notifLabel);
            } else {
                // Jika stok kosong, langsung minta input manual
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK GAGAL/KOSONG (${notifLabel})</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // 2. KOMPLAIN DARI USER
        // ==========================================
        else if (type === 'complaint') {
            const text = `⚠️ <b>LAPORAN MASALAH (KOMPLAIN)</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `👤 User: ${buyerContact || 'Guest'}\n` +
                         `💬 Pesan: "${message}"\n\n` +
                         `👇 <i>Klik tombol di bawah untuk membalas:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]]
                }
            });
        }
        
        // ==========================================
        // 3. KONFIRMASI PEMBAYARAN MANUAL
        // ==========================================
        else if (type === 'manual') {
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? ` (Input: ${i.note})` : '';
                    itemsDetail += `- ${i.name} x${i.qty}${note}\n`;
                });
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
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
};

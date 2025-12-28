const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda (Pastikan benar)

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        console.log(`[NOTIFY] Receiving: ${orderId} | Type: ${type}`);

        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB)
        // ==========================================
        if (type === 'auto') {
            // Susun Info Detail Produk
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `📦 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }

            // [PERBAIKAN] Saya tambahkan baris 'User' di sini agar Member/Tamu terlihat kontaknya
            const msg = `⚡️ <b>PESANAN OTOMATIS (MIDTRANS)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${buyerContact || 'Guest'}\n` +  // <--- BARIS INI PENTING
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem sedang mengecek stok database...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            
            // --- EKSEKUSI STOK LANGSUNG ---
            const result = await processOrderStock(orderId);
            
            if (result.success) {
                // Jika stok ada, kirim notif sukses + link WA
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                // Jika stok kosong, langsung minta input manual
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK OTOMATIS GAGAL/KOSONG</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // ==========================================
        // 2. PEMBAYARAN VIA SALDO (NEW FEATURE) 💎
        // ==========================================
        else if (type === 'saldo') {
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `💎 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }

            // Pesan Awal: Memberitahu Admin ada member beli pakai Saldo
            const msg = `💎 <b>PESANAN VIA SALDO (MEMBER)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${buyerContact || 'Member'}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Memverifikasi & memotong stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);

            // --- EKSEKUSI STOK (Sama persis kayak Auto) ---
            const result = await processOrderStock(orderId);

            if (result.success) {
                // Stok Ada -> Kirim Notif Sukses ke Telegram Admin
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "SALDO/MEMBER");
            } else {
                // Stok Kosong -> Minta Input Manual
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK SALDO GAGAL/KOSONG</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // ==========================================
        // 3. KOMPLAIN DARI USER
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
        // 4. KONFIRMASI PEMBAYARAN MANUAL
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
        console.error("[Notify Error]:", e);
        return res.status(500).json({ error: e.message });
    }
};

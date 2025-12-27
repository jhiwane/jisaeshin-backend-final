const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Kamu

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // 1. AUTO ORDER (MIDTRANS)
        if (type === 'auto') {
            // ... (KODE LAMA BIARKAN SAMA) ...
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `📦 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }
            const msg = `⚡️ <b>PESANAN OTOMATIS (WEB)</b>\n🆔 ID: <code>${orderId}</code>\n💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n${itemsDetail}\n⚙️ <i>Sistem sedang mengecek stok database...</i>`;
            await sendMessage(ADMIN_CHAT_ID, msg);
            
            // Logic Auto Stock
            const result = await processOrderStock(orderId);
            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "OTOMATIS");
            } else {
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK OTOMATIS GAGAL/KOSONG</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        } 
        
        // 2. KOMPLAIN USER (SAMA SEPERTI LAMA)
        else if (type === 'complaint') {
             // ... (KODE LAMA BIARKAN SAMA) ...
             const text = `⚠️ <b>LAPORAN MASALAH</b>\n🆔 ${orderId}\n👤 ${buyerContact}\n💬 "${message}"`;
             await sendMessage(ADMIN_CHAT_ID, text, { reply_markup: { inline_keyboard: [[{ text: "🗣 BALAS", callback_data: `REPLY_COMPLAINT_${orderId}` }]] } });
        }
        
        // 3. MANUAL PAYMENT (SAMA SEPERTI LAMA)
        else if (type === 'manual') {
            // ... (KODE LAMA BIARKAN SAMA) ...
            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n🆔 ${orderId}\n💰 Rp ${(parseInt(total)||0).toLocaleString()}\n👤 ${buyerContact}\n👇 Cek mutasi, lalu klik ACC.`;
            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: { inline_keyboard: [[{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }], [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]] }
            });
        }

        // === [BARU] 4. PEMBAYARAN SALDO ===
        // Karena frontend sudah memotong saldo & stok secara aman (Atomic),
        // Backend cukup kirim laporan sukses ke Telegram Admin.
        else if (type === 'saldo') {
            const msg = `💎 <b>PEMBAYARAN SALDO SUKSES</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: LUNAS (Potong Saldo)\n` +
                        `✅ Stok & Saldo user sudah terpotong otomatis oleh sistem.\n` +
                        `📅 ${new Date().toLocaleString()}`;
            
            await sendMessage(ADMIN_CHAT_ID, msg);
            // Kita kirim notif "SUKSES" lagi biar link WA generate di chat admin juga (opsional)
            await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "SALDO MEMBER");
        }

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
};

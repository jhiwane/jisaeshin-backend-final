const { sendMessage } = require('./botConfig');
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID; 

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    if (!ADMIN_CHAT_ID) return res.status(500).json({ error: "Server Config Error" });

    try {
        console.log(`[NOTIFY] Receiving: ${orderId} | Type: ${type}`);

        // --- TIPE 1: AUTO (Midtrans) - Opsional jika ingin double check ---
        if (type === 'auto') {
             // Biasanya ini ditangani webhook, tapi jika dipanggil manual:
             await processOrderStock(orderId);
        } 
        
        // --- TIPE 2: SALDO (MEMBER) ---
        else if (type === 'saldo') {
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    const note = i.note ? `\n   📝 <i>Input: ${i.note}</i>` : '';
                    itemsDetail += `💎 <b>${i.name}</b>\n   Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}\n`;
                });
            }

            const msg = `💎 <b>PESANAN VIA SALDO (MEMBER)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${buyerContact || 'Member'}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Memverifikasi & memotong stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);

            const result = await processOrderStock(orderId);

            if (result.success) {
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, "SALDO/MEMBER");
            } else {
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>STOK SALDO GAGAL</b>\n${result.logs.join('\n')}`);
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
            }
        }

        // --- TIPE 3: KOMPLAIN ---
        else if (type === 'complaint') {
            const text = `⚠️ <b>LAPORAN MASALAH</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `👤 User: ${buyerContact}\n` +
                         `💬 Pesan: "${message}"\n\n` +
                         `👇 <i>Klik untuk membalas:</i>`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [[{ text: "🗣 BALAS KE USER", callback_data: `REPLY_COMPLAINT_${orderId}` }]]
                }
            });
        }
        
        // --- TIPE 4: MANUAL TRANSFER ---
        else if (type === 'manual') {
            let itemsDetail = "";
            if (items && Array.isArray(items)) {
                items.forEach(i => {
                    itemsDetail += `- ${i.name} x${i.qty}\n`;
                });
            }

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                         `👤 User: ${buyerContact}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n` +
                         `👇 <b>TINDAKAN:</b> Cek mutasi, lalu klik ACC.`;

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

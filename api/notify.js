const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Otak Utama 
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items } = req.body;

    try {
        // Fungsi helper untuk merapikan tampilan list item
        const formatItemsList = (itemsArr) => {
            if (!itemsArr || !Array.isArray(itemsArr)) return "";
            return itemsArr.map((i, idx) => {
                const note = i.note ? `\n    📝 <i>Note: ${i.note}</i>` : '';
                return `<b>${idx + 1}. ${i.name}</b>\n    Qty: ${i.qty} x Rp${(parseInt(i.price)||0).toLocaleString()}${note}`;
            }).join('\n');
        };

        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB) & SALDO
        // ==========================================
        if (type === 'auto' || type === 'saldo') {
            const sourceLabel = type === 'saldo' ? "SALDO/MEMBER" : "OTOMATIS (WEB)";
            const userLabel = type === 'saldo' ? (buyerContact || 'Member') : 'Guest/Web';
            
            // 1. Info Awal ke Admin (Pesanan Masuk)
            const itemsDetail = formatItemsList(items);
            const msgStart = `⚡️ <b>PESANAN ${sourceLabel} MASUK</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${userLabel}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `📦 <b>Daftar Item:</b>\n${itemsDetail}\n\n` +
                        `⚙️ <i>Sistem sedang memproses stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msgStart);
            
            // 2. EKSEKUSI STOK (OTOMATIS)
            // Hasil result.items berisi status terbaru setiap item (terisi/kosong)
            const result = await processOrderStock(orderId);
            
            // 3. ANALISA HASIL (LOGIKA BARU ANTI-BENGONG)
            const processedItems = result.items || [];
            
            // Cek mana yang sukses terisi, mana yang kosong
            const filledItems = processedItems.filter(i => i.data && i.data.length > 0);
            const emptyItems = processedItems.filter(i => !i.data || i.data.length === 0);

            // SKENARIO A: Jika ada item yang TERISI (Walaupun cuma sebagian)
            if (filledItems.length > 0) {
                // Kirim notifikasi sukses ke user berisi data yang ADA saja dulu
                // Fungsi sendSuccessNotification harus support mengirim data parsial
                await sendSuccessNotification(ADMIN_CHAT_ID, orderId, sourceLabel);
            }

            // SKENARIO B: Jika ada item yang KOSONG (Butuh input manual)
            if (emptyItems.length > 0) {
                // Beri tahu admin ada yang kurang
                let logMessage = result.logs && result.logs.length > 0 
                    ? result.logs.join('\n') 
                    : "Sebagian stok kosong/gagal diambil.";

                const msgPartial = `⚠️ <b>BUTUH TINDAKAN MANUAL</b>\n` +
                                   `RefID: <code>${orderId}</code>\n\n` +
                                   `<b>Status:</b> ${filledItems.length} Terkirim, ${emptyItems.length} Kosong.\n` +
                                   `<b>Log System:</b>\n${logMessage}\n\n` +
                                   `👇 <i>Silakan input manual data yang kurang:</i>`;
                
                await sendMessage(ADMIN_CHAT_ID, msgPartial);

                // Tampilkan Menu Input Manual (Hanya tombol item yang kosong atau All items utk revisi)
                // Ini akan memicu webhook untuk menampilkan tombol "Isi Data"
                await showManualInputMenu(ADMIN_CHAT_ID, orderId, processedItems);
            }
            
            // SKENARIO C: SUKSES SEMUA (Tidak ada yang kosong)
            // Tidak perlu else khusus, karena sudah tercover di Skenario A (kirim data) 
            // dan Skenario B tidak akan jalan (karena emptyItems 0).
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
            const itemsDetail = formatItemsList(items);

            const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                         `🆔 ID: <code>${orderId}</code>\n` +
                         `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                         `👤 User: ${buyerContact}\n\n` +
                         `🛒 <b>Items:</b>\n${itemsDetail}\n\n` +
                         `👇 <b>TINDAKAN:</b>\nCek mutasi bank/e-wallet. Jika dana masuk, klik ACC.`;

            await sendMessage(ADMIN_CHAT_ID, text, {
                reply_markup: {
                    inline_keyboard: [
                        // Tombol ACC akan memicu processOrderStock di webhook
                        // Webhook nanti akan menjalankan logika yang sama: Cek Stok -> Jika kosong -> Tampil Menu
                        [{ text: "✅ TERIMA (ACC)", callback_data: `ACC_${orderId}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }]
                    ]
                }
            });
        }

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("Notify Error:", e);
        await sendMessage(ADMIN_CHAT_ID, `🔥 <b>SYSTEM ERROR</b>\n${e.message}`);
        // Tetap return 200 agar request tidak diulang-ulang oleh sender
        return res.status(200).json({ error: e.message });
    }
};

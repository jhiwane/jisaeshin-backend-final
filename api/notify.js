const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
// Import Helper (Tetap dipakai sebagai cadangan/fallback)
const { processOrderStock, sendSuccessNotification, showManualInputMenu } = require('./orderHelper');

const ADMIN_CHAT_ID = '1383656187'; // ID Admin Anda

module.exports = async function(req, res) {
    const { orderId, type, buyerContact, message, total, items: rawItems } = req.body;

    try {
        // ==========================================
        // 0. PRE-CHECK DATA (LOGIKA CERDAS)
        // ==========================================
        // Kita cek langsung ke database: Apakah Frontend sudah menyimpan data akun/voucher di order ini?
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        // Ambil data terbaru dari DB (karena rawItems dari request mungkin data lama)
        let orderData = orderSnap.exists ? orderSnap.data() : null;
        let finalItems = orderData ? orderData.items : rawItems;

        // Cek 1: Apakah konten/akun sudah siap? (Hasil inject dari Frontend App.jsx)
        const isContentReady = finalItems && Array.isArray(finalItems) && finalItems.some(i => i.data && i.data.length > 0);
        
        // Cek 2: Apakah ini produk digital/otomatis? (Bukan Joki/Barang Fisik)
        const isDigitalProduct = finalItems && finalItems.some(i => !i.isManual && i.processType !== 'MANUAL');

        // --- FUNGSI REUSABLE: Menangani Pengiriman Sukses ---
        const handleSuccessDelivery = async (sourceType) => {
            // SKENARIO A: KONTEN SUDAH ADA (Frontend Berhasil)
            if (isContentReady) {
                // 1. Update status jadi PAID/SUCCESS
                await orderRef.update({ status: 'paid' }); 
                
                // 2. Susun Laporan untuk Admin
                let contentLog = "";
                finalItems.forEach(i => {
                    if (i.data && i.data.length > 0) {
                        contentLog += `📦 <b>${i.name}</b>\n<code>${i.data.join('\n')}</code>\n\n`;
                    } else if (!i.isManual && i.processType !== 'EXTERNAL_API') {
                        contentLog += `📦 <b>${i.name}</b>\n(Stok kosong/gagal diambil oleh Frontend)\n\n`;
                    } else {
                        contentLog += `📦 <b>${i.name}</b>\n(Manual/Proses API)\n\n`;
                    }
                });

                const successMsg = `✅ <b>TRANSAKSI SUKSES (${sourceType})</b>\n` +
                                   `🆔 ID: <code>${orderId}</code>\n` +
                                   `💰 Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                                   `<b>DATA TERKIRIM KE USER:</b>\n${contentLog}`;
                
                await sendMessage(ADMIN_CHAT_ID, successMsg);
            
            // SKENARIO B: KONTEN BELUM ADA (Frontend Gagal / API Error)
            } else {
                // Kita coba paksa ambil stok pakai cara lama (Backend Logic)
                const result = await processOrderStock(orderId);
                
                if (result.success) {
                    // Jika backend berhasil ambil stok, kirim notif
                    await sendSuccessNotification(ADMIN_CHAT_ID, orderId, sourceType, result.orderData);
                } else {
                    // Jika backend juga gagal (stok habis), lapor admin suruh isi manual
                    await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>GAGAL AMBIL STOK (${sourceType})</b>\n${result.logs.join('\n')}`);
                    await showManualInputMenu(ADMIN_CHAT_ID, orderId, result.items);
                }
            }
        };

        // ==========================================
        // 1. AUTO ORDER (MIDTRANS / WEB)
        // ==========================================
        if (type === 'auto') {
            // Info awal ke Admin
            const itemsDetail = finalItems.map(i => `📦 ${i.name} x${i.qty}`).join('\n');
            const msg = `⚡️ <b>PESANAN OTOMATIS (WEB)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Sistem memverifikasi pembayaran & stok...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);
            
            // Eksekusi pengiriman
            await handleSuccessDelivery("OTOMATIS");
        } 
        
        // ==========================================
        // 2. PEMBAYARAN SALDO (MEMBER)
        // ==========================================
        else if (type === 'saldo') {
            const itemsDetail = finalItems.map(i => `💎 ${i.name} x${i.qty}`).join('\n');
            const msg = `💎 <b>PESANAN VIA SALDO (MEMBER)</b>\n` +
                        `🆔 ID: <code>${orderId}</code>\n` +
                        `👤 User: ${buyerContact || 'Member'}\n` +
                        `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                        `${itemsDetail}\n` +
                        `⚙️ <i>Saldo terpotong. Memproses kiriman...</i>`;

            await sendMessage(ADMIN_CHAT_ID, msg);

            // Eksekusi pengiriman (Sama seperti auto)
            await handleSuccessDelivery("SALDO/MEMBER");
        }

        // ==========================================
        // 3. KONFIRMASI PEMBAYARAN MANUAL
        // ==========================================
        else if (type === 'manual') {
            
            // [LOGIKA BARU] BYPASS ACC JIKA PRODUK DIGITAL & DATA SIAP
            // Jika user beli "Netflix" (Otomatis) pakai "Transfer Manual", dan klik "Sudah Bayar".
            // Bot akan langsung kirim akunnya (Anggap user jujur), Admin cek mutasi belakangan.
            
            if (isDigitalProduct) {
                const itemsDetail = finalItems.map(i => `🚀 ${i.name} (Auto-Process)`).join('\n');
                const msg = `🚀 <b>MANUAL TRANSFER - AUTO PROCESS</b>\n` +
                            `🆔 ID: <code>${orderId}</code>\n` +
                            `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n\n` +
                            `${itemsDetail}\n` +
                            `ℹ️ <i>User konfirmasi transfer. Karena produk OTOMATIS, sistem langsung memproses...</i>`;
                
                await sendMessage(ADMIN_CHAT_ID, msg);

                // Langsung eksekusi tanpa ACC
                await handleSuccessDelivery("MANUAL-AUTO-BYPASS");

                // Peringatan ke Admin
                await sendMessage(ADMIN_CHAT_ID, `⚠️ <b>PERHATIAN ADMIN:</b>\nOrder <code>${orderId}</code> telah diproses otomatis. Mohon cek mutasi bank nanti untuk memastikan uang benar-benar masuk.`);

            } else {
                // [LOGIKA LAMA] JIKA PRODUK MEMANG MANUAL (JOKI / TOPUP VIA LOGIN)
                // Tetap butuh tombol ACC / TOLAK
                let itemsDetail = "";
                if (finalItems && Array.isArray(finalItems)) {
                    finalItems.forEach(i => {
                        const note = i.note ? ` (Input: ${i.note})` : '';
                        itemsDetail += `- ${i.name} x${i.qty}${note}\n`;
                    });
                }

                const text = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n\n` +
                             `🆔 ID: <code>${orderId}</code>\n` +
                             `💰 Total: Rp ${(parseInt(total)||0).toLocaleString()}\n` +
                             `👤 User: ${buyerContact}\n\n` +
                             `🛒 <b>Items (Produk Manual):</b>\n${itemsDetail}\n` +
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
        }
        
        // ==========================================
        // 4. KOMPLAIN DARI USER
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

        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("Notify Error:", e);
        return res.status(500).json({ error: e.message });
    }
};

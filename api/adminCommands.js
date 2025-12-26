const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// ==========================================
// 1. TAMPILKAN DASHBOARD MENU
// ==========================================
async function showAdminDashboard(chatId) {
    const text = `🎛 <b>DASHBOARD ADMIN</b>\n\nSilakan pilih menu di bawah ini untuk memantau toko Anda:`;
    
    const kb = [
        [
            { text: "📊 Laporan Hari Ini", callback_data: "ADMIN_REPORT" },
            { text: "⚠️ Cek Stok Menipis", callback_data: "ADMIN_STOCK" }
        ],
        [
            { text: "🔄 Refresh Menu", callback_data: "ADMIN_MENU" }
        ]
    ];

    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: kb } });
}

// ==========================================
// 2. LOGIKA LAPORAN OMZET HARIAN
// ==========================================
async function handleDailyReport(chatId) {
    await sendMessage(chatId, "⏳ <i>Sedang menghitung data hari ini...</i>");

    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();

        // Ambil order yg statusnya sukses/paid hari ini
        const snapshot = await db.collection('orders')
            .where('date', '>=', startOfDay)
            .where('date', '<=', endOfDay)
            .get();

        let totalOmzet = 0;
        let totalTrx = 0;
        let pendingTrx = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'success' || data.status === 'paid') {
                totalOmzet += parseInt(data.total) || 0;
                totalTrx++;
            } else if (data.status === 'processing' || data.status === 'pending') {
                pendingTrx++;
            }
        });

        const msg = `📊 <b>LAPORAN HARIAN (${new Date().toLocaleDateString('id-ID')})</b>\n` +
                    `---------------------------\n` +
                    `✅ <b>Transaksi Sukses:</b> ${totalTrx}\n` +
                    `💰 <b>Total Omzet:</b> Rp ${totalOmzet.toLocaleString()}\n` +
                    `⏳ <b>Pending/Proses:</b> ${pendingTrx}\n` +
                    `---------------------------\n` +
                    `<i>Semangat terus jualannya, Bos! 🔥</i>`;

        // Kirim Laporan & Tampilkan Menu Lagi
        await sendMessage(chatId, msg);
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error(e);
        await sendMessage(chatId, "❌ Gagal mengambil data laporan.");
    }
}

// ==========================================
// 3. LOGIKA CEK STOK MENIPIS
// ==========================================
async function handleLowStockCheck(chatId) {
    await sendMessage(chatId, "🔍 <i>Memindai gudang produk...</i>");

    try {
        const snapshot = await db.collection('products').get();
        let lowStockItems = "";
        let count = 0;
        const THRESHOLD = 3; // Batas aman stok (bisa diubah)

        snapshot.forEach(doc => {
            const p = doc.data();
            
            // Skip produk manual/joki
            if (p.isManual || p.processType === 'MANUAL') return;

            // 1. Cek Produk Utama
            if (p.items && p.items.length <= THRESHOLD && (!p.variations || p.variations.length === 0)) {
                const sisa = p.items.length;
                lowStockItems += `📦 <b>${p.name}</b> (Sisa: ${sisa})\n`;
                count++;
            }

            // 2. Cek Variasi
            if (p.variations && p.variations.length > 0) {
                p.variations.forEach(v => {
                    const sisa = v.items ? v.items.length : 0;
                    if (sisa <= THRESHOLD) {
                        lowStockItems += `🔸 <b>${p.name} - ${v.name}</b> (Sisa: ${sisa})\n`;
                        count++;
                    }
                });
            }
        });

        if (count > 0) {
            await sendMessage(chatId, `⚠️ <b>PERINGATAN STOK MENIPIS (< ${THRESHOLD})</b>\n\n${lowStockItems}\n👉 <i>Segera isi stok agar tidak boncos!</i>`);
        } else {
            await sendMessage(chatId, `✅ <b>AMAN!</b> Semua stok produk digital masih melimpah.`);
        }
        
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error(e);
        await sendMessage(chatId, "❌ Gagal mengecek stok.");
    }
}

module.exports = { showAdminDashboard, handleDailyReport, handleLowStockCheck };

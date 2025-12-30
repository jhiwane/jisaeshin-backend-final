const { db } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// 1. DASHBOARD ADMIN (MENU UTAMA)
async function showAdminDashboard(chatId) {
    const text = `🎛 <b>DASHBOARD ADMIN</b>\n\nSilakan pilih menu operasional:`;
    
    // Perbaikan: Menambahkan tombol "Cek Order Pending" agar fitur baru bisa diakses
    const kb = [
        [
            { text: "📊 Laporan Harian", callback_data: "ADMIN_REPORT" },
            { text: "⏳ Cek Order Pending", callback_data: "CHECK_PENDING" } 
        ],
        [
            { text: "⚠️ Cek Stok Menipis", callback_data: "ADMIN_STOCK" },
            { text: "⚙️ Refresh Menu", callback_data: "ADMIN_MENU" }
        ]
    ];
    
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: kb } });
}

// 2. LAPORAN OMZET
async function handleDailyReport(chatId) {
    await sendMessage(chatId, "⏳ <i>Menghitung data transaksi hari ini...</i>");
    try {
        const today = new Date();
        const startOfDay = new Date(today.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(today.setHours(23, 59, 59, 999)).toISOString();

        const snapshot = await db.collection('orders')
            .where('date', '>=', startOfDay)
            .where('date', '<=', endOfDay)
            .get();

        let totalOmzet = 0;
        let totalTrx = 0;
        let pendingTrx = 0;
        let manualTrx = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            
            // Hitung Sukses
            if (data.status === 'success' || data.status === 'paid') {
                totalOmzet += parseInt(data.total) || 0;
                totalTrx++;
            } 
            // Hitung Pending (Termasuk yang macet/manual verification)
            else if (['processing', 'pending', 'manual_verification'].includes(data.status)) {
                pendingTrx++;
                if (data.status === 'manual_verification') manualTrx++;
            }
        });

        const msg = `📊 <b>LAPORAN HARIAN</b>\n` +
                    `📅 ${new Date().toLocaleDateString('id-ID')}\n` +
                    `-----------------\n` +
                    `✅ Sukses: <b>${totalTrx}</b> trx\n` +
                    `💰 Omzet: <b>Rp ${totalOmzet.toLocaleString('id-ID')}</b>\n` +
                    `⏳ Pending: <b>${pendingTrx}</b> trx\n` +
                    `   └─ <i>(Butuh Manual: ${manualTrx})</i>`;

        await sendMessage(chatId, msg);
        
        // Tampilkan dashboard lagi agar admin tidak perlu scroll ke atas
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error(e);
        await sendMessage(chatId, "❌ Gagal menarik laporan harian.");
    }
}

// 3. CEK STOK (SAFETY CHECK OKE)
async function handleLowStockCheck(chatId) {
    await sendMessage(chatId, "🔍 <i>Memindai gudang...</i>");

    try {
        const snapshot = await db.collection('products').get();
        let lowStockItems = "";
        let count = 0;
        const THRESHOLD = 3; // Batas stok dianggap menipis

        snapshot.forEach(doc => {
            const p = doc.data();
            // SKIP JIKA MANUAL (Karena stok manual biasanya unlimited/by request)
            if (p.isManual || p.processType === 'MANUAL') return;

            // SAFETY CHECK: Gunakan '|| []' agar tidak error
            const mainItems = p.items || [];
            const variations = p.variations || [];

            // 1. Cek Produk Utama (Hanya jika tidak punya variasi)
            if (variations.length === 0) {
                if (mainItems.length <= THRESHOLD) {
                    lowStockItems += `📦 <b>${p.name}</b> (Sisa: ${mainItems.length})\n`;
                    count++;
                }
            }

            // 2. Cek Variasi
            if (variations.length > 0) {
                variations.forEach(v => {
                    const vItems = v.items || [];
                    if (vItems.length <= THRESHOLD) {
                        lowStockItems += `🔸 ${p.name} - ${v.name} (Sisa: ${vItems.length})\n`;
                        count++;
                    }
                });
            }
        });

        if (count > 0) {
            await sendMessage(chatId, `⚠️ <b>PERINGATAN STOK MENIPIS</b>\nFound: ${count} item\n\n${lowStockItems}`);
        } else {
            await sendMessage(chatId, `✅ <b>AMAN!</b> Stok gudang masih tersedia.`);
        }
        
        // Kembali ke dashboard
        await showAdminDashboard(chatId);

    } catch (e) {
        console.error("Stock Check Error:", e);
        await sendMessage(chatId, `❌ Error Cek Stok: ${e.message}`);
    }
}

module.exports = { showAdminDashboard, handleDailyReport, handleLowStockCheck };

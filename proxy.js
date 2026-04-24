import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- CACHE & CONCURRENCY CONTROL ---
const DEVICE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const deviceCache = new Map(); // key: `${sn}__${startDate}` -> { data, fetchedAt }
const inFlight = new Map();

function cacheKey(sn, startDate) {
    return `${sn}__${startDate || ''}`;
}

function isFresh(entry) {
    return entry && (Date.now() - entry.fetchedAt) < DEVICE_TTL_MS;
}

async function getDeviceDataWithCache(sn, perPage, startDate, bustCache) {
    const key = cacheKey(sn, startDate);

    if (!bustCache) {
        const cached = deviceCache.get(key);
        if (isFresh(cached)) return cached.data;
    } else {
        deviceCache.delete(key);
        inFlight.delete(key);
    }

    if (inFlight.has(key)) {
        try { return await inFlight.get(key); } catch (e) {}
    }

    const p = (async () => {
        try {
            const data = await fetchFromZentra(sn, perPage, startDate);
            deviceCache.set(key, { data, fetchedAt: Date.now() });
            return data;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, p);
    return p;
}

async function fetchFromZentra(sn, perPage, startDate) {
    let url = `https://zentracloud.com/api/v3/get_readings/?device_sn=${encodeURIComponent(sn)}&per_page=${perPage}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;

    const response = await fetch(url, {
        headers: { 'Authorization': 'Token d445bff30fd09944398c70521da24e19f6c11abf' }
    });

    if (!response.ok) {
        const text = await response.text();
        return { device_sn: sn, error: 'Failed to fetch', status: response.status, body: text };
    }

    const data = await response.json();
    return {
        device_sn: sn,
        pagination: data.pagination,
        data: data.data
    };
}

// --- ROUTE ---
app.get('/zentra', async (req, res) => {
    try {
        let deviceSNs = req.query.device_sn;
        const perPage = req.query.per_page || 500;
        const startDate = req.query.start_date;
        const bustCache = req.query.bust === '1';

        if (!deviceSNs) return res.status(400).json({ error: 'device_sn query parameter is required' });

        if (typeof deviceSNs === 'string') {
            deviceSNs = deviceSNs.split(',').map(sn => sn.trim()).filter(Boolean);
        }

        const results = await Promise.all(
            deviceSNs.map(sn => getDeviceDataWithCache(sn, perPage, startDate, bustCache))
        );

        res.json({ devices: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cache bust endpoint
app.get('/bust-cache', (req, res) => {
    deviceCache.clear();
    inFlight.clear();
    res.json({ ok: true, message: 'Cache cleared' });
});

app.get('/', (req, res) => res.send('Zentra Proxy Server is running.'));

app.listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- CACHE ---
const DEVICE_TTL_MS = 5 * 60 * 1000;
const deviceCache = new Map();
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
            const data = await fetchAllPorts(sn, perPage, startDate);
            deviceCache.set(key, { data, fetchedAt: Date.now() });
            return data;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, p);
    return p;
}

async function fetchZentraPort(sn, perPage, startDate, portNumber) {
    let url = `https://zentracloud.com/api/v3/get_readings/?device_sn=${encodeURIComponent(sn)}&per_page=${perPage}`;
    if (startDate) url += `&start_date=${encodeURIComponent(startDate)}`;
    if (portNumber != null) url += `&port_number=${portNumber}`;

    const response = await fetch(url, {
        headers: { 'Authorization': 'Token d445bff30fd09944398c70521da24e19f6c11abf' }
    });

    if (!response.ok) {
        const text = await response.text();
        console.warn(`Port ${portNumber} fetch failed: ${response.status} ${text}`);
        return null;
    }

    const json = await response.json();
    return json.data || {};
}

async function fetchAllPorts(sn, perPage, startDate) {
    const [defaultData, port1Data, port2Data] = await Promise.all([
        fetchZentraPort(sn, perPage, startDate, null),
        fetchZentraPort(sn, perPage, startDate, 1),
        fetchZentraPort(sn, perPage, startDate, 2)
    ]);

    const merged = { ...(defaultData || {}) };

    for (const [portNum, portData] of [[1, port1Data], [2, port2Data]]) {
        if (!portData) continue;
        Object.keys(portData).forEach(key => {
            const arr = portData[key];
            if (!Array.isArray(arr) || arr.length === 0) return;

            const existingArr = merged[key];
            const existingPort = existingArr && existingArr[0] && existingArr[0].metadata
                ? existingArr[0].metadata.port_number : null;
            const thisPort = arr[0].metadata ? arr[0].metadata.port_number : null;

            if (!merged[key]) {
                merged[key] = arr;
            } else if (existingPort !== thisPort) {
                if (existingPort != null && !(`${key} (Port ${existingPort})` in merged)) {
                    merged[`${key} (Port ${existingPort})`] = merged[key];
                    delete merged[key];
                }
                const newKey = thisPort != null ? `${key} (Port ${thisPort})` : `${key} (Port ${portNum})`;
                merged[newKey] = arr;
            }
        });
    }

    return {
        device_sn: sn,
        data: merged
    };
}

app.get('/zentra', async (req, res) => {
    try {
        let deviceSNs = req.query.device_sn;
        const perPage = req.query.per_page || 1000;
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

app.get('/bust-cache', (req, res) => {
    deviceCache.clear();
    inFlight.clear();
    res.json({ ok: true, message: 'Cache cleared' });
});

app.get('/', (req, res) => res.send('Zentra Proxy Server is running.'));

app.listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));

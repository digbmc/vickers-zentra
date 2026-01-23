import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS for your frontend
app.use(cors());


// --- CACHE & CONCURRENCY CONTROL ---
const DEVICE_TTL_MS = 60 * 1000;
const deviceCache = new Map(); // device_sn -> { data, fetchedAt }
const inFlight = new Map();    // device_sn -> Promise

function isFresh(entry) {
  return entry && (Date.now() - entry.fetchedAt) < DEVICE_TTL_MS;
}

async function getDeviceDataWithCache(sn, perPage, startDate) {
  // 1. Serve from fresh cache
  const cached = deviceCache.get(sn);
  if (isFresh(cached)) {
    return cached.data;
  }

  // 2. Await in-flight fetch if present
  if (inFlight.has(sn)) {
    try {
      return await inFlight.get(sn);
    } catch (e) {
      // If in-flight failed, fall through to new fetch
    }
  }

  // 3. Start new fetch, mark as in-flight
  const p = (async () => {
    try {
      const data = await fetchFirstPage(sn, perPage, startDate);
      deviceCache.set(sn, { data, fetchedAt: Date.now() });
      return data;
    } finally {
      inFlight.delete(sn);
    }
  })();

  inFlight.set(sn, p);
  return p;
}

// --- ORIGINAL FETCH LOGIC (unchanged) ---
async function fetchFirstPage(sn, perPage, startDate) {
  let url = `https://zentracloud.com/api/v3/get_readings/?device_sn=${encodeURIComponent(sn)}&per_page=${perPage}`;
  if (startDate) {
    url += `&start_date=${encodeURIComponent(startDate)}`;
  }
  const response = await fetch(url, {
    headers: {
      'Authorization': 'Token d445bff30fd09944398c70521da24e19f6c11abf'
    }
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

// --- ROUTE: use cache-aware fetch ---
app.get('/zentra', async (req, res) => {
  try {
    let deviceSNs = req.query.device_sn;
    let perPage = req.query.per_page || 500;
    let startDate = req.query.start_date;

    if (!deviceSNs) {
      return res.status(400).json({ error: 'device_sn query parameter is required' });
    }
    // Accept comma-separated SNs or multiple device_sn params
    if (typeof deviceSNs === 'string') {
      deviceSNs = deviceSNs.split(',').map(sn => sn.trim()).filter(Boolean);
    }

    // Use cache/concurrency wrapper
    const results = await Promise.all(
      deviceSNs.map(sn => getDeviceDataWithCache(sn, perPage, startDate))
    );
    res.json({ devices: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Zentra Proxy Server is running.');
});

app.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}/zentra`);
});

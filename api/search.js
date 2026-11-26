export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) {
    return res.status(400).json({ error: 'Empty query' });
  }

  try {
    let resolvedQuery = rawQuery;
    let coverUrl = null;

    // 1. Очищаем ссылку Spotify от ?si=... и вытягиваем название + обложку через oEmbed
    const spotifyMatch = rawQuery.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const cleanSpotifyUrl = `https://spotify.com{spotifyMatch[1]}`;
      const oembedRes = await fetch(
        `https://spotify.com{encodeURIComponent(cleanSpotifyUrl)}`
      );
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (oembed.title) resolvedQuery = oembed.title;
        if (oembed.thumbnail_url) coverUrl = oembed.thumbnail_url;
      }
    }

    // 2. Если есть GEMINI_API_KEY — распознаём трек и текст через Gemini AI
    let aiMeta = null;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (geminiKey) {
      const prompt = `Identify the exact song for: "${resolvedQuery}". Return ONLY JSON: {"trackName":"...","artistName":"...","themeColor":"#18181b","lines":["..."]}`;
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        }
      );
      if (geminiRes.ok) {
        const gData = await geminiRes.json();
        const rawText = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) aiMeta = JSON.parse(rawText);
      }
    }

    const searchTerm = aiMeta ? `${aiMeta.artistName} ${aiMeta.trackName}` : resolvedQuery;
    let trackName = aiMeta?.trackName || resolvedQuery;
    let artistName = aiMeta?.artistName || '';
    let duration = 160;

    // 3. Получаем метаданные и обложку 600x600 через iTunes API
    try {
      const itunesRes = await fetch(
        `https://apple.com{encodeURIComponent(searchTerm)}&entity=song&limit=1`
      );
      if (itunesRes.ok) {
        const itunesData = await itunesRes.json();
        const song = itunesData?.results?.[0];
        if (song) {
          if (!aiMeta?.trackName && song.trackName) trackName = song.trackName;
          if (!artistName && song.artistName) artistName = song.artistName;
          if (song.trackTimeMillis) duration = Math.round(song.trackTimeMillis / 1000);
          if (!coverUrl && song.artworkUrl100) {
            coverUrl = song.artworkUrl100.replace('100x100bb', '600x600bb');
          }
        }
      }
    } catch (_) {}

    // 4. Подтягиваем текст с таймкодами из LRCLIB
    let lines = [];
    try {
      const lrcQuery = artistName ? `${artistName} ${trackName}` : searchTerm;
      const lrcRes = await fetch(
        `https://lrclib.net{encodeURIComponent(lrcQuery)}`
      );
      if (lrcRes.ok) {
        const lrcList = await lrcRes.json();
        const best = (Array.isArray(lrcList) ? lrcList : []).find(
          (t) => t.syncedLyrics || t.plainLyrics
        );
        if (best) {
          if (!artistName && best.artistName) artistName = best.artistName;
          if (best.trackName) trackName = best.trackName;
          duration = best.duration || duration;

          if (best.syncedLyrics) {
            const timeRegex = /^\[(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*(.*)$/;
            for (const raw of best.syncedLyrics.split('\n')) {
              const m = raw.trim().match(timeRegex);
              if (m && m[3].trim()) {
                const mins = parseInt(m[1], 10);
                const secs = parseInt(m[2], 10);
                const pct = Math.min(95, Math.max(5, Math.round(((mins * 60 + secs) / duration) * 100)));
                lines.push({
                  text: m[3].trim(),
                  time: `${mins}:${secs.toString().padStart(2, '0')}`,
                  progress: pct
                });
              }
            }
          } else if (best.plainLyrics) {
            const plain = best.plainLyrics.split('\n').map((s) => s.trim()).filter(Boolean);
            lines = plain.map((txt, idx) => ({
              text: txt,
              time: '0:30',
              progress: Math.min(92, Math.max(8, Math.round(((idx + 1) / (plain.length + 1)) * 100)))
            }));
          }
        }
      }
    } catch (_) {}

    if (lines.length === 0 && Array.isArray(aiMeta?.lines)) {
      lines = aiMeta.lines.map((txt, idx) => ({
        text: txt,
        time: '0:30',
        progress: Math.min(92, Math.max(8, Math.round(((idx + 1) / (aiMeta.lines.length + 1)) * 100)))
      }));
    }

    return res.status(200).json({
      trackName,
      artistName: artistName || 'Artist',
      duration,
      coverUrl,
      themeColor: aiMeta?.themeColor || '#18181b',
      lines
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Search failed' });
  }
}

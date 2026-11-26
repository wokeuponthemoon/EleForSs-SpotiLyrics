export default async function handler(req, res) {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Empty query' });
  }

  try {
    let resolvedQuery = query;

    // 1. Если вставлена прямая ссылка ://spotify.com... — забираем название и артиста через oEmbed
    if (query.includes('://spotify.com')) {
      const oembedRes = await fetch(
        `https://spotify.com{encodeURIComponent(query)}`
      );
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (oembed.title) {
          resolvedQuery = oembed.title;
        }
      }
    }

    // 2. Если на сервере задан GEMINI_API_KEY — распознаём трек и текст через Gemini AI
    let aiMeta = null;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (geminiKey) {
      const prompt = `Identify the exact song for this search query (could be a track name, lyrics snippet, or description): "${resolvedQuery}".
Return ONLY valid JSON with fields:
{
  "trackName": "exact track title",
  "artistName": "exact artist name",
  "themeColor": "#hex dark rich background color matching the album cover vibe",
  "lines": ["line 1", "line 2", "..."]
}`;

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
        if (rawText) {
          aiMeta = JSON.parse(rawText);
        }
      }
    }

    const searchTerm = aiMeta
      ? `${aiMeta.artistName} ${aiMeta.trackName}`
      : resolvedQuery;

    // 3. Получаем официальную обложку альбома 600x600 через iTunes Search API
    let coverUrl = null;
    try {
      const itunesRes = await fetch(
        `https://apple.com{encodeURIComponent(searchTerm)}&entity=song&limit=1`
      );
      if (itunesRes.ok) {
        const itunesData = await itunesRes.json();
        const artwork = itunesData?.results?.[0]?.artworkUrl100;
        if (artwork) {
          coverUrl = artwork.replace('100x100bb', '600x600bb');
        }
      }
    } catch (_) {}

    // 4. Подтягиваем точные построчные таймкоды из LRCLIB
    let lines = [];
    let duration = 160;
    try {
      const lrcRes = await fetch(
        `https://lrclib.net{encodeURIComponent(searchTerm)}`
      );
      if (lrcRes.ok) {
        const lrcList = await lrcRes.json();
        const best = (Array.isArray(lrcList) ? lrcList : []).find(
          (t) => t.syncedLyrics || t.plainLyrics
        );
        if (best) {
          duration = best.duration || 160;
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

    // Если LRCLIB не нашёл текст, берём строки от Gemini AI
    if (lines.length === 0 && Array.isArray(aiMeta?.lines)) {
      lines = aiMeta.lines.map((txt, idx) => ({
        text: txt,
        time: '0:30',
        progress: Math.min(92, Math.max(8, Math.round(((idx + 1) / (aiMeta.lines.length + 1)) * 100)))
      }));
    }

    return res.status(200).json({
      trackName: aiMeta?.trackName || resolvedQuery,
      artistName: aiMeta?.artistName || 'Artist',
      duration,
      coverUrl,
      themeColor: aiMeta?.themeColor || '#18181b',
      lines
    });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed' });
  }
}

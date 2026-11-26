export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) {
    return res.status(400).json({ error: 'Empty query' });
  }

  try {
    let resolvedQuery = rawQuery;
    let coverUrl = null;
    let trackName = '';
    let artistName = '';

    // 1. Разбор прямой ссылки ://spotify.com...
    const spotifyMatch = rawQuery.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const cleanSpotifyUrl = `https://://spotify.com${spotifyMatch[1]}`;

      try {
        const oembedRes = await fetch(
          `https://spotify.com{encodeURIComponent(cleanSpotifyUrl)}`
        );
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          if (oembed.title) resolvedQuery = oembed.title;
          if (oembed.thumbnail_url) coverUrl = oembed.thumbnail_url;
        }
      } catch (_) {}

      if (resolvedQuery === rawQuery) {
        try {
          const pageRes = await fetch(cleanSpotifyUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
            }
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
            const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
            const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);

            if (titleMatch && titleMatch[1]) {
              trackName = titleMatch[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
              resolvedQuery = trackName;
            }
            if (descMatch && descMatch[1]) {
              const parts = descMatch[1].split('·').map((s) => s.trim());
              if (parts.length >= 2) {
                artistName = parts[0].replace(/^Listen to .* on Spotify\.\s*/i, '').trim();
                resolvedQuery = `${artistName} ${trackName}`;
              }
            }
            if (!coverUrl && imgMatch && imgMatch[1]) {
              coverUrl = imgMatch[1];
            }
          }
        } catch (_) {}
      }
    }

    // 2. Поиск точного названия трека, исполнителя и обложки 600x600 через iTunes Search API
    let duration = 160;
    try {
      const itunesRes = await fetch(
        `https://apple.com{encodeURIComponent(resolvedQuery)}&entity=song&limit=1`
      );
      if (itunesRes.ok) {
        const itunesData = await itunesRes.json();
        const song = itunesData?.results?.[0];
        if (song) {
          if (song.trackName) trackName = song.trackName;
          if (song.artistName) artistName = song.artistName;
          if (song.trackTimeMillis) duration = Math.round(song.trackTimeMillis / 1000);
          if (!coverUrl && song.artworkUrl100) {
            coverUrl = song.artworkUrl100.replace('100x100bb', '600x600bb');
          }
        }
      }
    } catch (_) {}

    if (!trackName) trackName = resolvedQuery;

    // 3. Поиск текста с таймкодами через LRCLIB (с обязательным User-Agent)
    let lines = [];
    try {
      const lrcQuery = artistName ? `${artistName} ${trackName}` : resolvedQuery;
      const lrcRes = await fetch(
        `https://lrclib.net{encodeURIComponent(lrcQuery)}`,
        {
          headers: {
            'User-Agent': 'EleForSs-SpotiLyrics/1.0 (https://github.com/wokeuponthemoon/EleForSs-SpotiLyrics)'
          }
        }
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

    return res.status(200).json({
      trackName,
      artistName: artistName || 'Artist',
      duration,
      coverUrl,
      themeColor: '#18181b',
      lines
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Search failed' });
  }
}
